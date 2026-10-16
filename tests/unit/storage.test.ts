import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import * as repo from '../../src/data/repo';
import { measureStorage } from '../../src/data/storage';
import { fmtBytes, photosRemaining, usageLevel } from '../../src/lib/storagePrefs';
import { appendText, suggestFromSpeech, tidyTranscript } from '../../src/lib/voiceDraft';
import { STARTER_CATEGORIES } from '../../src/lib/types';

const blob = (n: number, type = 'image/jpeg') => new Blob([new Uint8Array(n)], { type });
const processed = (shared: boolean): repo.ProcessedImage => {
  const display = blob(3000);
  return { filename: 'p.jpg', mime: 'image/jpeg', width: 10, height: 10, original: shared ? display : blob(30000), display, thumbnail: blob(500) };
};

describe('storage saver and measurement', () => {
  beforeEach(async () => { await Promise.all(db.tables.map((t) => t.clear())); });

  async function setup() {
    const p = await repo.createProject({ name: 'S' });
    const [floor] = await repo.listFloors(p.id);
    const cat = (await repo.listCategories(p.id))[0];
    const f = await repo.createFinding({ floorId: floor.id, u: 0.5, v: 0.5, categoryId: cat.id, title: 'x' });
    return { p, f };
  }

  it('stores a compressed-only photo once, and a kept original separately', async () => {
    const { p, f } = await setup();
    await repo.addPhoto(f.id, processed(true));
    expect(await db.blobs.count()).toBe(2);
    const a = (await db.assets.toArray())[0];
    expect(a.originalBlobId).toBe(a.displayBlobId);
    expect(a.sizeBytes).toBe(3500);
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

describe('voice draft suggestions', () => {
  const cats = STARTER_CATEGORIES.map((c, i) => ({ id: `c${i}`, name: c.name, archived: false }));
  it('suggests category and severity from words', () => {
    const s = suggestFromSpeech('Hairline crack above the window on the north wall, minor', cats);
    expect(s.categoryId).toBe('c0');
    expect(s.severity).toBe('minor');
  });
  it('picks moisture and major', () => {
    const s = suggestFromSpeech('Severe water damage and leak at the ceiling corner', cats);
    expect(s.categoryId).toBe('c1');
    expect(s.severity).toBe('major');
  });
  it('suggests nothing when unsure and ignores archived categories', () => {
    expect(suggestFromSpeech('Something odd here', cats)).toEqual({});
    expect(suggestFromSpeech('large crack', cats.map((c) => ({ ...c, archived: true })))).toMatchObject({ severity: 'major' });
    expect(suggestFromSpeech('large crack', cats.map((c) => ({ ...c, archived: true }))).categoryId).toBeUndefined();
  });
  it('tidies and appends text', () => {
    expect(tidyTranscript('  crack   in wall ')).toBe('Crack in wall.');
    expect(tidyTranscript('   ')).toBe('');
    expect(appendText('', 'A.')).toBe('A.');
    expect(appendText('First.', 'Second.')).toBe('First.\nSecond.');
    expect(appendText('First.', '  ')).toBe('First.');
  });
});
