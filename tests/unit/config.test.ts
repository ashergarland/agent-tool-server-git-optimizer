import { resolve } from 'node:path';
import { ConfigurationError } from '@agent-tool-platform/runtime/config';
import { createTestPlatformConfig } from '@agent-tool-platform/testkit';
import { describe, expect, it } from 'vitest';
import { buildGitConfig, gitEnvSchema, loadGitConfig } from '../../src/config/index.js';

const production = (overrides: Record<string, unknown> = {}) =>
  buildGitConfig(
    createTestPlatformConfig({
      serviceName: 'agent-tool-server-git-optimizer',
      serviceVersion: '0.1.0-test',
      env: { NODE_ENV: 'production' },
    }),
    gitEnvSchema.parse({
      GIT_ALLOWED_ROOTS: resolve('/srv/repositories'),
      ...overrides,
    }),
  );

describe('Git configuration', () => {
  it('loads through the Platform base configuration and normalizes booleans', () => {
    const config = loadGitConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      GIT_LOCAL_PATHS_ENABLED: 'True',
      GIT_MAX_FILES: '12',
    });
    expect(config.service.name).toBe('agent-tool-server-git-optimizer');
    expect(config.git.localPathsEnabled).toBe(true);
    expect(config.git.limits.maxFiles).toBe(12);
  });

  it('uses the launch directory only when local paths are explicitly enabled', () => {
    const cwd = resolve('/workspace');
    const local = buildGitConfig(
      createTestPlatformConfig(),
      gitEnvSchema.parse({ GIT_LOCAL_PATHS_ENABLED: 'true' }),
      cwd,
    );
    expect(local.git.allowedRoots).toEqual([cwd]);
    expect(local.git.baseDirectory).toBe(cwd);

    const disabled = buildGitConfig(
      createTestPlatformConfig(),
      gitEnvSchema.parse({ GIT_LOCAL_PATHS_ENABLED: 'false' }),
      cwd,
    );
    expect(disabled.git.allowedRoots).toEqual([]);
  });

  it('includes both the launch directory and explicit roots when both are enabled', () => {
    const cwd = resolve('/workspace');
    const explicit = resolve('/repositories');
    const config = buildGitConfig(
      createTestPlatformConfig(),
      gitEnvSchema.parse({
        GIT_LOCAL_PATHS_ENABLED: 'true',
        GIT_ALLOWED_ROOTS: explicit,
      }),
      cwd,
    );
    expect(config.git.baseDirectory).toBe(cwd);
    expect(config.git.allowedRoots).toEqual([cwd, explicit]);
  });

  it('requires explicit repository roots in production', () => {
    expect(() => production({ GIT_ALLOWED_ROOTS: '' })).toThrow(ConfigurationError);
    expect(() => production({ GIT_LOCAL_PATHS_ENABLED: 'true' })).toThrow(
      'GIT_LOCAL_PATHS_ENABLED',
    );
    expect(production().git.allowedRoots).toEqual([resolve('/srv/repositories')]);
  });

  it('rejects relative roots, executables, and inconsistent buffer limits', () => {
    expect(() => production({ GIT_ALLOWED_ROOTS: 'relative/path' })).toThrow('absolute');
    expect(() => production({ GIT_EXECUTABLE: 'git' })).toThrow('absolute');
    expect(() =>
      production({ GIT_MAX_PATCH_BYTES: 4_000_000, GIT_MAX_BUFFER_BYTES: 1_000_000 }),
    ).toThrow('GIT_MAX_PATCH_BYTES');
  });

  it('exposes bounded Git limits and configurable noise filters', () => {
    const config = production({
      GIT_MAX_FILES: 12,
      GIT_CONCURRENCY: 2,
      GIT_EXTRA_IGNORED_BASENAMES: 'schema.gen.ts, snapshot.json',
      GIT_EXTRA_IGNORED_DIRECTORIES: 'dist,coverage',
    });
    expect(config.git.limits.maxFiles).toBe(12);
    expect(config.git.limits.concurrency).toBe(2);
    expect(config.git.noise.basenames).toEqual(['schema.gen.ts', 'snapshot.json']);
    expect(config.git.noise.directories).toEqual(['dist', 'coverage']);
  });

  it('rejects out-of-range limits', () => {
    expect(() => production({ GIT_MAX_FILES: 0 })).toThrow();
    expect(() => production({ GIT_TIMEOUT_MS: 10 })).toThrow();
    expect(() => production({ GIT_CONCURRENCY: 0 })).toThrow();
  });
});
