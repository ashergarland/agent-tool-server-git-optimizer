import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import type { GitRunner } from '../../src/services/git.js';
import { createServices } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const closeables: { close(): Promise<void> }[] = [];

afterEach(async () => Promise.all(closeables.splice(0).map((value) => value.close())));

describe('MCP adapter', () => {
  it('lists and invokes tools from the shared registry', async () => {
    const config = testConfig();
    const runner: GitRunner = async () => '';
    const server = createMcpServer(config, createToolRegistry(), createServices(config, runner), {
      requestId: 'mcp-test',
      principal: 'test-client',
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('summarize_commit_diff');
    const result = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { baseRef: 'HEAD', targetRef: 'HEAD' },
    });
    expect(result.isError).not.toBe(true);
    const failure = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: '' },
    });
    expect(failure.isError).toBe(true);
  });
});
