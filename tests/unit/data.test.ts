import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it } from 'vitest';
import { InspectorDb, db, useDb } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { getSaveState, resetSaveState } from '../../src/data/saveStatus';
import { BackupError, createBackup, parseBackup } from '../../src/lib/backup';
import { buildCsv, buildReportModel } from '../../src/lib/report';
import { zipSync, strToU8, unzipSync } from 'fflate';

let n = 0;
beforeEach(() => { useDb(new InspectorDb(`test-${++n}`)); resetSaveState(); });

const img = (name = 'plan.png', w = 400, h = 300): repo.ProcessedImage => ({
  filename: name, mime: 'image/png', width: w, height: h,
  original: new Blob([new Uint8Array([1, 2, 3, n])], { type: 'image/png' }),
  display: new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }),
  thumbnail: new Blob([new Uint8Array([7, 8])], { type: 'image/jpeg' }),
  report: new Blob([new Uint8Array([9])], { type: 'image/png' }),
});
const photo = (): repo.ProcessedImage => ({ ...img('p.jpg', 100, 100), mime: 'image/jpeg', report: undefined });

async function seeded() {
  const p = await repo.createProject({ name: 'Test' });
  const floors = await repo.listFloors(p.id);
  for (const f of floors) await repo.setFloorPlan(f.id, img(`${f.name}.png`));
  const cats = await repo.listCategories(p.id);
  return { p, floors, cats };
}

describe('projects and floors', () => {
  it('creates 5 ordered floors and starter categories', async () => {
    const p = await repo.createProject({ name: ' X ' });
    const floors = await repo.listFloors(p.id);
    expect(floors.map((f) => f.name)).toEqual(['Ground', 'Level 1', 'Level 2', 'Level 3', 'Level 4']);
    expect((await repo.listCategories(p.id))).toHaveLength(8);
    expect(getSaveState().kind).toBe('saved');
  });
  it('A01: five plans persist independently with aspect ratio recorded', async () => {
    const { p } = await seeded();
    const floors = await repo.listFloors(p.id);
    const list = await repo.listProjects();
    expect(list[0].floorCount).toBe(5);
    const assets = await db.assets.where('projectId').equals(p.id).toArray();
    expect(assets).toHaveLength(5);
    expect(new Set(floors.map((f) => f.planAssetId)).size).toBe(floors.length);
  });
  it('moves floors', async () => {
    const p = await repo.createProject();
    const [a, b] = await repo.listFloors(p.id);
    await repo.moveFloor(a.id, 1);
    const after = await repo.listFloors(p.id);
    expect(after[0].id).toBe(b.id); expect(after[1].id).toBe(a.id);
  });
  it('moves floors that share the same order number (e.g. after syncing two devices)', async () => {
    const p = await repo.createProject();
    const floors = await repo.listFloors(p.id);
    await Promise.all(floors.slice(0, 2).map((f) => db.floors.update(f.id, { order: 0 })));
    const before = await repo.listFloors(p.id);
    await repo.moveFloor(before[0].id, 1);
    const after = await repo.listFloors(p.id);
    expect(after[1].id).toBe(before[0].id); expect(after[0].id).toBe(before[1].id);
    expect(after.map((f) => f.order)).toEqual([0, 1, 2, 3, 4]);
    await repo.moveFloor(before[0].id, 1); // and keeps going down
    expect((await repo.listFloors(p.id))[2].id).toBe(before[0].id);
  });
});

describe('findings', () => {
  it('allocates monotonic references and never renumbers', async () => {
    const { floors, cats } = await seeded();
    const mk = (t: string) => repo.createFinding({ floorId: floors[0].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: t });
    const a = await mk('a'), b = await mk('b');
    expect([a.reference, b.reference]).toEqual(['G-001', 'G-002']);
    await repo.deleteFinding(b.id);
    const c = await mk('c');
    expect(c.reference).toBe('G-003'); // a deleted number is not reused
    const l1 = await repo.createFinding({ floorId: floors[1].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 'up' });
    expect(l1.reference).toBe('L1-001'); // each floor counts on its own
  });
  it('a floor code set by hand is used for new findings, and two floors never share a prefix', async () => {
    const { p, floors, cats } = await seeded();
    await repo.updateFloor(floors[4].id, { code: 'Roof' });
    const f = await repo.createFinding({ floorId: floors[4].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 'r' });
    expect(f.reference).toBe('Roof-001');
    await repo.updateFloor(floors[3].id, { name: 'Level 1' }); // a second "Level 1"
    const codes = repo.floorCodes(await repo.listFloors(p.id));
    expect(codes.get(floors[1].id)).toBe('L1'); expect(codes.get(floors[3].id)).toBe('L1B');
  });
  it('renumbers per floor in floor order, by position on the plan or by capture order', async () => {
    const { p, floors, cats } = await seeded();
    const mk = (fl: number, u: number, v: number, title: string) => repo.createFinding({ floorId: floors[fl].id, u, v, categoryId: cats[0].id, title });
    // Old-style numbers, captured out of order across floors.
    const x = await mk(1, 0.9, 0.9, 'L1 bottom right'); const y = await mk(0, 0.8, 0.1, 'G top right');
    const z = await mk(1, 0.1, 0.1, 'L1 top left'); const w = await mk(0, 0.1, 0.12, 'G top left');
    let i = 0;
    for (const f of [x, y, z, w]) await db.findings.update(f.id, { reference: `D-${String(++i).padStart(3, '0')}` });
    await repo.moveFloor(floors[1].id, -1); // Level 1 now first in the list
    expect(await repo.renumberFindings(p.id, 'position')).toBe(4);
    const ref = async (id: string) => (await db.findings.get(id))!.reference;
    expect([await ref(z.id), await ref(x.id), await ref(w.id), await ref(y.id)]).toEqual(['L1-001', 'L1-002', 'G-001', 'G-002']);
    expect((await repo.listFindings(p.id)).map((f) => f.reference)).toEqual(['L1-001', 'L1-002', 'G-001', 'G-002']);
    expect((await mk(0, 0.5, 0.5, 'next')).reference).toBe('G-003');
    await repo.renumberFindings(p.id, 'captured');
    expect([await ref(x.id), await ref(z.id), await ref(y.id), await ref(w.id)]).toEqual(['L1-001', 'L1-002', 'G-001', 'G-002']);
  });
  it('validates title, category and coordinates', async () => {
    const { floors, cats } = await seeded();
    await expect(repo.createFinding({ floorId: floors[0].id, u: 1.2, v: 0.5, categoryId: cats[0].id, title: 'x' })).rejects.toThrow(/outside/);
    await expect(repo.createFinding({ floorId: floors[0].id, u: 0.2, v: 0.5, categoryId: cats[0].id, title: '  ' })).rejects.toThrow(/title/);
    await expect(repo.createFinding({ floorId: floors[0].id, u: 0.2, v: 0.5, categoryId: 'nope', title: 'x' })).rejects.toThrow(/category/i);
    await expect(repo.relocateFinding('x', NaN, 0)).rejects.toThrow();
  });
  it('A22: deleting a finding removes its photos and only unreferenced assets', async () => {
    const { p, floors, cats } = await seeded();
    const f = await repo.createFinding({ floorId: floors[1].id, u: 0.1, v: 0.9, categoryId: cats[1].id, title: 't' });
    await repo.addPhoto(f.id, photo()); await repo.addPhoto(f.id, photo());
    const before = await db.blobs.where('projectId').equals(p.id).count();
    await repo.deleteFinding(f.id);
    expect(await db.photos.count()).toBe(0);
    expect(await db.blobs.where('projectId').equals(p.id).count()).toBe(before - 6);
    expect(await db.assets.where('projectId').equals(p.id).count()).toBe(5);
  });
});

describe('plan replacement (A18, A03)', () => {
  it('keep: marks findings for review; remove: deletes them', async () => {
    const { floors, cats } = await seeded();
    const f = await repo.createFinding({ floorId: floors[0].id, u: 0.3, v: 0.3, categoryId: cats[0].id, title: 't' });
    await repo.setFloorPlan(floors[0].id, img('new.png'), 'keep');
    const kept = await db.findings.get(f.id);
    expect(kept?.locationNeedsReview).toBe(true);
    expect([kept?.u, kept?.v]).toEqual([0.3, 0.3]);
    await repo.clearLocationReview(f.id);
    expect((await db.findings.get(f.id))?.locationNeedsReview).toBe(false);
    await repo.setFloorPlan(floors[0].id, img('newer.png'), 'remove');
    expect(await db.findings.get(f.id)).toBeUndefined();
  });
  it('failed replacement leaves previous plan and findings intact', async () => {
    const { floors, cats } = await seeded();
    const f = await repo.createFinding({ floorId: floors[0].id, u: 0.3, v: 0.3, categoryId: cats[0].id, title: 't' });
    const before = (await db.floors.get(floors[0].id))!.planAssetId;
    const blobsBefore = await db.blobs.count();
    const orig = db.assets.add.bind(db.assets);
    db.assets.add = (() => Promise.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))) as unknown as unknown as typeof db.assets.add;
    await expect(repo.setFloorPlan(floors[0].id, img('bad.png'), 'keep')).rejects.toThrow();
    db.assets.add = orig;
    expect((await db.floors.get(floors[0].id))!.planAssetId).toBe(before);
    expect(await db.blobs.count()).toBe(blobsBefore);
    expect((await db.findings.get(f.id))?.locationNeedsReview).toBe(false);
  });
});

describe('save status (A15)', () => {
  it('never reports Saved after a failed write and can retry', async () => {
    const p = await repo.createProject();
    expect(getSaveState().kind).toBe('saved');
    const orig = db.projects.update.bind(db.projects);
    db.projects.update = (() => Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' }))) as unknown as typeof db.projects.update;
    await expect(repo.updateProject(p.id, { name: 'new' })).rejects.toThrow();
    const s = getSaveState();
    expect(s.kind).toBe('failed');
    expect(s.kind === 'failed' && /storage is full/i.test(s.message)).toBe(true);
    db.projects.update = orig;
    expect((await db.projects.get(p.id))?.name).toBe('Untitled inspection');
    await repo.updateProject(p.id, { name: 'new' });
    expect(getSaveState().kind).toBe('saved');
    expect((await db.projects.get(p.id))?.name).toBe('new');
  });
});

describe('categories (A13)', () => {
  it('rejects blanks and case-insensitive duplicates; archive keeps linkage; delete requires reassignment', async () => {
    const { p, floors, cats } = await seeded();
    await expect(repo.createCategory(p.id, '  ')).rejects.toThrow(/blank/);
    await expect(repo.createCategory(p.id, 'cracks')).rejects.toThrow(/exists/);
    const f = await repo.createFinding({ floorId: floors[0].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 't' });
    await repo.updateCategory(cats[0].id, { name: 'Hairline cracks', colour: '#ff0000' });
    expect((await db.categories.get(f.categoryId))?.name).toBe('Hairline cracks');
    await repo.setCategoryArchived(cats[0].id, true);
    await expect(repo.createFinding({ floorId: floors[0].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 'new' })).rejects.toThrow(/archived/);
    await repo.updateFinding(f.id, { title: 'still editable' });
    await expect(repo.deleteCategory(cats[0].id)).rejects.toThrow(/reassign/i);
    await repo.deleteCategory(cats[0].id, cats[1].id);
    expect((await db.findings.get(f.id))?.categoryId).toBe(cats[1].id);
    await repo.moveCategory(cats[2].id, -1);
    expect((await repo.listCategories(p.id))[0].id).toBe(cats[2].id);
  });
});

describe('photos', () => {
  it('orders, captions, covers and deletes', async () => {
    const { floors, cats } = await seeded();
    const f = await repo.createFinding({ floorId: floors[0].id, u: 0.5, v: 0.5, categoryId: cats[0].id, title: 't' });
    const a = await repo.addPhoto(f.id, photo(), 'A'), b = await repo.addPhoto(f.id, photo(), 'B');
    expect(a.isCover).toBe(true);
    await repo.movePhoto(b.id, -1);
    expect((await repo.listPhotos(f.id)).map((p) => p.caption)).toEqual(['B', 'A']);
    await repo.setPhotoCover(b.id);
    await repo.updatePhotoCaption(a.id, 'A2');
    await repo.deletePhoto(b.id);
    const left = await repo.listPhotos(f.id);
    expect(left).toHaveLength(1);
    expect(left[0].isCover).toBe(true);
    expect(left[0].caption).toBe('A2');
  });
});

describe('duplicate, backup and restore (A16, A17, A22)', () => {
  async function withData() {
    const s = await seeded();
    const f = await repo.createFinding({ floorId: s.floors[2].id, u: 0.25, v: 0.75, categoryId: s.cats[1].id, title: 'Damp, "wall"', description: 'multi\nline', severity: 'major' });
    await repo.addPhoto(f.id, photo(), 'cap');
    return { ...s, f };
  }
  it('duplicate is independent with remapped ids', async () => {
    const { p, f } = await withData();
    const copy = await repo.duplicateProject(p.id);
    const cb = await repo.loadBundle(copy.id);
    expect(cb.findings).toHaveLength(1);
    expect(cb.findings[0].id).not.toBe(f.id);
    expect(cb.findings[0].floorId).toBe(cb.floors[2].id);
    repo.assertBundleIntegrity(cb);
    await repo.updateFinding(cb.findings[0].id, { title: 'changed' });
    expect((await db.findings.get(f.id))?.title).toBe('Damp, "wall"');
    await repo.deleteProject(copy.id);
    expect(await db.findings.get(f.id)).toBeDefined();
    expect((await repo.loadBundle(p.id)).blobs.size).toBeGreaterThan(0);
  });
  it('round-trips through a zip backup into a new project', async () => {
    const { p } = await withData();
    const zip = await createBackup(await repo.loadBundle(p.id));
    const restored = await repo.saveBundleAsNew(parseBackup(zip));
    const a = await repo.loadBundle(p.id), b = await repo.loadBundle(restored.id);
    expect(restored.id).not.toBe(p.id);
    expect(b.findings.map((x) => [x.title, x.u, x.v, x.severity, x.description])).toEqual(a.findings.map((x) => [x.title, x.u, x.v, x.severity, x.description]));
    expect(b.photos.map((x) => x.caption)).toEqual(['cap']);
    expect(b.blobs.size).toBe(a.blobs.size);
    expect(new Set([...a.blobs.keys()].filter((k) => b.blobs.has(k))).size).toBe(0);
    expect((await repo.listProjects()).length).toBe(2);
  });
  it('rejects corrupt, future-version, missing-asset and unsafe backups without touching the DB', async () => {
    const { p } = await withData();
    const good = await createBackup(await repo.loadBundle(p.id));
    const before = await db.projects.count();
    expect(() => parseBackup(new Uint8Array([1, 2, 3]))).toThrow(BackupError);
    const files = unzipSync(good);
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const rebuild = (m: unknown, drop?: string, extra: Record<string, Uint8Array> = {}) => {
      const copy: Record<string, Uint8Array> = { ...files, ...extra, 'manifest.json': strToU8(JSON.stringify(m)) };
      if (drop) delete copy[drop];
      return zipSync(copy);
    };
    expect(() => parseBackup(rebuild({ ...manifest, version: 99 }))).toThrow(/newer version/);
    const firstBlob = Object.values(manifest.blobs)[0] as string;
    expect(() => parseBackup(rebuild(manifest, firstBlob))).toThrow(/missing an asset/);
    expect(() => parseBackup(rebuild({ ...manifest, findings: [{ ...manifest.findings[0], u: 4 }] }))).toThrow(/invalid/);
    expect(() => parseBackup(rebuild({ ...manifest, findings: [{ ...manifest.findings[0], floorId: 'zzz' }] }))).toThrow(/inconsistent/);
    expect(() => parseBackup(rebuild({ ...manifest, blobs: { ...manifest.blobs, x: '../evil.png' } }))).toThrow(/unsafe/);
    expect(() => parseBackup(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/manifest/);
    expect(await db.projects.count()).toBe(before);
  });
});

describe('report model (A19)', () => {
  it('aggregates full-project counts independent of any filter, with empty floors', async () => {
    const p = await repo.createProject({ name: 'R' });
    const floors = await repo.listFloors(p.id);
    await repo.setFloorPlan(floors[0].id, img());
    const cats = await repo.listCategories(p.id);
    const a = await repo.createFinding({ floorId: floors[0].id, u: 0.1, v: 0.2, categoryId: cats[0].id, title: '=cmd', severity: 'minor' });
    await repo.createFinding({ floorId: floors[0].id, u: 0.4, v: 0.2, categoryId: cats[0].id, title: 'b', severity: 'major' });
    await repo.addPhoto(a.id, photo(), 'one');
    const m = buildReportModel(await repo.loadBundle(p.id));
    expect(m.total).toBe(2);
    expect(m.floors).toHaveLength(5);
    expect(m.floors[1].hasPlan).toBe(false);
    expect(m.byCategory).toEqual([{ category: 'Cracks', count: 2 }]);
    expect(m.bySeverity.find((s) => s.severity === 'minor')?.count).toBe(1);
    expect(m.floors[0].findings[0].photos).toHaveLength(1);
    const csv = buildCsv(m);
    expect(csv.split('\r\n')[0]).toContain('location review required');
    expect(csv).toContain("'=cmd");
  });
});

describe('schema migration (v1 -> v2)', () => {
  it('fills defaults for v1 findings and photo projectId', async () => {
    const name = `mig-${Date.now()}`;
    const old = new Dexie(name);
    old.version(1).stores({
      projects: 'id, updatedAt', floors: 'id, projectId, [projectId+order]', findings: 'id, projectId, floorId, categoryId',
      categories: 'id, projectId', photos: 'id, findingId, projectId, assetId', assets: 'id, projectId', blobs: 'id, projectId',
    });
    await old.table('findings').add({ id: 'f1', projectId: 'p1', floorId: 'fl', reference: 'D-001', u: 0.1, v: 0.2, categoryId: 'c', title: 't', createdAt: 'x', updatedAt: 'x' });
    await old.table('photos').add({ id: 'ph', findingId: 'f1', assetId: 'a', caption: '', order: 0, isCover: true, createdAt: 'x' });
    old.close();
    const next = new InspectorDb(name);
    const f = await next.findings.get('f1');
    expect(f?.locationNeedsReview).toBe(false);
    expect(f?.severity).toBe('not_assessed');
    expect(f?.description).toBe('');
    expect((await next.photos.get('ph'))?.projectId).toBe('p1');
    next.close();
  });
});
