import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { createServices } from '../../src/services/index.js';
import { serverInstructions } from '../../src/tools/definitions.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';
import { emptyGitClient, fakeGitClient } from '../helpers/git-client.js';

const closeables: { close(): Promise<void> }[] = [];

afterEach(async () => Promise.all(closeables.splice(0).map((value) => value.close())));

const connect = async (gitClient = emptyGitClient()) => {
  const config = testConfig();
  const services = createServices(config, { gitClient });
  const server = createMcpServer(config, createToolRegistry(), services, {
    requestId: 'mcp-test',
    principal: 'test-client',
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(client, server, services);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe('MCP adapter', () => {
  it('advertises read-only annotations and routing instructions', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === 'summarize_commit_diff');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    expect(tool?.annotations?.openWorldHint).toBe(false);
    expect(client.getInstructions()).toBe(serverInstructions);
  });

  it('invokes tools from the shared registry and returns structured content', async () => {
    const client = await connect(
      fakeGitClient((options) => {
        if (options.args.includes('--is-bare-repository')) return `false\n${process.cwd()}/.git\n`;
        if (options.args.includes('--show-toplevel')) return `${process.cwd()}\n`;
        if (options.args.includes('--verify')) return `${'a'.repeat(40)}\n`;
        if (options.args.includes('--parents')) return `${'a'.repeat(40)} ${'b'.repeat(40)}\n`;
        return '';
      }),
    );
    const result = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: '.', baseRef: 'HEAD', targetRef: 'HEAD' },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ returnedFiles: 0, truncated: false });
  });

  it('maps failures onto the shared safe error body', async () => {
    const client = await connect();
    const failure = await client.callTool({
      name: 'summarize_commit_diff',
      arguments: { repositoryPath: '.', targetRef: '--output=/tmp/pwned' },
    });
    expect(failure.isError).toBe(true);
    const content = failure.content as { type: string; text: string }[];
    const body = JSON.parse(content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'bad_request', retryable: false, requestId: 'mcp-test' });
  });
});
