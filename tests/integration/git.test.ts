import { access, chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GitConfig } from '../../src/config/index.js';
import { createServices, type GitServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
  TestRepository,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

const servicesFor = async (root: string, overrides: Record<string, unknown> = {}) => {
  const config: GitConfig = testConfig({
    GIT_LOCAL_PATHS_ENABLED: 'false',
    GIT_ALLOWED_ROOTS: root,
    ...overrides,
  });
  return createServices(config, {
    scratchDirectory: await temporaryDirectory('git-optimizer-integration-'),
  });
};

const summarize = (
  services: GitServices,
  repository: TestRepository,
  input: Record<string, unknown> = {},
) =>
  services.git.summarizeCommitDiff({
    repositoryPath: repository.path,
    targetRef: 'HEAD',
    whitespace: 'preserve',
    ...input,
  });

const objectDirectoryFor = async (repository: TestRepository): Promise<string> =>
  (await repository.git('rev-parse', '--path-format=absolute', '--git-path', 'objects')).trim();

const sharedClone = async (
  source: TestRepository,
  destination: string,
): Promise<TestRepository> => {
  await source.git('clone', '--shared', '--quiet', source.path, destination);
  const clone = new TestRepository(destination);
  const counts = await clone.git('count-objects', '--verbose');
  expect(counts).toMatch(/^count: 0$/mu);
  expect(counts).toMatch(/^packs: 0$/mu);
  expect(counts).toMatch(/^alternate: /mu);
  return clone;
};

const writeAlternates = async (
  repository: TestRepository,
  entries: readonly string[],
): Promise<void> => {
  const objectDirectory = await objectDirectoryFor(repository);
  await mkdir(join(objectDirectory, 'info'), { recursive: true });
  await writeFile(join(objectDirectory, 'info', 'alternates'), `${entries.join('\n')}\n`);
};

describe('summarize_commit_diff over real repositories', () => {
  it('summarizes a commit against its parent and filters lockfiles and assets', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    const { root: rootCommit, head } = await seedRepository(repository);
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root);

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
    const services = await servicesFor(root, { GIT_MAX_FILES: 5 });

    const result = await summarize(services, repository);
    expect(result.returnedFiles).toBe(5);
    expect(result.totalFiles).toBe(12);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('maxFiles'))).toBe(true);

    const narrower = await summarize(services, repository, { maxFiles: 2 });
    expect(narrower.returnedFiles).toBe(2);
    await services.close();
  });

  it('bounds ignored paths and summary text without hiding structured coverage', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    for (let index = 0; index < 5; index += 1) {
      await repository.write(
        `src/long-component-name-${index}.ts`,
        `export function changedComponent${index}(): number {\n  return ${index};\n}\n`,
      );
    }
    await repository.write('package-lock.json', '{}\n');
    await repository.write('yarn.lock', '# lock\n');
    await repository.write('Cargo.lock', '# lock\n');
    await repository.commit('bounded output');
    const services = await servicesFor(root, {
      GIT_MAX_IGNORED_FILES: 1,
      GIT_MAX_SUMMARY_LENGTH: 256,
    });

    const result = await summarize(services, repository);
    expect(result.returnedFiles).toBe(5);
    expect(result.totalFiles).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.ignoredFiles).toHaveLength(1);
    expect(result.ignoredFileCount).toBe(3);
    expect(result.summary).toHaveLength(256);
    expect(result.summary.endsWith('…')).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('first 1 of 3 filtered paths'),
        expect.stringContaining('textual summary reached'),
      ]),
    );
    await services.close();
  });

  it('keeps exact file counts when best-effort signal extraction exceeds its patch budget', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('src/large.ts', 'export const seed = 0;\n');
    await repository.commit('root');
    await repository.write(
      'src/large.ts',
      Array.from(
        { length: 2_000 },
        (_, index) => `export const changedValue${index} = ${index};`,
      ).join('\n'),
    );
    await repository.commit('large patch');
    const services = await servicesFor(root, { GIT_MAX_PATCH_BYTES: 16 * 1024 });

    const result = await summarize(services, repository);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/large.ts');
    expect(result.files[0]?.additions).toBe(2_000);
    expect(result.files[0]?.symbols).toEqual([]);
    expect(result.warnings).toContain(
      'The diff was too large to extract symbol context; per-file counts are still exact.',
    );
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

    const services = await servicesFor(root);
    const result = await summarize(services, repository);
    expect(result.files.map((file) => file.path)).toContain('src/app.ts');
    await expect(access(marker)).rejects.toBeInstanceOf(Error);
    await services.close();
  });

  it('pins repository-controlled helpers, prompts, and executable configuration', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('base.txt', 'base\n');
    await repository.commit('root');
    await repository.git('config', 'credential.helper', '!echo leaked');
    await repository.git('config', 'core.pager', '!echo leaked');
    await repository.git('config', 'diff.external', '/bin/false');
    const services = await servicesFor(root);
    const client = services.gitClient;

    const effective = async (key: string) =>
      (
        await client.run({
          cwd: repository.path,
          args: ['config', '--get', key],
          allowFailure: true,
        })
      ).stdout.trim();

    try {
      expect(await effective('credential.helper')).toBe('');
      expect(await effective('core.askPass')).toBe('');
      expect(await effective('core.pager')).toBe('cat');
      expect(await effective('diff.external')).toBe('');
      expect(await effective('core.fsmonitor')).toBe('false');
      expect(await effective('gc.auto')).toBe('0');
    } finally {
      await services.close();
    }
  });

  it('summarizes through an explicitly supported bare repository', async () => {
    const root = await temporaryDirectory();
    const source = await initRepository(join(root, 'source'));
    await seedRepository(source);
    await source.git('clone', '--bare', '--quiet', source.path, join(root, 'mirror.git'));
    const services = await servicesFor(root);

    const result = await services.git.summarizeCommitDiff({
      repositoryPath: join(root, 'mirror.git'),
      targetRef: 'HEAD',
      whitespace: 'preserve',
    });
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.ignoredFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
    await services.close();
  });

  it('confines the tool to configured roots', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    await initRepository(join(outside, 'other'));
    const services = await servicesFor(root);

    await expect(
      services.git.summarizeCommitDiff({
        repositoryPath: join(outside, 'other'),
        targetRef: 'HEAD',
        whitespace: 'preserve',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await services.close();
  });

  it('rejects an in-root shared clone whose object database is outside every allowed root', async () => {
    const allowed = await temporaryDirectory('git-optimizer-alternate-allowed-');
    const outside = await temporaryDirectory('git-optimizer-alternate-outside-');
    const source = await initRepository(join(outside, 'source'));
    await seedRepository(source);
    const borrower = await sharedClone(source, join(allowed, 'borrower'));
    const services = await servicesFor(allowed);

    await expect(summarize(services, borrower)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'The Git object database lies outside the configured repository roots',
    });
    await services.close();
  });

  it('accepts a shared clone when its external object database is explicitly authorized', async () => {
    const allowed = await temporaryDirectory('git-optimizer-alternate-allowed-');
    const outside = await temporaryDirectory('git-optimizer-alternate-authorized-');
    const source = await initRepository(join(outside, 'source'));
    await seedRepository(source);
    const borrower = await sharedClone(source, join(allowed, 'borrower'));
    const borrowerObjects = await objectDirectoryFor(borrower);
    const sourceObjects = await objectDirectoryFor(source);
    const relativeObjectPath = relative(borrowerObjects, sourceObjects).split(sep).join('/');
    await writeAlternates(borrower, [JSON.stringify(relativeObjectPath)]);
    const services = await servicesFor(`${allowed};${sourceObjects}`);

    const result = await summarize(services, borrower);
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(result.ignoredFiles.sort()).toEqual(['assets/logo.png', 'package-lock.json']);
    await services.close();
  });

  it('rejects an unauthorized object database reached through an authorized alternate', async () => {
    const allowed = await temporaryDirectory('git-optimizer-alternate-allowed-');
    const middleRoot = await temporaryDirectory('git-optimizer-alternate-middle-');
    const outside = await temporaryDirectory('git-optimizer-alternate-deep-');
    const deep = await initRepository(join(outside, 'deep'));
    await seedRepository(deep);
    const middle = await sharedClone(deep, join(middleRoot, 'middle'));
    const borrower = await sharedClone(middle, join(allowed, 'borrower'));
    const middleObjects = await objectDirectoryFor(middle);
    const services = await servicesFor(`${allowed};${middleObjects}`);

    await expect(summarize(services, borrower)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await services.close();
  });

  it('terminates authorized cycles in the alternate object database graph', async () => {
    const root = await temporaryDirectory('git-optimizer-alternate-cycle-');
    const source = await initRepository(join(root, 'source'));
    await seedRepository(source);
    const alternate = await sharedClone(source, join(root, 'alternate'));
    await writeAlternates(source, [await objectDirectoryFor(alternate)]);
    const services = await servicesFor(root);

    const result = await summarize(services, source);
    expect(result.files.map((file) => file.path)).toEqual(['src/app.ts']);
    await services.close();
  });

  it('resolves symlinks before parent segments in relative alternate paths', async (context) => {
    const allowed = await temporaryDirectory('git-optimizer-alternate-allowed-');
    const outside = await temporaryDirectory('git-optimizer-alternate-symlink-');
    const source = await initRepository(join(outside, 'source'));
    await seedRepository(source);
    const borrower = await sharedClone(source, join(allowed, 'borrower'));
    const borrowerObjects = await objectDirectoryFor(borrower);
    const link = join(borrowerObjects, 'redirect');
    await mkdir(join(outside, 'target'), { recursive: true });
    await mkdir(join(borrowerObjects, 'source', '.git', 'objects'), { recursive: true });
    try {
      await symlink(join(outside, 'target'), link, 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        context.skip();
        return;
      }
      throw error;
    }
    await writeAlternates(borrower, ['redirect/../source/.git/objects']);
    const services = await servicesFor(allowed);

    await expect(summarize(services, borrower)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await services.close();
  });

  it('serves concurrent invocations without exceeding the worker limit', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const services = await servicesFor(root, {
      GIT_CONCURRENCY: 2,
      GIT_QUEUE_LIMIT: 64,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => summarize(services, repository)),
    );
    for (const result of results) expect(result.returnedFiles).toBe(1);
    expect(services.gitClient.stats().active).toBe(0);
    await services.close();
  });
});
