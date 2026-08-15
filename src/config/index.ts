import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const pathList = z
  .string()
  .transform((value) =>
    value
      .split(/[,;]/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const booleanish = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === 'boolean') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  context.addIssue({ code: 'custom', message: 'Expected a boolean value' });
  return z.NEVER;
});

export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-git-optimizer'),
  SERVICE_VERSION: z.string().min(1).default('0.0.0-dev'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  AUTH_MODE: z.enum(['api-key', 'disabled']).default('api-key'),
  API_KEYS: csv.default([]),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(120_000).default(10_000),

  /** Absolute directories that may contain analyzable repositories. */
  GIT_ALLOWED_ROOTS: pathList.default([]),
  /** Allows the launch directory to act as the implicit allowed root outside production. */
  GIT_LOCAL_PATHS_ENABLED: booleanish.default(false),
  /** Absolute path to a trusted Git executable; discovered from PATH when unset. */
  GIT_EXECUTABLE: z.string().min(1).optional(),
  /** Adds `safe.directory=*` so mounted repositories owned by another user remain readable. */
  GIT_TRUST_REPOSITORY_OWNERSHIP: booleanish.default(false),
  /** Additional generated filenames to filter, beyond the built-in lockfile set. */
  GIT_EXTRA_IGNORED_BASENAMES: csv.default([]),
  /** Additional generated directory segments to filter, such as `dist` for a bundled project. */
  GIT_EXTRA_IGNORED_DIRECTORIES: csv.default([]),

  GIT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(20_000),
  GIT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  GIT_QUEUE_LIMIT: z.coerce.number().int().min(0).max(1024).default(32),
  GIT_MAX_BUFFER_BYTES: z.coerce
    .number()
    .int()
    .min(64 * 1024)
    .max(64 * 1024 * 1024)
    .default(8 * 1024 * 1024),
  GIT_MAX_PATCH_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024)
    .max(32 * 1024 * 1024)
    .default(2 * 1024 * 1024),
  GIT_MAX_ARGUMENT_BYTES: z.coerce
    .number()
    .int()
    .min(4096)
    .max(1024 * 1024)
    .default(96 * 1024),
  GIT_MAX_FILES: z.coerce.number().int().min(1).max(5000).default(200),
  GIT_MAX_IGNORED_FILES: z.coerce.number().int().min(0).max(5000).default(200),
  GIT_MAX_PATH_LENGTH: z.coerce.number().int().min(64).max(8192).default(1024),
  GIT_MAX_SUMMARY_LENGTH: z.coerce.number().int().min(256).max(1_000_000).default(60_000),
});

export type Env = z.infer<typeof envSchema>;

export interface GitLimits {
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly queueLimit: number;
  readonly maxBufferBytes: number;
  readonly maxPatchBytes: number;
  readonly maxArgumentBytes: number;
  readonly maxFiles: number;
  readonly maxIgnoredFiles: number;
  readonly maxPathLength: number;
  readonly maxSummaryLength: number;
}

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly shutdownGraceMs: number;
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
  readonly git: {
    /** Absolute, normalized roots. Callers may only reach repositories beneath one of them. */
    readonly allowedRoots: readonly string[];
    /** Directory that relative `repositoryPath` values resolve against. */
    readonly baseDirectory: string;
    readonly localPathsEnabled: boolean;
    readonly executable: string | undefined;
    readonly trustRepositoryOwnership: boolean;
    readonly noise: {
      readonly basenames: readonly string[];
      readonly directories: readonly string[];
    };
    readonly limits: GitLimits;
  };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

export interface BuildConfigOptions {
  /** Launch directory used for implicit local roots and relative path resolution. */
  readonly cwd?: string;
}

export const buildConfig = (env: Env, options: BuildConfigOptions = {}): AppConfig => {
  const cwd = resolve(options.cwd ?? process.cwd());

  if (env.AUTH_MODE === 'disabled' && env.NODE_ENV === 'production') {
    throw new ConfigurationError('AUTH_MODE=disabled is not permitted in production');
  }
  if (env.AUTH_MODE === 'api-key') {
    if (env.API_KEYS.length === 0) {
      throw new ConfigurationError('AUTH_MODE=api-key requires API_KEYS');
    }
    if (env.API_KEYS.some((key) => key.length < 32)) {
      throw new ConfigurationError('Every API key must be at least 32 characters');
    }
  }
  for (const root of env.GIT_ALLOWED_ROOTS) {
    if (!isAbsolute(root)) {
      throw new ConfigurationError(`GIT_ALLOWED_ROOTS entries must be absolute paths: ${root}`);
    }
  }
  if (env.GIT_EXECUTABLE !== undefined && !isAbsolute(env.GIT_EXECUTABLE)) {
    throw new ConfigurationError('GIT_EXECUTABLE must be an absolute path');
  }
  if (env.GIT_MAX_PATCH_BYTES > env.GIT_MAX_BUFFER_BYTES) {
    throw new ConfigurationError('GIT_MAX_PATCH_BYTES must not exceed GIT_MAX_BUFFER_BYTES');
  }
  if (env.NODE_ENV === 'production') {
    if (env.GIT_LOCAL_PATHS_ENABLED) {
      throw new ConfigurationError('GIT_LOCAL_PATHS_ENABLED is not permitted in production');
    }
    if (env.GIT_ALLOWED_ROOTS.length === 0) {
      throw new ConfigurationError(
        'Production requires GIT_ALLOWED_ROOTS; mount a read-only repository source and list it explicitly',
      );
    }
  }

  const explicitRoots = env.GIT_ALLOWED_ROOTS.map((root) => resolve(root));
  const localPathsEnabled = env.GIT_LOCAL_PATHS_ENABLED;
  const allowedRoots =
    explicitRoots.length > 0 ? explicitRoots : localPathsEnabled ? [cwd] : ([] as string[]);

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    service: {
      name: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      gitSha: env.GIT_SHA,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
      rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
    },
    logLevel: env.LOG_LEVEL,
    shutdownGraceMs: env.SHUTDOWN_GRACE_MS,
    auth:
      env.AUTH_MODE === 'disabled'
        ? { mode: 'disabled' }
        : { mode: 'api-key', apiKeys: env.API_KEYS },
    git: {
      allowedRoots,
      baseDirectory: localPathsEnabled ? cwd : (allowedRoots[0] ?? cwd),
      localPathsEnabled,
      executable: env.GIT_EXECUTABLE,
      trustRepositoryOwnership: env.GIT_TRUST_REPOSITORY_OWNERSHIP,
      noise: {
        basenames: env.GIT_EXTRA_IGNORED_BASENAMES,
        directories: env.GIT_EXTRA_IGNORED_DIRECTORIES,
      },
      limits: {
        timeoutMs: env.GIT_TIMEOUT_MS,
        concurrency: env.GIT_CONCURRENCY,
        queueLimit: env.GIT_QUEUE_LIMIT,
        maxBufferBytes: env.GIT_MAX_BUFFER_BYTES,
        maxPatchBytes: env.GIT_MAX_PATCH_BYTES,
        maxArgumentBytes: env.GIT_MAX_ARGUMENT_BYTES,
        maxFiles: env.GIT_MAX_FILES,
        maxIgnoredFiles: env.GIT_MAX_IGNORED_FILES,
        maxPathLength: env.GIT_MAX_PATH_LENGTH,
        maxSummaryLength: env.GIT_MAX_SUMMARY_LENGTH,
      },
    },
  };
};

export const loadConfig = (
  source: NodeJS.ProcessEnv = process.env,
  options: BuildConfigOptions = {},
): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data, options);
};
