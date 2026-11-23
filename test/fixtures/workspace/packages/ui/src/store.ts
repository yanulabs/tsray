export interface Repository {
  save(value: string): void;
}

export class MemoryRepository implements Repository {
  private hidden(): string {
    return "hidden";
  }

  save(value: string): void {
    void this.hidden();
    void value;
  }
}

export interface Serializable {
  serialize(): string;
}

export type Snapshot = {
  serialize(): string;
};
