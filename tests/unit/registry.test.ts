import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/errors.js';
import { createServices } from '../../src/services/index.js';
import { defineTool } from '../../src/tools/definitions.js';
import { createToolRegistry, ToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const context = { requestId: 'test', principal: 'tester' };

describe('tool registry', () => {
  it('exposes unique definitions and schemas', () => {
    const registry = createToolRegistry();
    expect(registry.list().map((tool) => tool.name)).toEqual(['summarize_commit_diff']);
    expect(registry.list().every((tool) => tool.inputJsonSchema['type'] === 'object')).toBe(true);
  });

  it('validates input and output', async () => {
    const services = createServices(testConfig());
    await expect(
      createToolRegistry().invoke(
        'summarize_commit_diff',
        { repositoryPath: '' },
        services,
        context,
      ),
    ).rejects.toMatchObject({
      code: 'bad_request',
    });

    const invalid = defineTool({
      name: 'invalid_output',
      title: 'Invalid',
      summary: 'Invalid',
      description: 'Invalid',
      kind: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: 'not-a-boolean' }) as never,
    });
    await expect(
      new ToolRegistry([invalid]).invoke('invalid_output', {}, services, context),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('rejects duplicate and unknown tools', () => {
    const definition = createToolRegistry().list()[0]!;
    expect(() => new ToolRegistry([definition as never, definition as never])).toThrow('Duplicate');
    expect(() => createToolRegistry().get('missing')).toThrow(AppError);
  });
});
