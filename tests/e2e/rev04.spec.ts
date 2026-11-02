import { expect, test } from '@playwright/test';
import { openSample, pointer } from './helpers';

test('Help: the guide is searchable; Ask and Suggest ask you to sign in first', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Help' }).click();
  const dlg = page.getByRole('dialog', { name: 'Help' });
  await expect(dlg.getByRole('tab', { name: 'Ask' })).toHaveAttribute('aria-selected', 'true');
  await expect(dlg).toContainText('Sign in on the projects page to ask the assistant');
  await dlg.getByRole('tab', { name: 'Guide' }).click();
  await dlg.getByLabel('Search the guide').fill('invite link');
  await expect(dlg.locator('details')).toHaveCount(1);
  await expect(dlg.locator('details').first()).toContainText('Create invite link');
  await dlg.getByLabel('Search the guide').fill('');
  expect(await dlg.locator('details').count()).toBeGreaterThan(10);
  await dlg.getByRole('tab', { name: 'Suggest an improvement' }).click();
  await expect(dlg).toContainText('Sign in on the projects page to send a suggestion');
  await dlg.screenshot({ path: 'test-results/help.png' });
});

test('Share project explains that sign-in is needed; join links ask you to sign in', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Project ▾' }).click();
  await page.getByRole('menuitem', { name: 'Share project…' }).click();
  await expect(page.getByRole('dialog')).toContainText('Sharing needs cloud sync. Sign in on the projects page first');
  await page.getByRole('dialog').locator('.dialog-foot').getByRole('button', { name: 'Close' }).click();
  await page.goto('/#/join/abcdef1234');
  await expect(page.getByRole('heading', { name: 'Join a shared project' })).toBeVisible();
  await expect(page.getByText('You have been invited to a dilapidation inspection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('switching floors while zoomed in keeps the same spot and zoom; at fit, the next floor is fitted', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: /^Ground,/ }).click();
  await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return s.mode !== 'overview3d' && !s.animating; });
  await page.getByRole('button', { name: '2D view' }).first().click();
  await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return s.mode === 'floor2d' && !s.animating; });
  const centreUv = (floorId: string) => page.evaluate((id) => {
    const e = (window as any).__inspector.engine, st = e.debugState();
    return e.screenToUv(id, st.size.w / 2, st.size.h / 2);
  }, floorId);
  const fitZoomL1 = await page.evaluate(() => (window as any).__inspector.engine.debugState().camera.zoom);
  // zoom in on the top-left part of Ground
  await page.evaluate(() => (window as any).__inspector.engine.zoomBy(3));
  await page.waitForFunction(() => !(window as any).__inspector.engine.debugState().animating);
  // drag the plan so the centre is off the middle of the drawing
  await pointer(page, 'pointerdown', { id: 1, x: 300, y: 300, pointerType: 'mouse' });
  for (let i = 1; i <= 5; i++) await pointer(page, 'pointermove', { id: 1, x: 300 + i * 30, y: 300 + i * 20, pointerType: 'mouse' });
  await pointer(page, 'pointerup', { id: 1, x: 450, y: 400, pointerType: 'mouse' });
  const g = await page.evaluate(() => (window as any).__inspector.engine.debugState());
  const uvG = await centreUv(g.floorId);
  await page.getByRole('button', { name: /^Level 1,/ }).click();
  await page.waitForFunction((gid) => { const s = (window as any).__inspector.engine.debugState(); return s.floorId !== gid && !s.animating; }, g.floorId);
  const l1 = await page.evaluate(() => (window as any).__inspector.engine.debugState());
  const uvL1 = await centreUv(l1.floorId);
  expect(Math.abs(uvG.u - 0.5) + Math.abs(uvG.v - 0.5)).toBeGreaterThan(0.05);
  expect(uvL1.u).toBeCloseTo(uvG.u, 2); expect(uvL1.v).toBeCloseTo(uvG.v, 2);
  expect(l1.camera.zoom).toBeGreaterThan(fitZoomL1 * 2);
  // back to fit, then to another floor: fitted
  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.waitForFunction(() => !(window as any).__inspector.engine.debugState().animating);
  await page.getByRole('button', { name: /^Level 2,/ }).click();
  await page.waitForFunction((id) => { const s = (window as any).__inspector.engine.debugState(); return s.floorId !== id && !s.animating; }, l1.floorId);
  const l2 = await page.evaluate(() => (window as any).__inspector.engine.debugState());
  expect(l2.camera.zoom).toBeLessThan(fitZoomL1 * 1.5);
});
