import { execFile, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { AppConfig, GitLimits } from '../config/index.js';
import { AppError, badRequest, busy, forbidden, limitExceeded, timedOut } from '../errors.js';

export interface GitRunOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  /** Overrides the default stdout ceiling for this command. */
  readonly maxBufferBytes?: number;
  /** When true a non-zero exit resolves instead of throwing. */
  readonly allowFailure?: boolean;
  readonly signal?: AbortSignal | undefined;
}

export interface GitRunResult {
  readonly stdout: string;
  readonly exitCode: number;
  /** Classification of a failed command; never raw Git output. */
  readonly failure?: GitFailureKind;
}

export type GitFailureKind =
  'unknown-revision' | 'not-a-repository' | 'untrusted-ownership' | 'ambiguous-argument' | 'other';

export interface GitProbe {
  readonly executable: string;
  readonly version: string;
}

export interface GitClient {
  run(options: GitRunOptions): Promise<GitRunResult>;
  probe(): Promise<GitProbe>;
  stats(): { readonly active: number; readonly queued: number };
  close(): Promise<void>;
}

const executableCandidates = (): readonly string[] =>
  process.platform === 'win32' ? ['git.exe'] : ['git'];

const isExecutableFile = async (candidate: string): Promise<boolean> => {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Resolves an absolute Git path without ever consulting a shell. */
export const resolveGitExecutable = async (
  configured: string | undefined,
  pathValue = process.env['PATH'] ?? '',
): Promise<string> => {
  if (configured) {
    if (await isExecutableFile(configured)) return configured;
    throw new AppError('internal_error', 'The configured Git executable is unavailable');
  }
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of executableCandidates()) {
      const candidate = join(directory, name);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  throw new AppError('internal_error', 'A Git executable could not be found on PATH');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const classifyStderr = (stderr: string): GitFailureKind => {
  const normalized = stderr.toLowerCase();
  if (normalized.includes('dubious ownership')) return 'untrusted-ownership';
  if (normalized.includes('not a git repository')) return 'not-a-repository';
  if (normalized.includes('ambiguous argument')) return 'ambiguous-argument';
  if (
    normalized.includes('unknown revision') ||
    normalized.includes('bad revision') ||
    normalized.includes('bad object') ||
    normalized.includes('not a valid object name')
  ) {
    return 'unknown-revision';
  }
  return 'other';
};

/** Maps a classified Git failure onto a safe typed error. */
export const gitFailureToError = (kind: GitFailureKind): AppError => {
  switch (kind) {
    case 'unknown-revision':
    case 'ambiguous-argument': {
      return badRequest('The requested Git reference could not be resolved in this repository');
    }
    case 'not-a-repository': {
      return badRequest('The requested path is not a readable Git repository');
    }
    case 'untrusted-ownership': {
      return forbidden(
        'The repository is owned by another user and this deployment does not trust it',
      );
    }
    default: {
      return badRequest('Git could not complete the requested read');
    }
  }
};

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  public constructor(
    private readonly limit: number,
    private readonly queueLimit: number,
  ) {}

  public get counts(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  public async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.queueLimit) {
        throw busy('The Git worker queue is saturated; retry shortly');
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiting.shift()?.();
    };
  }
}

interface EnvironmentPaths {
  readonly home: string;
  readonly temporaryDirectory: string;
}

export class ChildProcessGitClient implements GitClient {
  private readonly limits: GitLimits;
  private readonly children = new Set<ChildProcess>();
  private readonly semaphore: Semaphore;
  private probeResult: Promise<GitProbe> | undefined;
  private environmentPaths: Promise<EnvironmentPaths> | undefined;
  private shuttingDown = false;

  public constructor(private readonly config: AppConfig) {
    this.limits = config.git.limits;
    this.semaphore = new Semaphore(this.limits.concurrency, this.limits.queueLimit);
  }

  public stats(): { active: number; queued: number } {
    return this.semaphore.counts;
  }

  public probe(): Promise<GitProbe> {
    this.probeResult ??= this.runProbe().catch((error: unknown) => {
      this.probeResult = undefined;
      throw error;
    });
    return this.probeResult;
  }

  public async run(options: GitRunOptions): Promise<GitRunResult> {
    if (this.shuttingDown) throw busy('The tool server is shutting down');
    const release = await this.semaphore.acquire();
    try {
      // A queued caller may have been admitted while shutdown was starting.
      if (this.shuttingDown) throw busy('The tool server is shutting down');
      return await this.execute(options);
    } finally {
      release();
    }
  }

  public async close(): Promise<void> {
    this.shuttingDown = true;
    for (const child of this.children) child.kill('SIGKILL');
    const paths = await this.environmentPaths?.catch(() => undefined);
    if (paths) await rm(paths.home, { force: true, recursive: true }).catch(() => undefined);
    this.children.clear();
  }

  private async runProbe(): Promise<GitProbe> {
    const executable = await resolveGitExecutable(this.config.git.executable);
    const result = await this.execute({ cwd: tmpdir(), args: ['--version'], executable });
    const version = result.stdout.trim().replace(/^git version\s+/u, '');
    if (!version) throw new AppError('internal_error', 'Git did not report a usable version');
    return { executable, version };
  }

  /** Directories Git may write to, kept away from any repository or the read-only root. */
  private paths(): Promise<EnvironmentPaths> {
    this.environmentPaths ??= mkdtemp(join(tmpdir(), 'git-optimizer-'))
      .then((home) => ({ home, temporaryDirectory: home }))
      .catch(() => ({ home: tmpdir(), temporaryDirectory: tmpdir() }));
    return this.environmentPaths;
  }

  /**
   * Builds an environment with no inherited credentials, proxies, or Git variables so a
   * repository can never steer Git towards a helper, prompt, or external program.
   */
  private environment(executable: string, paths: EnvironmentPaths): NodeJS.ProcessEnv {
    const searchPath = [dirname(executable)];
    if (process.platform === 'win32') {
      const windows = process.env['SystemRoot'] ?? 'C:\\Windows';
      searchPath.push(join(windows, 'System32'), windows);
    } else {
      searchPath.push('/usr/bin', '/bin');
    }
    const missingConfig = join(paths.home, 'no-such-git-config');
    const environment: NodeJS.ProcessEnv = {
      PATH: searchPath.join(delimiter),
      HOME: paths.home,
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: paths.temporaryDirectory,
      TEMP: paths.temporaryDirectory,
      TMP: paths.temporaryDirectory,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: missingConfig,
      GIT_CONFIG_SYSTEM: missingConfig,
      GIT_ATTR_NOSYSTEM: '1',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_PAGER: 'cat',
      GIT_ADVICE: '0',
      GIT_PROTOCOL_FROM_USER: '0',
      GCM_INTERACTIVE: 'never',
    };
    if (process.platform === 'win32') {
      environment['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
      environment['windir'] = process.env['windir'] ?? 'C:\\Windows';
      environment['USERPROFILE'] = paths.home;
      environment['PATHEXT'] = '.EXE';
    }
    return environment;
  }

  /**
   * Global options that neutralize repository-controlled configuration: no external diff or
   * text conversion drivers, no hooks, no credential helpers, no remote protocols, and no
   * background maintenance that would write to a read-only mount.
   */
  private globalArguments(paths: EnvironmentPaths): string[] {
    const missing = join(paths.home, 'no-such-git-path');
    const globals = [
      '--no-pager',
      '--literal-pathspecs',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `core.hooksPath=${missing}`,
      '-c',
      'core.pager=cat',
      '-c',
      'core.editor=true',
      '-c',
      'core.askPass=',
      '-c',
      'core.sshCommand=',
      '-c',
      'core.quotePath=false',
      '-c',
      'diff.external=',
      '-c',
      'color.ui=false',
      '-c',
      'credential.helper=',
      '-c',
      'protocol.allow=never',
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
    ];
    if (this.config.git.trustRepositoryOwnership) globals.push('-c', 'safe.directory=*');
    return globals;
  }

  private async execute(
    options: GitRunOptions & { readonly executable?: string },
  ): Promise<GitRunResult> {
    const executable = options.executable ?? (await this.probe()).executable;
    const paths = await this.paths();
    const args = [...this.globalArguments(paths), ...options.args];
    const argumentBytes = args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
    if (argumentBytes > this.limits.maxArgumentBytes) {
      throw limitExceeded('The Git command exceeded the configured argument size limit');
    }

    return new Promise<GitRunResult>((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        {
          cwd: options.cwd,
          env: this.environment(executable, paths),
          encoding: 'utf8',
          maxBuffer: options.maxBufferBytes ?? this.limits.maxBufferBytes,
          timeout: this.limits.timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          shell: false,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          this.children.delete(child);
          if (!error) {
            resolve({ stdout, exitCode: 0 });
            return;
          }
          const code = isRecord(error) ? error.code : undefined;
          if (code === 'ENOENT') {
            reject(new AppError('internal_error', 'The Git executable is unavailable'));
            return;
          }
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(limitExceeded('Git produced more output than the configured limit allows'));
            return;
          }
          if (isRecord(error) && (error.killed === true || error.name === 'AbortError')) {
            reject(timedOut('The Git command exceeded its time budget and was cancelled'));
            return;
          }
          const exitCode = typeof code === 'number' ? code : 1;
          const failure = classifyStderr(stderr);
          if (options.allowFailure) {
            resolve({ stdout, exitCode, failure });
            return;
          }
          reject(gitFailureToError(failure));
        },
      );
      this.children.add(child);
    });
  }
}

export const createGitClient = (config: AppConfig): GitClient => new ChildProcessGitClient(config);
