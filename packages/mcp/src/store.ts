import fs from "node:fs";
import path from "node:path";
import { dataDir, runtimeDir } from "./env.js";

/**
 * Tiny JSON-file store. Good enough for a sandbox: one file per collection,
 * synchronous writes, seeded from data/<name>.seed.json on first boot.
 */
export class JsonStore<T extends { id: string }> {
  private file: string;
  private items: T[];

  constructor(private name: string) {
    this.file = path.join(runtimeDir, `${name}.json`);
    if (fs.existsSync(this.file)) {
      this.items = JSON.parse(fs.readFileSync(this.file, "utf8")) as T[];
    } else {
      const seed = path.join(dataDir, `${name}.seed.json`);
      this.items = fs.existsSync(seed) ? (JSON.parse(fs.readFileSync(seed, "utf8")) as T[]) : [];
      this.flush();
    }
  }

  all(): T[] {
    return [...this.items];
  }

  get(id: string): T | undefined {
    return this.items.find((i) => i.id === id);
  }

  insert(item: T): T {
    this.items.push(item);
    this.flush();
    return item;
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx === -1) return undefined;
    this.items[idx] = { ...this.items[idx], ...patch };
    this.flush();
    return this.items[idx];
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    this.flush();
    return this.items.length !== before;
  }

  reset(): void {
    const seed = path.join(dataDir, `${this.name}.seed.json`);
    this.items = fs.existsSync(seed) ? (JSON.parse(fs.readFileSync(seed, "utf8")) as T[]) : [];
    this.flush();
  }

  private flush() {
    fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2));
  }
}

export function shortId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}
