import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config/index.js';
import { MemoryProvider } from '../provider/memory.js';
import { createServices } from '../services/index.js';
import { createToolRegistry } from '../tools/registry.js';
import { createMcpServer } from './server.js';

const config = loadConfig({ ...process.env, AUTH_MODE: 'disabled', NODE_ENV: 'development' });
const server = createMcpServer(
  config,
  createToolRegistry(),
  createServices(config, new MemoryProvider()),
  {
    requestId: `stdio-${process.pid}`,
    principal: 'stdio-client',
  },
);

await server.connect(new StdioServerTransport());
