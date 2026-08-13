import type { AppConfig } from '../config/index.js';
import type { ExampleProvider } from '../provider/types.js';
import { Guardrails } from './guardrails.js';
import { ItemService } from './items.js';

export interface Services {
  readonly items: ItemService;
  readonly guardrails: Guardrails;
}

export const createServices = (config: AppConfig, provider: ExampleProvider): Services => {
  const guardrails = new Guardrails(config);
  return { guardrails, items: new ItemService(provider, guardrails) };
};
