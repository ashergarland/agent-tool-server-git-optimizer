import { randomUUID } from 'node:crypto';
import fastifyRateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError, toAppError } from '../errors.js';
import { createMcpServer } from '../mcp/server.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createAuthenticator, type Principal } from './auth.js';
import { registerErrorHandler } from './errors.js';
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit.js';
import type { HttpServer } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface HttpServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
}

const readinessCacheMs = 2000;

export const createHttpServer = ({
  config,
  logger,
  services,
  registry,
}: HttpServerDeps): HttpServer => {
  const startedAt = Date.now();
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (request) => {
      const requestId = request.headers['x-request-id'];
      return typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200
        ? requestId
        : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: 1_000_000,
    trustProxy: false,
  });
  const authenticator = createAuthenticator(config);
  const limiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max,
    config.http.rateLimit.windowMs,
  );

  const rateLimitError = (reply: FastifyReply, decision: RateLimitDecision): AppError => {
    void reply.header(
      'retry-after',
      String(Math.max(1, Math.ceil((decision.resetAtMs - Date.now()) / 1000))),
    );
    return new AppError('rate_limited', 'Too many requests; slow down and retry');
  };

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  registerErrorHandler(app, config);

  app.get('/health', () => ({
    status: 'ok' as const,
    service: config.service.name,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  let readinessCache: { at: number; value: Awaited<ReturnType<Services['readiness']>> } | undefined;
  app.get('/ready', async (_request, reply) => {
    const now = Date.now();
    if (!readinessCache || now - readinessCache.at > readinessCacheMs) {
      readinessCache = { at: now, value: await services.readiness() };
    }
    const report = readinessCache.value;
    void reply.status(report.ready ? 200 : 503);
    return {
      status: report.ready ? ('ready' as const) : ('not-ready' as const),
      service: config.service.name,
      checks: report.checks,
    };
  });

  app.get('/version', async () => {
    const probe = await services.gitClient.probe().catch(() => undefined);
    return {
      service: config.service.name,
      version: config.service.version,
      gitSha: config.service.gitSha,
      node: process.version,
      environment: config.env,
      git: { version: probe?.version ?? null },
      capabilities: {
        transports: ['stdio', 'streamable-http', 'http-openapi'],
        readOnly: true,
        repositoryRootsConfigured: config.git.allowedRoots.length,
        authMode: config.auth.mode,
      },
    };
  });

  const openApi = buildOpenApiDocument(config, registry);
  app.get('/openapi.json', () => openApi);

  void app.register(async (protectedApp) => {
    await protectedApp.register(fastifyRateLimit, {
      global: false,
      errorResponseBuilder: () =>
        new AppError('rate_limited', 'Too many requests; slow down and retry'),
    });

    const authenticateAndLimit = async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = await authenticator.authenticate(request);
      request.principal = principal;
      const decision = limiter.consume(principal.id);
      void reply.header('x-ratelimit-remaining', String(decision.remaining));
      if (!decision.allowed) {
        request.log.warn({ event: 'auth.rate_limited', principal: principal.id });
        throw rateLimitError(reply, decision);
      }
    };
    const protectedRouteOptions = {
      config: {
        rateLimit: {
          max: Math.max(1, config.http.rateLimit.max * 2),
          timeWindow: config.http.rateLimit.windowMs,
          allowList: () => config.http.rateLimit.max === 0,
        },
      },
      preValidation: authenticateAndLimit,
    };

    protectedApp.get('/tools', protectedRouteOptions, () => ({
      tools: registry.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        summary: tool.summary,
        description: tool.description,
        kind: tool.kind,
        annotations: tool.annotations,
        inputSchema: tool.inputJsonSchema,
        outputSchema: tool.outputJsonSchema,
      })),
    }));

    protectedApp.post<{ Params: { toolName: string }; Body: unknown }>(
      '/tools/:toolName',
      protectedRouteOptions,
      async (request) => {
        const tool = registry.get(request.params.toolName);
        const principal = request.principal?.id ?? 'anonymous';
        const invokedAt = Date.now();
        // Cancels queued and running Git work when the caller disconnects.
        const controller = new AbortController();
        request.raw.on('close', () => {
          if (!request.raw.readableEnded) controller.abort();
        });
        request.log.info({
          event: 'tool.invoke',
          tool: tool.name,
          kind: tool.kind,
          queueDepth: services.gitClient.stats().queued,
        });
        try {
          const result = await tool.invoke(request.body ?? {}, services, {
            requestId: request.id,
            principal,
            signal: controller.signal,
          });
          const summary = result as { returnedFiles?: number; truncated?: boolean };
          request.log.info({
            event: 'tool.result',
            tool: tool.name,
            outcome: 'success',
            durationMs: Date.now() - invokedAt,
            returnedFiles: summary.returnedFiles,
            truncated: summary.truncated,
          });
          return { tool: tool.name, requestId: request.id, result };
        } catch (error) {
          request.log.warn({
            event: 'tool.result',
            tool: tool.name,
            outcome: 'error',
            code: toAppError(error).code,
            durationMs: Date.now() - invokedAt,
          });
          throw error;
        }
      },
    );

    const handleMcp = async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const transport = new StreamableHTTPServerTransport();
      const controller = new AbortController();
      const server = createMcpServer(config, registry, services, {
        requestId: request.id,
        principal: request.principal?.id ?? 'anonymous',
        signal: controller.signal,
      });
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        controller.abort();
        await Promise.allSettled([transport.close(), server.close()]);
      };
      reply.raw.on('close', () => {
        void close();
      });
      // The SDK's Node transport is structurally compatible, but its optional callbacks conflict
      // with exactOptionalPropertyTypes in the SDK's own Transport declaration.
      try {
        await server.connect(transport as unknown as Transport);
        reply.hijack();
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        await close();
        if (!reply.sent) throw error;
        request.log.error({ err: error, event: 'mcp.request.error' }, 'MCP request failed');
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        } else {
          reply.raw.destroy();
        }
      }
    };

    protectedApp.get<{ Body: unknown }>('/mcp', protectedRouteOptions, handleMcp);
    protectedApp.post<{ Body: unknown }>('/mcp', protectedRouteOptions, handleMcp);
    protectedApp.delete<{ Body: unknown }>('/mcp', protectedRouteOptions, handleMcp);
  });

  return app;
};
