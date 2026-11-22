import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only JSONL log (trades, decisions). No-op when path is empty. */
export class Journal {
  private readonly listeners: ((entry: object) => void)[] = [];
  constructor(readonly path: string) {
    if (path) mkdirSync(dirname(path), { recursive: true });
  }
  /** Called for every entry written (even when the journal has no file). */
  onWrite(fn: (entry: object) => void): void {
    this.listeners.push(fn);
  }
  write(entry: object): void {
    for (const fn of this.listeners) fn(entry);
    if (!this.path) return;
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }
}
