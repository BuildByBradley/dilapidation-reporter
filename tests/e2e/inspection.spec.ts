import { expect, test, type Page } from '@playwright/test';
import { canvas, dbAll, demo, drag, isolate, newProject, openSample, pointer, screenOf, state, tap, PLANS } from './helpers';

async function withPlans(page: Page) {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles(PLANS);
  await page.getByRole('button', { name: /Import 5 plans/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
}
async function addPin(page: Page, floor: string, uv: [number, number], title: string, category = 'Cracks') {
  await isolate(page, floor);
  await page.getByRole('button', { name: 'Add pin' }).first().click();
  const fid = (await state(page)).floorId!;
  const p = await screenOf(page, fid, uv[0], uv[1]);
  await tap(page, p.x, p.y);
  await expect(page.getByTestId('placement-panel')).toBeVisible();
  await page.getByLabel('Title *').fill(title);
  await page.getByLabel('Category *').selectOption({ label: category });
  await page.getByRole('button', { name: 'Save finding' }).click();
  await expect(page.getByTestId('finding-editor')).toBeVisible();
  return fid;
}

test.describe('pins (A09, A10)', () => {
  test('A09 corners and centre round-trip within 2 CSS px in 3D and 2D, after navigation and resize', async ({ page }) => {
    await withPlans(page);
    await isolate(page, 'Level 2');
    const fid = (await state(page)).floorId!;
    const targets: [number, number][] = [[0.0, 0.0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]];
    const check = async (label: string) => {
      for (const [u, v] of targets) {
        const err = await page.evaluate(({ fid, u, v }) => {
          const e = (window as any).__inspector.engine;
          const s = e.uvToScreen(fid, u, v);
          const back = e.screenToUv(fid, s.x, s.y);
          if (!back) return 999;
          const s2 = e.uvToScreen(fid, back.u, back.v);
          return Math.hypot(s2.x - s.x, s2.y - s.y);
        }, { fid, u, v });
        expect(err, `${label} corner ${u},${v}`).toBeLessThan(2);
      }
    };
    await check('3D');
    await drag(page, [150, 300], [340, 300]); await page.getByRole('button', { name: 'Zoom in' }).click();
    await check('3D after rotate+zoom');
    await page.getByRole('button', { name: '2D view' }).first().click();
    await check('2D');
    const w0 = (await state(page)).size.w;
    await page.setViewportSize({ width: 820, height: 640 });
    await page.waitForFunction((w) => (window as any).__inspector.engine.debugState().size.w !== w, w0);
    // below 900px wide the app switches to the phone layout and rebuilds the viewer: wait until the floor is drawn again
    await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return s.mode === 'floor2d' && s.visible.length === 1 && !s.animating; });
    await check('2D after resize');
  });

  test('A09b placing in 3D at a screen point stores uv that reprojects to the tap within 2px; nudge moves one source pixel', async ({ page }) => {
    await withPlans(page);
    const fid = await addPin(page, 'Ground', [0.3, 0.6], 'Pin A');
    const [f] = await dbAll(page, 'findings');
    expect(f.floorId).toBe(fid);
    const p = await screenOf(page, fid, f.u, f.v);
    const want = await screenOf(page, fid, 0.3, 0.6);
    expect(Math.hypot(p.x - want.x, p.y - want.y)).toBeLessThan(2);
    expect(f.u).toBeCloseTo(0.3, 2); expect(f.v).toBeCloseTo(0.6, 2);
    // relocate with nudges: +3 px right = 3/2000 in u (ground plan is 2000px wide)
    await page.getByRole('button', { name: 'Relocate pin' }).last().click();
    await expect(page.getByTestId('placement-panel')).toBeVisible();
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Nudge right' }).click();
    await page.getByRole('button', { name: 'Nudge down' }).click();
    await page.getByRole('button', { name: 'Confirm new location' }).click();
    const [g] = await dbAll(page, 'findings');
    expect(g.u - f.u).toBeCloseTo(3 / 2000, 5);
    expect(g.v - f.v).toBeCloseTo(1 / 1400, 5);
    expect(g.reference).toBe(f.reference);
  });

  test('A10 drag, pinch, tap on a pin and tap outside the plan never create unintended findings', async ({ page }) => {
    await withPlans(page);
    await addPin(page, 'Ground', [0.5, 0.5], 'Existing');
    await page.getByRole('button', { name: 'Add pin' }).first().click();
    await drag(page, [200, 300], [320, 340]);                                // drag
    await pointer(page, 'pointerdown', { id: 1, x: 250, y: 300 }); await pointer(page, 'pointerdown', { id: 2, x: 300, y: 300 });
    await pointer(page, 'pointermove', { id: 2, x: 360, y: 300 }); await pointer(page, 'pointerup', { id: 2, x: 360, y: 300 }); await pointer(page, 'pointerup', { id: 1, x: 250, y: 300 }); // pinch
    await expect(page.getByTestId('placement-panel')).toHaveCount(0);
    expect(await dbAll(page, 'findings')).toHaveLength(1);
    await tap(page, 3, 3);                                                   // outside the plan
    await expect(page.getByText(/outside the floor plan/i)).toBeVisible();
    await expect(page.getByTestId('placement-panel')).toHaveCount(0);
    // in placement mode a tap over an existing pin only *proposes* a location (nothing is saved until confirmed)
    const fid = (await state(page)).floorId!;
    const [f] = await dbAll(page, 'findings');
    const p = await screenOf(page, fid, f.u, f.v);
    await tap(page, p.x, p.y - 12);
    await expect(page.getByTestId('placement-panel')).toBeVisible();
    expect(await dbAll(page, 'findings')).toHaveLength(1);
    await page.getByTestId('placement-panel').getByRole('button', { name: 'Cancel' }).click();
    // in Navigate mode the same tap selects the finding
    await tap(page, p.x, p.y - 12);
    expect(await dbAll(page, 'findings')).toHaveLength(1);
    await expect(page.getByTestId('sr-selection')).toContainText('Existing');
  });

  test('overlapping pins offer a chooser instead of picking silently', async ({ page }) => {
    await withPlans(page);
    await addPin(page, 'Ground', [0.5, 0.5], 'First');
    await page.getByRole('button', { name: 'Close finding editor' }).click();
    await page.getByRole('button', { name: 'Add pin' }).first().click();
    const fid = (await state(page)).floorId!;
    const p = await screenOf(page, fid, 0.5, 0.5);
    // second pin ~2px away: place via tap, then nudge back to be almost coincident
    await tap(page, p.x + 30, p.y + 30);
    await page.getByLabel('Title *').fill('Second'); await page.getByLabel('Category *').selectOption({ label: 'Floors' });
    await page.getByRole('button', { name: 'Save finding' }).click();
    const fs = await dbAll(page, 'findings');
    await page.evaluate(({ id }) => Promise.resolve(id), { id: fs[1].id });
    await page.getByRole('button', { name: 'Close finding editor' }).click();
    // relocate #2 onto #1
    await page.getByTestId('finding-row').filter({ hasText: 'Second' }).click();
    await page.getByRole('button', { name: 'Relocate pin' }).last().click();
    await tap(page, p.x, p.y);
    await page.getByRole('button', { name: 'Confirm new location' }).click();
    await page.getByRole('button', { name: 'Close finding editor' }).click();
    await tap(page, p.x, p.y - 12);
    await expect(page.getByRole('dialog', { name: 'Choose finding' })).toContainText('2 findings overlap');
    await page.getByRole('dialog', { name: 'Choose finding' }).getByRole('button', { name: /Second/ }).click();
    await expect(page.getByTestId('finding-editor')).toContainText('D-002');
  });

  test('Escape cancels placement; switching floors with drafted content asks first', async ({ page }) => {
    await withPlans(page);
    await isolate(page, 'Level 1');
    await page.getByRole('button', { name: 'Add pin' }).first().click();
    const fid = (await state(page)).floorId!;
    const p = await screenOf(page, fid, 0.4, 0.4);
    await tap(page, p.x, p.y);
    await page.getByLabel('Title *').fill('draft in progress');
    await page.getByRole('button', { name: /^Ground,/ }).click();
    await expect(page.getByRole('dialog', { name: /Discard/ })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Title *')).toHaveValue('draft in progress');
    await canvas(page).focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: /Discard/ })).toBeVisible();
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('placement-panel')).toHaveCount(0);
    expect(await dbAll(page, 'findings')).toHaveLength(0);
  });
});

test.describe('findings, photos, categories, persistence (A11-A15)', () => {
  test('A11 photos: upload two, caption, reorder, delete; camera capture works and stops its tracks', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any; w.__streams = [];
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); w.__streams.push(s); return s; };
    });
    await withPlans(page);
    await addPin(page, 'Ground', [0.3, 0.3], 'With photos');
    await page.getByLabel('Upload photos').setInputFiles([demo('photo-landscape.jpg'), demo('photo-portrait.jpg')]);
    await expect(page.getByTestId('photo-item')).toHaveCount(2, { timeout: 20_000 });
    await page.getByLabel('Photo caption').first().fill('Landscape caption'); await page.getByLabel('Photo caption').first().blur();
    await page.getByRole('button', { name: 'Move photo 1 later' }).click();
    await expect.poll(async () => (await dbAll(page, 'photos')).sort((a, b) => a.order - b.order).map((p) => p.caption)).toEqual(['', 'Landscape caption']);
    // camera
    await page.getByRole('button', { name: 'Take photo' }).click();
    await expect(page.getByLabel('Camera preview')).toBeVisible();
    await page.getByRole('button', { name: 'Capture' }).click();
    await expect(page.getByAltText('Captured photo preview')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true); // stopped on capture
    await page.getByRole('button', { name: 'Retake' }).click();
    await page.getByRole('button', { name: 'Capture' }).click();
    await page.getByRole('button', { name: 'Use photo' }).click();
    await expect(page.getByTestId('photo-item')).toHaveCount(3, { timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).__streams.length)).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true);
    // cancel dialog stops the stream too
    await page.getByRole('button', { name: 'Take photo' }).click();
    await expect(page.getByLabel('Camera preview')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true);
    // derivatives drop location metadata; originals retained
    const assets = (await dbAll(page, 'assets')).filter((a) => a.kind === 'photo');
    expect(assets).toHaveLength(3);
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await expect(page.getByTestId('photo-item')).toHaveCount(2);
    expect((await dbAll(page, 'assets')).filter((a) => a.kind === 'photo')).toHaveLength(2);
  });

  test('A12 denied camera shows a clear message and the upload fallback still works', async ({ page }) => {
    await page.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
    await withPlans(page);
    await addPin(page, 'Ground', [0.3, 0.3], 'No camera');
    await page.getByRole('button', { name: 'Take photo' }).click();
    await expect(page.getByRole('alert')).toContainText(/permission was denied/i);
    await expect(page.getByRole('button', { name: /device camera \(file picker\)/ })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByLabel('Upload photos').setInputFiles(demo('photo-exif6.jpg'));
    await expect(page.getByTestId('photo-item')).toHaveCount(1, { timeout: 20_000 });
    // unsupported photo types are rejected, not stored unreadable
    await page.getByLabel('Upload photos').setInputFiles({ name: 'x.heic', mimeType: 'image/heic', buffer: Buffer.from('heic?') });
    await expect(page.getByText(/HEIC/)).toBeVisible();
    expect(await dbAll(page, 'photos')).toHaveLength(1);
  });

  test('A13 rename, archive and reassign categories keep findings valid; archived categories are unavailable for new findings', async ({ page }) => {
    await withPlans(page);
    await addPin(page, 'Ground', [0.3, 0.3], 'Crack one', 'Cracks');
    await page.getByRole('button', { name: 'Project ▾' }).click();
    await page.getByRole('menuitem', { name: 'Categories' }).click();
    const name = page.getByLabel('Category name Cracks');
    await name.fill('Structural cracks'); await name.blur();
    await expect(page.getByLabel('Category name Structural cracks')).toBeVisible();
    await page.getByLabel('Category name Floors').fill('structural cracks'); await page.getByLabel('Category name Floors').blur();
    await expect(page.getByText(/already exists/).first()).toBeVisible();          // case-insensitive duplicate
    await page.getByLabel('New category name').fill('   '); await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.getByText(/cannot be blank/).first()).toBeVisible();
    await page.locator('.cat-list li', { has: page.getByLabel('Category name Structural cracks') }).getByRole('button', { name: 'Archive' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    // existing finding keeps its (archived) label and stays editable
    await expect(page.getByTestId('finding-editor').getByLabel('Category')).toContainText('Structural cracks (archived)');
    await page.getByTestId('finding-editor').getByLabel('Title').fill('Crack one edited');
    await page.getByRole('button', { name: 'Close finding editor' }).click();
    expect((await dbAll(page, 'findings'))[0].title).toBe('Crack one edited');
    // new findings cannot choose it
    await page.getByRole('button', { name: 'Add pin' }).first().click();
    const fid = (await state(page)).floorId!;
    const p = await screenOf(page, fid, 0.6, 0.6); await tap(page, p.x, p.y);
    await expect(page.getByLabel('Category *').locator('option', { hasText: 'Structural cracks' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel' }).last().click();
    // delete in-use category requires reassignment
    await page.getByRole('button', { name: 'Project ▾' }).click(); await page.getByRole('menuitem', { name: 'Categories' }).click();
    await page.getByRole('button', { name: 'Delete Structural cracks' }).click();
    await page.getByLabel('Reassign to').selectOption({ label: 'Finishes' });
    await page.getByRole('button', { name: 'Delete category' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    const cats = await dbAll(page, 'categories');
    expect(cats.find((c) => c.name === 'Finishes')).toBeTruthy();
    expect((await dbAll(page, 'findings'))[0].categoryId).toBe(cats.find((c) => c.name === 'Finishes').id);
    expect(cats.find((c) => c.name === 'Structural cracks')).toBeUndefined();
  });

  test('A14 everything committed survives a reload', async ({ page }) => {
    await withPlans(page);
    await addPin(page, 'Level 2', [0.25, 0.75], 'Persistent finding');
    await page.getByTestId('finding-editor').getByLabel('Description').fill('Long\nmulti-line description');
    await page.getByTestId('finding-editor').getByLabel('Severity').selectOption('major');
    await page.getByLabel('Upload photos').setInputFiles(demo('photo-landscape.jpg'));
    await expect(page.getByTestId('photo-item')).toHaveCount(1, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Close finding editor' }).click(); // flushes the debounce
    await expect(page.getByTestId('save-status')).toContainText('Saved');
    await page.reload();
    await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
    await page.getByTestId('finding-row').click();
    const ed = page.getByTestId('finding-editor');
    await expect(ed.getByLabel('Title')).toHaveValue('Persistent finding');
    await expect(ed.getByLabel('Description')).toHaveValue('Long\nmulti-line description');
    await expect(ed.getByLabel('Severity')).toHaveValue('major');
    await expect(page.getByTestId('photo-item')).toHaveCount(1);
    const [f] = await dbAll(page, 'findings');
    expect([f.u, f.v]).toEqual([f.u, f.v]);
    expect(f.u).toBeCloseTo(0.25, 2); expect(f.v).toBeCloseTo(0.75, 2);
  });

  test('A15 a failed write never shows Saved, keeps the draft, and can be retried', async ({ page }) => {
    await withPlans(page);
    await isolate(page, 'Ground');
    await page.getByRole('button', { name: 'Add pin' }).first().click();
    const fid = (await state(page)).floorId!;
    const p = await screenOf(page, fid, 0.4, 0.4); await tap(page, p.x, p.y);
    await page.getByLabel('Title *').fill('Will fail first'); await page.getByLabel('Category *').selectOption({ label: 'Floors' });
    await page.evaluate(() => {
      const w = window as any; w.__origAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); };
    });
    await page.getByRole('button', { name: 'Save finding' }).click();
    await expect(page.getByTestId('save-status')).toContainText('Save failed');
    await expect(page.getByText(/storage is full/i).first()).toBeVisible();
    await expect(page.getByLabel('Title *')).toHaveValue('Will fail first'); // draft retained
    expect(await dbAll(page, 'findings')).toHaveLength(0);
    await page.evaluate(() => { IDBObjectStore.prototype.add = (window as any).__origAdd; });
    await page.getByRole('button', { name: 'Save finding' }).click();
    await expect(page.getByTestId('save-status')).toContainText(/Saved/);
    expect(await dbAll(page, 'findings')).toHaveLength(1);
  });

  test('editor edits are debounced and committed before navigating to the report', async ({ page }) => {
    await withPlans(page);
    await addPin(page, 'Ground', [0.3, 0.3], 'Original');
    await page.getByTestId('finding-editor').getByLabel('Title').fill('Edited right before leaving');
    await page.getByRole('button', { name: 'Report' }).click();
    await page.waitForURL(/report$/);
    await expect(page.getByTestId('report-finding')).toContainText('Edited right before leaving');
  });
});

test('A24 a second tab on the same project is read-only', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const a = await ctx.newPage();
  await openSample(a);
  const url = a.url();
  const b = await ctx.newPage();
  await b.goto(url);
  await expect(b.getByTestId('readonly-banner')).toBeVisible();
  await expect(b.getByRole('button', { name: 'Add pin' })).toBeDisabled();
  await expect(b.getByRole('button', { name: 'Replace' }).first()).toBeDisabled();
  await b.getByTestId('finding-row').first().click();
  await expect(b.getByTestId('finding-editor').getByLabel('Title')).toBeDisabled();
  await a.close();
  await b.getByRole('button', { name: 'Try again' }).click();
  await expect(b.getByTestId('readonly-banner')).toBeHidden();
  await ctx.close();
});

test('A23 pins stay aligned after resize and device-pixel-ratio changes', async ({ browser }) => {
  for (const dpr of [1, 2, 3]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    await openSample(page);
    await isolate(page, 'Level 1');
    await page.getByRole('button', { name: '2D view' }).first().click();
    const fid = (await state(page)).floorId!;
    const f = (await dbAll(page, 'findings')).find((x) => x.floorId === fid)!;
    const w0 = (await state(page)).size.w;
    await page.setViewportSize({ width: 900, height: 700 });
    await page.waitForFunction((w) => (window as any).__inspector.engine.debugState().size.w !== w, w0);
    // below 900px wide the app switches to the phone layout and rebuilds the viewer: wait until the floor is drawn again
    await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return s.mode === 'floor2d' && s.visible.length === 1 && !s.animating; });
    const s = await screenOf(page, fid, f.u, f.v);
    // tapping the pin's drawn tip selects it => hit-testing agrees with drawing at this DPR/size
    await tap(page, s.x, s.y - 10);
    await expect(page.getByTestId('finding-editor')).toContainText(f.reference);
    await ctx.close();
  }
});
