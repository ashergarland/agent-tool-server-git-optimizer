import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

// Local stdio is the primary mode: authentication is irrelevant across a private pipe, and the
// launch directory is the implicit repository root unless GIT_ALLOWED_ROOTS narrows it further.
const config = loadConfig({
  GIT_LOCAL_PATHS_ENABLED: 'true',
  ...process.env,
  AUTH_MODE: 'disabled',
  NODE_ENV: process.env['NODE_ENV'] === 'test' ? 'test' : 'development',
});
const services = createServices(config);
const server = createMcpServer(config, createToolRegistry(), services, {
  requestId: `stdio-${process.pid}`,
  principal: 'stdio-client',
});

const shutdown = async (): Promise<void> => {
  await server.close().catch(() => undefined);
  await services.close().catch(() => undefined);
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());
