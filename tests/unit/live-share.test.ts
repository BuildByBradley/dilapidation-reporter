/**
 * Live sharing check against the real Supabase project (network). Skipped unless LIVE_SYNC=1.
 * Owner shares a project with a photo by invite link; the invitee joins, receives it (records + file), edits as editor;
 * a viewer cannot write; the owner deletes it and everyone's copy goes. Uses two test accounts.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { InspectorDb, useDb as selectDb } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { SUPABASE_KEY, SUPABASE_URL } from '../../src/sync/config';
import { SyncEngine } from '../../src/sync/engine';
import { supabaseRemote } from '../../src/sync/supabaseRemote';

const live = process.env.LIVE_SYNC === '1';
const until = async (cond: () => Promise<boolean>, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error('timed out');
};
async function account(email: string, password: string): Promise<{ c: SupabaseClient; uid: string }> {
  const c = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  let r = await c.auth.signInWithPassword({ email, password });
  if (r.error) { await c.auth.signUp({ email, password }); r = await c.auth.signInWithPassword({ email, password }); }
  if (r.error) throw r.error;
  return { c, uid: r.data.user!.id };
}

describe.skipIf(!live)('live sharing', () => {
  it('invite link → member receives the project live, edits it; owner deletion reaches everyone', async () => {
    const pw = process.env.LIVE_PASSWORD!;
    const A = await account('sync-check@buildbybradley-test.dev', pw);
    const B = await account('share-check@buildbybradley-test.dev', pw);
    const aDb = new InspectorDb(`share-a-${Date.now()}`), bDb = new InspectorDb(`share-b-${Date.now()}`);
    const a = new SyncEngine(aDb, supabaseRemote(A.c, A.uid, true), 'share-a', () => {}, () => true, 0);
    const b = new SyncEngine(bDb, supabaseRemote(B.c, B.uid, true), 'share-b', () => {}, () => true, 0);

    selectDb(aDb);
    const p = await repo.createProject({ name: `Share check ${new Date().toISOString()}` });
    const [floor] = await repo.listFloors(p.id);
    const cats = await repo.listCategories(p.id);
    const f = await repo.createFinding({ floorId: floor.id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 'Shared crack' });
    await repo.addPhoto(f.id, { filename: 'p.jpg', mime: 'image/jpeg', width: 2, height: 2,
      original: new Blob([new Uint8Array([7, 7, 7])], { type: 'image/jpeg' }), display: new Blob([new Uint8Array([7, 7, 7])], { type: 'image/jpeg' }), thumbnail: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) });
    await a.start(); await a.idle();
    const role = await A.c.from('project_members').select('role').eq('project_id', p.id).eq('user_id', A.uid).single();
    expect(role.data?.role).toBe('owner'); // claimed on first upload

    // B cannot see it yet
    expect((await B.c.from('records').select('id').eq('project_id', p.id)).data).toEqual([]);
    const inv = await A.c.from('project_invites').insert({ project_id: p.id, role: 'editor', project_name: 'x' }).select('token').single();
    expect(inv.error).toBeNull();
    await b.start();
    const acc = await B.c.rpc('accept_invite', { t: inv.data!.token });
    expect(acc.error).toBeNull();
    await b.resyncAll(); await b.idle();
    await until(async () => (await bDb.photos.where('findingId').equals(f.id).count()) === 1);
    expect((await bDb.findings.get(f.id))?.title).toBe('Shared crack');
    const ph = (await bDb.photos.where('findingId').equals(f.id).toArray())[0];
    const asset = await bDb.assets.get(ph.assetId);
    expect(new Uint8Array(await (await bDb.blobs.get(asset!.originalBlobId))!.data.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));

    // the link cannot be reused
    expect((await A.c.rpc('accept_invite', { t: inv.data!.token })).error).not.toBeNull();

    // B edits; A sees it live
    selectDb(bDb);
    await repo.updateFinding(f.id, { title: 'Shared crack (edited by member)' });
    await b.push();
    await a.syncNow(); await a.idle();
    await until(async () => (await aDb.findings.get(f.id))?.title === 'Shared crack (edited by member)');

    // B as editor cannot delete the project for everyone
    const tomb = await B.c.from('records').update({ deleted: true }).eq('kind', 'projects').eq('id', p.id).select('id');
    expect(tomb.error ?? (tomb.data?.length === 0 ? 'blocked' : null)).not.toBeNull();

    // switch B to viewer: writes are refused
    await A.c.from('project_members').update({ role: 'viewer' }).eq('project_id', p.id).eq('user_id', B.uid);
    const w = await B.c.from('records').update({ data: { title: 'nope' } }).eq('kind', 'findings').eq('id', f.id).select('id');
    expect(w.data ?? []).toEqual([]);

    // owner deletes the project: B's copy goes too, files are removed
    selectDb(aDb);
    await repo.deleteProject(p.id);
    await a.push();
    await b.syncNow(); await b.idle();
    await until(async () => !(await bDb.projects.get(p.id)));
    const left = await A.c.storage.from('blobs').list(p.id);
    expect(left.data ?? []).toEqual([]);
    a.stop(); b.stop();
    await A.c.removeAllChannels(); await B.c.removeAllChannels();
  }, 90000);
});
