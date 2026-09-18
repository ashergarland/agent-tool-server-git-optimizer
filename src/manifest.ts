import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const gitOptimizerManifest: CapabilityManifest = {
  name: 'agent-tool-server-git-optimizer',
  version: packageManifest.version,
  title: 'Git Optimizer',
  description:
    'Read-only summaries of changed files, symbols, configuration keys, and routes between two local Git commits.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-git-optimizer#readme',
};
