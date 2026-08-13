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

const fileSummarySchema = z.object({
  path: z.string(),
  change: z.enum(['Added', 'Deleted', 'Modified', 'Renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  details: z.string(),
});

export const summarizeCommitDiffTool = defineTool({
  name: 'summarize_commit_diff',
  title: 'Summarize a commit diff',
  summary: 'Summarize meaningful local Git changes while filtering generated noise.',
  description:
    'Runs a local Git diff, ignores whitespace-only changes, lockfiles, and generated assets, and returns a dense per-file changelog.',
  kind: 'read',
  inputSchema: z.object({
    repositoryPath: z.string().min(1).max(4096).default('.'),
    baseRef: z.string().min(1).max(255).optional(),
    targetRef: z.string().min(1).max(255).default('HEAD'),
  }),
  outputSchema: z.object({
    summary: z.string(),
    files: z.array(fileSummarySchema),
    ignoredFiles: z.array(z.string()),
  }),
  handler: (input, services) => services.git.summarizeCommitDiff(input),
});

export const toolDefinitions = [summarizeCommitDiffTool] as const satisfies readonly ToolDefinition[];
