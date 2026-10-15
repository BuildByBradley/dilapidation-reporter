import { beforeEach, describe, expect, it } from 'vitest';
import { InspectorDb, useDb as selectDb } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { resetSaveState } from '../../src/data/saveStatus';
import { SyncEngine, hashRow, stableJson, type Kind, type RecordRow, type Remote, type RemoteRecord } from '../../src/sync/engine';

/** In-memory stand-in for Supabase: one records table, one file bucket, a live feed. */
class FakeCloud {
  records = new Map<string, RemoteRecord>();
  files = new Map<string, Blob>();
  subs = new Set<(r: RemoteRecord) => void>();
  clock = Date.parse('2026-10-15T10:00:00Z');
  online = true;
  remote(): Remote {
    const self = this; // eslint-disable-line @typescript-eslint/no-this-alias
    const check = () => { if (!self.online) throw new Error('network down'); };
    return {
      async upsert(rows: RecordRow[]) {
        check();
        for (const r of rows) {
          const rec: RemoteRecord = { ...structuredClone(r), updated_at: new Date(++self.clock).toISOString() };
          self.records.set(`${r.kind}:${r.id}`, rec);
          self.subs.forEach((s) => s(structuredClone(rec)));
        }
      },
      async fetchSince(since) { check(); return [...self.records.values()].filter((r) => !since || r.updated_at > since).map((r) => structuredClone(r)); },
      async fetchOne(kind: Kind, id) { check(); const r = self.records.get(`${kind}:${id}`); return r ? structuredClone(r) : null; },
      async uploadBlob(id, b) { check(); self.files.set(id, b); },
      async downloadBlob(id) { check(); return self.files.get(id) ?? null; },
      async deleteBlobs(ids) { check(); ids.forEach((id) => self.files.delete(id)); },
      subscribe(on, onLive) { self.subs.add(on); onLive(true); return () => self.subs.delete(on); },
    };
  }
}

const img = (n: number): repo.ProcessedImage => ({
  filename: `f${n}.png`, mime: 'image/png', width: 400, height: 300,
  original: new Blob([new Uint8Array([1, n])]), display: new Blob([new Uint8Array([2, n])]), thumbnail: new Blob([new Uint8Array([3, n])]),
});

let n = 0;
let cloud: FakeCloud;
const dbs: InspectorDb[] = [];
function device(name: string) {
  const db = new InspectorDb(`sync-${name}-${++n}`);
  dbs.push(db);
  const engine = new SyncEngine(db, cloud.remote(), `${name}-${n}`, () => {}, () => cloud.online, 0);
  return { db, engine };
}
/** Run repo code against one device's database. */
async function on<T>(db: InspectorDb, fn: () => Promise<T>): Promise<T> { selectDb(db); return fn(); }
const settle = async (...es: SyncEngine[]) => { for (let i = 0; i < 3; i++) for (const e of es) { await e.push(); await e.idle(); } };

beforeEach(() => { cloud = new FakeCloud(); resetSaveState(); });

describe('hashing', () => {
  it('is stable across key order and undefined fields (jsonb round trip)', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
    expect(hashRow({ a: 1, b: 'x', u: undefined })).toBe(hashRow(JSON.parse('{"b":"x","a":1}')));
    expect(hashRow({ a: 1 })).not.toBe(hashRow({ a: 2 }));
  });
});

describe('phone → PC live sync', () => {
  it('a project, plan, finding and photo logged on the phone appear on the PC', async () => {
    const phone = device('phone'), pc = device('pc');
    await pc.engine.start();
    const { p, floor, finding } = await on(phone.db, async () => {
      const p = await repo.createProject({ name: 'Site A' });
      const [floor] = await repo.listFloors(p.id);
      await repo.setFloorPlan(floor.id, img(1));
      const cats = await repo.listCategories(p.id);
      const finding = await repo.createFinding({ floorId: floor.id, u: 0.25, v: 0.5, categoryId: cats[0].id, title: 'Crack above door' });
      await repo.addPhoto(finding.id, img(2), 'close-up');
      return { p, floor, finding };
    });
    await phone.engine.start();
    await settle(phone.engine, pc.engine);

    expect((await pc.db.projects.get(p.id))?.name).toBe('Site A');
    const pcFloor = await pc.db.floors.get(floor.id);
    const asset = await pc.db.assets.get(pcFloor!.planAssetId!);
    expect(await pc.db.blobs.get(asset!.displayBlobId)).toBeTruthy();
    expect((await pc.db.findings.get(finding.id))?.title).toBe('Crack above door');
    const photos = await pc.db.photos.where('findingId').equals(finding.id).toArray();
    expect(photos).toHaveLength(1);
    const pAsset = await pc.db.assets.get(photos[0].assetId);
    expect(await pc.db.blobs.get(pAsset!.thumbnailBlobId)).toBeTruthy();

    // Live edit after the initial sync
    await on(phone.db, () => repo.updateFinding(finding.id, { title: 'Crack above door (widened)' }));
    await settle(phone.engine, pc.engine);
    expect((await pc.db.findings.get(finding.id))?.title).toBe('Crack above door (widened)');

    // Deleting a finding on the PC removes it (and its photo files) on the phone
    await on(pc.db, () => repo.deleteFinding(finding.id));
    await settle(pc.engine, phone.engine);
    expect(await phone.db.findings.get(finding.id)).toBeUndefined();
    expect(await phone.db.photos.where('findingId').equals(finding.id).count()).toBe(0);
    expect(cloud.files.has(pAsset!.thumbnailBlobId)).toBe(false);
    phone.engine.stop(); pc.engine.stop();
  });

  it('changes made offline wait, then upload when the connection returns; a late device catches up', async () => {
    const phone = device('phone');
    await phone.engine.start();
    cloud.online = false;
    const p = await on(phone.db, () => repo.createProject({ name: 'No signal' }));
    await phone.engine.push();
    expect(cloud.records.size).toBe(0);
    cloud.online = true;
    await phone.engine.push();
    expect(cloud.records.get(`projects:${p.id}`)?.data?.name).toBe('No signal');

    const pc = device('pc');
    await pc.engine.start(); // not running while the phone worked: catches up from the cloud
    await pc.engine.idle();
    expect((await pc.db.projects.get(p.id))?.name).toBe('No signal');
    expect(await pc.db.floors.where('projectId').equals(p.id).count()).toBe(5);
    phone.engine.stop(); pc.engine.stop();
  });

  it('an unsynced local edit is not overwritten by an older incoming change', async () => {
    const phone = device('phone'), pc = device('pc');
    const p = await on(phone.db, () => repo.createProject({ name: 'Original' }));
    await phone.engine.start(); await pc.engine.start(); await settle(phone.engine, pc.engine);
    pc.engine.stop(); // PC goes quiet with a pending edit
    await on(pc.db, () => repo.updateProject(p.id, { name: 'PC edit' }));
    await on(phone.db, () => repo.updateProject(p.id, { name: 'Phone edit' }));
    await settle(phone.engine);
    const pc2 = new SyncEngine(pc.db, cloud.remote(), 'pc-again', () => {}, () => true, 0);
    await pc2.start(); await pc2.idle();
    expect((await pc.db.projects.get(p.id))?.name).toBe('PC edit');
    expect(cloud.records.get(`projects:${p.id}`)?.data?.name).toBe('PC edit');
    phone.engine.stop(); pc2.stop();
  });

  it('a record that arrives before its file is in the cloud gets the file on a later pull', async () => {
    const phone = device('phone'), pc = device('pc');
    const { asset } = await on(phone.db, async () => {
      const p = await repo.createProject({ name: 'Race' });
      const [floor] = await repo.listFloors(p.id);
      const asset = await repo.setFloorPlan(floor.id, img(7));
      return { asset };
    });
    await phone.engine.start(); await phone.engine.idle();
    const held = cloud.files.get(asset.displayBlobId)!;
    cloud.files.delete(asset.displayBlobId); // file not visible yet
    await pc.engine.start(); await pc.engine.idle();
    expect(await pc.db.assets.get(asset.id)).toBeTruthy();
    expect(await pc.db.blobs.get(asset.displayBlobId)).toBeUndefined();
    cloud.files.set(asset.displayBlobId, held);
    await pc.engine.pull(); await pc.engine.idle();
    expect(await pc.db.blobs.get(asset.displayBlobId)).toBeTruthy();
    expect((await pc.db.meta.get('missingBlobs'))?.value).toBe('{}');
    phone.engine.stop(); pc.engine.stop();
  });
});
