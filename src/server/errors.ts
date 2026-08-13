import type { AppConfig } from '../config/index.js';
import { toAppError } from '../errors.js';
import type { HttpServer } from './types.js';

export const registerErrorHandler = (app: HttpServer, config: AppConfig): void => {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    const message =
      config.isProduction && appError.statusCode >= 500
        ? 'The tool server failed to complete the request'
        : appError.message;

    if (appError.statusCode >= 500) {
      request.log.error({ err: error, event: 'request.error' }, 'unhandled request failure');
    }

    void reply.status(appError.statusCode).send({
      error: {
        code: appError.code,
        message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
        retryable: appError.retryable,
        requestId: request.id,
      },
    });
  });
};
