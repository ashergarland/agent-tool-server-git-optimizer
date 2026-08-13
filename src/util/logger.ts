import pino, { type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';

export const createLogger = (config: AppConfig): Logger =>
  pino({
    level: config.logLevel,
    base: {
      service: config.service.name,
      version: config.service.version,
      environment: config.env,
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        'headers.authorization',
        'headers.x-api-key',
      ],
      censor: '[REDACTED]',
    },
  });
