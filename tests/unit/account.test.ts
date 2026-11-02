import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { adoptSyncState } from '../../src/sync/account';

const seed = async () => {
  await db.sync.put({ key: 'blob:b1', kind: 'blob', id: 'b1', projectId: 'p1', hash: 'stored' });
  await db.meta.put({ key: 'cursor', value: '2026-10-20T00:00:00Z' });
};

describe('sync bookkeeping follows the account', () => {
  beforeEach(async () => { await db.sync.clear(); await db.meta.clear(); });

  it('keeps what is already uploaded when the same account signs back in', async () => {
    expect(await adoptSyncState(db, 'user-a')).toBe('new');
    await seed();
    expect(await adoptSyncState(db, 'user-a')).toBe('kept');
    expect(await db.sync.count()).toBe(1);
    expect((await db.meta.get('cursor'))?.value).toBe('2026-10-20T00:00:00Z');
  });

  it('starts clean for a different account', async () => {
    await adoptSyncState(db, 'user-a');
    await seed();
    expect(await adoptSyncState(db, 'user-b')).toBe('reset');
    expect(await db.sync.count()).toBe(0);
    expect(await db.meta.get('cursor')).toBeUndefined();
    expect((await db.meta.get('syncUser'))?.value).toBe('user-b');
  });

  it('adopts state written before accounts were tracked instead of resending everything', async () => {
    await seed();
    expect(await adoptSyncState(db, 'user-a')).toBe('new');
    expect(await db.sync.count()).toBe(1);
    expect((await db.meta.get('syncUser'))?.value).toBe('user-a');
  });
});
