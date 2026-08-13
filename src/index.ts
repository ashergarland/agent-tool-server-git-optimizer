import { createApplication } from './app.js';

const application = createApplication();

const shutdown = async (signal: string): Promise<void> => {
  application.logger.info({ signal }, 'shutting down');
  await application.http.close();
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await application.http.listen({
    host: application.config.http.host,
    port: application.config.http.port,
  });
} catch (error) {
  application.logger.fatal({ err: error }, 'startup failed');
  process.exitCode = 1;
}
