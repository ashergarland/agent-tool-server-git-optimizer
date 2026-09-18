import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildGitChildEnvironment,
  buildGitGlobalArguments,
  createGitClient,
  gitFailureToError,
  isSupportedGitVersion,
  resolveGitExecutable,
} from '../../src/services/git-exec.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

const clientFor = async (root: string, overrides: Record<string, unknown> = {}) => {
  const scratch = await temporaryDirectory('git-optimizer-client-');
  return {
    client: createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root, ...overrides }), scratch),
    scratch,
  };
};

describe('Git executable resolution', () => {
  it('finds a supported Git executable and reports its version', async () => {
    const executable = await resolveGitExecutable(undefined);
    expect(executable).toMatch(/git(\.exe)?$/u);

    const root = await temporaryDirectory();
    await initRepository(root);
    const { client } = await clientFor(root);
    const probe = await client.probe();
    expect(probe.version).toMatch(/^\d+\.\d+/u);
    expect(isSupportedGitVersion(probe.version)).toBe(true);
    expect(probe.executable).toBe(executable);
    await client.close();
  });

  it('enforces the minimum version needed by the fixed argv policy', () => {
    expect(isSupportedGitVersion('2.34.0')).toBe(true);
    expect(isSupportedGitVersion('3.0.0.windows.1')).toBe(true);
    expect(isSupportedGitVersion('2.33.9')).toBe(false);
    expect(isSupportedGitVersion('not-a-version')).toBe(false);
  });

  it('rejects configured or PATH executables that do not exist', async () => {
    await expect(resolveGitExecutable(join('/definitely', 'missing', 'git'))).rejects.toMatchObject(
      { code: 'internal_error' },
    );
    await expect(resolveGitExecutable(undefined, '')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

describe('Git isolation policy', () => {
  it('builds a minimal child environment rooted in lifecycle scratch', async () => {
    const executable = await resolveGitExecutable(undefined);
    const scratch = await temporaryDirectory('git-optimizer-environment-');
    const environment = buildGitChildEnvironment(executable, scratch, {
      PATH: 'ambient-path',
      HOME: 'ambient-home',
      GIT_CONFIG_GLOBAL: 'ambient-config',
      HTTPS_PROXY: 'https://proxy.invalid',
      SECRET_TOKEN: 'must-not-leak',
      SystemRoot: process.env['SystemRoot'],
      windir: process.env['windir'],
    });

    expect(environment['HOME']).toBe(scratch);
    expect(environment['TMPDIR']).toBe(scratch);
    expect(environment['TMP']).toBe(scratch);
    expect(environment['TEMP']).toBe(scratch);
    expect(environment['GIT_CONFIG_GLOBAL']).toBe(join(scratch, 'global.gitconfig'));
    expect(environment['GIT_CONFIG_SYSTEM']).toBe(join(scratch, 'system.gitconfig'));
    expect(environment['PATH']?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(
      dirname(executable),
    );
    expect(environment).not.toHaveProperty('HTTPS_PROXY');
    expect(environment).not.toHaveProperty('SECRET_TOKEN');
  });

  it('pins dangerous Git configuration and enables ownership trust only on request', async () => {
    const scratch = await temporaryDirectory('git-optimizer-argv-');
    const safe = buildGitGlobalArguments(false, scratch);
    expect(safe).toContain('--literal-pathspecs');
    expect(safe).toContain('--no-optional-locks');
    expect(safe).toContain('diff.external=');
    expect(safe).toContain('credential.helper=');
    expect(safe).toContain('protocol.allow=never');
    expect(safe).not.toContain('safe.directory=*');
    expect(buildGitGlobalArguments(true, scratch)).toContain('safe.directory=*');
  });
});

describe('Git failures and process bounds', () => {
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
    const { client } = await clientFor(root);

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

  it('rejects oversized argument lists before spawning Git', async () => {
    const root = await temporaryDirectory();
    await initRepository(root);
    const { client } = await clientFor(root, { GIT_MAX_ARGUMENT_BYTES: 4096 });
    await expect(
      client.run({ cwd: root, args: ['rev-parse', 'x'.repeat(8000)] }),
    ).rejects.toMatchObject({ code: 'limit_exceeded' });
    await client.close();
  });

  it('rejects output larger than the configured process buffer', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('seed.txt', 'seed\n');
    await repository.commit('root');
    await repository.write('big.txt', 'line of text\n'.repeat(20_000));
    await repository.commit('large');
    const { client } = await clientFor(root);

    await expect(
      client.run({
        cwd: root,
        args: ['diff', '--no-ext-diff', '--no-textconv', 'HEAD~1', 'HEAD', '--'],
        maxBufferBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
    await client.close();
  });

  it('rejects work beyond the queue limit with a retryable busy error', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const { client } = await clientFor(root, {
      GIT_CONCURRENCY: 1,
      GIT_QUEUE_LIMIT: 0,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () => client.run({ cwd: root, args: ['rev-parse', 'HEAD'] })),
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

  it('cancels queued or active work when its caller aborts', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const { client } = await clientFor(root);
    await client.probe();

    const controller = new AbortController();
    const pending = client.run({
      cwd: root,
      args: ['rev-list', '--all'],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'busy', retryable: true });
    await client.close();
  });

  it('drains without deleting scratch because Platform owns scratch cleanup', async () => {
    const root = await temporaryDirectory();
    await initRepository(root);
    const { client, scratch } = await clientFor(root);
    await client.run({ cwd: root, args: ['rev-parse', '--git-dir'] });
    await client.close();
    await expect(access(scratch)).resolves.toBeUndefined();
    await expect(client.run({ cwd: root, args: ['rev-parse', 'HEAD'] })).rejects.toMatchObject({
      code: 'busy',
    });
  });
});
