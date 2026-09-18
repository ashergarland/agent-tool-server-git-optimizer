import { defineTool, type AnyToolDefinition } from '@agent-tool-platform/runtime/tools';
import { z } from 'zod';
import type { CapabilityServices } from '../services/index.js';

const fileSummarySchema = z.strictObject({
  path: z.string().max(8192),
  change: z.enum(['Added', 'Deleted', 'Modified']),
  additions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  deletions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  binary: z.boolean(),
  details: z.string().max(4096),
  symbols: z.array(z.string().max(255)).max(3),
  configurationKeys: z.array(z.string().max(255)).max(3),
  routes: z.array(z.string().max(255)).max(3),
});

const summarizeCommitDiffInputSchema = z.strictObject({
  repositoryPath: z
    .string()
    .min(1)
    .max(4096)
    .default('.')
    .describe('Local Git repository path confined beneath a configured repository root.'),
  baseRef: z
    .string()
    .min(1)
    .max(255)
    .optional()
    .describe('Base commit-ish. Defaults to the first parent of targetRef.'),
  targetRef: z.string().min(1).max(255).default('HEAD').describe('Target commit-ish to summarize.'),
  maxFiles: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe('Upper bound on returned files; the configured server ceiling still applies.'),
  whitespace: z
    .enum(['preserve', 'ignore-eol'])
    .default('preserve')
    .describe(
      'preserve reports every whitespace change; ignore-eol ignores only trailing end-of-line whitespace.',
    ),
});

const summarizeCommitDiffOutputSchema = z.strictObject({
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
});

export type SummarizeCommitDiffToolInput = z.infer<typeof summarizeCommitDiffInputSchema>;
export type SummarizeCommitDiffToolOutput = z.infer<typeof summarizeCommitDiffOutputSchema>;

export const summarizeCommitDiffTool = defineTool<
  CapabilityServices,
  typeof summarizeCommitDiffInputSchema,
  typeof summarizeCommitDiffOutputSchema
>({
  name: 'summarize_commit_diff',
  title: 'Summarize a commit diff',
  summary:
    'Summarize changed files and source-level orientation signals between two local commits.',
  description:
    'Return a compact per-file changelog with exact line counts and best-effort changed symbols, configuration keys, and route signatures, without returning a full patch.',
  kind: 'read',
  routing: {
    useWhen: [
      'establishing the effective base and target commits plus the files changed by a pull request, branch, tag, or commit',
      'triaging source, configuration, route, test, and deployment-file changes before selecting files for AST or raw-source inspection',
      'checking whether a tracked file was unchanged when the returned inventory is complete and unqualified',
    ],
    doNotUseWhen: [
      'uncommitted or staged working-tree changes must be inspected',
      'exact implementation, literal values, or the full patch are required; use a raw-source or full-diff reader after this summary',
      'declaration or dependency structure inside selected source files is required; use an AST capability after this Git summary',
      'structured results from many comparisons must be aggregated; use Data Cruncher after collecting the Git summaries',
      'a repository must be cloned, fetched, committed, merged, rebased, pushed, or otherwise mutated',
    ],
    scope:
      'one comparison between existing commit-ish references in one local repository beneath an allowed root',
    changesState: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: summarizeCommitDiffInputSchema,
  outputSchema: summarizeCommitDiffOutputSchema,
  handler: (input, services, context) =>
    services.git.summarizeCommitDiff(input, { signal: context.signal }),
});

export const capabilityTools: readonly AnyToolDefinition<CapabilityServices>[] = [
  summarizeCommitDiffTool,
];
