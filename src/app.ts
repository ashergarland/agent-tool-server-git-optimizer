import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from './config/index.js';
import { MemoryProvider } from './provider/memory.js';
import type { ExampleProvider } from './provider/types.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly provider?: ExampleProvider;
}

export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const services = createServices(config, options.provider ?? new MemoryProvider());
  const registry = createToolRegistry();
  const http = createHttpServer({ config, logger, services, registry });
  return { config, logger, services, registry, http };
};
