import { beforeEach, describe, expect, it } from 'vitest';
import { InspectorDb, db, useDb } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { resetSaveState } from '../../src/data/saveStatus';
import { buildReportModel, draftSummary, floorSeverityMatrix, keyFindings } from '../../src/lib/report';
import { createBackup, parseBackup } from '../../src/lib/backup';

let n = 0;
beforeEach(() => { useDb(new InspectorDb(`summary-${++n}`)); resetSaveState(); });
const plan = (): repo.ProcessedImage => ({ filename: 'p.png', mime: 'image/png', width: 400, height: 300,
  original: new Blob([new Uint8Array([1])]), display: new Blob([new Uint8Array([2])]), thumbnail: new Blob([new Uint8Array([3])]) });

async function seeded() {
  const p = await repo.createProject({ name: 'Block A', siteName: '14 Hartley Street', inspector: 'B. Brits', inspectionDate: '2026-10-16' });
  const floors = await repo.listFloors(p.id);
  await repo.setFloorPlan(floors[0].id, plan()); await repo.setFloorPlan(floors[1].id, plan());
  const cats = await repo.listCategories(p.id);
  const mk = (fl: number, title: string, severity: repo.NewFinding['severity'], cat = 0) =>
    repo.createFinding({ floorId: floors[fl].id, u: 0.5, v: 0.5, categoryId: cats[cat].id, title, severity });
  await mk(0, 'Crack above door', 'moderate'); await mk(0, 'Rising damp', 'major', 1); await mk(1, 'Scuffed paint', 'minor', 2);
  await mk(1, 'Cracked tile', 'major', 4); await mk(1, 'Loose skirting', 'not_assessed', 2);
  return { p, model: buildReportModel(await repo.loadBundle(p.id)) };
}

describe('executive summary', () => {
  it('key findings: major first, then moderate; minor and unassessed left out', async () => {
    const { model } = await seeded();
    expect(keyFindings(model).map((f) => `${f.reference} ${f.severity}`)).toEqual(['G-002 major', 'L1-002 major', 'G-001 moderate']);
  });
  it('floor × severity matrix counts each floor', async () => {
    const { model } = await seeded();
    const m = floorSeverityMatrix(model);
    expect(m.map((r) => [r.floor, r.total])).toEqual([['Ground', 2], ['Level 1', 3]]);
    expect(m[1].counts).toEqual([1, 0, 1, 1]); // major, moderate, minor, not assessed
  });
  it('draft is neutral prose built from the data', async () => {
    const { p, model } = await seeded();
    const t = draftSummary(model, p);
    expect(t).toContain('B. Brits inspected 14 Hartley Street on 2026-10-16');
    expect(t).toContain('5 conditions were recorded across 2 floors (Ground and Level 1)');
    expect(t).toContain('2 are rated major, 1 moderate and 1 minor; 1 has not been assessed');
    expect(t).toContain('Major items: G-002 rising damp (Ground) and L1-002 cracked tile (Level 1).');
    expect(t).toContain('not a structural assessment');
  });
  it('the written summary survives a backup round trip', async () => {
    const { p } = await seeded();
    await repo.updateProject(p.id, { summary: 'Generally fair; two major items need attention.' });
    const restored = await parseBackup(await createBackup(await repo.loadBundle(p.id)));
    expect(restored.project.summary).toBe('Generally fair; two major items need attention.');
  });
});

describe('compact photos', () => {
  it('a photo whose original and display are the same blob is stored once and survives backup + delete', async () => {
    const { p } = await seeded();
    const [f] = await repo.listFindings(p.id);
    const one = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/jpeg' });
    const ph = await repo.addPhoto(f.id, { filename: 'c.jpg', mime: 'image/jpeg', width: 1920, height: 1440, original: one, display: one, thumbnail: new Blob([new Uint8Array([7])]) });
    const a = (await db.assets.get(ph.assetId))!;
    expect(a.displayBlobId).toBe(a.originalBlobId);
    expect(await db.blobs.where('projectId').equals(p.id).filter((b) => b.id === a.originalBlobId).count()).toBe(1);
    const restored = await parseBackup(await createBackup(await repo.loadBundle(p.id)));
    expect(restored.blobs.has(a.originalBlobId)).toBe(true);
    await repo.deletePhoto(ph.id);
    expect(await db.blobs.get(a.originalBlobId)).toBeUndefined();
  });
});
