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
