import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

describe('OpenAPI generation', () => {
  it('includes every registry tool and the MCP endpoint', () => {
    const document = buildOpenApiDocument(testConfig(), createToolRegistry());
    const paths = document['paths'] as Record<string, Record<string, unknown>>;
    expect(paths['/mcp']).toBeDefined();
    for (const tool of createToolRegistry().list()) {
      expect(paths[`/tools/${tool.name}`]).toBeDefined();
      expect(
        (paths[`/tools/${tool.name}`]?.['post'] as Record<string, unknown>)['operationId'],
      ).toBe(tool.name);
    }
  });
});
