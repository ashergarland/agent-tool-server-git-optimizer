import type { ExampleProvider, Item, ItemStatus } from './types.js';

/** Replaceable demonstration adapter. Production templates should provide a real provider. */
export class MemoryProvider implements ExampleProvider {
  private readonly items = new Map<string, Item>([
    ['example-1', { id: 'example-1', title: 'Replace the example provider', status: 'pending' }],
  ]);

  public listItems(): Promise<readonly Item[]> {
    return Promise.resolve([...this.items.values()]);
  }

  public getItem(id: string): Promise<Item | undefined> {
    return Promise.resolve(this.items.get(id));
  }

  public updateItemStatus(id: string, status: ItemStatus): Promise<Item | undefined> {
    const current = this.items.get(id);
    if (!current) return Promise.resolve(undefined);
    const updated = { ...current, status };
    this.items.set(id, updated);
    return Promise.resolve(updated);
  }
}
