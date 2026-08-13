import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { MemoryProvider } from '../../src/provider/memory.js';
import { createServices } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const closeables: { close(): Promise<void> }[] = [];

afterEach(async () => Promise.all(closeables.splice(0).map((value) => value.close())));

describe('MCP adapter', () => {
  it('lists and invokes tools from the shared registry', async () => {
    const config = testConfig();
    const server = createMcpServer(
      config,
      createToolRegistry(),
      createServices(config, new MemoryProvider()),
      { requestId: 'mcp-test', principal: 'test-client' },
    );
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('example_list_items');
    const result = await client.callTool({
      name: 'example_get_item',
      arguments: { id: 'example-1' },
    });
    expect(result.isError).not.toBe(true);
    const failure = await client.callTool({ name: 'example_get_item', arguments: {} });
    expect(failure.isError).toBe(true);
  });
});
