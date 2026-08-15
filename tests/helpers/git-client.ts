import type { GitClient, GitRunOptions, GitRunResult } from '../../src/services/git-exec.js';

export type FakeHandler = (
  options: GitRunOptions,
) => Promise<GitRunResult | string> | GitRunResult | string;

/** Minimal in-memory Git client for tests that must not touch the filesystem. */
export const fakeGitClient = (handler: FakeHandler, version = '2.49.0'): GitClient => ({
  async run(options) {
    const result = await handler(options);
    return typeof result === 'string' ? { stdout: result, exitCode: 0 } : result;
  },
  probe: () => Promise.resolve({ executable: '/usr/bin/git', version }),
  stats: () => ({ active: 0, queued: 0 }),
  close: () => Promise.resolve(),
});

export const emptyGitClient = (topLevel = process.cwd()): GitClient =>
  fakeGitClient((options) => {
    if (options.args.includes('--is-bare-repository')) return `false\n${topLevel}/.git\n`;
    if (options.args.includes('--show-toplevel')) return `${topLevel}\n`;
    return '';
  });
