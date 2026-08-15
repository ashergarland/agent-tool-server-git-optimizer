import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors.js';
import { createServices } from '../../src/services/index.js';
import { defineTool } from '../../src/tools/definitions.js';
import { createToolRegistry, ToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';
import { emptyGitClient } from '../helpers/git-client.js';

const context = { requestId: 'test', principal: 'tester' };
const services = () => createServices(testConfig(), { gitClient: emptyGitClient() });

const stub = (overrides: Record<string, unknown> = {}) =>
  defineTool({
    name: 'stub_tool',
    title: 'Stub',
    summary: 'Stub',
    description: 'Stub',
    kind: 'read',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    useWhen: [],
    doNotUseWhen: [],
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler: async () => ({ ok: true }),
    ...overrides,
  });

describe('tool registry', () => {
  it('exposes unique read-only definitions and schemas', () => {
    const registry = createToolRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual(['summarize_commit_diff']);
    expect(registry.list().every((tool) => tool.inputJsonSchema['type'] === 'object')).toBe(true);
    expect(registry.list().every((tool) => tool.kind === 'read')).toBe(true);
    expect(registry.list().every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(registry.list().every((tool) => !tool.annotations.destructiveHint)).toBe(true);
  });

  it('rejects invalid and unknown input keys', async () => {
    await expect(
      createToolRegistry().invoke(
        'summarize_commit_diff',
        { repositoryPath: '' },
        services(),
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });

    await expect(
      createToolRegistry().invoke(
        'summarize_commit_diff',
        { repositoryPath: '.', unexpected: true },
        services(),
        context,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects a handler result that violates the declared output schema', async () => {
    const invalid = stub({ handler: async () => ({ ok: 'not-a-boolean' }) as never });
    await expect(
      new ToolRegistry([invalid]).invoke('stub_tool', {}, services(), context),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('rejects duplicate and unknown tools', () => {
    const definition = stub();
    expect(() => new ToolRegistry([definition, definition])).toThrow('Duplicate');
    expect(() => createToolRegistry().get('missing')).toThrow(AppError);
  });
});
