import { expect, test, devices } from '@playwright/test';
import { dbAll, settle, state } from './helpers';

// iPhone 13 viewport/UA/touch, but run in Chromium (the descriptor defaults to WebKit, which is not installed here)
const { defaultBrowserType: _browser, ...phone } = devices['iPhone 13'];
test.use({ ...phone, hasTouch: true });

async function openSampleOnPhone(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load sample project' }).click();
  await page.waitForURL(/#\/p\//, { timeout: 90_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5, null, { timeout: 30_000 });
  await settle(page);
}

test('phone: the plan fills the screen and the other panels are hidden behind edge tabs', async ({ page }) => {
  await openSampleOnPhone(page);
  const vp = page.viewportSize()!;
  const box = (await page.getByTestId('viewer').boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(vp.width - 1);
  expect(box.height).toBeGreaterThanOrEqual(vp.height - 1);
  for (const id of ['drawer-top', 'drawer-left', 'drawer-right']) await expect(page.locator(`#${id}`)).toBeHidden();
  await expect(page.getByTestId('bottom-sheet')).toHaveCount(0);
  // nothing makes the page itself scroll sideways
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('phone: left, right and top drawers open from their tabs and close again', async ({ page }) => {
  await openSampleOnPhone(page);
  await page.locator('.tab-left').tap();
  await expect(page.locator('#drawer-left')).toBeVisible();
  await expect(page.locator('#drawer-right')).toBeHidden();
  await page.getByRole('button', { name: /^Level 2,/ }).tap();
  await expect(page.locator('#drawer-left')).toBeHidden();            // choosing a floor returns you to the plan
  await page.waitForFunction(() => (window as any).__inspector.engine.debugState().visible.length === 1);
  await expect(page.locator('.tab-top')).toContainText('Level 2');
  await page.locator('.tab-right').tap();
  await expect(page.locator('#drawer-right')).toBeVisible();
  await page.getByTestId('finding-row').filter({ hasText: 'D-005' }).tap();
  await expect(page.locator('#drawer-right')).toBeHidden();
  await expect(page.getByTestId('bottom-sheet')).toBeVisible();      // the editor lives in the bottom sheet
  await expect(page.getByTestId('finding-editor')).toContainText('D-005');
  await page.getByRole('button', { name: /D-005 — Lifting floor finish/ }).tap(); // collapse
  await expect(page.getByTestId('finding-editor')).toHaveCount(0);
  await page.locator('.tab-top').tap();
  await expect(page.locator('#drawer-top')).toBeVisible();
  await page.getByTestId('scrim').tap({ position: { x: 20, y: 500 } });
  await expect(page.locator('#drawer-top')).toBeHidden();
});

test('phone: place a pin and save it from the bottom sheet', async ({ page }) => {
  await openSampleOnPhone(page);
  await page.locator('.tab-left').tap();
  await page.getByRole('button', { name: /^Ground,/ }).tap();
  await page.waitForFunction(() => (window as any).__inspector.engine.debugState().visible.length === 1);
  await settle(page);
  await page.getByRole('button', { name: 'Add pin' }).tap();
  const fid = (await state(page)).floorId!;
  const p = await page.evaluate((id) => (window as any).__inspector.engine.uvToScreen(id, 0.6, 0.5), fid);
  const box = (await page.getByTestId('viewer-canvas').boundingBox())!;
  await page.touchscreen.tap(box.x + p.x, box.y + p.y);
  await expect(page.getByTestId('placement-panel')).toBeVisible();
  await page.getByLabel('Title *').fill('Phone pin');
  await page.getByLabel('Category *').selectOption({ label: 'Cracks' });
  await page.getByRole('button', { name: 'Save finding' }).tap();
  await expect(page.getByTestId('finding-editor')).toContainText('D-009');
  expect((await dbAll(page, 'findings')).some((f) => f.title === 'Phone pin')).toBe(true);
});

test('phone: placing a pin opens a full-screen sheet — position first, no keyboard; photos attach on save', async ({ page }) => {
  await openSampleOnPhone(page);
  await page.locator('.tab-left').tap();
  await page.getByRole('button', { name: /^Level 1,/ }).tap();
  await page.waitForFunction(() => (window as any).__inspector.engine.debugState().visible.length === 1);
  await settle(page);
  await page.getByRole('button', { name: 'Add pin' }).tap();
  const fid = (await state(page)).floorId!;
  const p = await page.evaluate((id) => (window as any).__inspector.engine.uvToScreen(id, 0.4, 0.4), fid);
  const box = (await page.getByTestId('viewer-canvas').boundingBox())!;
  await page.touchscreen.tap(box.x + p.x, box.y + p.y);
  const sheet = page.getByTestId('bottom-sheet');
  await expect(page.getByTestId('placement-panel')).toBeVisible();
  const vp = page.viewportSize()!;
  const sb = (await sheet.boundingBox())!;
  expect(sb.y).toBeLessThanOrEqual(1);                                   // fills the screen from the top
  expect(sb.height).toBeGreaterThan(vp.height * 0.8);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT'); // no keyboard on open
  // step 1 is first: magnifier and direction pad, before the title
  const mag = (await page.getByLabel('Magnified view of the pin location').boundingBox())!;
  const title = (await page.getByLabel('Title *').boundingBox())!;
  expect(mag.y).toBeLessThan(title.y);
  const px = async () => Number(/pixel (\d+),/.exec(await page.getByTestId('placement-panel').innerText())![1]);
  const before = await px();
  await page.getByRole('button', { name: 'Nudge right' }).tap();
  expect(await px()).toBe(before + 1);
  await page.screenshot({ path: 'test-results/phone-placement-sheet.png' });
  // "Show plan" collapses the sheet; re-tapping the plan moves the pin and brings the sheet back
  await page.getByRole('button', { name: 'Show plan to re-tap' }).tap();
  await expect(page.getByTestId('placement-panel')).toHaveCount(0);
  const p2 = await page.evaluate((id) => (window as any).__inspector.engine.uvToScreen(id, 0.45, 0.45), fid);
  await page.touchscreen.tap(box.x + p2.x, box.y + p2.y);
  await expect(page.getByTestId('placement-panel')).toBeVisible();
  // details, then photos in the same sheet
  await page.getByLabel('Title *').fill('Damp patch');
  await page.getByLabel('Category *').selectOption({ label: 'Moisture / water damage' });
  await page.getByTestId('placement-panel').getByLabel('Upload photos').setInputFiles(['public/demo/photo-landscape.jpg', 'public/demo/photo-portrait.jpg']);
  await expect(page.getByTestId('pending-photos').locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove new photo 2' }).tap();
  await expect(page.getByTestId('pending-photos').locator('li')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/phone-placement-details.png', fullPage: false });
  await page.getByRole('button', { name: 'Save finding + 1 photo' }).tap();
  await expect(page.getByTestId('finding-editor')).toContainText('Photographs (1)');
  await expect(page.getByTestId('finding-editor').getByLabel('Title')).toHaveValue('Damp patch');
  const f = (await dbAll(page, 'findings')).find((x) => x.title === 'Damp patch');
  expect((await dbAll(page, 'photos')).filter((ph) => ph.findingId === f.id)).toHaveLength(1);
});

test('phone: fitted floor is not hidden behind the edge tabs or toolbar', async ({ page }) => {
  await openSampleOnPhone(page);
  await page.locator('.tab-left').tap();
  await page.getByRole('button', { name: /^Ground,/ }).tap();
  await page.waitForFunction(() => (window as any).__inspector.engine.debugState().visible.length === 1);
  await settle(page);
  const b = await page.evaluate(() => { const e = (window as any).__inspector.engine; const s = e.debugState(); return { bounds: e.planScreenBounds(s.floorId), size: s.size }; });
  expect(b.bounds.minX).toBeGreaterThanOrEqual(40);
  expect(b.bounds.maxX).toBeLessThanOrEqual(b.size.w - 40);
  expect(b.bounds.minY).toBeGreaterThanOrEqual(44);
  expect(b.bounds.maxY).toBeLessThanOrEqual(b.size.h - 70);
});

test.describe('phone held sideways', () => {
  test.use({ viewport: { width: 800, height: 370 } });
  test('a short, wide screen gets the phone layout (plan full screen, edge tabs)', async ({ page }) => {
    await openSampleOnPhone(page);
    await expect(page.getByTestId('workspace-compact')).toBeVisible();
    const box = (await page.getByTestId('viewer').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(799);
    await expect(page.locator('.tab-left')).toBeVisible();
  });
});
