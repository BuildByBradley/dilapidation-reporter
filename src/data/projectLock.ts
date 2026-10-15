/**
 * One editor per project: a Web Lock held for as long as the workspace is open.
 * A second tab does not get the lock and is shown read-only. Without the Web Locks API we cannot protect,
 * so we report unsupported and let the UI say so.
 */
export type LockHandle = { release(): void };
export const locksSupported = () => typeof navigator !== 'undefined' && !!navigator.locks;

export async function acquireProjectLock(projectId: string): Promise<LockHandle | null> {
  if (!locksSupported()) return { release() {} };
  return new Promise((resolve) => {
    try {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    navigator.locks.request(`dilapidation-project:${projectId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { resolve(null); return; }
      resolve({ release: () => release() });
      await held;
    }).catch(() => resolve({ release() {} }));
    } catch { resolve({ release() {} }); } // locks unavailable in this frame: do not block editing
  });
}
