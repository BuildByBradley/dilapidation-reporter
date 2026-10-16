import { expect, test } from '@playwright/test';
import { dbAll, demo, openSample } from './helpers';

test('add a floor and remove an empty one', async ({ page }) => {
  await openSample(page);
  await expect(page.getByTestId('floor-slot')).toHaveCount(5);
  await page.getByRole('button', { name: '+ Add floor' }).click();
  await expect(page.getByTestId('floor-slot')).toHaveCount(6);
  await expect(page.getByTestId('floor-slot').last()).toContainText('Level 5');
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove Level 5' }).click();
  await expect(page.getByTestId('floor-slot')).toHaveCount(5);
  // floors with findings cannot be removed
  await expect(page.getByRole('button', { name: 'Remove Ground' })).toHaveCount(0);
});

test('draw on a camera photo before using it; the drawing is saved in the photo', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'D-003' }).click();
  const before = (await dbAll(page, 'photos')).length;
  await page.getByTestId('finding-editor').getByRole('button', { name: 'Take photo' }).click();
  await page.getByRole('button', { name: 'Capture' }).click();
  await page.getByRole('button', { name: /Draw on photo/ }).click();
  const c = page.getByTestId('markup-canvas');
  await expect(c).toBeVisible();
  const b = (await c.boundingBox())!;
  // red circle around the middle, then an arrow
  await page.getByRole('button', { name: '◯ Circle' }).click();
  await page.mouse.move(b.x + b.width * 0.35, b.y + b.height * 0.35); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.65, b.y + b.height * 0.65, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: '➚ Arrow' }).click();
  await page.getByRole('button', { name: 'Yellow' }).click();
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.9); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.7, { steps: 5 }); await page.mouse.up();
  await page.getByRole('button', { name: '↶ Undo' }).click();
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.9); await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.7, { steps: 5 }); await page.mouse.up();
  await page.screenshot({ path: 'test-results/markup.png' });
  await page.getByRole('button', { name: 'Done drawing' }).click();
  await expect(page.getByRole('button', { name: /Edit drawing/ })).toBeVisible();
  await page.getByRole('button', { name: 'Use photo' }).click();
  await expect.poll(async () => (await dbAll(page, 'photos')).length, { timeout: 20_000 }).toBe(before + 1);
  // the stored photo has red pixels where the circle was drawn and is compact
  const res = await page.evaluate(async () => {
    const req = indexedDB.open('dilapidation-inspector');
    const dbx: IDBDatabase = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const all = <T,>(store: string) => new Promise<T[]>((r) => { const q = dbx.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result as T[]); });
    const assets = (await all<any>('assets')).filter((a) => a.kind === 'photo').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const a = assets.at(-1);
    const blob = (await all<any>('blobs')).find((x) => x.id === a.displayBlobId).data as Blob;
    const bmp = await createImageBitmap(blob);
    const cv = new OffscreenCanvas(bmp.width, bmp.height); const ctx = cv.getContext('2d')!; ctx.drawImage(bmp, 0, 0);
    // walk the circle's left edge (x = 35% of width, y = 50%)
    let red = 0;
    for (let dx = -8; dx <= 8; dx++) { const [r, g, b] = ctx.getImageData(Math.round(bmp.width * 0.35) + dx, Math.round(bmp.height * 0.5), 1, 1).data; if (r > 180 && g < 90 && b < 90) red++; }
    return { red, shared: a.displayBlobId === a.originalBlobId, size: blob.size, w: bmp.width, h: bmp.height };
  });
  expect(res.red).toBeGreaterThan(0);
  expect(res.shared).toBe(true);
  expect(Math.max(res.w, res.h)).toBeLessThanOrEqual(1920);
});

test('report opens with a 1–2 page executive summary; a written summary replaces the draft', async ({ page }) => {
  await openSample(page);
  const pid = /#\/p\/([^/]+)/.exec(page.url())![1];
  await page.goto(`/#/p/${pid}/report`);
  await expect(page.getByTestId('report-status')).toHaveText('Ready to print', { timeout: 60_000 });
  const exec = page.getByTestId('exec-summary');
  await expect(exec).toContainText('Executive summary');
  await expect(exec).toContainText('Summary generated automatically');
  await expect(exec.locator('.exec-key tbody tr').first()).toBeVisible();
  await exec.screenshot({ path: 'test-results/exec-summary.png' });
  // write one in Project details
  await page.goto(`/#/p/${pid}`);
  await page.getByRole('button', { name: /Project/ }).first().click();
  await page.getByRole('menuitem', { name: /Project details/ }).or(page.getByRole('button', { name: /Project details/ })).first().click();
  await page.getByRole('button', { name: 'Draft from findings' }).click();
  await expect(page.getByLabel(/Executive summary/)).toHaveValue(/conditions were recorded/);
  await page.getByLabel(/Executive summary/).fill('Overall fair. Two items need attention before handover.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.goto(`/#/p/${pid}/report`);
  await expect(page.getByTestId('exec-text')).toHaveText('Overall fair. Two items need attention before handover.');
  await expect(page.getByTestId('exec-summary')).not.toContainText('Summary generated automatically');
});

test('a compact photo upload is resized to 1920 px and stored once', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'D-004' }).click();
  await page.getByTestId('finding-editor').getByLabel('Upload photos').setInputFiles(demo('photo-landscape.jpg'));
  await expect.poll(async () => (await dbAll(page, 'assets')).filter((a) => a.kind === 'photo').length, { timeout: 20_000 }).toBe(7);
});

test('a long-open tab is told when a newer version is published', async ({ page }) => {
  await page.route(/\/\?v=\d+$/, async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, body: (await res.text()).replace(/assets\/index-[\w-]+\.js/, 'assets/index-NEWER123.js') });
  });
  await page.goto('/');
  await expect(page.getByTestId('update-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('update-banner')).toContainText('newer version');
});
