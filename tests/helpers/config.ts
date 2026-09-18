import { createTestPlatformConfig } from '@agent-tool-platform/testkit';
import { buildGitConfig, gitEnvSchema, type GitConfig } from '../../src/config/index.js';

export const testConfig = (
  overrides: Record<string, unknown> = {},
  options: { cwd?: string } = {},
): GitConfig =>
  buildGitConfig(
    createTestPlatformConfig({
      serviceName: 'agent-tool-server-git-optimizer',
      serviceVersion: '0.1.0-test',
    }),
    gitEnvSchema.parse({
      GIT_LOCAL_PATHS_ENABLED: 'true',
      ...overrides,
    }),
    options.cwd,
  );
