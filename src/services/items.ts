import { notFound } from '../errors.js';
import type { ExampleProvider, Item, ItemStatus } from '../provider/types.js';
import type { Guardrails } from './guardrails.js';

export class ItemService {
  public constructor(
    private readonly provider: ExampleProvider,
    private readonly guardrails: Guardrails,
  ) {}

  public list(): Promise<readonly Item[]> {
    return this.provider.listItems();
  }

  public async get(id: string): Promise<Item> {
    const item = await this.provider.getItem(id);
    if (!item) throw notFound(`Unknown item: ${id}`);
    return item;
  }

  public async updateStatus(input: {
    id: string;
    status: ItemStatus;
    confirm: boolean;
    dryRun: boolean;
  }): Promise<{ item: Item; performed: boolean; dryRun: boolean }> {
    const dryRun = this.guardrails.assertMutationAllowed({
      toolName: 'example_update_item',
      confirm: input.confirm,
      dryRun: input.dryRun,
    });
    const current = await this.get(input.id);
    if (dryRun)
      return { item: { ...current, status: input.status }, performed: false, dryRun: true };
    const item = await this.provider.updateItemStatus(input.id, input.status);
    if (!item) throw notFound(`Unknown item: ${input.id}`);
    return { item, performed: true, dryRun: false };
  }
}
