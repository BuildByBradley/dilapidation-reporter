import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbAll, openSample } from './helpers';

const haveTool = (t: string) => spawnSync('which', [t]).status === 0;

/** Insert many long findings (each with two photos) straight into IndexedDB to build a long-report fixture. */
async function addBulk(page: Page, n: number) {
  await page.evaluate(async (n) => {
    const open = indexedDB.open('dilapidation-inspector');
    const db: IDBDatabase = await new Promise((res, rej) => { open.onsuccess = () => res(open.result); open.onerror = () => rej(open.error); });
    const all = (s: string) => new Promise<any[]>((res) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); });
    const [project] = await all('projects'), floors = (await all('floors')).sort((a, b) => a.order - b.order), cats = await all('categories');
    const photoAssets = (await all('assets')).filter((a) => a.kind === 'photo');
    const tx = db.transaction(['findings', 'photos', 'projects'], 'readwrite');
    const long = 'Long observation text that wraps across several lines to exercise pagination and overflow handling. '.repeat(6);
    for (let i = 0; i < n; i++) {
      const num = 9 + i, id = crypto.randomUUID();
      tx.objectStore('findings').add({ id, projectId: project.id, floorId: floors[i % 5].id, reference: `D-${String(num).padStart(3, '0')}`, u: ((i * 37) % 100) / 100 * 0.9 + 0.05, v: ((i * 53) % 100) / 100 * 0.9 + 0.05, categoryId: cats[i % cats.length].id, severity: ['minor', 'moderate', 'major', 'not_assessed'][i % 4], title: `BULK finding ${i + 1} <b>not html</b>`, description: `${long}END-${num}`, locationNotes: `Loc notes ${i}`, locationNeedsReview: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      for (let k = 0; k < 2; k++) tx.objectStore('photos').add({ id: crypto.randomUUID(), findingId: id, projectId: project.id, assetId: photoAssets[(i + k) % photoAssets.length].id, caption: `BULKCAP-${num}-${k}`, order: k, isCover: k === 0, createdAt: new Date().toISOString() });
    }
    tx.objectStore('projects').put({ ...project, nextFindingNumber: project.nextFindingNumber + n });
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    db.close();
  }, n);
}

test('A19 full report ignores workspace filters and matches stored data; escapes user text', async ({ page }) => {
  await openSample(page);
  await page.getByLabel('Filter by severity').selectOption('major');
  await expect(page.getByTestId('finding-row')).toHaveCount(2);
  await page.getByRole('button', { name: 'Report' }).click();
  await page.waitForURL(/report$/);
  await expect(page.getByTestId('report-status')).toContainText('Ready to print', { timeout: 60_000 });
  const findings = await dbAll(page, 'findings'), photos = await dbAll(page, 'photos');
  await expect(page.getByTestId('report-finding')).toHaveCount(findings.length);
  await expect(page.locator('.report-photo')).toHaveCount(photos.length);
  const text = await page.getByTestId('report').innerText();
  for (const f of findings) { expect(text).toContain(f.reference); expect(text).toContain(f.title); }
  expect(text).toContain('regardless of any filters');
  expect(text).toMatch(/prototype inspection record/i);
  expect(text).toContain('Floor plans');
  // summary counts derived from data: 8 findings, 2 major
  await expect(page.locator('.summary-grid table').nth(2).locator('tr', { hasText: 'Major' })).toContainText('2');
  await expect(page.locator('.summary-grid table').first().locator('tr.total')).toContainText('8');
  // every floor has a plan figure with its pins
  await expect(page.locator('.plan-img')).toHaveCount(5);
  // CSV export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export findings CSV' }).click()]);
  const csv = fs.readFileSync((await dl.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toBe('reference,floor,title,category,severity,description,location notes,u,v,photo count,location review required,created time,updated time');
  expect(csv.trim().split('\r\n')).toHaveLength(9);
});

test('empty floor without a plan is reported as not imported, never as inspected', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New inspection' }).click();
  await page.getByLabel('Project name').fill('Empty report');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByTestId('report-status')).toContainText('Ready to print', { timeout: 30_000 });
  await expect(page.getByText(/Floor plan not imported/)).toHaveCount(5);
  await expect(page.getByText('No findings recorded.').first()).toBeVisible();
});

test('A20 printing a long report: legible pages, no clipped content, workspace controls absent', async ({ page }, info) => {
  test.skip(!haveTool('pdftotext'), 'pdftotext (poppler) not installed');
  test.setTimeout(240_000);
  await openSample(page);
  await addBulk(page, 40);
  await page.reload();
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
  await page.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByTestId('report-status')).toContainText('Ready to print', { timeout: 180_000 });
  const total = (await dbAll(page, 'findings')).length;
  expect(total).toBe(48);
  // on-screen overflow checks (no horizontally clipped text or images)
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.report *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').length);
  expect(overflow).toBe(0);
  // user-entered "HTML" is shown literally
  expect(await page.getByTestId('report').innerText()).toContain('<b>not html</b>');
  await page.emulateMedia({ media: 'print' });
  const pdfPath = path.join(os.tmpdir(), `report-${Date.now()}.pdf`);
  await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  const info1 = execFileSync('pdfinfo', [pdfPath]).toString();
  const pages = Number(/Pages:\s+(\d+)/.exec(info1)![1]);
  expect(pages).toBeGreaterThan(10);
  expect(info1).toMatch(/A4|595\.\d+ x 841\.\d+/);
  const txt = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString();
  expect(txt).toMatch(/dilapidation inspection report/i);
  expect(txt).toMatch(/prototype inspection record/i);
  expect(txt).not.toMatch(/Print \/ Save as PDF|Export findings CSV|Back to inspection/); // toolbar is not printed
  const flat = txt.replace(/\s+/g, ' ');
  for (let i = 0; i < 40; i++) { const n = 9 + i; expect(flat, `finding D-${n}`).toContain(`END-${n}`); }
  const caps = (flat.match(/BULKCAP-/g) ?? []).length;
  expect(caps).toBe(80);
  // photos: one image per photo record is embedded (plan snapshots and insets add more)
  const imgs = execFileSync('pdfimages', ['-list', pdfPath]).toString().trim().split('\n').length - 2;
  expect(imgs).toBeGreaterThanOrEqual(86 + 5);
  // a captioned photo is never separated from its caption across pages: each caption page also holds an image
  const perPage: string[] = [];
  for (let p = 1; p <= pages; p++) perPage.push(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), pdfPath, '-']).toString());
  const imgPages = new Set(execFileSync('pdfimages', ['-list', pdfPath]).toString().trim().split('\n').slice(2).map((l) => l.trim().split(/\s+/)[0]));
  perPage.forEach((t, i) => { if (/BULKCAP-/.test(t)) expect(imgPages.has(String(i + 1)), `page ${i + 1} has captions but no image`).toBe(true); });
  fs.copyFileSync(pdfPath, info.outputPath('long-report.pdf'));
});
