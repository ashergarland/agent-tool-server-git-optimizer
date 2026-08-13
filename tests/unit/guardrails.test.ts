import { describe, expect, it } from 'vitest';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';

describe('mutation guardrails', () => {
  it('always permits previews', () => {
    expect(
      new Guardrails(testConfig()).assertMutationAllowed({
        toolName: 'write',
        confirm: false,
        dryRun: true,
      }),
    ).toBe(true);
  });

  it('requires deployment enablement and confirmation', () => {
    expect(() =>
      new Guardrails(testConfig()).assertMutationAllowed({
        toolName: 'write',
        confirm: true,
        dryRun: false,
      }),
    ).toThrow('MUTATIONS_ENABLED');
    expect(() =>
      new Guardrails(testConfig({ MUTATIONS_ENABLED: true })).assertMutationAllowed({
        toolName: 'write',
        confirm: false,
        dryRun: false,
      }),
    ).toThrow('confirm=true');
  });
});
