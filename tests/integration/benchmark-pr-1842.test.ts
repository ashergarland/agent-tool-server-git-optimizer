import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  temporaryDirectory,
} from '../helpers/repository.js';

interface BenchmarkFixture {
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly targetFiles: Readonly<Record<string, string>>;
  readonly expectedChangedFiles: readonly string[];
  readonly unchangedDeploymentFile: string;
}

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/pr-1842.json', import.meta.url), 'utf8'),
) as BenchmarkFixture;

afterAll(removeTemporaryDirectories);

describe('Level 1 PR 1842 Git evidence fixture', () => {
  it('returns targeted change facts without a patch or hardcoded diagnosis', async () => {
    const root = await temporaryDirectory('git-optimizer-benchmark-');
    const repository = await initRepository(join(root, 'checkout-api'));
    for (const [path, content] of Object.entries(fixture.baseFiles)) {
      await repository.write(path, content);
    }
    const baseCommit = await repository.commit('base');

    for (const [path, content] of Object.entries(fixture.targetFiles)) {
      await repository.write(path, content);
    }
    const targetCommit = await repository.commit('pull request');

    const services = createServices(
      testConfig({
        GIT_LOCAL_PATHS_ENABLED: 'false',
        GIT_ALLOWED_ROOTS: root,
      }),
      { scratchDirectory: await temporaryDirectory('git-optimizer-benchmark-scratch-') },
    );
    try {
      const result = await services.git.summarizeCommitDiff({
        repositoryPath: repository.path,
        baseRef: baseCommit,
        targetRef: targetCommit,
        whitespace: 'preserve',
      });

      expect(result.baseCommit).toBe(baseCommit);
      expect(result.targetCommit).toBe(targetCommit);
      expect(result.files.map(({ path }) => path)).toEqual(fixture.expectedChangedFiles);
      expect(result.files.some(({ path }) => path === fixture.unchangedDeploymentFile)).toBe(false);
      expect(result.totalFiles).toBe(fixture.expectedChangedFiles.length);
      expect(result.returnedFiles).toBe(fixture.expectedChangedFiles.length);
      expect(result.ignoredFileCount).toBe(0);
      expect(result.truncated).toBe(false);

      const configuration = result.files.find(({ path }) => path === 'src/config.ts');
      expect(configuration?.configurationKeys).toEqual(
        expect.arrayContaining(['APP_PORT', 'PORT']),
      );
      const health = result.files.find(({ path }) => path === 'src/routes/health.ts');
      expect(health?.routes).toEqual(expect.arrayContaining(['GET /healthz', 'GET /health']));

      expect(result.summary).not.toContain('process.env');
      expect(result.summary).not.toMatch(/\b(?:3000|8080)\b/u);
      expect(result.summary.length).toBeLessThan(2_000);
      expect(JSON.stringify(result)).not.toMatch(/root cause|incident diagnosis/iu);
    } finally {
      await services.close();
    }
  });
});
