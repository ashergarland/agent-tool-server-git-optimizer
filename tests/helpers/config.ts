import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

export const testConfig = (overrides: Record<string, unknown> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: 'test-api-key-that-is-at-least-32-characters',
      RATE_LIMIT_MAX: 120,
      ...overrides,
    }),
  );
