import { isAbsolute, resolve } from 'node:path';
import {
  ConfigurationError,
  defineCapabilityConfig,
  loadCapabilityConfig,
  strictBoolean,
  type PlatformConfig,
} from '@agent-tool-platform/runtime/config';
import { z } from 'zod';
import { gitOptimizerManifest } from '../manifest.js';

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

const csvList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

const boundedInteger = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

export const gitEnvSchema = z.object({
  GIT_ALLOWED_ROOTS: pathList.default([]),
  GIT_LOCAL_PATHS_ENABLED: strictBoolean.default(false),
  GIT_EXECUTABLE: z.string().min(1).optional(),
  GIT_TRUST_REPOSITORY_OWNERSHIP: strictBoolean.default(false),
  GIT_EXTRA_IGNORED_BASENAMES: csvList.default([]),
  GIT_EXTRA_IGNORED_DIRECTORIES: csvList.default([]),
  GIT_TIMEOUT_MS: boundedInteger(1000, 600_000, 20_000),
  GIT_CONCURRENCY: boundedInteger(1, 64, 4),
  GIT_QUEUE_LIMIT: boundedInteger(0, 1024, 32),
  GIT_MAX_BUFFER_BYTES: boundedInteger(64 * 1024, 64 * 1024 * 1024, 8 * 1024 * 1024),
  GIT_MAX_PATCH_BYTES: boundedInteger(16 * 1024, 32 * 1024 * 1024, 2 * 1024 * 1024),
  GIT_MAX_ARGUMENT_BYTES: boundedInteger(4096, 1024 * 1024, 96 * 1024),
  GIT_MAX_FILES: boundedInteger(1, 5000, 200),
  GIT_MAX_IGNORED_FILES: boundedInteger(0, 5000, 200),
  GIT_MAX_PATH_LENGTH: boundedInteger(64, 8192, 1024),
  GIT_MAX_SUMMARY_LENGTH: boundedInteger(256, 1_000_000, 60_000),
});

export type GitEnv = z.infer<typeof gitEnvSchema>;

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

export interface GitConfig extends PlatformConfig {
  readonly git: {
    readonly allowedRoots: readonly string[];
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

export const buildGitConfig = (
  base: PlatformConfig,
  env: GitEnv,
  cwd = process.cwd(),
): GitConfig => {
  const baseDirectory = resolve(cwd);
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
  if (base.isProduction && env.GIT_LOCAL_PATHS_ENABLED) {
    throw new ConfigurationError('GIT_LOCAL_PATHS_ENABLED is not permitted in production');
  }
  if (base.isProduction && env.GIT_ALLOWED_ROOTS.length === 0) {
    throw new ConfigurationError('Production requires GIT_ALLOWED_ROOTS');
  }

  const explicitRoots = env.GIT_ALLOWED_ROOTS.map((root) => resolve(root));
  const allowedRoots = env.GIT_LOCAL_PATHS_ENABLED
    ? [baseDirectory, ...explicitRoots.filter((root) => root !== baseDirectory)]
    : explicitRoots;

  return {
    ...base,
    git: {
      allowedRoots,
      baseDirectory: env.GIT_LOCAL_PATHS_ENABLED
        ? baseDirectory
        : (allowedRoots[0] ?? baseDirectory),
      localPathsEnabled: env.GIT_LOCAL_PATHS_ENABLED,
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

export const gitConfigSpec = defineCapabilityConfig<typeof gitEnvSchema, GitConfig>({
  schema: gitEnvSchema,
  build: ({ base, env }) => buildGitConfig(base, env),
});

export const gitConfigDefaults = {
  serviceName: gitOptimizerManifest.name,
  serviceVersion: gitOptimizerManifest.version,
};

export const loadGitConfig = (source: NodeJS.ProcessEnv = process.env): GitConfig =>
  loadCapabilityConfig({
    defaults: gitConfigDefaults,
    spec: gitConfigSpec,
    source,
  });
