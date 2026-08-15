import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  ConfigurationError,
  envSchema,
  loadConfig,
  withoutBlankValues,
} from '../../src/config/index.js';

const production = (overrides: Record<string, unknown> = {}) =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'production',
      AUTH_MODE: 'api-key',
      API_KEYS: '12345678901234567890123456789012',
      GIT_ALLOWED_ROOTS: resolve('/srv/repositories'),
      ...overrides,
    }),
  );

describe('configuration', () => {
  it('normalizes booleans and ignores blank optional values', () => {
    const config = loadConfig(
      {
        NODE_ENV: 'test',
        AUTH_MODE: 'api-key',
        API_KEYS: '12345678901234567890123456789012',
        GIT_LOCAL_PATHS_ENABLED: 'True',
        PUBLIC_BASE_URL: '',
      },
      { cwd: resolve('/workspace') },
    );
    expect(config.git.localPathsEnabled).toBe(true);
    expect(config.git.allowedRoots).toEqual([resolve('/workspace')]);
    expect(config.service.publicBaseUrl).toBeUndefined();
    expect(withoutBlankValues({ A: '', B: 'x' })).toEqual({ B: 'x' });
  });

  it('rejects disabled production authentication', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'production', AUTH_MODE: 'disabled' })),
    ).toThrow(ConfigurationError);
  });

  it('requires strong API keys', () => {
    expect(() =>
      buildConfig(envSchema.parse({ NODE_ENV: 'test', AUTH_MODE: 'api-key', API_KEYS: 'short' })),
    ).toThrow('at least 32');
  });

  it('requires explicit repository roots in production', () => {
    expect(() => production({ GIT_ALLOWED_ROOTS: '' })).toThrow('GIT_ALLOWED_ROOTS');
    expect(() => production({ GIT_LOCAL_PATHS_ENABLED: 'true' })).toThrow(
      'GIT_LOCAL_PATHS_ENABLED',
    );
    expect(production().git.allowedRoots).toEqual([resolve('/srv/repositories')]);
  });

  it('rejects relative roots, relative executables, and inconsistent limits', () => {
    expect(() => production({ GIT_ALLOWED_ROOTS: 'relative/path' })).toThrow('absolute');
    expect(() => production({ GIT_EXECUTABLE: 'git' })).toThrow('absolute');
    expect(() =>
      production({ GIT_MAX_PATCH_BYTES: 4_000_000, GIT_MAX_BUFFER_BYTES: 1_000_000 }),
    ).toThrow('GIT_MAX_PATCH_BYTES');
  });

  it('exposes bounded git limits and a configurable noise set', () => {
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

  it('leaves a deployment without roots explicitly unusable', () => {
    const config = buildConfig(
      envSchema.parse({ NODE_ENV: 'development', AUTH_MODE: 'disabled' }),
      {
        cwd: resolve('/workspace'),
      },
    );
    expect(config.git.allowedRoots).toEqual([]);
  });
});
