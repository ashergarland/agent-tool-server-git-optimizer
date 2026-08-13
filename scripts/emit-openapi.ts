import { writeFile } from 'node:fs/promises';
import { buildConfig, envSchema } from '../src/config/index.js';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { createToolRegistry } from '../src/tools/registry.js';

const config = buildConfig(
  envSchema.parse({
    NODE_ENV: 'development',
    AUTH_MODE: 'disabled',
    SERVICE_VERSION: process.env['SERVICE_VERSION'] ?? '0.1.0',
    PUBLIC_BASE_URL: process.env['PUBLIC_BASE_URL'] ?? 'http://localhost:8080',
  }),
);
const document = `${JSON.stringify(buildOpenApiDocument(config, createToolRegistry()), null, 2)}\n`;
const output = process.argv[2];

if (output) await writeFile(output, document, 'utf8');
else process.stdout.write(document);
