import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/http.js';
import { MemoryProvider } from '../../src/provider/memory.js';
import { createServices } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const servers: ReturnType<typeof createHttpServer>[] = [];
const apiKey = 'test-api-key-that-is-at-least-32-characters';

const server = (overrides: Record<string, unknown> = {}) => {
  const config = testConfig(overrides);
  const app = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    services: createServices(config, new MemoryProvider()),
    registry: createToolRegistry(),
  });
  servers.push(app);
  return app;
};

afterEach(async () => Promise.all(servers.splice(0).map((app) => app.close())));

describe('HTTP API', () => {
  it('serves public metadata and request IDs', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/version',
      headers: { 'x-request-id': 'caller-id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    expect(response.json().capabilities.transports).toContain('streamable-http');
  });

  it('authenticates protected routes', async () => {
    expect((await server().inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    expect(
      (
        await server().inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': 'not-the-configured-key-but-long-enough' },
        })
      ).statusCode,
    ).toBe(401);
    const response = await server().inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': apiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toHaveLength(3);
  });

  it('rate limits repeated unauthenticated attempts by client IP', async () => {
    const app = server({ RATE_LIMIT_MAX: 1 });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-forwarded-for': '192.0.2.1' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-forwarded-for': '192.0.2.2' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-forwarded-for': '192.0.2.3' },
        })
      ).statusCode,
    ).toBe(429);
  });

  it('supports development-only disabled authentication', async () => {
    const response = await server({ AUTH_MODE: 'disabled' }).inject({
      method: 'GET',
      url: '/tools',
    });
    expect(response.statusCode).toBe(200);
  });

  it('invokes tools and maps validation failures', async () => {
    const app = server();
    const success = await app.inject({
      method: 'POST',
      url: '/tools/example_get_item',
      headers: { 'x-api-key': apiKey },
      payload: { id: 'example-1' },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json().result.item.id).toBe('example-1');

    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/example_get_item',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.details.issues).toHaveLength(1);
  });

  it('previews guarded mutations and rate limits principals', async () => {
    const preview = await server().inject({
      method: 'POST',
      url: '/tools/example_update_item',
      headers: { 'x-api-key': apiKey },
      payload: { id: 'example-1', status: 'complete', dryRun: true },
    });
    expect(preview.json().result).toMatchObject({ performed: false, dryRun: true });

    const limited = server({ RATE_LIMIT_MAX: 1 });
    expect(
      (
        await limited.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': apiKey },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await limited.inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': apiKey },
        })
      ).statusCode,
    ).toBe(429);
  });

  it('publishes the generated OpenAPI document', async () => {
    const response = await server().inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/tools/example_list_items']).toBeDefined();
  });
});
