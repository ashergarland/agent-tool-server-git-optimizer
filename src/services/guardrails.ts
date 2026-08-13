import type { AppConfig } from '../config/index.js';
import { badRequest, forbidden } from '../errors.js';

export interface MutationRequest {
  readonly toolName: string;
  readonly confirm: boolean;
  readonly dryRun: boolean;
}

export class Guardrails {
  public constructor(private readonly config: AppConfig) {}

  /** Returns true for a preview; otherwise validates that execution is explicitly permitted. */
  public assertMutationAllowed(request: MutationRequest): boolean {
    if (request.dryRun) return true;
    if (!this.config.guardrails.mutationsEnabled) {
      throw forbidden(
        `Tool ${request.toolName} changes state and MUTATIONS_ENABLED is false; use dryRun=true`,
      );
    }
    if (this.config.guardrails.confirmationRequired && !request.confirm) {
      throw badRequest(`Tool ${request.toolName} requires explicit confirm=true`);
    }
    return false;
  }
}
