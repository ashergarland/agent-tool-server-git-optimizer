import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitClient } from '../../src/services/git-exec.js';
import { RepositoryBoundary } from '../../src/services/repository.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

const boundaryFor = async (root: string, overrides: Record<string, unknown> = {}) => {
  const config = testConfig({
    GIT_LOCAL_PATHS_ENABLED: 'false',
    GIT_ALLOWED_ROOTS: root,
    ...overrides,
  });
  const scratch = await temporaryDirectory('git-optimizer-boundary-');
  const client = createGitClient(config, scratch);
  return { boundary: new RepositoryBoundary(config, client), client };
};

describe('repository boundary', () => {
  it('resolves a repository beneath an allowed root to its canonical top level', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('src/app.ts', 'export const a = 1;\n');
    await repository.commit('root');
    const { boundary, client } = await boundaryFor(root);

    const fromSubdirectory = await boundary.resolveRepository(join(root, 'project', 'src'));
    expect(fromSubdirectory.path).toBe(repository.path);
    expect(fromSubdirectory.bare).toBe(false);
    await client.close();
  });

  it('rejects traversal, absolute escapes, and sibling-prefix paths', async () => {
    const root = await temporaryDirectory();
    await initRepository(join(root, 'project'));
    const { boundary, client } = await boundaryFor(join(root, 'project'));

    await expect(boundary.resolveRepository('../..')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(boundary.resolveRepository(join(root, 'elsewhere'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      boundary.resolveRepository(`${join(root, 'project')}-other`),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await client.close();
  });

  it('rejects a symlink or junction that escapes the root', async (context) => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await initRepository(join(outside, 'secret'));
    await mkdir(root, { recursive: true });
    const link = join(root, 'escape');
    try {
      await symlink(join(outside, 'secret'), link, 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        context.skip();
        return;
      }
      throw error;
    }
    const { boundary, client } = await boundaryFor(root);
    await expect(boundary.resolveRepository(link)).rejects.toMatchObject({ code: 'forbidden' });
    await client.close();
  });

  it('rejects linked worktrees unless their Git metadata roots are also authorized', async () => {
    const allowed = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const source = await initRepository(join(outside, 'source'));
    await source.write('TOP_SECRET.ts', 'export const secret = 1;\n');
    await source.commit('root');
    const linked = join(allowed, 'linked');
    await source.git('worktree', 'add', '--quiet', '--detach', linked, 'HEAD');

    const confined = await boundaryFor(allowed);
    await expect(confined.boundary.resolveRepository(linked)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await confined.client.close();

    const explicitlyAuthorized = await boundaryFor(`${allowed};${source.path}`);
    await expect(explicitlyAuthorized.boundary.resolveRepository(linked)).resolves.toMatchObject({
      path: linked,
      bare: false,
    });
    await explicitlyAuthorized.client.close();
  });

  it('rejects a primary object directory symlinked outside the allowed root', async (context) => {
    const allowed = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const source = await initRepository(join(outside, 'source'));
    await source.write('secret.txt', 'secret\n');
    await source.commit('root');
    const borrowerPath = join(allowed, 'borrower');
    await source.git('clone', '--quiet', source.path, borrowerPath);
    const sourceObjects = (
      await source.git('rev-parse', '--path-format=absolute', '--git-path', 'objects')
    ).trim();
    const borrowerObjects = join(borrowerPath, '.git', 'objects');
    await rm(borrowerObjects, { recursive: true });
    try {
      await symlink(sourceObjects, borrowerObjects, 'junction');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        context.skip();
        return;
      }
      throw error;
    }
    const { boundary, client } = await boundaryFor(allowed);

    await expect(boundary.resolveRepository(borrowerPath)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await client.close();
  });

  it('rejects malformed or oversized alternate-object metadata deterministically', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const objectDirectory = (
      await repository.git('rev-parse', '--path-format=absolute', '--git-path', 'objects')
    ).trim();
    const alternatesPath = join(objectDirectory, 'info', 'alternates');
    const { boundary, client } = await boundaryFor(root);

    await writeFile(alternatesPath, '"unterminated\n', 'utf8');
    await expect(boundary.resolveRepository(repository.path)).rejects.toMatchObject({
      code: 'bad_request',
    });

    await writeFile(alternatesPath, '#'.repeat(64 * 1024 + 1), 'utf8');
    await expect(boundary.resolveRepository(repository.path)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });

    await writeFile(alternatesPath, `${'segment/'.repeat(129)}objects\n`, 'utf8');
    await expect(boundary.resolveRepository(repository.path)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await client.close();
  });

  it('rejects alternate-object chains beyond the bounded Git nesting depth', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const primary = (
      await repository.git('rev-parse', '--path-format=absolute', '--git-path', 'objects')
    ).trim();
    const alternates = Array.from({ length: 7 }, (_, index) =>
      join(root, `alternate-${index + 1}`),
    );
    for (const alternate of alternates) {
      await mkdir(join(alternate, 'info'), { recursive: true });
    }
    await writeFile(join(primary, 'info', 'alternates'), `${alternates[0]}\n`, 'utf8');
    for (let index = 0; index < alternates.length - 1; index += 1) {
      await writeFile(
        join(alternates[index] ?? '', 'info', 'alternates'),
        `${alternates[index + 1]}\n`,
        'utf8',
      );
    }
    const { boundary, client } = await boundaryFor(root);

    await expect(boundary.resolveRepository(repository.path)).rejects.toMatchObject({
      code: 'limit_exceeded',
    });
    await client.close();
  });

  it('keeps readable roots usable when another configured root is unavailable', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const missing = join(root, 'missing-root');
    const { boundary, client } = await boundaryFor(`${missing};${root}`);

    await expect(boundary.roots()).resolves.toEqual([root]);
    await expect(boundary.resolveRepository(repository.path)).resolves.toMatchObject({
      path: repository.path,
    });
    await client.close();
  });

  it('accepts equivalent path casing on Windows', async (context) => {
    if (process.platform !== 'win32') {
      context.skip();
      return;
    }
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');
    const { boundary, client } = await boundaryFor(root);

    await expect(boundary.resolveRepository(repository.path.toUpperCase())).resolves.toMatchObject({
      path: repository.path,
    });
    await client.close();
  });

  it('rejects a repository whose top level sits above the allowed root', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(root);
    await repository.write('nested/file.txt', 'x\n');
    await repository.commit('root');
    const { boundary, client } = await boundaryFor(join(root, 'nested'));

    await expect(boundary.resolveRepository(join(root, 'nested'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await client.close();
  });

  it('rejects missing paths, files, non-repositories, and control characters', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'plain'), { recursive: true });
    await writeFile(join(root, 'plain', 'file.txt'), 'x\n', 'utf8');
    const { boundary, client } = await boundaryFor(root);

    await expect(boundary.resolveRepository(join(root, 'absent'))).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(boundary.resolveRepository(join(root, 'plain'))).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(boundary.resolveRepository(join(root, 'plain', 'file.txt'))).rejects.toMatchObject(
      { code: 'bad_request' },
    );
    await expect(boundary.resolveRepository('bad\u0000path')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await client.close();
  });

  it('reports not-ready when no repository root is configured', async () => {
    const config = testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false' });
    const scratch = await temporaryDirectory('git-optimizer-boundary-');
    const client = createGitClient(config, scratch);
    const boundary = new RepositoryBoundary(config, client);
    await expect(boundary.resolveRepository('.')).rejects.toMatchObject({ code: 'not_ready' });
    await expect(boundary.roots()).rejects.toMatchObject({ code: 'not_ready' });
    await client.close();
  });

  it('supports an explicitly addressed bare repository', async () => {
    const root = await temporaryDirectory();
    const source = await initRepository(join(root, 'source'));
    await source.write('a.txt', 'a\n');
    await source.commit('root');
    await source.git('clone', '--bare', '--quiet', source.path, join(root, 'mirror.git'));
    const { boundary, client } = await boundaryFor(root);

    const resolved = await boundary.resolveRepository(join(root, 'mirror.git'));
    expect(resolved.bare).toBe(true);
    expect(resolved.path).toBe(join(root, 'mirror.git'));
    await client.close();
  });
});
