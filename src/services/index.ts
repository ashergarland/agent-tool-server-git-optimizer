import type { CapabilityContext } from '@agent-tool-platform/runtime/capability';
import type { ScratchWorkspace } from '@agent-tool-platform/runtime/lifecycle';
import type { GitConfig } from '../config/index.js';
import { createGitClient, type GitClient } from './git-exec.js';
import { GitService } from './git.js';
import { RepositoryBoundary } from './repository.js';

export interface GitServices {
  readonly git: GitService;
  readonly gitClient: GitClient;
  readonly boundary: RepositoryBoundary;
  close(): Promise<void>;
}

export interface CapabilityServices extends GitServices {
  readonly scratch: ScratchWorkspace;
}

export interface CreateServicesOptions {
  readonly gitClient?: GitClient;
  readonly scratchDirectory?: string;
}

export const createServices = (
  config: GitConfig,
  options: CreateServicesOptions = {},
): GitServices => {
  let gitClient = options.gitClient;
  if (!gitClient) {
    if (!options.scratchDirectory) {
      throw new Error('scratchDirectory is required when no Git client is injected');
    }
    gitClient = createGitClient(config, options.scratchDirectory);
  }
  const boundary = new RepositoryBoundary(config, gitClient);
  const git = new GitService(config, boundary, gitClient, config.git.noise);
  return {
    git,
    gitClient,
    boundary,
    close: () => gitClient.close(),
  };
};

export const createCapabilityServices = async (
  context: CapabilityContext<GitConfig>,
): Promise<CapabilityServices> => {
  const scratch = await context.createScratchWorkspace({ prefix: 'git-optimizer-' });
  return {
    ...createServices(context.config, { scratchDirectory: scratch.path }),
    scratch,
  };
};
