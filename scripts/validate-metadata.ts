import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const repository = z.object({ url: z.url(), source: z.literal('github') });
const serverSchema = z.object({
  name: z.string().regex(/^[a-z0-9.-]+\/[a-z0-9._-]+$/),
  description: z.string().min(1).max(200),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  repository,
  packages: z.array(
    z.object({
      registryType: z.literal('npm'),
      identifier: z.string().min(1),
      version: z.string(),
      transport: z.object({ type: z.literal('stdio') }),
    }),
  ),
  remotes: z.array(z.object({ type: z.literal('streamable-http'), url: z.url() })),
});
const registrySchema = z.object({
  id: z.string().min(1),
  repository: z.url(),
  serverMetadata: z.string().min(1),
  categories: z.array(z.string().min(1)).min(1),
});

const load = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));
serverSchema.parse(await load('server.json'));
registrySchema.parse(await load('examples/central-registry-entry.json'));
process.stdout.write('Metadata examples are valid.\n');
