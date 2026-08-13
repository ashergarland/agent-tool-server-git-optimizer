import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

const itemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'complete']),
});

export const listItemsTool = defineTool({
  name: 'example_list_items',
  title: 'List example items',
  summary: 'List items from the replaceable example provider.',
  description: 'Demonstrates a read-only tool crossing tool, service, and provider boundaries.',
  kind: 'read',
  inputSchema: z.object({}),
  outputSchema: z.object({ items: z.array(itemSchema) }),
  handler: async (_input, services) => ({ items: [...(await services.items.list())] }),
});

export const getItemTool = defineTool({
  name: 'example_get_item',
  title: 'Get an example item',
  summary: 'Get one item by identifier.',
  description: 'Demonstrates validated input and safe not-found error mapping.',
  kind: 'read',
  inputSchema: z.object({ id: z.string().min(1).max(100) }),
  outputSchema: z.object({ item: itemSchema }),
  handler: async (input, services) => ({ item: await services.items.get(input.id) }),
});

export const updateItemTool = defineTool({
  name: 'example_update_item',
  title: 'Update an example item',
  summary: 'Preview or update an item status.',
  description: 'Demonstrates dry-run and explicit-confirmation mutation guardrails.',
  kind: 'write',
  inputSchema: z.object({
    id: z.string().min(1).max(100),
    status: z.enum(['pending', 'complete']),
    dryRun: z.boolean().default(false),
    confirm: z.boolean().default(false),
  }),
  outputSchema: z.object({ item: itemSchema, performed: z.boolean(), dryRun: z.boolean() }),
  handler: (input, services) => services.items.updateStatus(input),
});

export const toolDefinitions = [
  listItemsTool,
  getItemTool,
  updateItemTool,
] as const satisfies readonly ToolDefinition[];
