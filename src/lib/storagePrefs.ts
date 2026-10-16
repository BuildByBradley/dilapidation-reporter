import { useSyncExternalStore } from 'react';
import { LIMITS } from './types';

/** Per-device storage preferences. localStorage can be blocked, so every access is guarded and defaults apply. */
const KEY = 'dilapidation-storage-prefs';
export type StoragePrefs = { keepOriginals: boolean; budgetBytes: number };
const DEFAULTS: StoragePrefs = { keepOriginals: false, budgetBytes: LIMITS.storageBudgetBytes };

let cache: StoragePrefs | null = null;
const listeners = new Set<() => void>();

function read(): StoragePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<StoragePrefs>;
      return {
        keepOriginals: typeof p.keepOriginals === 'boolean' ? p.keepOriginals : DEFAULTS.keepOriginals,
        budgetBytes: typeof p.budgetBytes === 'number' && p.budgetBytes >= 50 * 1048576 ? p.budgetBytes : DEFAULTS.budgetBytes,
      };
    }
  } catch { /* blocked or corrupt: use defaults */ }
  return DEFAULTS;
}
export const getStoragePrefs = (): StoragePrefs => (cache ??= read());
export function setStoragePrefs(patch: Partial<StoragePrefs>): void {
  cache = { ...getStoragePrefs(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* keep in memory for this session */ }
  listeners.forEach((l) => l());
}
export function useStoragePrefs(): StoragePrefs {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, getStoragePrefs, () => DEFAULTS);
}

export type Level = 'ok' | 'warn' | 'crit';
export const usageLevel = (used: number, budget: number): Level => { const r = budget > 0 ? used / budget : 0; return r >= 0.9 ? 'crit' : r >= 0.7 ? 'warn' : 'ok'; };
export const fmtBytes = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(n >= 104857600 ? 0 : 1)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
/** Roughly how many more photos fit in what is left of the budget. */
export const photosRemaining = (used: number, budget: number, avgPhotoBytes: number) => Math.max(0, Math.floor((budget - used) / Math.max(1, avgPhotoBytes)));
