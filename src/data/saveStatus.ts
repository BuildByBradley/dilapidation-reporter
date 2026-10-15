import { useSyncExternalStore } from 'react';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string }
  | { kind: 'failed'; message: string };

let state: SaveState = { kind: 'idle' };
let pending = 0;
const listeners = new Set<() => void>();
const emit = (s: SaveState) => { state = s; listeners.forEach((l) => l()); };

export const getSaveState = () => state;
export const subscribeSave = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useSaveState = () => useSyncExternalStore(subscribeSave, getSaveState);
export const resetSaveState = () => { pending = 0; emit({ kind: 'idle' }); };

export function describeError(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'QuotaExceededError' || /quota/i.test(err?.message ?? '')) {
    return 'Browser storage is full. Free space (delete photos or projects, or back up and clear data) and retry.';
  }
  return err?.message || 'Unknown storage error';
}

/** Wrap a write: "Saved" is only reported after the transaction promise resolves. */
export async function tracked<T>(op: () => Promise<T>): Promise<T> {
  pending++;
  emit({ kind: 'saving' });
  try {
    const r = await op();
    pending--;
    if (pending === 0) emit({ kind: 'saved', at: new Date().toISOString() });
    return r;
  } catch (e) {
    pending--;
    emit({ kind: 'failed', message: describeError(e) });
    throw e;
  }
}
