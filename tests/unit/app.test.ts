import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import { FixedWindowRateLimiter } from '../../src/server/rate-limit.js';
import { createLogger } from '../../src/util/logger.js';
import { testConfig } from '../helpers/config.js';
import { emptyGitClient } from '../helpers/git-client.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

describe('application wiring', () => {
  it('builds an injectable application and closes its Git workers', async () => {
    const application = createApplication({
      config: testConfig(),
      gitClient: emptyGitClient(),
    });
    expect(application.registry.list()).toHaveLength(1);
    expect(application.config.git.allowedRoots.length).toBeGreaterThan(0);
    await application.close();
  });

  it('serves the tool end to end through the default wiring', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const application = createApplication({
      config: testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false', GIT_ALLOWED_ROOTS: root }),
    });

    const readiness = await application.services.readiness();
    expect(readiness.ready).toBe(true);

    const result = await application.registry.invoke(
      'summarize_commit_diff',
      { repositoryPath: repository.path, targetRef: 'HEAD' },
      application.services,
      { requestId: 'app-test', principal: 'tester' },
    );
    expect(result).toMatchObject({ returnedFiles: 1, truncated: false });
    await application.close();
  });
});

describe('logger', () => {
  it('redacts credential headers', () => {
    const logger = createLogger(testConfig({ LOG_LEVEL: 'silent' }));
    expect(logger.level).toBe('silent');
    expect(logger.bindings()).toMatchObject({
      service: 'agent-tool-server-git-optimizer',
      environment: 'test',
    });
  });
});

describe('fixed window rate limiter', () => {
  it('counts, resets, and treats a zero maximum as unlimited', () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect(limiter.consume('a', 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume('a', 10)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume('a', 20).allowed).toBe(false);
    expect(limiter.consume('a', 2000).allowed).toBe(true);
    expect(limiter.consume('b', 2000).allowed).toBe(true);

    const unlimited = new FixedWindowRateLimiter(0, 1000);
    expect(unlimited.consume('a', 0).allowed).toBe(true);
  });
});
