export type ItemStatus = 'pending' | 'complete';

export interface Item {
  readonly id: string;
  readonly title: string;
  readonly status: ItemStatus;
}

/** Domain port. Replace this interface and its adapter without changing transports. */
export interface ExampleProvider {
  listItems(): Promise<readonly Item[]>;
  getItem(id: string): Promise<Item | undefined>;
  updateItemStatus(id: string, status: ItemStatus): Promise<Item | undefined>;
}
