import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { unauthorized } from '../errors.js';

export interface Principal {
  readonly id: string;
  readonly kind: 'api-key' | 'anonymous';
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

const equals = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const credential = (request: FastifyRequest): string | undefined => {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim() || undefined;
  }
  const apiKey = request.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : undefined;
};

class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', kind: 'anonymous' });
  }
}

class ApiKeyAuthenticator implements Authenticator {
  private readonly apiKeys: ReadonlyArray<{ value: Buffer; principalId: string }>;

  public constructor(apiKeys: readonly string[]) {
    this.apiKeys = apiKeys.map((value, index) => ({
      value: Buffer.from(value, 'utf8'),
      principalId: `key:${index + 1}`,
    }));
  }

  public authenticate(request: FastifyRequest): Promise<Principal> {
    const presented = credential(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');
    const presentedValue = Buffer.from(presented, 'utf8');
    const match = this.apiKeys.find((candidate) => equals(candidate.value, presentedValue));
    if (!match) throw unauthorized('Invalid API key');
    return Promise.resolve({ id: match.principalId, kind: 'api-key' });
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
