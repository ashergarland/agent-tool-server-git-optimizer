import {
  defineAgentToolCapability,
  type CapabilityContext,
} from '@agent-tool-platform/runtime/capability';
import { readinessNotReady, readinessReady } from '@agent-tool-platform/runtime/lifecycle';
import { gitConfigSpec, type GitConfig, type gitEnvSchema } from './config/index.js';
import { gitOptimizerManifest } from './manifest.js';
import { createCapabilityServices, type CapabilityServices } from './services/index.js';
import { capabilityTools } from './tools/definitions.js';
import { capabilityInstructions } from './tools/guidance.js';

export const gitOptimizerCapability = defineAgentToolCapability<
  CapabilityServices,
  GitConfig,
  typeof gitEnvSchema
>({
  manifest: gitOptimizerManifest,
  instructions: capabilityInstructions,
  config: gitConfigSpec,
  tools: capabilityTools,

  createServices(context: CapabilityContext<GitConfig>): Promise<CapabilityServices> {
    return createCapabilityServices(context);
  },

  readiness: [
    async ({ services }) => {
      try {
        const probe = await services.gitClient.probe();
        return readinessReady('git', `git ${probe.version}`);
      } catch {
        return readinessNotReady('git', 'a usable Git executable is unavailable');
      }
    },
    async ({ config, services }) => {
      try {
        const roots = await services.boundary.roots();
        return roots.length === config.git.allowedRoots.length
          ? readinessReady('repository_roots', `${roots.length} readable root(s)`)
          : readinessNotReady(
              'repository_roots',
              `${roots.length} of ${config.git.allowedRoots.length} configured roots are readable`,
            );
      } catch {
        return readinessNotReady('repository_roots', 'no configured repository root is readable');
      }
    },
    ({ services }) => {
      const stats = services.gitClient.stats();
      const accepting =
        !stats.closed && (stats.active < stats.concurrency || stats.queued < stats.queueLimit);
      return accepting
        ? readinessReady('git_capacity')
        : readinessNotReady('git_capacity', 'the bounded Git queue is saturated');
    },
  ],

  lifecycle: {
    async stop({ services }) {
      await services.close();
    },
  },
});
