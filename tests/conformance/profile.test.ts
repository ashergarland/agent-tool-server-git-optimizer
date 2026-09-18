import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { gitOptimizerCapability } from '../../src/capability.js';

interface Declaration {
  readonly capability: {
    readonly id: string;
    readonly displayName: string;
    readonly repository: string;
  };
  readonly profiles: readonly [
    {
      readonly id: string;
      readonly dimensions: Record<string, string>;
      readonly requiredSecrets: readonly string[];
      readonly providerPrerequisites: readonly unknown[];
      readonly delivery: {
        readonly publication: { readonly identifier: string };
        readonly entrypoint: { readonly reference: string; readonly interface: string };
      };
      readonly configuration: {
        readonly schema: {
          readonly id: string;
          readonly capabilityId: string;
          readonly path: string;
        };
        readonly bounded: boolean;
      };
      readonly workload: {
        readonly interface: { readonly kind: string; readonly reference: string };
        readonly authorization: { readonly scope: string };
        readonly lifecycle: { readonly mode: string };
        readonly notReady: { readonly whenAbsent: string };
      };
      readonly mutation?: unknown;
    },
  ];
}

const load = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

describe('local Git capability profile truthfulness', () => {
  it('matches repository, package, entrypoint, and schema identity', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const server = (await load('../../server.json')) as {
      readonly name: string;
      readonly repository: { readonly url: string };
    };
    const manifest = (await load('../../package.json')) as {
      readonly name: string;
      readonly version: string;
    };
    const profile = declaration.profiles[0];

    expect(declaration.capability).toEqual({
      id: server.name,
      displayName: gitOptimizerCapability.manifest.title,
      repository: server.repository.url,
    });
    expect(profile.delivery.publication.identifier).toBe(manifest.name);
    expect(gitOptimizerCapability.manifest.version).toBe(manifest.version);
    expect(profile.delivery.entrypoint).toEqual({
      reference: 'dist/stdio.js',
      interface: 'stdio',
    });

    const configurationSchema = (await load(`../../${profile.configuration.schema.path}`)) as {
      readonly $id: string;
      readonly additionalProperties: boolean;
    };
    expect(profile.configuration).toEqual({
      schema: {
        id: configurationSchema.$id,
        capabilityId: declaration.capability.id,
        path: 'schemas/local-configuration.schema.json',
      },
      bounded: true,
    });
    expect(configurationSchema.additionalProperties).toBe(false);
  });

  it('declares all six local, package, filesystem, provider-free, read-only dimensions', async () => {
    const declaration = (await load('../../capability-profiles.json')) as Declaration;
    const profile = declaration.profiles[0];
    expect(profile.id).toBe('local-package');
    expect(profile.dimensions).toEqual({
      execution: 'local',
      delivery: 'package',
      access: 'local-process',
      workload: 'filesystem',
      provider: 'none',
      mutation: 'read-only',
    });
    expect(profile.requiredSecrets).toEqual([]);
    expect(profile.providerPrerequisites).toEqual([]);
    expect(profile.workload.interface.kind).toBe('filesystem');
    expect(profile.workload.authorization.scope).toMatch(/read-only/iu);
    expect(profile.workload.lifecycle.mode).toBe('session');
    expect(profile.workload.notReady.whenAbsent).toBe('not-ready');
    expect(profile).not.toHaveProperty('mutation');
    expect(gitOptimizerCapability.tools.every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('contains no operator instance, provider, secret, or cloud requirement', async () => {
    const declaration = await load('../../capability-profiles.json');
    const serialized = JSON.stringify(declaration);
    expect(serialized).not.toMatch(
      /subscription|tenant|key.?vault|resource.?group|container.?app|production endpoint/iu,
    );
    expect(serialized).not.toContain('secretValue');
  });
});
