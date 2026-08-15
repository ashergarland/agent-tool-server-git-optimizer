import { describe, expect, it } from 'vitest';
import {
  AppError,
  badRequest,
  busy,
  limitExceeded,
  timedOut,
  toAppError,
} from '../../src/errors.js';

describe('error model', () => {
  it('maps codes to statuses and retryability', () => {
    expect(badRequest('nope').statusCode).toBe(400);
    expect(limitExceeded('too big').statusCode).toBe(413);
    expect(busy('queued').statusCode).toBe(503);
    expect(busy('queued').retryable).toBe(true);
    expect(timedOut('slow').statusCode).toBe(504);
    expect(timedOut('slow').retryable).toBe(true);
    expect(badRequest('nope').retryable).toBe(false);
  });

  it('bounds detail payloads so responses cannot leak or bloat', () => {
    const error = badRequest('bounded', {
      long: 'x'.repeat(2000),
      many: Array.from({ length: 100 }, (_, index) => index),
      deep: { a: { b: { c: { d: 'too deep' } } } },
    });
    const details = error.details as Record<string, unknown>;
    expect((details['long'] as string).length).toBe(501);
    expect((details['many'] as unknown[]).length).toBe(20);
    const deep = details['deep'] as Record<string, Record<string, unknown>>;
    expect(deep['a']?.['b']).toBeUndefined();
  });

  it('produces one safe body shape for every transport', () => {
    const body = badRequest('bad ref').toBody('request-1');
    expect(body).toEqual({
      code: 'bad_request',
      message: 'bad ref',
      retryable: false,
      requestId: 'request-1',
    });
  });

  it('never surfaces an unexpected failure verbatim', () => {
    const converted = toAppError(new Error('ENOENT /etc/shadow'));
    expect(converted.code).toBe('internal_error');
    expect(converted.message).not.toContain('/etc/shadow');
    expect(converted.details).toBeUndefined();
    const preserved = badRequest('kept');
    expect(toAppError(preserved)).toBe(preserved);
    expect(new AppError('upstream_error', 'x').retryable).toBe(true);
  });
});
