import { expect, test } from '@playwright/test';
import { PLANS, canvas, dbAll, demo, drag, floorButton, floorIdByName, isolate, newProject, openSample, pointer, settle, state, tap } from './helpers';

test.describe('imports (A01-A03)', () => {
  test('A01 five different plans import, persist and appear in the ordered stack', async ({ page }) => {
    await newProject(page);
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    await page.getByLabel('Plan files').setInputFiles(PLANS);
    await expect(page.getByTestId('import-item')).toHaveCount(5);
    await page.getByRole('button', { name: /Import 5 plans/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
    const assets = await dbAll(page, 'assets');
    expect(assets).toHaveLength(5);
    const ratios = assets.map((a) => +(a.width / a.height).toFixed(2));
    expect(new Set(ratios).size).toBe(5); // five different aspect ratios preserved
    expect(ratios).toContain(+(2000 / 1400).toFixed(2));
    for (const n of ['Ground', 'Level 1', 'Level 2', 'Level 3', 'Level 4']) await expect(floorButton(page, n)).toContainText(/0 findings/);
    await page.reload();
    await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
  });

  test('A02 selected page of a multipage PDF is stored (not page 1)', async ({ page }) => {
    await newProject(page);
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    await page.getByLabel('Plan files').setInputFiles(demo('multipage.pdf'));
    await expect(page.getByRole('radiogroup')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('radio')).toHaveCount(3);
    await page.getByRole('radio', { name: /Page 2/ }).click();
    await expect(page.getByText('page 2 of 3')).toBeVisible();
    await page.getByRole('button', { name: /^Import plan$/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    const [asset] = await dbAll(page, 'assets');
    expect(asset.sourcePage).toBe(2);
    expect(asset.mime).toBe('application/pdf');
    const floors = await dbAll(page, 'floors');
    expect(floors.filter((f) => f.planAssetId)).toHaveLength(1);
    expect(floors.find((f) => f.planAssetId)!.sourcePage).toBe(2);
  });

  test('A02b different pages of one PDF can be assigned to different floors', async ({ page }) => {
    await newProject(page);
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    await page.getByLabel('Plan files').setInputFiles(demo('multipage.pdf'));
    await expect(page.getByRole('radio')).toHaveCount(3, { timeout: 30_000 });
    await page.getByRole('button', { name: /Use another page/ }).click();
    const items = page.getByTestId('import-item');
    await expect(items).toHaveCount(2);
    await items.nth(1).getByRole('radio', { name: /Page 3/ }).click();
    await page.getByRole('button', { name: /Import 2 plans/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    const pages = (await dbAll(page, 'assets')).map((a) => a.sourcePage).sort();
    expect(pages).toEqual([1, 3]);
  });

  test('A03 invalid files give useful errors and leave data intact', async ({ page }) => {
    await newProject(page);
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
    await page.getByLabel('Plan files').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await expect(page.getByRole('alert')).toContainText(/not supported/i);
    await page.getByLabel('Plan files').setInputFiles({ name: 'photo.heic', mimeType: 'image/heic', buffer: Buffer.from('x') });
    await expect(page.getByRole('alert')).toContainText(/HEIC/);
    await page.getByLabel('Plan files').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
    await expect(page.getByRole('alert')).toContainText(/corrupt|could not be read/i);
    await page.getByLabel('Plan files').setInputFiles({ name: 'bad.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 garbage') });
    await expect(page.getByRole('alert')).toContainText(/not a valid PDF|corrupt/i);
    await expect(page.getByTestId('import-item')).toHaveCount(0);
    expect(await dbAll(page, 'assets')).toHaveLength(0);
  });

  test('A03b replacing a plan that has findings requires an explicit choice', async ({ page }) => {
    await openSample(page);
    await page.getByRole('button', { name: 'Replace' }).first().click();
    await page.getByLabel('Plan files').setInputFiles(demo('plan-level4.png'));
    const run = page.getByRole('button', { name: /^Import plan$/ });
    await expect(page.getByText(/has 2 finding\(s\)/)).toBeVisible();
    await expect(run).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
    expect((await dbAll(page, 'assets')).filter((a) => a.kind === 'plan')).toHaveLength(5);
  });
});

test.describe('stack, isolation and gestures (A04-A08, A21)', () => {
  test.beforeEach(async ({ page }) => { await openSample(page); });

  test('A04 isolating a floor hides every other floor, pin and label from rendering and hit testing', async ({ page }) => {
    const before = await state(page);
    expect(before.visible).toHaveLength(5);
    await isolate(page, 'Level 2');
    const s = await state(page);
    expect(s.mode).toBe('isolated3d');
    expect(s.visible).toEqual([s.floorId]);
    expect(s.interactive).toEqual([s.floorId]);
    // no other floor can be picked, anywhere on screen
    const picks = await page.evaluate(() => { const e = (window as any).__inspector.engine; const out = new Set<string | null>(); for (let x = 0; x < 640; x += 16) for (let y = 0; y < 700; y += 16) out.add(e.pickFloor(x, y)); return [...out]; });
    expect(picks.filter((p) => p && p !== s.floorId)).toEqual([]);
    await expect(canvas(page)).toHaveAttribute('data-mode', 'isolated3d');
  });

  test('A04b prefers-reduced-motion applies isolation immediately', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await openSample(page);
    await floorButton(page, 'Level 1').click();
    const s = await state(page);
    expect(s.visible).toHaveLength(1);
    expect(s.animating).toBe(false);
    await ctx.close();
  });

  test('A05 one-finger horizontal drag rotates yaw continuously; elevation is locked', async ({ page }) => {
    await isolate(page, 'Level 1');
    const a = await state(page);
    await drag(page, [200, 300], [400, 300]);
    const b = await state(page);
    expect(((b.camera.yaw - a.camera.yaw + 360) % 360)).toBeCloseTo(60, 0); // 200px * 0.3
    expect(b.camera.elevation).toBe(a.camera.elevation);
    expect(b.camera.zoom).toBeCloseTo(a.camera.zoom, 6);
    expect(b.camera.panX).toBeCloseTo(a.camera.panX, 6);
    // keep going past 180 degrees: reveals the opposite side without any fixed-view switching
    await drag(page, [100, 300], [500, 300]); await drag(page, [100, 300], [500, 300]);
    const c = await state(page);
    expect(c.camera.elevation).toBe(a.camera.elevation);
    expect(((c.camera.yaw - a.camera.yaw + 360) % 360)).toBeCloseTo(300, 0);
    expect(c.mode).toBe('isolated3d');
  });

  test('A06 vertical/diagonal drags and two-finger twist never tilt, invert or twist', async ({ page }) => {
    await isolate(page, 'Level 1');
    const a = await state(page);
    await drag(page, [300, 150], [300, 600]);
    let b = await state(page);
    expect(b.camera).toEqual(a.camera);
    await drag(page, [200, 200], [300, 500]); // diagonal: only the horizontal part counts
    b = await state(page);
    expect(b.camera.elevation).toBe(a.camera.elevation);
    expect(b.camera.yaw - a.camera.yaw).toBeCloseTo(30, 0);
    const yaw0 = b.camera.yaw;
    // two-finger twist about a centre, constant distance
    const c = [300, 350], r = 80;
    await pointer(page, 'pointerdown', { id: 1, x: c[0] - r, y: c[1] });
    await pointer(page, 'pointerdown', { id: 2, x: c[0] + r, y: c[1] });
    for (let i = 1; i <= 12; i++) {
      const t = (i / 12) * (Math.PI / 2);
      await pointer(page, 'pointermove', { id: 1, x: c[0] - r * Math.cos(t), y: c[1] - r * Math.sin(t) });
      await pointer(page, 'pointermove', { id: 2, x: c[0] + r * Math.cos(t), y: c[1] + r * Math.sin(t) });
    }
    await pointer(page, 'pointerup', { id: 1, x: 0, y: 0 }); await pointer(page, 'pointerup', { id: 2, x: 0, y: 0 });
    const d = await state(page);
    expect(d.camera.yaw).toBeCloseTo(yaw0, 6);
    expect(d.camera.elevation).toBe(a.camera.elevation);
    expect(d.camera.zoom).toBeCloseTo(b.camera.zoom, 3);
  });

  test('A07 two-finger pan and pinch work, survive pointer-count changes and never create pins or scroll the page', async ({ page }) => {
    await isolate(page, 'Level 1');
    await page.getByRole('button', { name: 'Add pin' }).click();
    const a = await state(page);
    await pointer(page, 'pointerdown', { id: 1, x: 250, y: 350 });
    await pointer(page, 'pointerdown', { id: 2, x: 350, y: 350 });
    for (let i = 1; i <= 8; i++) { // pan right/down while spreading
      await pointer(page, 'pointermove', { id: 1, x: 250 + i * 6 - i * 3, y: 350 + i * 4 });
      await pointer(page, 'pointermove', { id: 2, x: 350 + i * 6 + i * 3, y: 350 + i * 4 });
    }
    const mid = await state(page);
    expect(mid.camera.zoom).toBeGreaterThan(a.camera.zoom);
    expect(mid.camera.panX).toBeGreaterThan(a.camera.panX);
    expect(mid.camera.yaw).toBe(a.camera.yaw);
    // lift one finger, keep dragging with the other: no jump
    await pointer(page, 'pointerup', { id: 2, x: 0, y: 0 });
    const afterLift = await state(page);
    await pointer(page, 'pointermove', { id: 1, x: 250 + 8 * 3 + 1, y: 350 + 32 });
    const next = await state(page);
    expect(Math.abs(next.camera.yaw - afterLift.camera.yaw)).toBeLessThan(0.5);
    await pointer(page, 'pointerup', { id: 1, x: 0, y: 0 });
    expect(await dbAll(page, 'findings')).toHaveLength(8); // unchanged (sample has 8)
    await expect(page.getByTestId('placement-panel')).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('A08 2D/3D toggling keeps selection and coordinates; each view restores its own state', async ({ page }) => {
    await isolate(page, 'Level 2');
    await settle(page);
    const fid = (await state(page)).floorId!;
    await page.getByTestId('finding-row').filter({ hasText: 'L2-001' }).click();
    const before = await dbAll(page, 'findings');
    await drag(page, [200, 300], [320, 300]); // rotate in 3D
    const s3 = await state(page);
    await page.getByRole('button', { name: '2D view' }).first().click();
    let s2 = await state(page);
    expect(s2.mode).toBe('floor2d'); expect(s2.camera.elevation).toBe(90); expect(s2.camera.yaw).toBe(0);
    await drag(page, [300, 300], [260, 330]); await page.getByRole('button', { name: 'Zoom in' }).click();
    const s2b = await state(page);
    await page.getByRole('button', { name: 'Show 3D' }).click();
    const back3 = await state(page);
    expect(back3.camera.yaw).toBeCloseTo(s3.camera.yaw, 4);
    expect(back3.camera.zoom).toBeCloseTo(s3.camera.zoom, 4);
    await page.getByRole('button', { name: '2D view' }).first().click();
    s2 = await state(page);
    expect(s2.camera.zoom).toBeCloseTo(s2b.camera.zoom, 4);
    expect(s2.floorId).toBe(fid);
    await expect(page.getByTestId('finding-editor')).toContainText('L2-001');
    expect(await dbAll(page, 'findings')).toEqual(before);
  });

  test('A21 returning to building and rapidly switching floors settles on the last choice with no ghosts', async ({ page }) => {
    await isolate(page, 'Level 3');
    await page.getByRole('button', { name: 'Return to building' }).first().click();
    for (const n of ['Ground', 'Level 4', 'Level 1', 'Level 2']) await floorButton(page, n).click({ noWaitAfter: true });
    await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return !s.animating; });
    const s = await state(page);
    expect(s.floorId).toBe(await floorIdByName(page, 'Level 2'));
    expect(s.visible).toEqual([s.floorId]); expect(s.interactive).toEqual([s.floorId]);
    await page.getByRole('button', { name: 'Return to building' }).first().click();
    await settle(page);
    const o = await state(page);
    expect(o.mode).toBe('overview3d'); expect(o.visible).toHaveLength(5); expect(o.interactive).toHaveLength(5);
  });

  test('wheel zoom is clamped and Fit view recovers; keyboard controls work', async ({ page }) => {
    await isolate(page, 'Level 1');
    const fit = await state(page);
    await canvas(page).hover();
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400);
    const z = await state(page);
    expect(z.camera.zoom).toBeLessThanOrEqual(fit.camera.zoom * 16 + 1e-6);
    await page.getByRole('button', { name: 'Fit view' }).click(); await settle(page);
    expect((await state(page)).camera.zoom).toBeCloseTo(fit.camera.zoom, 3);
    await canvas(page).focus();
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).camera.yaw).toBeCloseTo(fit.camera.yaw + 5, 3);
    await page.keyboard.press('Shift+ArrowLeft');
    expect((await state(page)).camera.panX).toBeGreaterThan(fit.camera.panX);
    await page.keyboard.press('+');
    expect((await state(page)).camera.zoom).toBeGreaterThan(fit.camera.zoom);
  });

  test('tapping a floor in the overview isolates it (pointer tap, not just the list)', async ({ page }) => {
    const ids = (await state(page)).visible;
    const target = ids[2];
    const p = await page.evaluate((id) => { const e = (window as any).__inspector.engine; return e.uvToScreen(id, 0.5, 0.5); }, target);
    await tap(page, p.x, p.y);
    await page.waitForFunction(() => (window as any).__inspector.engine.debugState().mode === 'isolated3d');
    expect((await state(page)).floorId).toBe(target);
  });
});
