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
  await page.getByTestId('finding-row').filter({ hasText: 'L1-001' }).click();
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

test('report opens with a summary page; a written summary replaces the draft', async ({ page }) => {
  await openSample(page);
  const pid = /#\/p\/([^/]+)/.exec(page.url())![1];
  await page.goto(`/#/p/${pid}/report`);
  await expect(page.getByTestId('report-status')).toHaveText('Ready to print', { timeout: 60_000 });
  const exec = page.getByTestId('exec-summary');
  await expect(exec.locator('h2')).toContainText('Summary');
  await expect(exec).toContainText('Summary generated automatically');
  await expect(exec.locator('.summary-grid table')).toHaveCount(2); // by floor, by category
  await exec.screenshot({ path: 'test-results/exec-summary.png' });
  // write one in Project details
  await page.goto(`/#/p/${pid}`);
  await page.getByRole('button', { name: /Project/ }).first().click();
  await page.getByRole('menuitem', { name: /Project details/ }).or(page.getByRole('button', { name: /Project details/ })).first().click();
  await page.getByRole('button', { name: 'Draft from findings' }).click();
  await expect(page.getByLabel(/Report summary/)).toHaveValue(/conditions were recorded/);
  await page.getByLabel(/Report summary/).fill('Overall fair. Two items need attention before handover.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await page.goto(`/#/p/${pid}/report`);
  await expect(page.getByTestId('exec-text')).toHaveText('Overall fair. Two items need attention before handover.');
  await expect(page.getByTestId('exec-summary')).not.toContainText('Summary generated automatically');
});

test('a compact photo upload is resized to 1920 px and stored once', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-002' }).click();
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

test('renumber findings per floor with a prefix set in the dialog', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Project ▾' }).click();
  await page.getByRole('menuitem', { name: 'Renumber findings…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Renumber findings per floor' });
  await expect(dlg).toContainText('G-001 … G-002');
  await dlg.getByLabel('Level 4 number prefix').fill('Roof');
  await dlg.getByLabel('Level 4 number prefix').press('Enter');
  await expect(dlg).toContainText('Roof-001');
  await page.screenshot({ path: 'test-results/renumber-dialog.png' });
  await dlg.getByLabel(/In the order they were captured/).check();
  await expect(dlg.getByRole('button', { name: 'Renumber 1 finding' })).toBeEnabled();
  await dlg.getByRole('button', { name: 'Renumber 1 finding' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByTestId('finding-row').filter({ hasText: 'Roof-001' })).toBeVisible();
  expect((await dbAll(page, 'findings')).map((f) => f.reference).sort()).toEqual(['G-001', 'G-002', 'L1-001', 'L1-002', 'L2-001', 'L2-002', 'L3-001', 'Roof-001']);
});

test('rotate a saved photo: the stored image turns a quarter, caption and cover stay', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-002' }).click();
  const editor = page.getByTestId('finding-editor');
  const count = await editor.getByTestId('photo-item').count();
  await editor.getByLabel('Upload photos').setInputFiles(demo('photo-landscape.jpg'));
  await expect(editor.getByTestId('photo-item')).toHaveCount(count + 1, { timeout: 20_000 });
  const item = editor.getByTestId('photo-item').last();
  await item.getByLabel('Photo caption').fill('Turned');
  await item.getByLabel('Photo caption').blur();
  const photoRow = async () => {
    const photos = await dbAll(page, 'photos'), assets = await dbAll(page, 'assets');
    const p = photos.find((x) => x.caption === 'Turned');
    return p && { photo: p, asset: assets.find((a) => a.id === p.assetId)! };
  };
  await expect.poll(async () => !!(await photoRow())).toBe(true);
  const before = (await photoRow())!;
  expect(before.asset.width).toBeGreaterThan(before.asset.height);
  await item.getByRole('button', { name: /Rotate photo \d+ right/ }).click();
  await expect.poll(async () => (await photoRow())?.asset?.id !== before.asset.id, { timeout: 10_000 }).toBe(true);
  const after = (await photoRow())!;
  expect([after.asset.width, after.asset.height]).toEqual([before.asset.height, before.asset.width]);
  expect((await dbAll(page, 'assets')).some((a) => a.id === before.asset.id)).toBe(false); // old image removed
});

test('zoom into a saved photo and keep the cropped part as the photo', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-002' }).click();
  const editor = page.getByTestId('finding-editor');
  const count = await editor.getByTestId('photo-item').count();
  await editor.getByLabel('Upload photos').setInputFiles(demo('photo-landscape.jpg'));
  await expect(editor.getByTestId('photo-item')).toHaveCount(count + 1, { timeout: 20_000 });
  const item = editor.getByTestId('photo-item').last();
  await item.getByLabel('Photo caption').fill('Cropped');
  await item.getByLabel('Photo caption').blur();
  const row = async () => {
    const p = (await dbAll(page, 'photos')).find((x) => x.caption === 'Cropped');
    return p && (await dbAll(page, 'assets')).find((a) => a.id === p.assetId);
  };
  await expect.poll(async () => !!(await row())).toBe(true);
  const before = (await row())!;
  await item.getByRole('button', { name: /Crop photo \d+/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Zoom and crop photo' });
  await dlg.getByRole('button', { name: 'Square' }).click();
  await dlg.getByLabel('Zoom').fill('2');
  // drag the photo a little
  const box = (await dlg.getByTestId('crop-stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 }); await page.mouse.up();
  await page.screenshot({ path: 'test-results/crop-dialog.png' });
  await dlg.getByRole('button', { name: 'Use cropped photo' }).click();
  await expect(dlg).toBeHidden();
  await expect.poll(async () => (await row())?.id !== before.id, { timeout: 10_000 }).toBe(true);
  const after = (await row())!;
  expect(after.width).toBe(after.height); // square
  expect(after.width).toBeLessThan(before.height); // zoomed in: a smaller part of the photo
});

test('the full-size photo window rotates and crops the photo in place', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-002' }).click();
  const editor = page.getByTestId('finding-editor');
  const count = await editor.getByTestId('photo-item').count();
  await editor.getByLabel('Upload photos').setInputFiles(demo('photo-landscape.jpg'));
  await expect(editor.getByTestId('photo-item')).toHaveCount(count + 1, { timeout: 20_000 });
  const item = editor.getByTestId('photo-item').last();
  await item.getByLabel('Photo caption').fill('Viewer');
  await item.getByLabel('Photo caption').blur();
  const row = async () => {
    const p = (await dbAll(page, 'photos')).find((x) => x.caption === 'Viewer');
    return p && (await dbAll(page, 'assets')).find((a) => a.id === p.assetId);
  };
  await expect.poll(async () => !!(await row())).toBe(true);
  const before = (await row())!;
  await item.getByRole('button', { name: /Open photo \d+ full size/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Photo' });
  await dlg.getByRole('button', { name: 'Rotate right' }).click();
  await expect.poll(async () => (await row())?.id !== before.id, { timeout: 10_000 }).toBe(true);
  const rotated = (await row())!;
  expect([rotated.width, rotated.height]).toEqual([before.height, before.width]);
  await expect(dlg).toBeVisible(); // stays open on the turned photo
  await dlg.getByRole('button', { name: 'Zoom & crop' }).click();
  const crop = page.getByRole('dialog', { name: 'Zoom and crop photo' });
  await crop.getByRole('button', { name: 'Square' }).click();
  await crop.getByRole('button', { name: 'Use cropped photo' }).click();
  await expect(page.getByRole('dialog', { name: 'Photo' })).toBeVisible();
  await expect.poll(async () => (await row())?.id !== rotated.id, { timeout: 10_000 }).toBe(true);
  const cropped = (await row())!;
  expect(cropped.width).toBe(cropped.height);
  await page.screenshot({ path: 'test-results/lightbox.png' });
});

test('add a new category straight from a finding’s category list', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-002' }).click();
  page.once('dialog', (d) => void d.accept('Lift doors'));
  await page.getByTestId('finding-editor').getByLabel('Category').selectOption({ label: '+ New category…' });
  await expect(page.getByTestId('finding-editor').getByLabel('Category')).toHaveValue(/.+/);
  await expect(page.getByTestId('finding-editor').getByLabel('Category').locator('option:checked')).toHaveText('Lift doors');
  await expect.poll(async () => (await dbAll(page, 'findings')).find((f) => f.reference === 'L1-002')?.categoryId).toBe(
    (await dbAll(page, 'categories')).find((c) => c.name === 'Lift doors')?.id);
  // cancelling the name leaves the category unchanged
  page.once('dialog', (d) => void d.dismiss());
  await page.getByTestId('finding-editor').getByLabel('Category').selectOption({ label: '+ New category…' });
  await expect(page.getByTestId('finding-editor').getByLabel('Category').locator('option:checked')).toHaveText('Lift doors');
});

test('copy a finding to other floors from the finding editor', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L1-001' }).click();
  await page.getByRole('button', { name: 'Copy to floor…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Copy L1-001 to other floors' });
  await expect(dlg.getByLabel('Level 1')).toHaveCount(0); // not its own floor
  await dlg.getByLabel('Level 2').check(); await dlg.getByLabel('Level 4').check();
  await dlg.getByRole('button', { name: 'Copy to 2 floors' }).click();
  await expect(dlg).toBeHidden();
  const all = await dbAll(page, 'findings');
  const src = all.find((f) => f.reference === 'L1-001')!;
  for (const ref of ['L2-003', 'L4-002']) {
    const c = all.find((f) => f.reference === ref)!;
    expect(c).toMatchObject({ title: src.title, u: src.u, v: src.v, categoryId: src.categoryId, severity: src.severity });
    expect((await dbAll(page, 'photos')).filter((p) => p.findingId === c.id).length).toBe((await dbAll(page, 'photos')).filter((p) => p.findingId === src.id).length);
  }
  await expect(page.getByTestId('finding-row').filter({ hasText: 'L4-002' })).toBeVisible();
});
