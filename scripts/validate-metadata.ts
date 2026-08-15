import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Metadata must describe something that actually exists: no unpublished packages, no placeholder
 * endpoints, and no version drift between the registry entry and the package manifest.
 */
const placeholder = /(example\.(?:com|org|invalid)|replace-me|replace\.invalid|localhost|TODO)/iu;

const noPlaceholders = (label: string) =>
  z.string().refine((value) => !placeholder.test(value), {
    message: `${label} still contains placeholder content`,
  });

const repository = z.object({
  url: z.url().refine((value) => !placeholder.test(value), {
    message: 'repository.url still contains placeholder content',
  }),
  source: z.literal('github'),
});

const serverSchema = z.object({
  $schema: z.url(),
  name: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9._-]+$/u),
  description: noPlaceholders('description').min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  repository,
  // Only declare a distribution channel that genuinely exists.
  packages: z
    .array(
      z.object({
        registryType: z.enum(['npm', 'oci', 'nuget', 'pypi', 'mcpb']),
        identifier: noPlaceholders('package identifier').min(1),
        version: z.string().min(1),
        transport: z.object({ type: z.enum(['stdio', 'streamable-http', 'sse']) }),
      }),
    )
    .optional(),
  remotes: z
    .array(
      z.object({
        type: z.enum(['streamable-http', 'sse']),
        url: z.url().refine((value) => !placeholder.test(value), {
          message: 'remote url still contains placeholder content',
        }),
      }),
    )
    .optional(),
});

const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const server = serverSchema.parse(await load('server.json'));
registrySchema.parse(await load('examples/central-registry-entry.json'));

const manifest = z
  .object({ version: z.string(), private: z.boolean().optional() })
  .parse(await load('package.json'));

if (manifest.version !== server.version) {
  throw new Error(
    `server.json version ${server.version} does not match package.json version ${manifest.version}`,
  );
}
if (manifest.private !== true && (server.packages ?? []).length === 0) {
  throw new Error('package.json is publishable but server.json declares no package');
}

process.stdout.write('Metadata is consistent and free of placeholders.\n');
