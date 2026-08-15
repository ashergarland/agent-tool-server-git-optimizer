import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AppConfig } from '../config/index.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { GitClient } from './git-exec.js';

export interface ResolvedRepository {
  /** Canonical directory Git commands run from. */
  readonly path: string;
  /** Canonical allowed root that contains the repository. */
  readonly root: string;
  readonly bare: boolean;
}

/** True when `target` is `root` or lives beneath it, without treating `..` as containment. */
export const isWithin = (root: string, target: string): boolean => {
  const step = relative(root, target);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
};

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });

export class RepositoryBoundary {
  private canonicalRoots: Promise<readonly string[]> | undefined;

  public constructor(
    private readonly config: AppConfig,
    private readonly git: GitClient,
  ) {}

  /** Canonical allowed roots, re-resolved whenever resolution previously failed. */
  public roots(): Promise<readonly string[]> {
    this.canonicalRoots ??= this.resolveRoots().catch((error: unknown) => {
      this.canonicalRoots = undefined;
      throw error;
    });
    return this.canonicalRoots;
  }

  /**
   * Confines a caller-supplied path to the configured roots. The lexical check runs before any
   * filesystem access so an out-of-bounds path cannot be used to probe the host, and the
   * canonical repository top level is re-checked so Git cannot walk upwards past a root.
   */
  public async resolveRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRepository> {
    if (this.config.git.allowedRoots.length === 0) {
      throw forbidden(
        'This deployment has no readable repository root; configure GIT_ALLOWED_ROOTS or run locally over stdio',
      );
    }
    if (hasControlCharacters(repositoryPath)) {
      throw badRequest('repositoryPath contains unsupported control characters');
    }

    const requested = resolve(this.config.git.baseDirectory, repositoryPath);
    if (!this.config.git.allowedRoots.some((root) => isWithin(root, requested))) {
      throw forbidden('repositoryPath is outside the configured repository roots');
    }

    const canonicalRoots = await this.roots();
    const candidate = await realpath(requested).catch(() => {
      throw notFound('repositoryPath does not exist or is not readable');
    });
    if (!canonicalRoots.some((root) => isWithin(root, candidate))) {
      throw forbidden('repositoryPath resolves outside the configured repository roots');
    }

    const layout = await this.git.run({
      cwd: candidate,
      args: ['rev-parse', '--is-bare-repository', '--absolute-git-dir'],
      allowFailure: false,
      signal,
    });
    const [bareFlag = 'false', gitDirectory = ''] = layout.stdout.split('\n').map((l) => l.trim());
    const bare = bareFlag === 'true';

    let top = gitDirectory;
    if (!bare) {
      const topLevel = await this.git.run({
        cwd: candidate,
        args: ['rev-parse', '--show-toplevel'],
        allowFailure: false,
        signal,
      });
      top = topLevel.stdout.trim();
    }
    if (!top) throw badRequest('The requested path is not a readable Git repository');

    const canonicalTop = await realpath(resolve(top)).catch(() => {
      throw badRequest('The requested path is not a readable Git repository');
    });
    const root = canonicalRoots.find((entry) => isWithin(entry, canonicalTop));
    if (!root) {
      throw forbidden('The resolved Git repository lies outside the configured repository roots');
    }
    return { path: canonicalTop, root, bare };
  }

  private async resolveRoots(): Promise<readonly string[]> {
    const resolved: string[] = [];
    for (const root of this.config.git.allowedRoots) {
      const canonical = await realpath(root).catch(() => undefined);
      if (canonical) resolved.push(canonical);
    }
    if (resolved.length === 0) {
      throw forbidden('No configured repository root is currently readable');
    }
    return resolved;
  }
}
