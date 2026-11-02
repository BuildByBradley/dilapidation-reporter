import type { InspectorDb } from '../data/db';

const OWNER = 'syncUser';

/**
 * Which account the "already uploaded / last synced" bookkeeping belongs to.
 * Signing out and back in as the SAME account keeps it, so only what changed is sent (not every plan and photo again).
 * A DIFFERENT account starts clean: its bookkeeping must not claim the other account's files are already in its cloud.
 */
export async function adoptSyncState(db: InspectorDb, uid: string): Promise<'kept' | 'reset' | 'new'> {
  const owner = (await db.meta.get(OWNER))?.value;
  if (owner === uid) return 'kept';
  const had = owner !== undefined;
  // No recorded owner: state written before this was tracked belongs to whoever is signed in now, so it is kept.
  if (had) await db.transaction('rw', db.sync, db.meta, async () => { await db.sync.clear(); await db.meta.clear(); });
  await db.meta.put({ key: OWNER, value: uid });
  return had ? 'reset' : 'new';
}
