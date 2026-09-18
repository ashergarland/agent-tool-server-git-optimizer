import { readFile } from 'node:fs/promises';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import {
  generateTestApiKey,
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runProcessConformance,
  runRegistryConformance,
  runRootBoundaryConformance,
  runRoutingConformance,
  runScratchWorkspaceConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gitOptimizerCapability } from '../../src/capability.js';
import type { GitConfig } from '../../src/config/index.js';
import { gitOptimizerManifest } from '../../src/manifest.js';
import type { CapabilityServices } from '../../src/services/index.js';
import { capabilityTools } from '../../src/tools/definitions.js';
import { capabilityInstructions } from '../../src/tools/guidance.js';
import {
  initRepository,
  removeTemporaryDirectories,
  seedRepository,
  temporaryDirectory,
  type TestRepository,
} from '../helpers/repository.js';

type TestApplication = AgentToolApplication<GitConfig, CapabilityServices>;

const apiKey = generateTestApiKey();
const applications: TestApplication[] = [];
let repository: TestRepository;

const readSample = () =>
  ({
    name: 'summarize_commit_diff',
    input: {
      repositoryPath: repository.path,
      targetRef: 'HEAD',
      whitespace: 'preserve',
    },
  }) as const;

const createApplication = async (start = true): Promise<TestApplication> => {
  const application = await createAgentToolApplication(gitOptimizerCapability, {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
      GIT_LOCAL_PATHS_ENABLED: 'false',
      GIT_ALLOWED_ROOTS: repository.path,
    },
    readinessCacheMs: 0,
  });
  applications.push(application);
  if (start) await application.start();
  return application;
};

beforeAll(async () => {
  const root = await temporaryDirectory('git-optimizer-conformance-');
  repository = await initRepository(root);
  await seedRepository(repository);
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

afterAll(removeTemporaryDirectories);

describe('Platform conformance', () => {
  it('satisfies registry and routing contracts', async () => {
    const application = await createApplication(false);
    const registry = createToolRegistry(capabilityTools);
    const registryResult = await runRegistryConformance({
      registry,
      services: application.services,
      invalidInputSample: {
        name: 'summarize_commit_diff',
        input: { repositoryPath: 42 },
      },
    });
    const routingResult = runRoutingConformance({
      registry,
      instructions: capabilityInstructions,
    });
    expect(registryResult.failures).toEqual([]);
    expect(routingResult.failures).toEqual([]);
  });

  it('satisfies authentication and configuration contracts', async () => {
    expect((await runAuthConformance()).failures).toEqual([]);
    expect(
      (
        await runConfigConformance({
          serviceName: gitOptimizerManifest.name,
          serviceVersion: gitOptimizerManifest.version,
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies HTTP, MCP, OpenAPI, and transport parity contracts', async () => {
    const application = await createApplication();
    const sample = readSample();
    expect(
      (
        await runHttpConformance({
          app: application.http,
          registry: application.registry,
          apiKey,
          readSample: { name: sample.name, body: sample.input },
        })
      ).failures,
    ).toEqual([]);
    expect(
      (
        await runMcpConformance({
          createServer: () => application.createStdioServer(),
          registry: application.registry,
          instructions: capabilityInstructions,
          readSample: sample,
        })
      ).failures,
    ).toEqual([]);
    expect(
      runOpenApiConformance({
        document: application.openApiDocument(),
        registry: application.registry,
      }).failures,
    ).toEqual([]);
    expect(
      (
        await runTransportParity({
          app: application.http,
          createMcpServer: () => application.createStdioServer(),
          apiKey,
          samples: [sample],
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies lifecycle and readiness behavior', async () => {
    expect(
      (
        await runLifecycleConformance({
          createApplication: () => createApplication(false),
        })
      ).failures,
    ).toEqual([]);

    const application = await createApplication();
    const readiness = await application.readiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.state).toBe('ready');
    expect(readiness.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['git', 'repository_roots', 'git_capacity']),
    );

    const rootless = await createAgentToolApplication(gitOptimizerCapability, {
      logger: createSilentLogger(),
      env: {
        NODE_ENV: 'test',
        AUTH_MODE: 'disabled',
        GIT_LOCAL_PATHS_ENABLED: 'false',
      },
      readinessCacheMs: 0,
    });
    applications.push(rootless);
    await rootless.start();
    const rootlessReadiness = await rootless.readiness();
    expect(rootlessReadiness.ready).toBe(false);
    expect(rootlessReadiness.checks.find(({ name }) => name === 'repository_roots')?.state).toBe(
      'not_ready',
    );
  });

  it('satisfies scratch-workspace lifecycle conformance with Git services', async () => {
    const result = await runScratchWorkspaceConformance({
      createApplication: async () => {
        const application = await createApplication(false);
        return { application, workspace: application.services.scratch };
      },
    });
    expect(result.failures).toEqual([]);
  });

  it('satisfies shared root-boundary and process conformance', async () => {
    expect((await runRootBoundaryConformance()).failures).toEqual([]);
    expect((await runProcessConformance()).failures).toEqual([]);
  }, 90_000);

  it('publishes truthful repository metadata', async () => {
    const load = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    expect(
      runMetadataConformance({
        server: await load('../../server.json'),
        packageManifest: await load('../../package.json'),
        registryEntry: await load('../../examples/central-registry-entry.json'),
      }).failures,
    ).toEqual([]);
  });
});
