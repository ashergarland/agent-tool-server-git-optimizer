export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'limit_exceeded'
  | 'rate_limited'
  | 'busy'
  | 'timeout'
  | 'upstream_error'
  | 'internal_error';

const statusByCode: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  limit_exceeded: 413,
  rate_limited: 429,
  internal_error: 500,
  upstream_error: 502,
  busy: 503,
  timeout: 504,
};

const retryableByCode: Readonly<Record<ErrorCode, boolean>> = {
  bad_request: false,
  unauthorized: false,
  forbidden: false,
  not_found: false,
  limit_exceeded: false,
  rate_limited: true,
  internal_error: false,
  upstream_error: true,
  busy: true,
  timeout: true,
};

/** Bounds untrusted detail payloads so error responses cannot leak or bloat. */
const boundDetails = (details: unknown, depth = 0): unknown => {
  if (details === null || details === undefined) return details;
  if (typeof details === 'string')
    return details.length > 500 ? `${details.slice(0, 500)}…` : details;
  if (typeof details === 'number' || typeof details === 'boolean') return details;
  if (depth >= 3) return undefined;
  if (Array.isArray(details))
    return details.slice(0, 20).map((entry) => boundDetails(entry, depth + 1));
  if (typeof details === 'object') {
    return Object.fromEntries(
      Object.entries(details as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, value]) => [key.slice(0, 64), boundDetails(value, depth + 1)]),
    );
  }
  return undefined;
};

export interface SafeErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly details?: unknown;
}

export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly details: unknown;

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    details?: unknown,
    retryable?: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.statusCode = statusByCode[code];
    this.retryable = retryable ?? retryableByCode[code];
    this.details = boundDetails(details);
  }

  /** Single safe representation shared by every transport. */
  public toBody(requestId: string): SafeErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, details);
export const unauthorized = (message: string): AppError => new AppError('unauthorized', message);
export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('forbidden', message, details);
export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, details);
export const limitExceeded = (message: string, details?: unknown): AppError =>
  new AppError('limit_exceeded', message, details);
export const busy = (message: string, details?: unknown): AppError =>
  new AppError('busy', message, details);
export const timedOut = (message: string, details?: unknown): AppError =>
  new AppError('timeout', message, details);

export const toAppError = (error: unknown): AppError =>
  error instanceof AppError
    ? error
    : new AppError(
        'internal_error',
        'The tool server failed to complete the request',
        undefined,
        false,
        error,
      );
