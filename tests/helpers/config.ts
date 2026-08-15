import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

export const apiKey = 'test-api-key-that-is-at-least-32-characters';

export const testConfig = (
  overrides: Record<string, unknown> = {},
  options: { cwd?: string } = {},
): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
      RATE_LIMIT_MAX: 120,
      GIT_LOCAL_PATHS_ENABLED: 'true',
      ...overrides,
    }),
    options,
  );
