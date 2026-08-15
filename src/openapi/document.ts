import type { AppConfig } from '../config/index.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: {
          type: 'string',
          enum: [
            'bad_request',
            'unauthorized',
            'forbidden',
            'not_found',
            'limit_exceeded',
            'rate_limited',
            'busy',
            'timeout',
            'upstream_error',
            'internal_error',
          ],
        },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const errorResponses: JsonObject = Object.fromEntries(
  [
    [400, 'Invalid input'],
    [401, 'Missing or invalid credentials'],
    [403, 'Repository access is outside the configured boundary'],
    [404, 'Unknown tool or unreadable repository path'],
    [413, 'Result exceeded a configured limit'],
    [429, 'Rate limited'],
    [500, 'Tool server failure'],
    [502, 'Provider failure'],
    [503, 'Git worker queue saturated or shutting down'],
    [504, 'Git command exceeded its time budget'],
  ].map(([status, description]) => [
    String(status),
    {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    },
  ]),
);

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description: tool.description,
    tags: [tool.kind],
    'x-openai-isConsequential': false,
    'x-tool-annotations': tool.annotations,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe. Reports only that the process is running.',
        security: [],
        responses: { '200': { description: 'Process is alive' } },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe covering Git, temporary storage, and repository roots.',
        security: [],
        responses: {
          '200': { description: 'Service can serve tool calls' },
          '503': { description: 'A dependency or repository root is unavailable' },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build, Git version, and capability information.',
        security: [],
        responses: { '200': { description: 'Service metadata' } },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'openapi',
        summary: 'Generated OpenAPI document.',
        security: [],
        responses: { '200': { description: 'OpenAPI 3.1 document' } },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List every registered tool and JSON Schema.',
        responses: { '200': { description: 'Tool catalogue' }, ...errorResponses },
      },
    },
    '/mcp': {
      post: {
        operationId: 'mcp',
        summary: 'Stateless Streamable HTTP MCP endpoint.',
        responses: { '200': { description: 'MCP response' }, ...errorResponses },
      },
    },
  };
  for (const tool of registry.list()) paths[`/tools/${tool.name}`] = toolPath(tool);

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Tool Server Git Optimizer',
      version: config.service.version,
      description:
        'Read-only Git diff summarization for repositories already present on the host. The server never mutates a repository, clones, fetches, or returns a full patch.',
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Static API key supplied as a bearer token or x-api-key header.',
        },
      },
    },
    paths,
    tags: [{ name: 'read', description: 'Read-only tools.' }],
  };
};
