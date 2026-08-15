import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { serverInstructions, summarizeCommitDiffTool } from '../../src/tools/definitions.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const tool = summarizeCommitDiffTool;
const guidance = `${tool.description}\n${serverInstructions}`.toLowerCase();

/**
 * Lightweight routing evals. Each request is scored against the vocabulary that distinguishes the
 * documented in-scope cases from the out-of-scope cases, so wording changes that blur the two fail
 * the build instead of silently degrading agent behaviour.
 */
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z]+/gu) ?? []).filter((word) => word.length > 3));

const positiveVocabulary = words(tool.useWhen.join(' '));
const negativeVocabulary = words(tool.doNotUseWhen.join(' '));
const distinctivePositive = [...positiveVocabulary].filter((word) => !negativeVocabulary.has(word));
const distinctiveNegative = [...negativeVocabulary].filter((word) => !positiveVocabulary.has(word));

const score = (request: string): number => {
  const requested = words(request);
  const hits = (vocabulary: string[]) => vocabulary.filter((word) => requested.has(word)).length;
  return hits(distinctivePositive) - hits(distinctiveNegative);
};

const shouldRoute = [
  'summarize what this commit changed before I read the full patch',
  'compare the feature branch against main in my local repository',
  'which files and symbols changed between these two commits',
];

const shouldNotRoute = [
  'stage my uncommitted working tree changes and commit them',
  'push the current branch to the remote and open a pull request',
  'clone a repository from a url and install its dependencies',
  'rewrite the contents of a source file for me',
];

describe('routing guidance', () => {
  it('states the positive and negative cases an agent needs', () => {
    for (const phrase of tool.useWhen) expect(tool.description).toContain(phrase);
    for (const phrase of tool.doNotUseWhen) expect(tool.description).toContain(phrase);
    expect(tool.description).toContain('read-only');
    expect(tool.description).toContain('warnings');
    expect(tool.description).toContain('full patch');
    expect(tool.description).toMatch(/advisory/u);
    expect(guidance.length).toBeGreaterThan(0);
  });

  it('never claims mutation or general Git optimization', () => {
    const claims = `${tool.title} ${tool.summary} ${tool.description} ${serverInstructions}`;
    expect(claims).not.toMatch(/optimi[sz]e your (?:repository|git)/iu);
    expect(claims).not.toMatch(/\b(?:commits|pushes|merges|rewrites) (?:your|the) repository\b/iu);
    expect(tool.annotations.destructiveHint).toBe(false);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('scores in-scope requests positively and out-of-scope requests negatively', () => {
    for (const request of shouldRoute) expect(score(request)).toBeGreaterThan(0);
    for (const request of shouldNotRoute) expect(score(request)).toBeLessThan(0);
  });

  it('warns agents away from assuming full coverage', () => {
    expect(serverInstructions).toContain('truncated');
    expect(serverInstructions).toContain('ignoredFiles');
    expect(serverInstructions).toContain('warnings');
  });
});

describe('transport parity', () => {
  it('serves one registry definition through every surface', () => {
    const registry = createToolRegistry();
    const document = buildOpenApiDocument(testConfig(), registry);
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;

    for (const registered of registry.list()) {
      const operation = paths[`/tools/${registered.name}`]?.['post'];
      expect(operation?.['operationId']).toBe(registered.name);
      expect(operation?.['summary']).toBe(registered.summary);
      expect(operation?.['description']).toBe(registered.description);
      expect(operation?.['x-openai-isConsequential']).toBe(false);
      expect(operation?.['x-tool-annotations']).toEqual(registered.annotations);
      expect(
        (operation?.['requestBody'] as { content: Record<string, { schema: unknown }> }).content[
          'application/json'
        ]?.schema,
      ).toEqual(registered.inputJsonSchema);
    }
  });

  it('documents readiness, liveness, and the MCP endpoint', () => {
    const document = buildOpenApiDocument(testConfig(), createToolRegistry());
    const paths = document['paths'] as Record<string, unknown>;
    expect(paths['/health']).toBeDefined();
    expect(paths['/ready']).toBeDefined();
    expect(paths['/mcp']).toBeDefined();
    expect(document['tags']).toEqual([{ name: 'read', description: 'Read-only tools.' }]);
  });

  it('declares every transport error code once', () => {
    const document = buildOpenApiDocument(testConfig(), createToolRegistry());
    const components = document['components'] as {
      schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
    };
    expect(components.schemas.Error.properties.error.properties.code.enum).toContain(
      'limit_exceeded',
    );
    expect(components.schemas.Error.properties.error.properties.code.enum).toContain('busy');
    expect(components.schemas.Error.properties.error.properties.code.enum).toContain('timeout');
  });
});
