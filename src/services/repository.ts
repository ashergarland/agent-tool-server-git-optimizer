import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AppError, badRequest, forbidden, notReady } from '@agent-tool-platform/runtime/errors';
import { RootBoundary } from '@agent-tool-platform/runtime/fs';
import type { GitConfig } from '../config/index.js';
import type { GitClient } from './git-exec.js';

export interface ResolvedRepository {
  readonly path: string;
  readonly root: string;
  readonly bare: boolean;
}

const hasControlCharacters = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });

interface ResolvedRoot {
  readonly path: string;
  readonly boundary: RootBoundary;
}

interface ConfiguredRoot {
  readonly path: string;
  readonly boundary: RootBoundary;
}

interface LexicalRoot extends ConfiguredRoot {
  readonly relativeInput: string;
}

const relativeWithin = (root: string, requested: string): string | undefined => {
  const fromRoot = relative(resolve(root), resolve(requested));
  if (fromRoot === '') return '.';
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return fromRoot;
};

export class RepositoryBoundary {
  private readonly configuredRoots: readonly ConfiguredRoot[];

  public constructor(
    private readonly config: GitConfig,
    private readonly git: GitClient,
  ) {
    this.configuredRoots = config.git.allowedRoots.map((root) => ({
      path: root,
      boundary: new RootBoundary({ root, allowRoot: true }),
    }));
  }

  public async roots(): Promise<readonly string[]> {
    if (this.configuredRoots.length === 0) {
      throw notReady('No readable repository root is configured');
    }
    const roots = await this.resolvedRoots();
    if (roots.length === 0) {
      throw notReady('No configured repository root is readable');
    }
    return roots.map(({ path }) => path);
  }

  public async resolveRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRepository> {
    if (this.configuredRoots.length === 0) {
      throw notReady(
        'No readable repository root is configured; run locally over stdio or configure GIT_ALLOWED_ROOTS',
      );
    }
    if (hasControlCharacters(repositoryPath)) {
      throw badRequest('repositoryPath contains unsupported control characters');
    }

    const requested = resolve(this.config.git.baseDirectory, repositoryPath);
    const lexicalRoots = this.configuredRoots
      .map((configured): LexicalRoot | undefined => {
        const relativeInput = relativeWithin(configured.path, requested);
        return relativeInput === undefined ? undefined : { ...configured, relativeInput };
      })
      .filter((root): root is LexicalRoot => root !== undefined);
    if (lexicalRoots.length === 0) {
      throw forbidden('repositoryPath is outside the configured repository roots');
    }

    let candidate: Awaited<ReturnType<RootBoundary['resolve']>> | undefined;
    for (const lexicalRoot of lexicalRoots) {
      try {
        candidate = await lexicalRoot.boundary.resolve(lexicalRoot.relativeInput);
        break;
      } catch (error) {
        if (error instanceof AppError && error.code === 'not_ready') continue;
        throw error;
      }
    }
    if (!candidate) {
      throw notReady('No readable repository root contains the requested path');
    }
    const candidateStat = await stat(candidate.realPath);
    if (!candidateStat.isDirectory()) {
      throw badRequest('repositoryPath must be a directory containing a Git repository');
    }

    const layout = await this.git.run({
      cwd: candidate.realPath,
      args: [
        'rev-parse',
        '--is-bare-repository',
        '--absolute-git-dir',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      signal,
    });
    const [bareFlag = 'false', gitDirectory = '', commonDirectory = ''] = layout.stdout
      .split('\n')
      .map((line) => line.trim());
    const bare = bareFlag === 'true';
    if (!gitDirectory || !commonDirectory) {
      throw badRequest('The requested path is not a readable Git repository');
    }

    const roots = await this.resolvedRoots();
    await this.resolveRepositoryDirectory(resolve(candidate.realPath, gitDirectory), roots);
    await this.resolveRepositoryDirectory(resolve(candidate.realPath, commonDirectory), roots);

    let top = gitDirectory;
    if (!bare) {
      const topLevel = await this.git.run({
        cwd: candidate.realPath,
        args: ['rev-parse', '--show-toplevel'],
        signal,
      });
      top = topLevel.stdout.trim();
    }
    if (!top) throw badRequest('The requested path is not a readable Git repository');

    const canonicalTop = await this.resolveKnownPath(resolve(top), await this.resolvedRoots());
    const topStat = await stat(canonicalTop.realPath);
    if (!topStat.isDirectory()) {
      throw badRequest('The requested path is not a readable Git repository');
    }
    return {
      path: canonicalTop.realPath,
      root: canonicalTop.root,
      bare,
    };
  }

  private async resolvedRoots(): Promise<readonly ResolvedRoot[]> {
    const settled = await Promise.allSettled(
      this.configuredRoots.map(async ({ boundary }) => ({
        path: await boundary.root(),
        boundary,
      })),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  private async resolveKnownPath(
    requested: string,
    roots: readonly ResolvedRoot[],
  ): Promise<{ readonly realPath: string; readonly root: string }> {
    const owner = roots.find(({ path, boundary }) => boundary.isWithin(path, requested, true));
    if (!owner) {
      throw forbidden('The resolved Git repository lies outside the configured repository roots');
    }
    const relativeInput = owner.boundary.formatRelative(owner.path, requested);
    const resolved = await owner.boundary.resolve(relativeInput);
    return { realPath: resolved.realPath, root: owner.path };
  }

  private async resolveRepositoryDirectory(
    requested: string,
    roots: readonly ResolvedRoot[],
  ): Promise<void> {
    const resolved = await this.resolveKnownPath(requested, roots);
    if (!(await stat(resolved.realPath)).isDirectory()) {
      throw badRequest('The requested path is not a readable Git repository');
    }
  }
}
