import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { migrateState } from '../core/state';
import type { State, StateStore } from '../core/types';

/** Local JSON file. CLI default. Writes are atomic (temp file + rename). */
export class FileStateStore implements StateStore {
  readonly name = 'file';
  readonly path: string;

  constructor(path = '.play-review-notify/state.json') {
    this.path = resolve(path);
  }

  async load(): Promise<State | null> {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      return migrateState(JSON.parse(text));
    } catch {
      return null; // corrupt file → baseline
    }
  }

  async save(state: State): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    renameSync(tmp, this.path);
  }
}
