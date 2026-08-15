import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppConfig } from '../config/index.js';
import { toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import { serverInstructions, type ToolInvocationContext } from '../tools/definitions.js';
import type { ToolRegistry } from '../tools/registry.js';

const shapeOf = (schema: z.ZodType): z.ZodRawShape =>
  schema instanceof z.ZodObject ? schema.shape : {};

export const createMcpServer = (
  config: AppConfig,
  registry: ToolRegistry,
  services: Services,
  context: ToolInvocationContext,
): McpServer => {
  const server = new McpServer(
    { name: config.service.name, version: config.service.version },
    { capabilities: { tools: {} }, instructions: serverInstructions },
  );

  for (const tool of registry.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: shapeOf(tool.inputSchema),
        outputSchema: shapeOf(tool.outputSchema),
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: unknown) => {
        try {
          const result = await tool.invoke(args, services, context);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          const body = toAppError(error).toBody(context.requestId);
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify(body) }],
            structuredContent: undefined,
          };
        }
      },
    );
  }
  return server;
};
