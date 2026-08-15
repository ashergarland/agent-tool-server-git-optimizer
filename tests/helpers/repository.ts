import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const fixtureEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(tmpdir(), 'agent-tool-server-missing-gitconfig'),
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2024-01-01T00:00:00+0000',
  GIT_COMMITTER_DATE: '2024-01-01T00:00:00+0000',
};

const created: string[] = [];

/** Temporary directory resolved through realpath so macOS `/var` symlinks do not skew assertions. */
export const temporaryDirectory = async (prefix = 'ato-fixture-'): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  created.push(directory);
  return directory;
};

export const removeTemporaryDirectories = async (): Promise<void> => {
  await Promise.all(
    created.splice(0).map((directory) =>
      // A cancelled Git child can still hold a handle briefly on Windows.
      rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => undefined,
      ),
    ),
  );
};

export class TestRepository {
  public constructor(public readonly path: string) {}

  public async git(...args: string[]): Promise<string> {
    const { stdout } = await exec('git', args, { cwd: this.path, env: fixtureEnvironment });
    return stdout;
  }

  public async write(relativePath: string, contents: string): Promise<void> {
    const target = join(this.path, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, 'utf8');
  }

  public async commit(message: string): Promise<string> {
    await this.git('add', '--all');
    await this.git('commit', '--no-gpg-sign', '--message', message);
    return (await this.git('rev-parse', 'HEAD')).trim();
  }

  public async head(): Promise<string> {
    return (await this.git('rev-parse', 'HEAD')).trim();
  }
}

export const initRepository = async (path: string): Promise<TestRepository> => {
  await mkdir(path, { recursive: true });
  const repository = new TestRepository(path);
  await repository.git('init', '--quiet', '--initial-branch', 'main');
  await repository.git('config', 'commit.gpgsign', 'false');
  return repository;
};

/** A repository with one root commit and one follow-up commit touching source and noise files. */
export const seedRepository = async (
  repository: TestRepository,
): Promise<{ root: string; head: string }> => {
  await repository.write('src/app.ts', 'export const value = 1;\n');
  await repository.write('README.md', 'seed\n');
  const root = await repository.commit('root');

  await repository.write('src/app.ts', 'export function value(): number {\n  return 2;\n}\n');
  await repository.write('package-lock.json', '{"lockfileVersion": 3}\n');
  await repository.write('assets/logo.png', 'not really a png\n');
  const head = await repository.commit('change');
  return { root, head };
};
