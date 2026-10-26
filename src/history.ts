import type { AppState } from "./state";

/** Fields that are part of the gradient; view preferences (solid style, opacity) are not undoable. */
const KEYS = [
  "a", "b", "space", "mode", "hueMode", "points", "arcBend", "arcRoll", "stops", "spacing", "easing", "gamut",
] as const satisfies readonly (keyof AppState)[];

type Snapshot = Pick<AppState, (typeof KEYS)[number]>;

/** Edits to the same fields within this long merge into one step (slider scrubs, drags). */
const MERGE_MS = 600;
const LIMIT = 200;

/**
 * Undo/redo over snapshots of the gradient state. Call `record` after every
 * change; it pushes a step only when something differs from the current one,
 * so applying a snapshot and re-rendering records nothing.
 */
export class UndoHistory {
  private stack: string[] = [];
  private at = -1;
  private lastKeys = "";
  private lastTime = 0;
  /** While true, edits to the same fields always merge (an open pointer drag). */
  holding = false;

  constructor(private onChange: () => void = () => {}) {}

  get canUndo() { return this.at > 0; }
  get canRedo() { return this.at < this.stack.length - 1; }

  record(state: AppState) {
    const snap = JSON.stringify(pick(state));
    if (snap === this.stack[this.at]) return;
    const prev = this.at >= 0 ? (JSON.parse(this.stack[this.at]) as Snapshot) : null;
    const next = JSON.parse(snap) as Snapshot;
    const keys = prev ? KEYS.filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])).join() : "";
    const now = performance.now();
    const merge =
      prev && this.at > 0 && keys === this.lastKeys && (this.holding || now - this.lastTime < MERGE_MS);
    this.lastKeys = keys;
    this.lastTime = now;
    if (merge) {
      this.stack[this.at] = snap;
      this.stack.length = this.at + 1;
    } else {
      this.stack.length = this.at + 1;
      this.stack.push(snap);
      if (this.stack.length > LIMIT) this.stack.shift();
      this.at = this.stack.length - 1;
    }
    this.onChange();
  }

  undo(state: AppState): boolean { return this.go(state, this.at - 1); }
  redo(state: AppState): boolean { return this.go(state, this.at + 1); }

  private go(state: AppState, to: number): boolean {
    if (to < 0 || to >= this.stack.length) return false;
    this.at = to;
    this.lastKeys = "";
    Object.assign(state, JSON.parse(this.stack[to]) as Snapshot);
    this.onChange();
    return true;
  }
}

function pick(s: AppState): Snapshot {
  const out: Partial<Snapshot> = {};
  for (const k of KEYS) (out as Record<string, unknown>)[k] = s[k];
  return out as Snapshot;
}
