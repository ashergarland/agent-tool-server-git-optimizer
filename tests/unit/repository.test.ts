import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createGitClient } from '../../src/services/git-exec.js';
import { isWithin, RepositoryBoundary } from '../../src/services/repository.js';
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
  const client = createGitClient(config);
  return { boundary: new RepositoryBoundary(config, client), config, client };
};

describe('containment helper', () => {
  it('treats a root as containing itself but never its parent or a sibling prefix', () => {
    expect(isWithin(join('/srv', 'repos'), join('/srv', 'repos'))).toBe(true);
    expect(isWithin(join('/srv', 'repos'), join('/srv', 'repos', 'a', 'b'))).toBe(true);
    expect(isWithin(join('/srv', 'repos'), join('/srv'))).toBe(false);
    expect(isWithin(join('/srv', 'repos'), join('/srv', 'repos-other'))).toBe(false);
  });
});

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

  it('rejects traversal above the root without touching the filesystem', async () => {
    const root = await temporaryDirectory();
    await initRepository(join(root, 'project'));
    const { boundary, client } = await boundaryFor(join(root, 'project'));

    await expect(boundary.resolveRepository('../..')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(boundary.resolveRepository(join(root, 'elsewhere'))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await client.close();
  });

  it('rejects a symlink that escapes the root', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await initRepository(join(outside, 'secret'));
    await mkdir(root, { recursive: true });
    const link = join(root, 'escape');
    try {
      await symlink(join(outside, 'secret'), link, 'junction');
    } catch {
      return; // Unprivileged Windows hosts cannot create links; confinement is covered elsewhere.
    }
    const { boundary, client } = await boundaryFor(root);
    await expect(boundary.resolveRepository(link)).rejects.toMatchObject({ code: 'forbidden' });
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

  it('rejects missing paths, non-repositories, and control characters', async () => {
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
    await expect(boundary.resolveRepository('bad\u0000path')).rejects.toMatchObject({
      code: 'bad_request',
    });
    await client.close();
  });

  it('refuses every request when no root is configured', async () => {
    const config = testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false' });
    const client = createGitClient(config);
    const boundary = new RepositoryBoundary(config, client);
    await expect(boundary.resolveRepository('.')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(boundary.roots()).rejects.toMatchObject({ code: 'forbidden' });
    await client.close();
  });

  it('supports an explicitly mounted bare repository', async () => {
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
