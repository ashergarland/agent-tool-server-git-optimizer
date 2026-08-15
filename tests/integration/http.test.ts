import { join } from 'node:path';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/http.js';
import { createServices, type Services } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { apiKey, testConfig } from '../helpers/config.js';
import { emptyGitClient } from '../helpers/git-client.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
} from '../helpers/repository.js';

const closeables: { close(): Promise<unknown> }[] = [];
const serviceInstances: Services[] = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((app) => app.close()));
  await Promise.all(serviceInstances.splice(0).map((service) => service.close()));
});
afterAll(removeTemporaryDirectories);

const server = (overrides: Record<string, unknown> = {}, services?: Services) => {
  const config = testConfig(overrides);
  const resolved = services ?? createServices(config, { gitClient: emptyGitClient() });
  serviceInstances.push(resolved);
  const app = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    services: resolved,
    registry: createToolRegistry(),
  });
  closeables.push(app);
  return app;
};

describe('HTTP API', () => {
  it('serves public metadata, the Git version, and request IDs', async () => {
    const response = await server().inject({
      method: 'GET',
      url: '/version',
      headers: { 'x-request-id': 'caller-id' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('caller-id');
    expect(response.json().capabilities.transports).toContain('streamable-http');
    expect(response.json().capabilities.readOnly).toBe(true);
    expect(response.json().capabilities).not.toHaveProperty('mutationsEnabled');
    expect(response.json().git.version).toBe('2.49.0');
  });

  it('separates liveness from readiness', async () => {
    const app = server({ GIT_LOCAL_PATHS_ENABLED: 'false' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(503);
    const body = ready.json<{ status: string; checks: { name: string; ok: boolean }[] }>();
    expect(body.status).toBe('not-ready');
    expect(body.checks.find((check) => check.name === 'repositoryRoots')?.ok).toBe(false);
  });

  it('reports ready when Git and a repository root are usable', async () => {
    const root = await temporaryDirectory();
    await initRepository(join(root, 'project'));
    const config = testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false', GIT_ALLOWED_ROOTS: root });
    const services = createServices(config);
    serviceInstances.push(services);
    const app = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      services,
      registry: createToolRegistry(),
    });
    closeables.push(app);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
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
    expect(
      (
        await server().inject({
          method: 'GET',
          url: '/tools',
          headers: { 'x-api-key': apiKey.slice(0, 8) },
        })
      ).statusCode,
    ).toBe(401);
    const response = await server().inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tools).toHaveLength(1);
    expect(response.json().tools[0].annotations.readOnlyHint).toBe(true);
  });

  it('rate limits repeated unauthenticated attempts by client IP', async () => {
    const app = server({ RATE_LIMIT_MAX: 1 });
    for (const address of ['192.0.2.1', '192.0.2.2']) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/tools',
            headers: { 'x-forwarded-for': address },
          })
        ).statusCode,
      ).toBe(401);
    }
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

  it('invokes the tool over HTTP against a real repository', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const config = testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false', GIT_ALLOWED_ROOTS: root });
    const services = createServices(config);
    serviceInstances.push(services);
    const app = createHttpServer({
      config,
      logger: pino({ level: 'silent' }),
      services,
      registry: createToolRegistry(),
    });
    closeables.push(app);

    const success = await app.inject({
      method: 'POST',
      url: '/tools/summarize_commit_diff',
      headers: { 'x-api-key': apiKey },
      payload: { repositoryPath: repository.path, targetRef: 'HEAD' },
    });
    expect(success.statusCode).toBe(200);
    const body = success.json<{ result: { files: { path: string }[]; truncated: boolean } }>();
    expect(body.result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(body.result.truncated).toBe(false);

    const outside = await app.inject({
      method: 'POST',
      url: '/tools/summarize_commit_diff',
      headers: { 'x-api-key': apiKey },
      payload: { repositoryPath: join(root, '..'), targetRef: 'HEAD' },
    });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toMatchObject({ code: 'forbidden', retryable: false });
  });

  it('returns one safe error shape for validation failures', async () => {
    const app = server();
    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/summarize_commit_diff',
      headers: { 'x-api-key': apiKey },
      payload: { repositoryPath: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatchObject({ code: 'bad_request', retryable: false });
    expect(invalid.json().error.requestId).toEqual(expect.any(String));
    expect(invalid.json().error.details.issues).toHaveLength(1);

    const unknown = await app.inject({
      method: 'POST',
      url: '/tools/does_not_exist',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');
  });

  it('rate limits principals', async () => {
    const limited = server({ RATE_LIMIT_MAX: 1 });
    expect(
      (await limited.inject({ method: 'GET', url: '/tools', headers: { 'x-api-key': apiKey } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await limited.inject({ method: 'GET', url: '/tools', headers: { 'x-api-key': apiKey } }))
        .statusCode,
    ).toBe(429);
  });

  it('publishes the generated OpenAPI document', async () => {
    const response = await server().inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().paths['/tools/summarize_commit_diff']).toBeDefined();
    expect(response.json().paths['/ready']).toBeDefined();
  });
});
