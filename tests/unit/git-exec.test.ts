import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createGitClient,
  gitFailureToError,
  resolveGitExecutable,
} from '../../src/services/git-exec.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

describe('Git executable resolution', () => {
  it('finds Git on PATH and reports a version', async () => {
    const executable = await resolveGitExecutable(undefined);
    expect(executable).toMatch(/git(\.exe)?$/u);

    const client = createGitClient(testConfig());
    const probe = await client.probe();
    expect(probe.version).toMatch(/^\d+\.\d+/u);
    expect(probe.executable).toBe(executable);
    await client.close();
  });

  it('rejects a configured executable that does not exist', async () => {
    await expect(resolveGitExecutable(join('/definitely', 'missing', 'git'))).rejects.toMatchObject(
      {
        code: 'internal_error',
      },
    );
    await expect(resolveGitExecutable(undefined, '')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('Git failure classification', () => {
  it('maps repository-controlled failures onto safe typed errors', () => {
    expect(gitFailureToError('unknown-revision').code).toBe('bad_request');
    expect(gitFailureToError('ambiguous-argument').code).toBe('bad_request');
    expect(gitFailureToError('not-a-repository').code).toBe('bad_request');
    expect(gitFailureToError('untrusted-ownership').code).toBe('forbidden');
    expect(gitFailureToError('other').message).not.toMatch(/fatal|stderr/iu);
  });

  it('never leaks raw stderr through a failing command', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const client = createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root }));

    await expect(
      client.run({ cwd: root, args: ['rev-parse', '--verify', 'no-such-ref'] }),
    ).rejects.toMatchObject({ code: 'bad_request' });

    const allowed = await client.run({
      cwd: root,
      args: ['rev-parse', '--verify', '--quiet', 'no-such-ref'],
      allowFailure: true,
    });
    expect(allowed.exitCode).not.toBe(0);
    await client.close();
  });
});

describe('Git execution bounds', () => {
  it('rejects oversized argument lists before spawning Git', async () => {
    const root = await temporaryDirectory();
    await initRepository(root);
    const client = createGitClient(
      testConfig({ GIT_ALLOWED_ROOTS: root, GIT_MAX_ARGUMENT_BYTES: 4096 }),
    );
    await expect(
      client.run({ cwd: root, args: ['rev-parse', 'x'.repeat(8000)] }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    await client.close();
  });

  it('rejects output larger than the configured buffer', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('seed.txt', 'seed\n');
    await repository.commit('root');
    await repository.write('big.txt', 'line of text\n'.repeat(20_000));
    await repository.commit('large');
    const client = createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root }));

    await expect(
      client.run({
        cwd: root,
        args: ['diff', '--no-ext-diff', '--no-textconv', 'HEAD~1', 'HEAD', '--'],
        maxBufferBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    await client.close();
  });

  it('rejects work beyond the queue limit with a retryable busy error', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const client = createGitClient(
      testConfig({ GIT_ALLOWED_ROOTS: root, GIT_CONCURRENCY: 1, GIT_QUEUE_LIMIT: 0 }),
    );

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => client.run({ cwd: root, args: ['rev-parse', 'HEAD'] })),
    );
    const rejected = results.filter((entry) => entry.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.status === 'rejected' && rejected[0].reason).toMatchObject({
      code: 'busy',
      retryable: true,
    });
    expect(client.stats().active).toBe(0);
    await client.close();
  });

  it('cancels a command when its caller aborts', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const client = createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root }));
    await client.probe();

    const controller = new AbortController();
    const pending = client.run({
      cwd: root,
      args: ['rev-list', '--all'],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await client.close();
  });

  it('refuses new work once the client is closing', async () => {
    const root = await temporaryDirectory();
    await initRepository(root);
    const client = createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root }));
    await client.close();
    await expect(client.run({ cwd: root, args: ['rev-parse', 'HEAD'] })).rejects.toMatchObject({
      code: 'busy',
    });
  });
});
