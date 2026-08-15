import type { AppConfig } from '../config/index.js';
import { AppError, toAppError } from '../errors.js';
import type { HttpServer } from './types.js';

export const registerErrorHandler = (app: HttpServer, config: AppConfig): void => {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    if (appError.statusCode >= 500) {
      request.log.error(
        { err: error, event: 'request.error', code: appError.code },
        'unhandled request failure',
      );
    }

    // Internal failures never expose their message outside development.
    const safe =
      config.isProduction && appError.statusCode >= 500
        ? new AppError(appError.code, 'The tool server failed to complete the request')
        : appError;

    void reply.status(safe.statusCode).send({ error: safe.toBody(request.id) });
  });
};
