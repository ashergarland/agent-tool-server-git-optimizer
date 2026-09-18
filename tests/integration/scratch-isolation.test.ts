import { access, lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { afterAll, describe, expect, it } from 'vitest';
import { gitOptimizerCapability } from '../../src/capability.js';
import type { GitConfig } from '../../src/config/index.js';
import type { CapabilityServices } from '../../src/services/index.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

afterAll(removeTemporaryDirectories);

describe('Platform-owned Git scratch isolation', () => {
  it('uses lifecycle scratch instead of ambient HOME, config, or temp state', async () => {
    const root = await temporaryDirectory('git-optimizer-isolation-root-');
    const repository = await initRepository(join(root, 'repository'));
    await repository.write('a.txt', 'a\n');
    await repository.commit('root');

    const ambientHome = await temporaryDirectory('git-optimizer-ambient-');
    const ambientTemp = await temporaryDirectory('git-optimizer-ambient-temp-');
    const ambientConfig = join(ambientHome, 'ambient.gitconfig');
    const ambientObjects = join(ambientHome, 'objects');
    await mkdir(ambientObjects);
    await writeFile(ambientConfig, '[agenttool]\n\tambient = leaked\n', 'utf8');

    const previous = {
      HOME: process.env['HOME'],
      USERPROFILE: process.env['USERPROFILE'],
      TMPDIR: process.env['TMPDIR'],
      TMP: process.env['TMP'],
      TEMP: process.env['TEMP'],
      GIT_CONFIG_GLOBAL: process.env['GIT_CONFIG_GLOBAL'],
      GIT_OBJECT_DIRECTORY: process.env['GIT_OBJECT_DIRECTORY'],
      GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'],
    };
    process.env['HOME'] = ambientHome;
    process.env['USERPROFILE'] = ambientHome;
    process.env['TMPDIR'] = ambientTemp;
    process.env['TMP'] = ambientTemp;
    process.env['TEMP'] = ambientTemp;
    process.env['GIT_CONFIG_GLOBAL'] = ambientConfig;
    process.env['GIT_OBJECT_DIRECTORY'] = ambientObjects;
    process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = ambientObjects;

    let application: AgentToolApplication<GitConfig, CapabilityServices> | undefined;
    try {
      application = await createAgentToolApplication(gitOptimizerCapability, {
        logger: createSilentLogger(),
        env: {
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          GIT_LOCAL_PATHS_ENABLED: 'false',
          GIT_ALLOWED_ROOTS: root,
        },
      });
      const scratchPath = application.services.scratch.path;
      const metadata = await stat(scratchPath);
      expect(metadata.isDirectory()).toBe(true);
      expect((await lstat(scratchPath)).isSymbolicLink()).toBe(false);
      expect(dirname(await realpath(scratchPath))).toBe(await realpath(tmpdir()));
      expect(scratchPath).not.toBe(ambientHome);
      expect(scratchPath).not.toBe(ambientTemp);
      if (process.platform !== 'win32') expect(metadata.mode & 0o777).toBe(0o700);

      const ambient = await application.services.gitClient.run({
        cwd: repository.path,
        args: ['config', '--global', '--get', 'agenttool.ambient'],
        allowFailure: true,
      });
      expect(ambient.stdout).toBe('');
      expect(ambient.exitCode).not.toBe(0);

      const result = await application.services.git.summarizeCommitDiff({
        repositoryPath: repository.path,
        targetRef: 'HEAD',
        whitespace: 'preserve',
      });
      expect(result.files.map((file) => file.path)).toEqual(['a.txt']);
      const objectPath = await application.services.gitClient.run({
        cwd: repository.path,
        args: ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      });
      expect(await realpath(objectPath.stdout.trim())).toBe(
        await realpath(join(repository.path, '.git', 'objects')),
      );
      const objectStores = await application.services.gitClient.run({
        cwd: repository.path,
        args: ['count-objects', '--verbose'],
      });
      expect(objectStores.stdout).not.toMatch(/^alternate: /mu);

      await application.start();
      await application.shutdown();
      await expect(access(scratchPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(ambientHome)).resolves.toBeUndefined();
      await expect(access(ambientTemp)).resolves.toBeUndefined();
      application = undefined;
    } finally {
      if (application) await application.shutdown();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
