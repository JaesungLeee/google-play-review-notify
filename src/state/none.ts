import type { State, StateStore } from '../core/types';

/** No persistence. Every run baselines; only useful for tests and `--dry-run` experiments. */
export class NoneStateStore implements StateStore {
  readonly name = 'none';
  private memory: State | null = null;

  async load(): Promise<State | null> {
    return this.memory;
  }

  async save(state: State): Promise<void> {
    this.memory = state;
  }
}
