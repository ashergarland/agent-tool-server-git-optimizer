import { describe, expect, it } from 'vitest';
import { createApplication } from '../../src/app.js';
import type { GitRunner } from '../../src/services/git.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';

describe('Git diff service', () => {
  it('summarizes source changes and filters noisy files', async () => {
    const runner: GitRunner = async (arguments_, cwd) => {
      expect(cwd).toBe('/repo');
      if (arguments_.includes('rev-parse')) return 'parent-sha\n';
      if (arguments_.includes('--name-status')) {
        return [
          'M\tsrc/state.ts',
          'M\tpackage-lock.json',
          'A\tdist/app.js',
          'M\tdocs/readme.md',
        ].join('\n');
      }
      if (arguments_.includes('--numstat')) {
        return [
          '4\t2\tsrc/state.ts',
          '10\t1\tpackage-lock.json',
          '50\t0\tdist/app.js',
          '1\t1\tdocs/readme.md',
        ].join('\n');
      }
      return [
        'diff --git a/src/state.ts b/src/state.ts',
        '+++ b/src/state.ts',
        '@@ -1 +1 @@ function activeState() {',
        'diff --git a/docs/readme.md b/docs/readme.md',
        '+++ b/docs/readme.md',
        '@@ -1 +1 @@',
      ].join('\n');
    };
    const services = createServices(testConfig(), runner);
    const result = await services.git.summarizeCommitDiff({
      repositoryPath: '/repo',
      targetRef: 'HEAD',
    });

    expect(result.ignoredFiles).toEqual(['package-lock.json', 'dist/app.js']);
    expect(result.files).toEqual([
      {
        path: 'src/state.ts',
        change: 'Modified',
        additions: 4,
        deletions: 2,
        details: 'Changed activeState (4 additions, 2 deletions)',
      },
      {
        path: 'docs/readme.md',
        change: 'Modified',
        additions: 1,
        deletions: 1,
        details: 'Updated 1 addition, 1 deletion',
      },
    ]);
    expect(result.summary).toContain('[Modified src/state.ts: Changed activeState');
  });

  it('rejects unsafe refs before running Git', async () => {
    const services = createServices(testConfig(), async () => {
      throw new Error('runner should not be called');
    });
    await expect(
      services.git.summarizeCommitDiff({
        repositoryPath: '.',
        baseRef: '--output=/tmp/file',
        targetRef: 'HEAD',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('wires an injectable application', async () => {
    const application = createApplication({ config: testConfig() });
    expect(application.registry.list()).toHaveLength(1);
    await application.http.close();
  });
});
