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
  MUTATIONS_ENABLED: booleanish.default(false),
  MUTATION_CONFIRMATION_REQUIRED: booleanish.default(true),
});

export type Env = z.infer<typeof envSchema>;

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
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
  readonly guardrails: {
    readonly mutationsEnabled: boolean;
    readonly confirmationRequired: boolean;
  };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

export const buildConfig = (env: Env): AppConfig => {
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
    auth:
      env.AUTH_MODE === 'disabled'
        ? { mode: 'disabled' }
        : { mode: 'api-key', apiKeys: env.API_KEYS },
    guardrails: {
      mutationsEnabled: env.MUTATIONS_ENABLED,
      confirmationRequired: env.MUTATION_CONFIRMATION_REQUIRED,
    },
  };
};

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return buildConfig(parsed.data);
};
