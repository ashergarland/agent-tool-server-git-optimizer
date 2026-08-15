import { access, constants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AppConfig } from '../config/index.js';
import { createGitClient, type GitClient } from './git-exec.js';
import { GitService } from './git.js';
import { RepositoryBoundary } from './repository.js';

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: readonly ReadinessCheck[];
  readonly gitVersion: string | undefined;
}

export interface Services {
  readonly git: GitService;
  readonly gitClient: GitClient;
  readonly boundary: RepositoryBoundary;
  readiness(): Promise<ReadinessReport>;
  close(): Promise<void>;
}

export interface CreateServicesOptions {
  /** Injected Git client used by tests and by alternative execution strategies. */
  readonly gitClient?: GitClient;
}

const check = (name: string, ok: boolean, detail: string): ReadinessCheck => ({ name, ok, detail });

export const createServices = (
  config: AppConfig,
  options: CreateServicesOptions = {},
): Services => {
  const gitClient = options.gitClient ?? createGitClient(config);
  const boundary = new RepositoryBoundary(config, gitClient);
  const git = new GitService(config, boundary, gitClient, config.git.noise);

  const readiness = async (): Promise<ReadinessReport> => {
    const checks: ReadinessCheck[] = [];
    let gitVersion: string | undefined;

    try {
      const probe = await gitClient.probe();
      gitVersion = probe.version;
      checks.push(check('git', true, `git ${probe.version}`));
    } catch {
      checks.push(check('git', false, 'A usable Git executable was not found'));
    }

    try {
      await access(tmpdir(), constants.W_OK);
      checks.push(check('temp', true, 'Temporary directory is writable'));
    } catch {
      checks.push(check('temp', false, 'Temporary directory is not writable'));
    }

    if (config.git.allowedRoots.length === 0) {
      checks.push(
        check(
          'repositoryRoots',
          false,
          'No repository root is configured; mount a read-only repository source and set GIT_ALLOWED_ROOTS',
        ),
      );
    } else {
      try {
        const roots = await boundary.roots();
        checks.push(check('repositoryRoots', true, `${roots.length} readable root(s)`));
      } catch {
        checks.push(check('repositoryRoots', false, 'No configured repository root is readable'));
      }
    }

    return { ready: checks.every((entry) => entry.ok), checks, gitVersion };
  };

  return {
    git,
    gitClient,
    boundary,
    readiness,
    close: () => gitClient.close(),
  };
};
