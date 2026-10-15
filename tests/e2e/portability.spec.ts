import { expect, test, type Page } from '@playwright/test';
import { zipSync, strToU8, unzipSync } from 'fflate';
import fs from 'node:fs';
import { dbAll, demo, isolate, openSample } from './helpers';

async function downloadBackup(page: Page): Promise<Buffer> {
  await page.getByRole('button', { name: 'Project ▾' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Back up project' }).click()]);
  const path = await dl.path();
  return fs.readFileSync(path!);
}
const projects = (page: Page) => dbAll<{ id: string; name: string }>(page, 'projects');

test('A16 back up then restore as a new, independent project; original untouched', async ({ page }) => {
  await openSample(page);
  const zip = await downloadBackup(page);
  const entries = Object.keys(unzipSync(new Uint8Array(zip)));
  expect(entries).toContain('manifest.json');
  expect(entries.filter((e) => e.startsWith('blobs/')).length).toBeGreaterThan(20);
  const [orig] = await projects(page);
  const origFindings = await dbAll(page, 'findings');
  await page.goto('/#/');
  await page.getByLabel('Backup file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: zip });
  await expect(page.getByTestId('project-card')).toHaveCount(2, { timeout: 30_000 });
  const ps = await projects(page);
  const copy = ps.find((p) => p.id !== orig.id)!;
  expect(copy.name).toContain('(restored)');
  const all = await dbAll(page, 'findings');
  const copyFindings = all.filter((f) => f.projectId === copy.id);
  expect(copyFindings).toHaveLength(origFindings.length);
  const key = (f: any) => `${f.reference}|${f.title}|${f.u}|${f.v}|${f.severity}|${f.description}`;
  expect(copyFindings.map(key).sort()).toEqual(origFindings.map(key).sort());
  expect(new Set(copyFindings.map((f) => f.id)).size).toBe(copyFindings.length);
  expect(copyFindings.every((f) => !origFindings.some((o) => o.id === f.id))).toBe(true);
  const photos = await dbAll(page, 'photos');
  expect(photos.filter((p) => p.projectId === copy.id)).toHaveLength(photos.filter((p) => p.projectId === orig.id).length);
  const blobs = await dbAll(page, 'blobs');
  expect(blobs.filter((b) => b.projectId === copy.id).length).toBe(blobs.filter((b) => b.projectId === orig.id).length);
  // edit the copy; the original is unchanged
  await page.getByTestId('project-card').filter({ hasText: '(restored)' }).getByRole('button', { name: 'Open' }).click();
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
  await page.getByTestId('finding-row').first().click();
  await page.getByTestId('finding-editor').getByLabel('Title').fill('EDITED IN COPY');
  await page.getByRole('button', { name: 'Close finding editor' }).click();
  const after = await dbAll(page, 'findings');
  expect(after.filter((f) => f.projectId === orig.id).map(key).sort()).toEqual(origFindings.map(key).sort());
  expect(after.some((f) => f.projectId === copy.id && f.title === 'EDITED IN COPY')).toBe(true);
});

test('A17 corrupt, future-version, missing-asset and unsafe-path backups are rejected without changes', async ({ page }) => {
  await openSample(page);
  const good = new Uint8Array(await downloadBackup(page));
  await page.goto('/#/');
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  const files = unzipSync(good);
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString());
  const rebuild = (m: any, mutate?: (f: Record<string, Uint8Array>) => void) => { const f = { ...files, 'manifest.json': strToU8(JSON.stringify(m)) }; mutate?.(f); return Buffer.from(zipSync(f)); };
  const firstBlob = Object.values(manifest.blobs)[0] as string;
  const cases: [string, Buffer, RegExp][] = [
    ['corrupt', Buffer.from('this is not a zip file at all'), /not a valid backup/i],
    ['future', rebuild({ ...manifest, version: 99 }), /newer version/i],
    ['missing asset', rebuild(manifest, (f) => { delete f[firstBlob]; }), /missing an asset/i],
    ['unsafe path', rebuild({ ...manifest, blobs: { ...manifest.blobs, evil: '../../evil.png' } }), /unsafe/i],
    ['bad schema', rebuild({ ...manifest, findings: [{ ...manifest.findings[0], u: 7 }] }), /invalid/i],
    ['dangling ref', rebuild({ ...manifest, findings: [{ ...manifest.findings[0], categoryId: 'nope' }] }), /inconsistent/i],
  ];
  for (const [name, buffer, msg] of cases) {
    await page.getByLabel('Backup file').setInputFiles({ name: `${name}.zip`, mimeType: 'application/zip', buffer });
    await expect(page.getByRole('alert').filter({ hasText: /Restore failed/ }).last(), name).toContainText(msg);
    await expect(page.getByTestId('project-card'), name).toHaveCount(1);
  }
  expect(await projects(page)).toHaveLength(1);
});

test('A22 duplicate is independent; deleting the copy leaves the original intact', async ({ page }) => {
  await openSample(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(2);
  const [a, b] = await projects(page);
  const beforeBlobs = (await dbAll(page, 'blobs')).filter((x) => x.projectId === a.id).length;
  const copyName = [a, b].find((p) => p.name.includes('(copy)'))!;
  await page.getByTestId('project-card').filter({ hasText: '(copy)' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog')).toContainText('permanently removes');
  await page.getByRole('button', { name: 'Delete project' }).click();
  await expect(page.getByTestId('project-card')).toHaveCount(1);
  const orig = [a, b].find((p) => p.id !== copyName.id)!;
  const remainingBlobs = await dbAll(page, 'blobs');
  expect(remainingBlobs.every((x) => x.projectId === orig.id)).toBe(true);
  expect(remainingBlobs.length).toBe(beforeBlobs);
  expect((await dbAll(page, 'findings')).every((f) => f.projectId === orig.id)).toBe(true);
  expect(await dbAll(page, 'findings')).toHaveLength(8);
  expect(await dbAll(page, 'photos')).toHaveLength(6);
});

test('A18 replacing a plan with retained pins flags them in the workspace, editor and report until cleared', async ({ page }) => {
  await openSample(page);
  await page.getByRole('button', { name: 'Replace' }).first().click();
  await page.getByLabel('Plan files').setInputFiles(demo('plan-level4.png'));
  await page.getByLabel('Replace and keep pin positions').check();
  await page.getByRole('button', { name: /^Import plan$/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('review-banner')).toContainText('2 findings need a location review');
  const flagged = (await dbAll(page, 'findings')).filter((f) => f.locationNeedsReview);
  expect(flagged).toHaveLength(2);
  expect(flagged.map((f) => f.reference).sort()).toEqual(['D-001', 'D-002']);
  // positions are unchanged ("normalised positions kept")
  await page.getByTestId('finding-row').filter({ hasText: 'D-001' }).click();
  await expect(page.getByTestId('review-warning')).toBeVisible();
  await page.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByTestId('report-review-warning')).toContainText('D-001, D-002');
  await expect(page.getByTestId('report-finding').filter({ hasText: 'D-001' })).toContainText('Location needs review');
  await page.getByRole('button', { name: /Back to inspection/ }).click();
  await page.getByTestId('finding-row').filter({ hasText: 'D-001' }).click();
  await page.getByRole('button', { name: 'Mark location as reviewed' }).click();
  await expect(page.getByTestId('review-banner')).toContainText('1 finding needs');
  // replace-and-remove path
  await isolate(page, 'Ground').catch(() => {});
  await page.getByRole('button', { name: 'Replace' }).first().click();
  await page.getByLabel('Plan files').setInputFiles(demo('plan-level1.png'));
  await page.getByLabel('Replace and remove').check();
  await page.getByRole('button', { name: /^Import plan$/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 });
  expect((await dbAll(page, 'findings')).filter((f) => f.floorId === flagged[0].floorId)).toHaveLength(0);
  expect(await dbAll(page, 'findings')).toHaveLength(6);
});
