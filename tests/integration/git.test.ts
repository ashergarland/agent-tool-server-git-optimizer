import { access, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config/index.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
  type TestRepository,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

const servicesFor = (root: string, overrides: Record<string, unknown> = {}) => {
  const config: AppConfig = testConfig({
    GIT_LOCAL_PATHS_ENABLED: 'false',
    GIT_ALLOWED_ROOTS: root,
    ...overrides,
  });
  return createServices(config);
};

const summarize = (
  services: ReturnType<typeof servicesFor>,
  repository: TestRepository,
  input: Record<string, unknown> = {},
) =>
  services.git.summarizeCommitDiff({
    repositoryPath: repository.path,
    targetRef: 'HEAD',
    whitespace: 'preserve',
    ...input,
  });

describe('summarize_commit_diff over real repositories', () => {
  it('summarizes a commit against its parent and filters lockfiles and assets', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    const { root: rootCommit, head } = await seedRepository(repository);
    const services = servicesFor(root);

    const result = await summarize(services, repository);
    expect(result.targetCommit).toBe(head);
    expect(result.baseCommit).toBe(rootCommit);
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.ignoredFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
    expect(result.ignoredFileCount).toBe(2);
    expect(result.totalFiles).toBe(1);
    expect(result.returnedFiles).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.warnings.some((warning) => warning.includes('filtered'))).toBe(true);
    expect(result.files[0]?.details).toContain('addition');
    await services.close();
  });

  it('compares a root commit against the empty tree only after proving it has no parent', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    const rootCommit = await (async () => {
      await repository.write('src/app.ts', 'export const a = 1;\n');
      return repository.commit('root');
    })();
    const services = servicesFor(root);

    const result = await summarize(services, repository, { targetRef: rootCommit });
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.files[0]?.change).toBe('Added');
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40,64}$/u);
    expect(result.warnings.some((warning) => warning.includes('root commit'))).toBe(true);
    await services.close();
  });

  it('resolves branches and annotated tags but rejects non-commit references', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    const { head } = await seedRepository(repository);
    await repository.git('tag', '--annotate', 'v1', '--message', 'release');
    await repository.git('branch', 'feature');
    const services = servicesFor(root);

    const byTag = await summarize(services, repository, { baseRef: 'v1', targetRef: 'feature' });
    expect(byTag.baseCommit).toBe(head);
    expect(byTag.targetCommit).toBe(head);
    expect(byTag.files).toEqual([]);
    expect(byTag.summary).toBe('No reviewable changes between the requested commits.');

    await expect(
      summarize(services, repository, { targetRef: 'HEAD^{tree}' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      summarize(services, repository, { targetRef: 'no-such-branch' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await services.close();
  });

  it('rejects reference syntax that could be read as an option', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const services = servicesFor(root);

    for (const ref of ['--output=/tmp/pwned', '-HEAD', 'HEAD;rm -rf /', 'HEAD\nHEAD']) {
      await expect(summarize(services, repository, { baseRef: ref })).rejects.toMatchObject({
        code: 'bad_request',
      });
    }
    await services.close();
  });

  it('preserves semantic indentation by default and ignores only end-of-line space on request', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('app.py', 'def run():\n    return 1\n');
    await repository.commit('root');
    await repository.write('app.py', 'def run():\n        return 1   \n');
    await repository.commit('reindent');
    const services = servicesFor(root);

    const preserved = await summarize(services, repository);
    expect(preserved.files.map((file) => file.path)).toEqual(['app.py']);
    expect(preserved.files[0]?.additions).toBe(1);

    const ignoringEol = await summarize(services, repository, { whitespace: 'ignore-eol' });
    expect(ignoringEol.files.map((file) => file.path)).toEqual(['app.py']);
    await services.close();
  });

  it('reports whitespace-only end-of-line churn as no change when asked to ignore it', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('notes.txt', 'alpha\nbeta\n');
    await repository.commit('root');
    await repository.write('notes.txt', 'alpha   \nbeta\t\n');
    await repository.commit('trailing space');
    const services = servicesFor(root);

    expect((await summarize(services, repository)).files).toHaveLength(1);
    expect((await summarize(services, repository, { whitespace: 'ignore-eol' })).files).toEqual([]);
    await services.close();
  });

  it('handles filenames with spaces, quotes, and unicode without corrupting results', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    await repository.write('a file with spaces.ts', 'export const a = 1;\n');
    await repository.write('ünïcode/файл.ts', 'export const b = 2;\n');
    await repository.commit('unusual names');
    const services = servicesFor(root);

    const result = await summarize(services, repository);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      'a file with spaces.ts',
      'ünïcode/файл.ts',
    ]);
    expect(result.warnings.some((warning) => warning.includes('unusual'))).toBe(true);
    await services.close();
  });

  it('marks binary changes instead of reporting misleading line counts', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    await writeFile(join(repository.path, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3, 4]));
    await repository.commit('binary');
    const services = servicesFor(root);

    const result = await summarize(services, repository);
    expect(result.files[0]).toMatchObject({ path: 'blob.bin', binary: true, additions: 0 });
    expect(result.files[0]?.details).toContain('binary content changed');
    await services.close();
  });

  it('bounds returned files and reports the totals honestly', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    for (let index = 0; index < 12; index += 1) {
      await repository.write(`src/file-${index}.ts`, `export const value = ${index};\n`);
    }
    await repository.commit('many files');
    const services = servicesFor(root, { GIT_MAX_FILES: 5 });

    const result = await summarize(services, repository);
    expect(result.returnedFiles).toBe(5);
    expect(result.totalFiles).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('maxFiles'))).toBe(true);

    const narrower = await summarize(services, repository, { maxFiles: 2 });
    expect(narrower.returnedFiles).toBe(2);
    await services.close();
  });

  it('ignores repository configuration that tries to run an external diff or textconv driver', async () => {
    const root = await temporaryDirectory();
    const marker = join(root, 'pwned.txt');
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');

    const script = join(repository.path, 'evil.sh');
    await writeFile(script, `#!/bin/sh\necho pwned > "${marker.replaceAll('\\', '/')}"\n`, 'utf8');
    await chmod(script, 0o755).catch(() => undefined);
    await repository.write('.gitattributes', '* diff=evil\n');
    await repository.write('src/app.ts', 'export const a = 1;\n');
    await repository.commit('hostile attributes');

    // Configured only after the fixture is committed, so nothing but the code under test can
    // ever be the process that runs the script.
    await repository.git('config', 'diff.external', script);
    await repository.git('config', 'diff.evil.textconv', script);
    await repository.git('config', 'core.fsmonitor', script);
    await expect(access(marker)).rejects.toBeInstanceOf(Error);

    const services = servicesFor(root);
    const result = await summarize(services, repository);
    expect(result.files.map((file) => file.path)).toContain('src/app.ts');
    await expect(access(marker)).rejects.toBeInstanceOf(Error);
    await services.close();
  });

  it('runs Git without inherited credential helpers, prompts, or user configuration', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    await repository.git('config', 'credential.helper', '!echo leaked');
    await repository.git('config', 'core.pager', '!echo leaked');
    await repository.git('config', 'diff.external', '/bin/false');
    const services = servicesFor(root);
    const client = services.gitClient;

    const effective = async (key: string) =>
      (
        await client.run({
          cwd: repository.path,
          args: ['config', '--get', key],
          allowFailure: true,
        })
      ).stdout.trim();

    // `--get` reports the winning value, which is always the one this server pins.
    expect(await effective('credential.helper')).toBe('');
    expect(await effective('core.askPass')).toBe('');
    expect(await effective('core.pager')).toBe('cat');
    expect(await effective('diff.external')).toBe('');
    expect(await effective('core.fsmonitor')).toBe('false');
    expect(await effective('gc.auto')).toBe('0');

    const global = await client.run({
      cwd: repository.path,
      args: ['config', '--global', '--list'],
      allowFailure: true,
    });
    expect(global.stdout.trim()).toBe('');
    await services.close();
  });

  it('summarizes through an explicitly supported bare repository', async () => {
    const root = await temporaryDirectory();
    const source = await initRepository(join(root, 'source'));
    await seedRepository(source);
    await source.git('clone', '--bare', '--quiet', source.path, join(root, 'mirror.git'));
    const services = servicesFor(root);

    const result = await services.git.summarizeCommitDiff({
      repositoryPath: join(root, 'mirror.git'),
      targetRef: 'HEAD',
      whitespace: 'preserve',
    });
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.ignoredFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
    await services.close();
  });

  it('confines the tool to configured roots and reports readiness accordingly', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    await initRepository(join(outside, 'other'));
    const services = servicesFor(root);

    await expect(
      services.git.summarizeCommitDiff({
        repositoryPath: join(outside, 'other'),
        targetRef: 'HEAD',
        whitespace: 'preserve',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const readiness = await services.readiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.gitVersion).toMatch(/^\d+\.\d+/u);
    await services.close();
  });

  it('is not ready when no repository root is configured', async () => {
    const services = createServices(testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false' }));
    const readiness = await services.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.checks.find((check) => check.name === 'repositoryRoots')?.ok).toBe(false);
    await services.close();
  });

  it('serves concurrent invocations without exceeding the worker limit', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const services = servicesFor(root, { GIT_CONCURRENCY: 2, GIT_QUEUE_LIMIT: 64 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => summarize(services, repository)),
    );
    for (const result of results) expect(result.returnedFiles).toBe(1);
    expect(services.gitClient.stats().active).toBe(0);
    await services.close();
  });
});
