import { dirname, join } from 'node:path';
import { BoundedQueue, type QueueStats } from '@agent-tool-platform/runtime/concurrency';
import {
  type AppError,
  badRequest,
  forbidden,
  internalError,
  limitExceeded,
} from '@agent-tool-platform/runtime/errors';
import {
  buildChildEnvironment,
  ExecutableResolutionError,
  processFailureToAppError,
  resolveExecutable,
  runBoundedProcess,
  toProcessError,
} from '@agent-tool-platform/runtime/process';
import type { GitConfig } from '../config/index.js';

export interface GitRunOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly maxBufferBytes?: number;
  readonly allowFailure?: boolean;
  readonly signal?: AbortSignal | undefined;
}

export interface GitRunResult {
  readonly stdout: string;
  readonly exitCode: number;
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
  stats(): QueueStats;
  close(): Promise<void>;
}

const minimumGitVersion = { major: 2, minor: 34 } as const;

export const isSupportedGitVersion = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version);
  if (!match) return false;
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  return (
    major > minimumGitVersion.major ||
    (major === minimumGitVersion.major && minor >= minimumGitVersion.minor)
  );
};

export const resolveGitExecutable = async (
  configured: string | undefined,
  pathValue = process.env['PATH'] ?? '',
): Promise<string> => {
  try {
    return await resolveExecutable('git', { override: configured, pathValue });
  } catch (error) {
    if (error instanceof ExecutableResolutionError) {
      throw internalError(
        configured
          ? 'The configured Git executable is unavailable'
          : 'A Git executable could not be found on PATH',
        error,
      );
    }
    throw error;
  }
};

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

export const buildGitChildEnvironment = (
  executable: string,
  scratchDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const pathEntries = [dirname(executable)];
  const extra: Record<string, string> = {
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(scratchDirectory, 'global.gitconfig'),
    GIT_CONFIG_SYSTEM: join(scratchDirectory, 'system.gitconfig'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_PAGER: 'cat',
    GIT_ADVICE: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GCM_INTERACTIVE: 'never',
  };
  if (process.platform === 'win32') {
    const windows = source['SystemRoot'] ?? 'C:\\Windows';
    pathEntries.push(join(windows, 'System32'), windows);
    extra['USERPROFILE'] = scratchDirectory;
    extra['PATHEXT'] = '.EXE';
  }
  return buildChildEnvironment({
    pathEntries,
    tempDir: scratchDirectory,
    source,
    extra,
  });
};

export const buildGitGlobalArguments = (
  trustRepositoryOwnership: boolean,
  scratchDirectory: string,
): string[] => {
  const missing = join(scratchDirectory, 'no-such-git-path');
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
  if (trustRepositoryOwnership) globals.push('-c', 'safe.directory=*');
  return globals;
};

export class ChildProcessGitClient implements GitClient {
  private readonly queue: BoundedQueue;
  private probeResult: Promise<GitProbe> | undefined;

  public constructor(
    private readonly config: GitConfig,
    private readonly scratchDirectory: string,
  ) {
    this.queue = new BoundedQueue(
      config.git.limits.concurrency,
      config.git.limits.queueLimit,
      'Git work',
    );
  }

  public stats(): QueueStats {
    return this.queue.stats;
  }

  public probe(): Promise<GitProbe> {
    this.probeResult ??= this.runProbe().catch((error: unknown) => {
      this.probeResult = undefined;
      throw error;
    });
    return this.probeResult;
  }

  public run(options: GitRunOptions): Promise<GitRunResult> {
    return this.queue.run(() => this.execute(options), options.signal);
  }

  public close(): Promise<void> {
    return this.queue.drain();
  }

  private async runProbe(): Promise<GitProbe> {
    const executable = await resolveGitExecutable(this.config.git.executable);
    const result = await this.execute({
      cwd: this.scratchDirectory,
      args: ['--version'],
      executable,
    });
    const version = result.stdout.trim().replace(/^git version\s+/u, '');
    if (!isSupportedGitVersion(version)) {
      throw internalError(
        `Git ${minimumGitVersion.major}.${minimumGitVersion.minor} or newer is required`,
      );
    }
    return { executable, version };
  }

  private environment(executable: string): Record<string, string> {
    return buildGitChildEnvironment(executable, this.scratchDirectory);
  }

  private globalArguments(): string[] {
    return buildGitGlobalArguments(this.config.git.trustRepositoryOwnership, this.scratchDirectory);
  }

  private async execute(
    options: GitRunOptions & { readonly executable?: string },
  ): Promise<GitRunResult> {
    const executable = options.executable ?? (await this.probe()).executable;
    const args = [...this.globalArguments(), ...options.args];
    const argumentBytes = args.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0);
    if (argumentBytes > this.config.git.limits.maxArgumentBytes) {
      throw limitExceeded('The Git command exceeded the configured argument size limit');
    }

    let result;
    try {
      result = await runBoundedProcess({
        executablePath: executable,
        label: 'Git',
        args,
        cwd: options.cwd,
        env: this.environment(executable),
        timeoutMs: this.config.git.limits.timeoutMs,
        maxOutputBytes: options.maxBufferBytes ?? this.config.git.limits.maxBufferBytes,
        signal: options.signal,
      });
    } catch (error) {
      throw toProcessError(error, 'Git');
    }

    const processError = processFailureToAppError(result, 'Git');
    if (processError) throw processError;
    if (result.code === 0) return { stdout: result.stdout, exitCode: 0 };

    const failure = classifyStderr(result.stderr);
    const exitCode = result.code ?? 1;
    if (options.allowFailure) return { stdout: result.stdout, exitCode, failure };
    throw gitFailureToError(failure);
  }
}

export const createGitClient = (config: GitConfig, scratchDirectory: string): GitClient =>
  new ChildProcessGitClient(config, scratchDirectory);
