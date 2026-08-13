import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError, badRequest } from '../errors.js';

const execFileAsync = promisify(execFile);
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const lockfiles = new Set(['package-lock.json', 'pnpm-lock.yaml']);
const generatedSegments = new Set(['build', 'coverage', 'dist', 'generated', 'out', 'vendor']);
const generatedAsset =
  /(?:\.map|\.min\.(?:css|js)|\.(?:gif|ico|jpe?g|pdf|png|svg|webp|woff2?|ttf))$/i;
const safeRef = /^(?!-)[A-Za-z0-9./_@~^+-]+$/;
const operationalGitErrorCodes = new Set(['EACCES', 'EAGAIN', 'EMFILE', 'ENOENT', 'ENOMEM']);

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isOperationalGitFailure = (error: unknown): boolean => {
  if (!isObjectRecord(error)) return false;
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code && operationalGitErrorCodes.has(code)) return true;
  const signal = typeof error.signal === 'string' ? error.signal : undefined;
  const killed = error.killed === true;
  return killed || signal === 'SIGTERM';
};

const toGitExecutionError = (error: unknown): AppError => {
  if (isOperationalGitFailure(error)) {
    return new AppError('internal_error', 'Unable to read the requested Git diff');
  }
  const details =
    isObjectRecord(error) && typeof error.stderr === 'string' && error.stderr.trim().length > 0
      ? error.stderr.trim()
      : undefined;
  return badRequest('Unable to read the requested Git diff', details ? { git: details } : undefined);
};

export interface DiffSummary {
  readonly summary: string;
  readonly files: FileSummary[];
  readonly ignoredFiles: string[];
}

export interface FileSummary {
  readonly path: string;
  readonly change: 'Added' | 'Deleted' | 'Modified';
  readonly additions: number;
  readonly deletions: number;
  readonly details: string;
}

export type GitRunner = (arguments_: readonly string[], cwd: string) => Promise<string>;

const runGit: GitRunner = async (arguments_, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', arguments_, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout;
  } catch (error) {
    throw toGitExecutionError(error);
  }
};

const isIgnored = (path: string): boolean => {
  const parts = path.split('/');
  const basename = parts.at(-1) ?? path;
  return (
    lockfiles.has(basename) ||
    parts.some((part) => generatedSegments.has(part.toLowerCase())) ||
    generatedAsset.test(basename)
  );
};

const isSafeRef = (ref: string): boolean =>
  safeRef.test(ref) && ![...ref].some((character) => character.charCodeAt(0) < 32);

const parseNameStatus = (output: string): { path: string; change: FileSummary['change'] }[] =>
  output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status = 'M', firstPath = '', renamedPath] = line.split('\t');
      const path = renamedPath ?? firstPath;
      const change = status[0] === 'A' ? 'Added' : status[0] === 'D' ? 'Deleted' : 'Modified';
      return { path, change };
    });

const parseNumstat = (output: string): Map<string, { additions: number; deletions: number }> => {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [added = '0', deleted = '0', path = ''] = line.split('\t');
    stats.set(path, {
      additions: added === '-' ? 0 : Number(added),
      deletions: deleted === '-' ? 0 : Number(deleted),
    });
  }
  return stats;
};

const functionNamesByFile = (patch: string): Map<string, readonly string[]> => {
  const names = new Map<string, Set<string>>();
  let path: string | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ b/')) {
      path = line.slice(6);
      continue;
    }
    if (!path || !line.startsWith('@@')) continue;
    const context = line.match(/^@@.*?@@\s*(.+)$/)?.[1]?.trim();
    if (!context) continue;
    const candidate =
      context.match(/(?:function|class|interface|type)\s+([A-Za-z_$][\w$]*)/)?.[1] ??
      context.match(/([A-Za-z_$][\w$]*)\s*\([^)]*\)/)?.[1];
    if (!candidate) continue;
    const fileNames = names.get(path) ?? new Set<string>();
    fileNames.add(candidate);
    names.set(path, fileNames);
  }
  return new Map([...names].map(([file, values]) => [file, [...values].slice(0, 3)]));
};

const detailFor = (names: readonly string[], additions: number, deletions: number): string => {
  const lines = `${additions} addition${additions === 1 ? '' : 's'}, ${deletions} deletion${
    deletions === 1 ? '' : 's'
  }`;
  return names.length > 0 ? `Changed ${names.join(', ')} (${lines})` : `Updated ${lines}`;
};

export class GitService {
  public constructor(private readonly runner: GitRunner = runGit) {}

  public async summarizeCommitDiff(input: {
    repositoryPath: string;
    baseRef?: string | undefined;
    targetRef: string;
  }): Promise<DiffSummary> {
    if (!isSafeRef(input.targetRef) || (input.baseRef && !isSafeRef(input.baseRef))) {
      throw badRequest('Git references contain unsupported characters');
    }

    let baseRef = input.baseRef;
    if (!baseRef) {
      try {
        baseRef = (
          await this.runner(
            ['rev-parse', '--verify', '--end-of-options', `${input.targetRef}^`],
            input.repositoryPath,
          )
        ).trim();
      } catch {
        baseRef = emptyTree;
      }
    }

    const diffArguments = [
      'diff',
      '--no-ext-diff',
      '--no-color',
      '--ignore-all-space',
      '--no-renames',
    ] as const;
    const rangeArguments = [baseRef, input.targetRef, '--'] as const;
    const [statusOutput, statsOutput] = await Promise.all([
      this.runner([...diffArguments, '--name-status', ...rangeArguments], input.repositoryPath),
      this.runner([...diffArguments, '--numstat', ...rangeArguments], input.repositoryPath),
    ]);
    const statuses = parseNameStatus(statusOutput);
    const ignoredFiles = statuses.filter(({ path }) => isIgnored(path)).map(({ path }) => path);
    const retained = statuses.filter(({ path }) => !isIgnored(path));
    const stats = parseNumstat(statsOutput);
    const patch =
      retained.length === 0
        ? ''
        : await this.runner(
            [
              ...diffArguments,
              '--unified=0',
              ...rangeArguments,
              ...retained.map(({ path }) => path),
            ],
            input.repositoryPath,
          );
    const names = functionNamesByFile(patch);
    const files = retained.map(({ path, change }) => {
      const counts = stats.get(path) ?? { additions: 0, deletions: 0 };
      return {
        path,
        change,
        ...counts,
        details: detailFor(names.get(path) ?? [], counts.additions, counts.deletions),
      };
    });
    return {
      summary:
        files.length === 0
          ? 'No relevant changes.'
          : files.map((file) => `[${file.change} ${file.path}: ${file.details}]`).join('\n'),
      files,
      ignoredFiles,
    };
  }
}
