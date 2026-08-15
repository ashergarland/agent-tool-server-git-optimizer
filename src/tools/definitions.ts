import { z } from 'zod';
import type { Services } from '../services/index.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
  readonly signal?: AbortSignal | undefined;
}

export type ToolKind = 'read';

export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly annotations: ToolAnnotations;
  /** Phrases that should steer an agent towards this tool. */
  readonly useWhen: readonly string[];
  /** Phrases that must steer an agent away from this tool. */
  readonly doNotUseWhen: readonly string[];
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
  path: z.string().max(8192),
  change: z.enum(['Added', 'Deleted', 'Modified']),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  binary: z.boolean(),
  details: z.string().max(4096),
});

const useWhen = [
  'understand what a commit changed before asking for the full patch',
  'compare two branches, tags, or commits that already exist in a local repository',
  'triage a large diff into the files and symbols worth reading',
] as const;

const doNotUseWhen = [
  'inspect uncommitted or staged working-tree changes',
  'read, search, or write file contents',
  'commit, merge, rebase, push, fetch, clone, or otherwise modify a repository',
  'run repository maintenance or arbitrary Git commands',
  'analyze a repository that is not already present on this host',
] as const;

const description = [
  'Summarizes the difference between two commits of a local Git repository as a compact per-file changelog with line counts and best-effort symbol names, so an agent can decide what to read before requesting a full patch.',
  '',
  `Use it to ${useWhen.join('; ')}.`,
  `Do not use it to ${doNotUseWhen.join('; ')}.`,
  '',
  'Pass exact refs when they are known. Omit baseRef only when you want the target commit compared against its first parent; a root commit is compared against the empty tree and says so in warnings.',
  'This tool is read-only and never mutates a repository. Results are bounded: inspect ignoredFiles, truncated, totalFiles, and warnings before concluding that a change set was fully reviewed, and request the full diff only when this summary is insufficient.',
  'Symbol names come from Git hunk headers and are advisory, not a complete list of changed definitions.',
].join('\n');

export const summarizeCommitDiffTool = defineTool({
  name: 'summarize_commit_diff',
  title: 'Summarize a commit diff',
  summary:
    'Summarize the changes between two commits of a local Git repository without returning the full patch.',
  description,
  kind: 'read',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  useWhen,
  doNotUseWhen,
  inputSchema: z
    .object({
      repositoryPath: z
        .string()
        .min(1)
        .max(4096)
        .default('.')
        .describe(
          'Path to a local Git repository. Must resolve beneath a configured repository root.',
        ),
      baseRef: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe('Base commit-ish. Defaults to the first parent of targetRef.'),
      targetRef: z.string().min(1).max(255).default('HEAD').describe('Commit-ish to summarize.'),
      maxFiles: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .optional()
        .describe('Upper bound on returned files; the server limit still applies.'),
      whitespace: z
        .enum(['preserve', 'ignore-eol'])
        .default('preserve')
        .describe(
          'preserve reports every whitespace change, including semantic indentation. ignore-eol ignores only trailing end-of-line whitespace differences.',
        ),
    })
    .strict(),
  outputSchema: z
    .object({
      summary: z.string().max(1_000_000),
      files: z.array(fileSummarySchema).max(5000),
      ignoredFiles: z.array(z.string().max(8192)).max(5000),
      totalFiles: z.number().int().nonnegative(),
      returnedFiles: z.number().int().nonnegative(),
      ignoredFileCount: z.number().int().nonnegative(),
      truncated: z.boolean(),
      warnings: z.array(z.string().max(1024)).max(50),
      baseCommit: z.string().max(64),
      targetCommit: z.string().max(64),
    })
    .strict(),
  handler: (input, services, context) =>
    services.git.summarizeCommitDiff(input, { signal: context.signal }),
});

export const toolDefinitions = [
  summarizeCommitDiffTool,
] as const satisfies readonly ToolDefinition[];

/** Shared guidance surfaced to MCP clients when the server is initialized. */
export const serverInstructions = [
  'This server exposes read-only Git diff summarization for repositories that already exist on the host running it.',
  'It cannot clone, fetch, mutate, or read arbitrary files, and it never returns a full patch.',
  `Reach for ${summarizeCommitDiffTool.name} to ${useWhen.join('; ')}.`,
  `Do not reach for it to ${doNotUseWhen.join('; ')}.`,
  'Treat every result as bounded: check truncated, totalFiles, ignoredFiles, and warnings before assuming a change set was fully reviewed.',
].join('\n');
