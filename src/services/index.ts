import type { AppConfig } from '../config/index.js';
import { GitService, type GitRunner } from './git.js';
import { Guardrails } from './guardrails.js';

export interface Services {
  readonly git: GitService;
  readonly guardrails: Guardrails;
}

export const createServices = (config: AppConfig, gitRunner?: GitRunner): Services => {
  const guardrails = new Guardrails(config);
  return { guardrails, git: new GitService(gitRunner) };
};
