import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  AppError,
  badRequest,
  forbidden,
  limitExceeded,
  notReady,
} from '@agent-tool-platform/runtime/errors';
import { RootBoundary, type ConfinedOpenedFile } from '@agent-tool-platform/runtime/fs';
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
  readonly alternateFileBoundary: RootBoundary;
}

interface ConfiguredRoot {
  readonly path: string;
  readonly boundary: RootBoundary;
  readonly alternateFileBoundary: RootBoundary;
}

interface LexicalRoot extends ConfiguredRoot {
  readonly relativeInput: string;
}

interface ResolvedObjectDatabase {
  readonly path: string;
  readonly owner: ResolvedRoot;
  readonly identity: string;
}

interface PendingObjectDatabase extends ResolvedObjectDatabase {
  readonly depth: number;
}

interface ObjectPathBudget {
  remainingComponents: number;
}

const maxAlternateFileBytes = 64 * 1024;
const maxAlternateEntries = 256;
const maxObjectDatabases = 128;
const maxAlternateDepth = 6;
const maxObjectPathComponents = 128;
const maxObjectPathResolutionComponents = 1024;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const invalidAlternateConfiguration = () =>
  badRequest('The repository has invalid alternate object database configuration');

const alternateLimitExceeded = () =>
  limitExceeded('The repository alternate object database graph exceeds the supported limit');

const relativeWithin = (root: string, requested: string): string | undefined => {
  const fromRoot = relative(resolve(root), resolve(requested));
  if (fromRoot === '') return '.';
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return undefined;
  }
  return fromRoot;
};

const decodeAlternatePath = (bytes: Uint8Array): string => {
  if (bytes.includes(0)) throw invalidAlternateConfiguration();
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw invalidAlternateConfiguration();
  }
};

const decodeQuotedAlternatePath = (raw: Buffer): string => {
  const decoded: number[] = [];
  let index = 1;

  while (index < raw.length) {
    const byte = raw[index];
    index += 1;
    if (byte === undefined) throw invalidAlternateConfiguration();
    if (byte === 0x22) {
      if (index !== raw.length) throw invalidAlternateConfiguration();
      return decodeAlternatePath(Uint8Array.from(decoded));
    }
    if (byte !== 0x5c) {
      decoded.push(byte);
      continue;
    }

    const escaped = raw[index];
    index += 1;
    switch (escaped) {
      case 0x61:
        decoded.push(0x07);
        break;
      case 0x62:
        decoded.push(0x08);
        break;
      case 0x74:
        decoded.push(0x09);
        break;
      case 0x6e:
        decoded.push(0x0a);
        break;
      case 0x76:
        decoded.push(0x0b);
        break;
      case 0x66:
        decoded.push(0x0c);
        break;
      case 0x72:
        decoded.push(0x0d);
        break;
      case 0x22:
      case 0x5c:
        decoded.push(escaped);
        break;
      default: {
        const second = raw[index];
        const third = raw[index + 1];
        if (
          escaped === undefined ||
          escaped < 0x30 ||
          escaped > 0x33 ||
          second === undefined ||
          second < 0x30 ||
          second > 0x37 ||
          third === undefined ||
          third < 0x30 ||
          third > 0x37
        ) {
          throw invalidAlternateConfiguration();
        }
        decoded.push((escaped - 0x30) * 64 + (second - 0x30) * 8 + (third - 0x30));
        index += 2;
      }
    }
  }

  throw invalidAlternateConfiguration();
};

const parseAlternateObjectDirectories = (contents: Buffer): readonly string[] => {
  const entries: string[] = [];
  let start = 0;

  while (start <= contents.length) {
    const newline = contents.indexOf(0x0a, start);
    const end = newline === -1 ? contents.length : newline;
    const raw = contents.subarray(start, end);
    if (raw.length > 0 && raw[0] !== 0x23) {
      const entry = raw[0] === 0x22 ? decodeQuotedAlternatePath(raw) : decodeAlternatePath(raw);
      if (entry.length > 0) {
        entries.push(entry);
        if (entries.length > maxAlternateEntries) throw alternateLimitExceeded();
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }

  return entries;
};

const pathComponents = (path: string): readonly string[] =>
  path.split(process.platform === 'win32' ? /[\\/]+/u : /\/+/u);

const resolveExistingDirectory = async (path: string): Promise<string> => {
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw invalidAlternateConfiguration();
  }

  let metadata;
  try {
    metadata = await stat(canonical);
  } catch {
    throw invalidAlternateConfiguration();
  }
  if (!metadata.isDirectory()) throw invalidAlternateConfiguration();
  return canonical;
};

const resolveGitObjectPath = async (
  baseDirectory: string,
  entry: string,
  budget: ObjectPathBudget,
  signal?: AbortSignal,
): Promise<string> => {
  signal?.throwIfAborted();
  if (process.platform === 'win32' && /^[a-zA-Z]:(?![\\/])/u.test(entry)) {
    throw invalidAlternateConfiguration();
  }

  const absolute = isAbsolute(entry);
  const root = absolute ? parse(entry).root : '';
  let current = absolute ? await resolveExistingDirectory(root) : baseDirectory;
  const components = pathComponents(absolute ? entry.slice(root.length) : entry).filter(
    (component) => component !== '' && component !== '.',
  );
  if (components.length > maxObjectPathComponents) throw alternateLimitExceeded();

  // Resolve one component at a time so symlink/../ ordering matches Git's realpath semantics.
  for (const component of components) {
    signal?.throwIfAborted();
    budget.remainingComponents -= 1;
    if (budget.remainingComponents < 0) throw alternateLimitExceeded();
    if (component === '..') {
      current = dirname(current);
      continue;
    }
    current = await resolveExistingDirectory(join(current, component));
  }
  return current;
};

const objectDatabaseIdentity = async (path: string): Promise<string> => {
  let metadata;
  try {
    metadata = await stat(path, { bigint: true });
  } catch {
    throw invalidAlternateConfiguration();
  }
  if (metadata.dev !== 0n && metadata.ino !== 0n) {
    return `inode:${metadata.dev}:${metadata.ino}`;
  }
  return `path:${process.platform === 'win32' ? path.toLowerCase() : path}`;
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
      alternateFileBoundary: new RootBoundary({
        root,
        allowRoot: true,
        requireRegularFile: true,
        maxFileBytes: maxAlternateFileBytes,
      }),
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
        '--git-path',
        'objects',
      ],
      signal,
    });
    const [bareFlag = 'false', gitDirectory = '', commonDirectory = '', objectDirectory = ''] =
      layout.stdout.split('\n').map((line) => line.trim());
    const bare = bareFlag === 'true';
    if (!gitDirectory || !commonDirectory || !objectDirectory || !isAbsolute(objectDirectory)) {
      throw badRequest('The requested path is not a readable Git repository');
    }

    const roots = await this.resolvedRoots();
    await this.resolveRepositoryDirectory(resolve(candidate.realPath, gitDirectory), roots);
    await this.resolveRepositoryDirectory(resolve(candidate.realPath, commonDirectory), roots);
    await this.validateObjectDatabaseGraph(objectDirectory, roots, signal);

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

    const canonicalTop = await this.resolveKnownPath(resolve(top), roots);
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
      this.configuredRoots.map(async ({ boundary, alternateFileBoundary }) => ({
        path: await boundary.root(),
        boundary,
        alternateFileBoundary,
      })),
    );
    return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  }

  private async validateObjectDatabaseGraph(
    primaryPath: string,
    roots: readonly ResolvedRoot[],
    signal?: AbortSignal,
  ): Promise<void> {
    const pathBudget: ObjectPathBudget = {
      remainingComponents: maxObjectPathResolutionComponents,
    };
    const primary = await this.resolveObjectDatabase(
      primaryPath,
      primaryPath,
      roots,
      pathBudget,
      signal,
    );
    const pending: PendingObjectDatabase[] = [{ ...primary, depth: 0 }];
    const visited = new Set([primary.identity]);
    const resolvedEntries = new Map<string, ResolvedObjectDatabase>();
    let declaredEntries = 0;

    for (let index = 0; index < pending.length; index += 1) {
      signal?.throwIfAborted();
      const current = pending[index];
      if (!current) break;
      const entries = await this.readAlternates(current, signal);
      declaredEntries += entries.length;
      if (declaredEntries > maxAlternateEntries) throw alternateLimitExceeded();
      if (current.depth >= maxAlternateDepth && entries.length > 0) {
        throw alternateLimitExceeded();
      }

      for (const entry of entries) {
        const cacheKey = `${current.path}\0${entry}`;
        let alternate = resolvedEntries.get(cacheKey);
        if (!alternate) {
          alternate = await this.resolveObjectDatabase(
            current.path,
            entry,
            roots,
            pathBudget,
            signal,
          );
          resolvedEntries.set(cacheKey, alternate);
        }
        if (visited.has(alternate.identity)) continue;
        if (visited.size >= maxObjectDatabases) throw alternateLimitExceeded();
        visited.add(alternate.identity);
        pending.push({ ...alternate, depth: current.depth + 1 });
      }
    }
  }

  private async resolveObjectDatabase(
    baseDirectory: string,
    entry: string,
    roots: readonly ResolvedRoot[],
    budget: ObjectPathBudget,
    signal?: AbortSignal,
  ): Promise<ResolvedObjectDatabase> {
    const lexicalPath = resolve(baseDirectory, entry);
    if (!roots.some(({ path }) => relativeWithin(path, lexicalPath) !== undefined)) {
      throw forbidden('The Git object database lies outside the configured repository roots');
    }
    const canonical = await resolveGitObjectPath(baseDirectory, entry, budget, signal);
    const owner = roots.find(({ path, boundary }) => boundary.isWithin(path, canonical, true));
    if (!owner) {
      throw forbidden('The Git object database lies outside the configured repository roots');
    }
    return {
      path: canonical,
      owner,
      identity: await objectDatabaseIdentity(canonical),
    };
  }

  private async readAlternates(
    objectDatabase: ResolvedObjectDatabase,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const alternatesPath = join(objectDatabase.path, 'info', 'alternates');
    const relativePath = objectDatabase.owner.alternateFileBoundary.formatRelative(
      objectDatabase.owner.path,
      alternatesPath,
    );
    let opened: ConfinedOpenedFile;
    try {
      opened = await objectDatabase.owner.alternateFileBoundary.openFile(relativePath, {
        previewBytes: 0,
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') return [];
      if (error instanceof AppError && error.code === 'limit_exceeded') {
        throw alternateLimitExceeded();
      }
      throw error;
    }

    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of opened.createReadStream(signal === undefined ? {} : { signal })) {
        if (!Buffer.isBuffer(chunk)) throw invalidAlternateConfiguration();
        chunks.push(chunk);
        bytes += chunk.byteLength;
      }
      return parseAlternateObjectDirectories(Buffer.concat(chunks, bytes));
    } finally {
      await opened.close();
    }
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
