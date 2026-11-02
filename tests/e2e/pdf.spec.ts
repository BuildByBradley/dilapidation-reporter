import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { dbAll, isolate, newProject, settle, state } from './helpers';

const fx = (f: string) => path.resolve('tests/fixtures', f);

/** Fraction of sampled canvas pixels that differ from the viewer background — i.e. something was actually drawn. */
async function drawnFraction(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid=viewer-canvas]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0, hit = 0;
    for (let i = 0; i < data.length; i += 4 * 97) { n++; if (Math.abs(data[i] - 0xe9) + Math.abs(data[i + 1] - 0xed) + Math.abs(data[i + 2] - 0xf2) > 12) hit++; }
    return hit / n;
  });
}

test('large vector PDF sheets (A1, rotated A0) import and are drawn in the viewer', async ({ page }) => {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles([fx('a1-vector.pdf'), fx('a0-rotated-vector.pdf')]);
  await expect(page.getByTestId('import-item')).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole('button', { name: /Import 2 plans/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 2, null, { timeout: 30_000 });
  await settle(page);
  const assets = await dbAll(page, 'assets');
  expect(assets).toHaveLength(2);
  // the rotated sheet is stored upright: a portrait MediaBox (2384x3370) with /Rotate 90 displays as landscape (~1.41)
  const rotated = assets.find((a) => a.filename.includes('rotated'))!;
  expect(rotated.width / rotated.height).toBeCloseTo(3370 / 2384, 1);
  // overview draws the stack; isolating draws the floor
  await expect.poll(() => drawnFraction(page)).toBeGreaterThan(0.05);
  await isolate(page, 'Ground');
  await expect.poll(() => drawnFraction(page)).toBeGreaterThan(0.2);
  await page.getByRole('button', { name: '2D view' }).first().click();
  await settle(page);
  expect((await state(page)).mode).toBe('floor2d');
  await expect.poll(() => drawnFraction(page)).toBeGreaterThan(0.2);
  await page.screenshot({ path: test.info().outputPath('a1-2d.png') });
});

test('an imported plan is never silently blank: first import shows the plan without any extra action', async ({ page }) => {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles(fx('a1-vector.pdf'));
  await page.getByRole('button', { name: /^Import plan$/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
  await expect.poll(() => drawnFraction(page), { timeout: 15_000 }).toBeGreaterThan(0.05);
});

test('zoomed-in PDF plans are re-rendered from the vector source (sharp) and line up with the base image', async ({ page }) => {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles([fx('a0-rotated-vector.pdf')]);
  await expect(page.getByTestId('import-item')).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Import plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 1, null, { timeout: 30_000 });
  await isolate(page, 'Ground');
  await page.getByRole('button', { name: '2D view' }).first().click();
  await settle(page);
  const detail = () => page.evaluate(() => { const d = (window as any).__inspector.engine.getDetail(); return d ? { w: d.bitmap.width, u0: d.u0, u1: d.u1 } : null; });
  // fitted: the base image is enough, no tile
  await page.waitForTimeout(600);
  expect(await detail()).toBeNull();
  // zoom far in
  const c = (await page.getByTestId('viewer-canvas').boundingBox())!;
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, -400); await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); }
  await page.waitForTimeout(100);
  await page.screenshot({ path: 'test-results/zoom-before.png' });
  await expect.poll(detail, { timeout: 15_000 }).not.toBeNull();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/zoom-after.png' });
  const d = (await detail())!;
  expect(d.u1 - d.u0).toBeLessThan(0.5);
  await expect(page.getByTestId('detail-status')).toHaveText(/PDF sharp/);
  // tile and base image line up: compare a downscaled region of both (edges should coincide)
  const err = await page.evaluate(async () => {
    const e = (window as any).__inspector.engine;
    const t = e.getDetail(); const img = e.getFloorImage(t.floorId);
    const W = 200, H = Math.round(200 * ((t.v1 - t.v0) * img.height) / ((t.u1 - t.u0) * img.width));
    const a = new OffscreenCanvas(W, H).getContext('2d')!, b = new OffscreenCanvas(W, H).getContext('2d')!;
    a.drawImage(t.bitmap, 0, 0, W, H);
    b.drawImage(img, t.u0 * img.width, t.v0 * img.height, (t.u1 - t.u0) * img.width, (t.v1 - t.v0) * img.height, 0, 0, W, H);
    const da = a.getImageData(0, 0, W, H).data, db2 = b.getImageData(0, 0, W, H).data;
    let s = 0; for (let i = 0; i < da.length; i += 4) s += Math.abs(da[i] - db2[i]);
    return s / (da.length / 4);
  });
  expect(err).toBeLessThan(12); // mean per-pixel difference: same drawing, same place
  // returning to the building clears the tile
  await page.getByRole('button', { name: 'Return to building' }).first().click();
  await expect.poll(detail, { timeout: 5000 }).toBeNull();
});

test('if the original PDF is missing on this device, the viewer says why it is not sharp', async ({ page }) => {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles([fx('a1-vector.pdf')]);
  await expect(page.getByTestId('import-item')).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Import plan', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });
  // simulate a device that has the plan images but not the original PDF
  await page.evaluate(async () => {
    const req = indexedDB.open('dilapidation-inspector');
    const dbx: IDBDatabase = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const a = await new Promise<any>((r) => { const q = dbx.transaction('assets').objectStore('assets').getAll(); q.onsuccess = () => r(q.result[0]); });
    await new Promise((r) => { const t = dbx.transaction('blobs', 'readwrite'); t.objectStore('blobs').delete(a.originalBlobId); t.oncomplete = r; });
  });
  await isolate(page, 'Ground');
  await expect(page.getByTestId('detail-status')).toHaveText(/not sharp/, { timeout: 10_000 });
  await expect(page.getByRole('status').filter({ hasText: 'not on this device' })).toBeVisible();
});
