import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

/**
 * Compares fixed-width keyed digests rather than the raw credentials, so neither the length nor
 * any prefix of a configured key is observable through comparison timing.
 */
class ApiKeyAuthenticator implements Authenticator {
  private readonly pepper = randomBytes(32);
  private readonly digests: ReadonlyArray<{ value: Buffer; principalId: string }>;

  public constructor(apiKeys: readonly string[]) {
    this.digests = apiKeys.map((value, index) => ({
      value: this.digest(value),
      principalId: `key:${index + 1}`,
    }));
  }

  public authenticate(request: FastifyRequest): Promise<Principal> {
    const presented = credential(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');
    const candidate = this.digest(presented);
    let match: string | undefined;
    for (const entry of this.digests) {
      if (timingSafeEqual(entry.value, candidate)) match = entry.principalId;
    }
    if (!match) throw unauthorized('Invalid API key');
    return Promise.resolve({ id: match, kind: 'api-key' });
  }

  /**
   * Not password hashing. These are machine-generated API keys of at least 32 characters, and the
   * digest is never stored: it exists only in memory, keyed with a per-process random pepper, so
   * that comparison is fixed-width and constant-time. A deliberately slow key-derivation function
   * would add attacker-controlled CPU cost to an unauthenticated code path.
   *
   * CodeQL reports `js/insufficient-password-hash` here; the alert is dismissed with this
   * reasoning, since inline suppression comments are not honoured for TypeScript.
   */
  private digest(value: string): Buffer {
    return createHmac('sha256', this.pepper).update(value, 'utf8').digest();
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator =>
  config.auth.mode === 'disabled'
    ? new DisabledAuthenticator()
    : new ApiKeyAuthenticator(config.auth.apiKeys);
