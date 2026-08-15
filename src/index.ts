import { createApplication } from './app.js';

const application = createApplication();
let shuttingDown = false;

/** Rejects new work, aborts Git children, and drains for a bounded period. */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  application.logger.info({ signal, event: 'shutdown.start' }, 'shutting down');
  const forced = setTimeout(() => {
    application.logger.error({ event: 'shutdown.timeout' }, 'shutdown grace expired');
    process.exit(1);
  }, application.config.shutdownGraceMs);
  forced.unref();
  try {
    await application.close();
    application.logger.info({ event: 'shutdown.complete' }, 'shutdown complete');
  } catch (error) {
    application.logger.error({ err: error, event: 'shutdown.error' }, 'shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(forced);
  }
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const readiness = await application.services.readiness();
  for (const check of readiness.checks.filter((entry) => !entry.ok)) {
    application.logger.warn({ event: 'readiness.check', check: check.name }, check.detail);
  }
  await application.http.listen({
    host: application.config.http.host,
    port: application.config.http.port,
  });
} catch (error) {
  application.logger.fatal({ err: error }, 'startup failed');
  process.exitCode = 1;
  await application.close().catch(() => undefined);
}
