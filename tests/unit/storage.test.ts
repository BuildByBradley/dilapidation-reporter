import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { measureStorage } from '../../src/data/storage';
import { fmtBytes, photosRemaining, usageLevel } from '../../src/lib/storagePrefs';

const blob = (n: number, type = 'image/jpeg') => new Blob([new Uint8Array(n)], { type });
const processed = (shared: boolean): repo.ProcessedImage => {
  const display = blob(3000);
  return { filename: 'p.jpg', mime: 'image/jpeg', width: 10, height: 10, original: shared ? display : blob(30000), display, thumbnail: blob(500) };
};

describe('storage measurement', () => {
  beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); });

  async function setup() {
    const p = await repo.createProject({ name: 'S' });
    const [floor] = await repo.listFloors(p.id);
    const cat = (await repo.listCategories(p.id))[0];
    const f = await repo.createFinding({ floorId: floor.id, u: 0.5, v: 0.5, categoryId: cat.id, title: 'x' });
    return { p, f };
  }

  it('measures a photo stored once and one with a separate original', async () => {
    const { p, f } = await setup();
    await repo.addPhoto(f.id, processed(true));
    expect(await db.blobs.count()).toBe(2);
    const a = (await db.assets.toArray())[0];
    expect(a.originalBlobId).toBe(a.displayBlobId);
    expect(a.sizeBytes).toBe(3000);
    await repo.addPhoto(f.id, processed(false));
    expect(await db.blobs.count()).toBe(5);
    const u = await measureStorage(p.id);
    expect(u.totalBytes).toBe(3500 + 33500);
    expect(u.projectBytes).toBe(u.totalBytes);
    expect(u.photoCount).toBe(2);
  });

  it('survives delete, duplicate and backup round-trips with shared blob ids', async () => {
    const { p, f } = await setup();
    const ph = await repo.addPhoto(f.id, processed(true));
    const copy = await repo.duplicateProject(p.id);
    const b = await repo.loadBundle(copy.id);
    expect(b.photos).toHaveLength(1);
    repo.assertBundleIntegrity(b);
    await repo.deletePhoto(ph.id);
    expect(await db.blobs.where('projectId').equals(p.id).count()).toBe(0);
  });

  it('levels, labels and estimates', () => {
    expect(usageLevel(60, 100)).toBe('ok');
    expect(usageLevel(70, 100)).toBe('warn');
    expect(usageLevel(90, 100)).toBe('crit');
    expect(fmtBytes(1073741824)).toBe('1.00 GB');
    expect(fmtBytes(5 * 1048576)).toBe('5.0 MB');
    expect(photosRemaining(900, 1000, 100)).toBe(1);
    expect(photosRemaining(2000, 1000, 100)).toBe(0);
  });
});
