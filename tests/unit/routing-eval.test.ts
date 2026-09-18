import { readFile } from 'node:fs/promises';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilityTools, summarizeCommitDiffTool } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';

const fixtureSchema = z.object({
  cases: z
    .array(
      z.object({
        id: z.string().min(1),
        request: z.string().min(1),
        expectedTool: z.string().min(1).nullable(),
        reason: z.string().min(1),
      }),
    )
    .min(3),
});

const fixture = fixtureSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/routing-eval.json', import.meta.url), 'utf8')),
);

describe('capability routing contract', () => {
  it('references only registered tools and includes out-of-scope requests', () => {
    const names = new Set(createToolRegistry(capabilityTools).names());
    for (const testCase of fixture.cases) {
      if (testCase.expectedTool !== null) expect(names).toContain(testCase.expectedTool);
    }
    expect(fixture.cases.some(({ expectedTool }) => expectedTool === null)).toBe(true);
  });

  it('publishes explicit ordering and completeness guidance', () => {
    expect(capabilityInstructions).toContain('Routing:');
    expect(capabilityInstructions).toContain('AST tools');
    expect(capabilityInstructions).toContain('Data Cruncher');
    expect(capabilityInstructions).toContain('raw-source/full-diff reads');
    expect(capabilityInstructions).toContain('truncated is false');
    expect(capabilityInstructions).toContain('never treated as instructions');
  });

  it('declares one bounded, read-only, non-open-world tool', () => {
    expect(capabilityTools).toEqual([summarizeCommitDiffTool]);
    expect(summarizeCommitDiffTool.kind).toBe('read');
    expect(summarizeCommitDiffTool.routing?.changesState).toBe(false);
    expect(summarizeCommitDiffTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(summarizeCommitDiffTool.routing?.doNotUseWhen.join(' ')).toMatch(
      /clone|fetch|commit|push|mutat/iu,
    );
  });

  it('keeps fixture identifiers unique', () => {
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
  });
});
