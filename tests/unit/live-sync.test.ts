/**
 * Live check against the real Supabase project (network). Skipped unless LIVE_SYNC=1.
 *   LIVE_SYNC=1 LIVE_EMAIL=... LIVE_PASSWORD=... npx vitest run tests/unit/live-sync.test.ts
 * Signs in (creating the account if needed), syncs a project from a "phone" database to a "pc" database through the
 * real records table, file bucket and Realtime feed, then deletes everything it created.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { InspectorDb, useDb as selectDb } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { SUPABASE_KEY, SUPABASE_URL } from '../../src/sync/config';
import { SyncEngine, type SyncStatus } from '../../src/sync/engine';
import { supabaseRemote } from '../../src/sync/supabaseRemote';

const live = process.env.LIVE_SYNC === '1';
const until = async (cond: () => Promise<boolean>, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('timed out');
};

describe.skipIf(!live)('live Supabase sync', () => {
  it('phone → cloud → pc, live, including a photo file; then cleans up', async () => {
    const email = process.env.LIVE_EMAIL!, password = process.env.LIVE_PASSWORD!;
    const mk = () => createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const phoneClient = mk(), pcClient = mk();
    let r = await phoneClient.auth.signInWithPassword({ email, password });
    if (r.error) { const s = await phoneClient.auth.signUp({ email, password }); if (s.error) throw s.error; r = await phoneClient.auth.signInWithPassword({ email, password }); }
    if (r.error) throw r.error;
    const pcSignIn = await pcClient.auth.signInWithPassword({ email, password });
    if (pcSignIn.error) throw pcSignIn.error;
    const uid = r.data.user!.id;
    const sharing = !(await phoneClient.from('project_members').select('project_id').limit(1)).error; // same detection as the app
    console.log(`sharing schema installed: ${sharing}`);

    const phoneDb = new InspectorDb(`live-phone-${Date.now()}`), pcDb = new InspectorDb(`live-pc-${Date.now()}`);
    const pcStatus: SyncStatus[] = [];
    const phone = new SyncEngine(phoneDb, supabaseRemote(phoneClient, uid, sharing), 'live-phone', () => {}, () => true, 0);
    const pc = new SyncEngine(pcDb, supabaseRemote(pcClient, uid, sharing), 'live-pc', (s) => pcStatus.push(s), () => true, 0);
    await pc.start();
    await until(async () => pcStatus.some((s) => s.kind === 'synced' && s.live));

    selectDb(phoneDb);
    const p = await repo.createProject({ name: `Live sync check ${new Date().toISOString()}` });
    const [floor] = await repo.listFloors(p.id);
    const cats = await repo.listCategories(p.id);
    await phone.start();
    const t0 = Date.now();
    const f = await repo.createFinding({ floorId: floor.id, u: 0.3, v: 0.6, categoryId: cats[0].id, title: 'Live crack' });
    await repo.addPhoto(f.id, { filename: 'x.jpg', mime: 'image/jpeg', width: 2, height: 2,
      original: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), display: new Blob([new Uint8Array([4])], { type: 'image/jpeg' }), thumbnail: new Blob([new Uint8Array([5])], { type: 'image/jpeg' }) });
    await phone.push();

    // The pc only listens: everything must arrive through the live feed.
    await until(async () => (await pcDb.photos.where('findingId').equals(f.id).count()) === 1);
    const lag = Date.now() - t0;
    expect((await pcDb.findings.get(f.id))?.title).toBe('Live crack');
    const ph = (await pcDb.photos.where('findingId').equals(f.id).toArray())[0];
    const asset = await pcDb.assets.get(ph.assetId);
    const fileIds = [asset!.originalBlobId, asset!.displayBlobId, asset!.thumbnailBlobId];
    const blob = (await pcDb.blobs.get(asset!.originalBlobId))!.data;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    console.log(`phone → pc (finding + photo, live): ${lag} ms`);

    // Delete on the phone; the pc follows.
    await repo.deleteProject(p.id);
    await phone.push();
    await until(async () => !(await pcDb.projects.get(p.id)));
    phone.stop(); pc.stop();

    // Clean up the cloud rows (tombstones) and any files.
    const del = await phoneClient.from('records').delete().eq('owner', uid).eq('project_id', p.id);
    expect(del.error).toBeNull();
    const files = await phoneClient.storage.from('blobs').list(uid);
    expect((files.data ?? []).filter((x) => fileIds.includes(x.name))).toEqual([]); // deleting the project removed its files
    await phoneClient.removeAllChannels(); await pcClient.removeAllChannels();
  }, 60000);
});
