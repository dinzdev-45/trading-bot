import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSONL log (trades, decisions). No-op when path is empty. */
export class Journal {
  constructor(private readonly path: string) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }
  write(entry: object): void {
    if (!this.path) return;
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
