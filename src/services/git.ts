import type { AppConfig } from '../config/index.js';
import { badRequest } from '../errors.js';
import type { GitClient } from './git-exec.js';
import type { RepositoryBoundary } from './repository.js';

export type WhitespaceMode = 'preserve' | 'ignore-eol';

export type ChangeKind = 'Added' | 'Deleted' | 'Modified';

export interface FileSummary {
  readonly path: string;
  readonly change: ChangeKind;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly details: string;
}

export interface DiffSummary {
  readonly summary: string;
  readonly files: FileSummary[];
  readonly ignoredFiles: string[];
  readonly totalFiles: number;
  readonly returnedFiles: number;
  readonly ignoredFileCount: number;
  readonly truncated: boolean;
  readonly warnings: string[];
  readonly baseCommit: string;
  readonly targetCommit: string;
}

export interface SummarizeCommitDiffInput {
  readonly repositoryPath: string;
  readonly baseRef?: string | undefined;
  readonly targetRef: string;
  readonly maxFiles?: number | undefined;
  readonly whitespace: WhitespaceMode;
}

export interface SummarizeOptions {
  readonly signal?: AbortSignal | undefined;
}

/** Empty tree object per hash algorithm, used only for proven root commits. */
const emptyTreeByFormat: Readonly<Record<string, string>> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

const defaultLockfiles: readonly string[] = [
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'Podfile.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'flake.lock',
  'go.sum',
  'gradle.lockfile',
  'mix.lock',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'packages.lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pubspec.lock',
  'uv.lock',
  'yarn.lock',
];

/**
 * Only unambiguously generated directories are filtered by default. Names such as `dist` or
 * `build` are legitimate source directories in many projects and must be opted into.
 */
const defaultIgnoredDirectories: readonly string[] = ['node_modules'];

const generatedAsset =
  /(?:\.map|\.min\.(?:css|js)|\.(?:gif|ico|jpe?g|pdf|png|svg|webp|woff2?|ttf|eot))$/iu;

const refSyntax = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}+-]*$/u;
const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** Paths Git reports unquoted and that are safe to echo back as literal pathspecs. */
const isPlainPath = (path: string): boolean =>
  path.length > 0 &&
  ![...path].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 32 || code === 127 || character === '"' || character === '\\';
  });

const isSafeRef = (ref: string): boolean =>
  ref.length <= 255 && refSyntax.test(ref) && !ref.includes('..') && !ref.endsWith('.lock');

/** Renders a repository-relative path without control characters or unbounded length. */
const displayPath = (path: string, maxLength: number): string => {
  const escaped = [...path]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? `\\x${code.toString(16).padStart(2, '0')}` : character;
    })
    .join('');
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength - 1)}…` : escaped;
};

interface StatusEntry {
  readonly path: string;
  readonly change: ChangeKind;
}

const changeFor = (status: string): ChangeKind => {
  switch (status[0]) {
    case 'A': {
      return 'Added';
    }
    case 'D': {
      return 'Deleted';
    }
    default: {
      return 'Modified';
    }
  }
};

/** Parses `--name-status -z`, where renames and copies carry two NUL-separated paths. */
export const parseNameStatus = (output: string): StatusEntry[] => {
  const tokens = output.split('\0');
  const entries: StatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status) continue;
    const letter = status[0] ?? 'M';
    const first = tokens[index++];
    if (!first) break;
    if (letter === 'R' || letter === 'C') {
      const destination = tokens[index++];
      if (!destination) break;
      entries.push({ path: destination, change: 'Modified' });
      continue;
    }
    entries.push({ path: first, change: changeFor(status) });
  }
  return entries;
};

export interface NumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** Parses `--numstat -z`; a rename emits an empty path field followed by source and destination. */
export const parseNumstat = (output: string): Map<string, NumstatEntry> => {
  const tokens = output.split('\0');
  const stats = new Map<string, NumstatEntry>();
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index++];
    if (!record) continue;
    const [added = '', deleted = '', ...rest] = record.split('\t');
    let path = rest.join('\t');
    if (path === '') {
      const source = tokens[index++];
      const destination = tokens[index++];
      if (!source || !destination) break;
      path = destination;
    }
    const binary = added === '-' || deleted === '-';
    stats.set(path, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return stats;
};

/**
 * Best-effort symbol names taken from hunk headers. Git derives them from language heuristics,
 * so they are advisory context rather than a reliable list of changed definitions.
 */
export const symbolsByFile = (patch: string): Map<string, readonly string[]> => {
  const names = new Map<string, Set<string>>();
  let path: string | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      path = target.startsWith('b/') ? target.slice(2) : undefined;
      continue;
    }
    if (!path || !line.startsWith('@@')) continue;
    const context = /^@@.*?@@\s*(.+)$/u.exec(line)?.[1]?.trim();
    if (!context) continue;
    const candidate =
      /(?:function|class|interface|type|struct|enum|def|fn)\s+([A-Za-z_$][\w$]*)/u.exec(
        context,
      )?.[1] ?? /([A-Za-z_$][\w$]*)\s*\([^)]*\)/u.exec(context)?.[1];
    if (!candidate) continue;
    const fileNames = names.get(path) ?? new Set<string>();
    fileNames.add(candidate);
    names.set(path, fileNames);
  }
  return new Map([...names].map(([file, values]) => [file, [...values].slice(0, 3)]));
};

const countLabel = (additions: number, deletions: number): string =>
  `${additions} addition${additions === 1 ? '' : 's'}, ${deletions} deletion${
    deletions === 1 ? '' : 's'
  }`;

export class GitService {
  private readonly lockfiles: ReadonlySet<string>;
  private readonly ignoredDirectories: ReadonlySet<string>;

  public constructor(
    private readonly config: AppConfig,
    private readonly boundary: RepositoryBoundary,
    private readonly client: GitClient,
    noise: { basenames?: readonly string[]; directories?: readonly string[] } = {},
  ) {
    this.lockfiles = new Set([...defaultLockfiles, ...(noise.basenames ?? [])]);
    this.ignoredDirectories = new Set(
      [...defaultIgnoredDirectories, ...(noise.directories ?? [])].map((entry) =>
        entry.toLowerCase(),
      ),
    );
  }

  public async summarizeCommitDiff(
    input: SummarizeCommitDiffInput,
    options: SummarizeOptions = {},
  ): Promise<DiffSummary> {
    const limits = this.config.git.limits;
    const warnings: string[] = [];
    const { signal } = options;

    if (!isSafeRef(input.targetRef) || (input.baseRef !== undefined && !isSafeRef(input.baseRef))) {
      throw badRequest('Git references contain unsupported syntax');
    }

    const repository = await this.boundary.resolveRepository(input.repositoryPath, signal);
    const cwd = repository.path;

    const targetCommit = await this.resolveCommit(cwd, input.targetRef, signal);
    const baseCommit = input.baseRef
      ? await this.resolveCommit(cwd, input.baseRef, signal)
      : await this.parentOrEmptyTree(cwd, targetCommit, warnings, signal);

    const diffFlags = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--no-renames',
      ...(input.whitespace === 'ignore-eol' ? ['--ignore-space-at-eol'] : []),
    ];
    const range = ['--end-of-options', baseCommit, targetCommit, '--'];

    const [statusOutput, statsOutput] = await Promise.all([
      this.client.run({ cwd, args: [...diffFlags, '--name-status', '-z', ...range], signal }),
      this.client.run({ cwd, args: [...diffFlags, '--numstat', '-z', ...range], signal }),
    ]);

    const statuses = parseNameStatus(statusOutput.stdout);
    const stats = parseNumstat(statsOutput.stdout);

    const ignored = statuses.filter(({ path }) => this.isIgnored(path));
    const retainedAll = statuses.filter(({ path }) => !this.isIgnored(path));

    const requestedMax = Math.min(input.maxFiles ?? limits.maxFiles, limits.maxFiles);
    const retained = retainedAll.slice(0, requestedMax);
    const truncated = retained.length < retainedAll.length;
    if (truncated) {
      warnings.push(
        `Only the first ${retained.length} of ${retainedAll.length} changed files were analyzed; raise maxFiles or narrow the comparison.`,
      );
    }
    if (ignored.length > 0) {
      warnings.push(
        `${ignored.length} lockfile or generated-asset change${ignored.length === 1 ? ' was' : 's were'} filtered and not reviewed.`,
      );
    }

    const symbols = await this.symbolsFor(cwd, diffFlags, range, retained, warnings, signal);

    const files = retained.map(({ path, change }) => {
      const counts = stats.get(path) ?? { additions: 0, deletions: 0, binary: false };
      const names = symbols.get(path) ?? [];
      const label = counts.binary
        ? 'binary content changed'
        : countLabel(counts.additions, counts.deletions);
      return {
        path: displayPath(path, limits.maxPathLength),
        change,
        additions: counts.additions,
        deletions: counts.deletions,
        binary: counts.binary,
        details: names.length > 0 ? `Changed ${names.join(', ')} (${label})` : `Updated ${label}`,
      } satisfies FileSummary;
    });

    const summaryText =
      files.length === 0
        ? 'No reviewable changes between the requested commits.'
        : files.map((file) => `[${file.change} ${file.path}: ${file.details}]`).join('\n');
    const summary =
      summaryText.length > limits.maxSummaryLength
        ? `${summaryText.slice(0, limits.maxSummaryLength - 1)}…`
        : summaryText;

    return {
      summary,
      files,
      ignoredFiles: ignored
        .slice(0, limits.maxIgnoredFiles)
        .map(({ path }) => displayPath(path, limits.maxPathLength)),
      totalFiles: retainedAll.length,
      returnedFiles: files.length,
      ignoredFileCount: ignored.length,
      truncated,
      warnings,
      baseCommit,
      targetCommit,
    };
  }

  private isIgnored(path: string): boolean {
    const parts = path.split('/');
    const basename = parts.at(-1) ?? path;
    return (
      this.lockfiles.has(basename) ||
      parts.some((part) => this.ignoredDirectories.has(part.toLowerCase())) ||
      generatedAsset.test(basename)
    );
  }

  /** Resolves a caller reference to a commit object id, rejecting non-commit references. */
  private async resolveCommit(
    cwd: string,
    ref: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.client.run({
      cwd,
      args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
      allowFailure: true,
      signal,
    });
    const oid = result.stdout.trim();
    if (result.exitCode !== 0 || !objectId.test(oid)) {
      throw badRequest('The requested Git reference does not resolve to a commit');
    }
    return oid;
  }

  /** Uses the first parent, falling back to the empty tree only for a proven root commit. */
  private async parentOrEmptyTree(
    cwd: string,
    targetCommit: string,
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const result = await this.client.run({
      cwd,
      args: ['rev-list', '--parents', '--max-count=1', '--end-of-options', targetCommit],
      signal,
    });
    const [, ...parents] = result.stdout.trim().split(/\s+/u).filter(Boolean);
    const first = parents[0];
    if (first && objectId.test(first)) return first;

    const format = await this.client.run({
      cwd,
      args: ['rev-parse', '--show-object-format'],
      signal,
    });
    const emptyTree = emptyTreeByFormat[format.stdout.trim()];
    if (!emptyTree) {
      throw badRequest('This repository uses an unsupported object format for root commits');
    }
    warnings.push('targetRef is a root commit; it was compared against the empty tree.');
    return emptyTree;
  }

  /**
   * Collects hunk-header symbols for the retained subset only. Paths that Git would quote are
   * skipped so a crafted filename can never be reinterpreted as an option or pathspec.
   */
  private async symbolsFor(
    cwd: string,
    diffFlags: readonly string[],
    range: readonly string[],
    retained: readonly StatusEntry[],
    warnings: string[],
    signal: AbortSignal | undefined,
  ): Promise<Map<string, readonly string[]>> {
    if (retained.length === 0) return new Map();
    const limits = this.config.git.limits;
    const budget = Math.floor(limits.maxArgumentBytes / 2);
    const pathspecs: string[] = [];
    let used = 0;
    let skipped = 0;
    for (const { path } of retained) {
      const size = Buffer.byteLength(path) + 1;
      if (!isPlainPath(path) || used + size > budget) {
        skipped += 1;
        continue;
      }
      pathspecs.push(path);
      used += size;
    }
    if (skipped > 0) {
      warnings.push(
        `Symbol context was skipped for ${skipped} file${skipped === 1 ? '' : 's'} with unusual or oversized paths.`,
      );
    }
    if (pathspecs.length === 0) return new Map();

    try {
      const patch = await this.client.run({
        cwd,
        args: [...diffFlags, '--unified=0', ...range, ...pathspecs],
        maxBufferBytes: limits.maxPatchBytes,
        signal,
      });
      return symbolsByFile(patch.stdout);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'limit_exceeded') {
        warnings.push(
          'The diff was too large to extract symbol context; per-file counts are still exact.',
        );
        return new Map();
      }
      throw error;
    }
  }
}
