import { afterAll, describe, expect, it, vi } from 'vitest';
import type * as FsPromises from 'node:fs/promises';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

const state = { failMkdtemp: false };

// ESM namespaces cannot be spied on, so the failure is injected at module resolution.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    default: actual,
    mkdtemp: (prefix: string) =>
      state.failMkdtemp
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : actual.mkdtemp(prefix),
  };
});

const { createGitClient } = await import('../../src/services/git-exec.js');

afterAll(removeTemporaryDirectories);

describe('private temporary directory', () => {
  it('fails loudly instead of sharing the system temporary directory', async () => {
    const root = await temporaryDirectory();
    await initRepository(root);
    const client = createGitClient(testConfig({ GIT_ALLOWED_ROOTS: root }));

    state.failMkdtemp = true;
    try {
      // Sharing os.tmpdir() would make the isolated Git config paths predictable and world
      // writable, and would put the shared directory in the shutdown deletion path.
      await expect(client.run({ cwd: root, args: ['rev-parse', 'HEAD'] })).rejects.toMatchObject({
        code: 'internal_error',
      });
    } finally {
      state.failMkdtemp = false;
      await client.close();
    }
  });
});
