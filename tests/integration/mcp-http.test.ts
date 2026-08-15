import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/server/http.js';
import { createServices, type Services } from '../../src/services/index.js';
import { serverInstructions } from '../../src/tools/definitions.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { apiKey, testConfig } from '../helpers/config.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
} from '../helpers/repository.js';

const closeables: { close(): Promise<unknown> }[] = [];
const serviceInstances: Services[] = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((entry) => entry.close()));
  await Promise.all(serviceInstances.splice(0).map((service) => service.close()));
});
afterAll(removeTemporaryDirectories);

const listen = async (root: string) => {
  const config = testConfig({ GIT_LOCAL_PATHS_ENABLED: 'false', GIT_ALLOWED_ROOTS: root });
  const services = createServices(config);
  serviceInstances.push(services);
  const app = createHttpServer({
    config,
    logger: pino({ level: 'silent' }),
    services,
    registry: createToolRegistry(),
  });
  closeables.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no address');
  return `http://127.0.0.1:${address.port}/mcp`;
};

describe('Streamable HTTP MCP transport', () => {
  it('rejects unauthenticated MCP sessions', async () => {
    const root = await temporaryDirectory();
    await initRepository(join(root, 'project'));
    const url = await listen(root);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'unauthorized',
    );
  });

  it('lists and invokes the same tool an stdio client would see', async () => {
    const root = await temporaryDirectory();
    const repository = await initRepository(join(root, 'project'));
    await seedRepository(repository);
    const url = await listen(root);

    const client = new Client({ name: 'http-mcp-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { 'x-api-key': apiKey } },
    });
    // The SDK's own client transport declares an optional sessionId that conflicts with
    // exactOptionalPropertyTypes in its Transport interface.
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    closeables.push(client);

    expect(client.getInstructions()).toBe(serverInstructions);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === 'summarize_commit_diff');
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: repository.path, targetRef: 'HEAD' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ returnedFiles: 1, truncated: false });

    const refused = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: join(root, '..'), targetRef: 'HEAD' },
    });
    expect(refused.isError).toBe(true);
    const content = refused.content as { text: string }[];
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ code: 'forbidden' });
  });
});
