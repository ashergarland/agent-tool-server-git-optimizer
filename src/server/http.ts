import { randomUUID } from 'node:crypto';
import fastifyRateLimit from '@fastify/rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
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

  app.get('/version', () => ({
    service: config.service.name,
    version: config.service.version,
    gitSha: config.service.gitSha,
    node: process.version,
    environment: config.env,
    capabilities: {
      transports: ['stdio', 'streamable-http', 'http-openapi'],
      mutationsEnabled: config.guardrails.mutationsEnabled,
      confirmationRequired: config.guardrails.confirmationRequired,
      authMode: config.auth.mode,
    },
  }));

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
      if (!decision.allowed) throw rateLimitError(reply, decision);
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
        request.log.info({ event: 'tool.invoke', tool: tool.name, kind: tool.kind });
        const result = await tool.invoke(request.body ?? {}, services, {
          requestId: request.id,
          principal,
        });
        request.log.info({
          event: 'tool.result',
          tool: tool.name,
          durationMs: Date.now() - invokedAt,
        });
        return { tool: tool.name, requestId: request.id, result };
      },
    );

    const handleMcp = async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
      const transport = new StreamableHTTPServerTransport();
      const server = createMcpServer(config, registry, services, {
        requestId: request.id,
        principal: request.principal?.id ?? 'anonymous',
      });
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
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
