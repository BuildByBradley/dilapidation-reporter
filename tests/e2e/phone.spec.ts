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
