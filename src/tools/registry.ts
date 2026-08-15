import { z } from 'zod';
import { badRequest, notFound, toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import {
  toolDefinitions,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolInvocationContext,
  type ToolKind,
} from './definitions.js';

export interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly annotations: ToolAnnotations;
  readonly useWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema: Record<string, unknown>;
  invoke(rawInput: unknown, services: Services, context: ToolInvocationContext): Promise<unknown>;
}

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> =>
  z.toJSONSchema(schema, { io, target: 'draft-7', unrepresentable: 'any' });

const issues = (error: z.ZodError): unknown =>
  error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));

const erase = (definition: ToolDefinition): RegisteredTool => ({
  ...definition,
  inputJsonSchema: jsonSchema(definition.inputSchema, 'input'),
  outputJsonSchema: jsonSchema(definition.outputSchema, 'output'),
  async invoke(rawInput, services, context) {
    const input = definition.inputSchema.safeParse(rawInput ?? {});
    if (!input.success) {
      throw badRequest(`Invalid input for tool ${definition.name}`, {
        issues: issues(input.error),
      });
    }
    try {
      const rawOutput = await definition.handler(input.data, services, context);
      const output = definition.outputSchema.safeParse(rawOutput);
      if (!output.success) {
        throw new Error(`Tool ${definition.name} returned an invalid output`);
      }
      return output.data;
    } catch (error) {
      throw toAppError(error);
    }
  },
});

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, RegisteredTool>;

  public constructor(definitions: readonly ToolDefinition[]) {
    const tools = new Map<string, RegisteredTool>();
    for (const definition of definitions) {
      if (tools.has(definition.name)) throw new Error(`Duplicate tool: ${definition.name}`);
      tools.set(definition.name, erase(definition));
    }
    this.tools = tools;
  }

  public list(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  public get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw notFound(`Unknown tool: ${name}`, { availableTools: [...this.tools.keys()] });
    return tool;
  }

  public invoke(
    name: string,
    input: unknown,
    services: Services,
    context: ToolInvocationContext,
  ): Promise<unknown> {
    return this.get(name).invoke(input, services, context);
  }
}

export const createToolRegistry = (
  definitions: readonly ToolDefinition[] = toolDefinitions,
): ToolRegistry => new ToolRegistry(definitions);
