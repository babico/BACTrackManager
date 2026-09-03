import type { JournalBackend } from "./store.js";

export class MemoryBackend implements JournalBackend {
  private rows: string[] = [];
  async append(row: string): Promise<void> {
    this.rows.push(row);
  }
  async readAll(): Promise<string[]> {
    return [...this.rows];
  }
  async replaceAll(rows: string[]): Promise<void> {
    this.rows = [...rows];
  }
}
