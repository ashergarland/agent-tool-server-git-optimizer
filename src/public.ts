export { gitOptimizerCapability, gitOptimizerCapability as capability } from './capability.js';
export {
  gitConfigDefaults,
  gitConfigSpec,
  gitEnvSchema,
  loadGitConfig,
  type GitConfig,
  type GitEnv,
  type GitLimits,
} from './config/index.js';
export { gitOptimizerManifest, gitOptimizerManifest as capabilityManifest } from './manifest.js';
export type {
  ChangeKind,
  DiffSummary,
  FileSummary,
  SummarizeCommitDiffInput,
  WhitespaceMode,
} from './services/git.js';
export {
  summarizeCommitDiffTool,
  type SummarizeCommitDiffToolInput,
  type SummarizeCommitDiffToolOutput,
} from './tools/definitions.js';
