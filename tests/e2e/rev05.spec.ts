import { expect, test } from '@playwright/test';
import { dbAll, isolate, openSample, screenOf, state, tap } from './helpers';

const byRef = async (page: import('@playwright/test').Page, ref: string) => (await dbAll(page, 'findings')).find((f) => f.reference === ref);

test('description suggestions: pick to link, edit changes all linked, make unique splits one off', async ({ page }) => {
  await openSample(page);
  await page.getByTestId('finding-row').filter({ hasText: 'L3-001' }).click();
  const editor = page.getByTestId('finding-editor');
  const desc = editor.getByLabel('Description');
  await desc.fill('crack hairline');
  const list = editor.getByRole('listbox', { name: 'Wording already used' });
  await expect(list).toBeVisible();
  const opt = list.getByRole('option').filter({ hasText: 'Hairline diagonal crack' });
  await expect(opt).toContainText('G-001');
  await opt.click();
  await expect(desc).toHaveValue(/^Hairline diagonal crack approx/);
  await expect(editor.getByTestId('description-link')).toContainText('shared with 1 other finding (G-001)');
  await expect.poll(async () => (await byRef(page, 'L3-001'))?.descriptionLinkId).toBeTruthy();
  // no suggestions pop up while editing linked wording: typing edits the shared text
  await desc.press('End'); await desc.type(' Monitor.');
  await expect(list).toBeHidden();
  await expect.poll(async () => (await byRef(page, 'G-001'))?.description).toMatch(/ceiling\. Monitor\.$/);
  // a slightly different case: make this one unique, then change only it
  await editor.getByRole('button', { name: 'Make unique' }).click();
  await expect(editor.getByTestId('description-link')).toHaveCount(0);
  await expect.poll(async () => (await byRef(page, 'L3-001'))?.descriptionLinkId).toBeFalsy();
  await desc.fill('Hairline crack to blockwork only.');
  await expect.poll(async () => (await byRef(page, 'L3-001'))?.description).toBe('Hairline crack to blockwork only.');
  expect((await byRef(page, 'G-001'))?.description).toMatch(/ceiling\. Monitor\.$/);
});

test('a new finding can reuse wording with the keyboard, and is saved linked to it', async ({ page }) => {
  await openSample(page);
  await isolate(page, 'Level 1');
  await page.getByRole('button', { name: 'Add pin' }).first().click();
  const fid = (await state(page)).floorId!;
  const p = await screenOf(page, fid, 0.3, 0.6);
  await tap(page, p.x, p.y);
  const panel = page.getByTestId('placement-panel');
  await panel.getByLabel('Title *').fill('Damp patch');
  await panel.getByLabel('Category *').selectOption({ index: 1 });
  const desc = panel.getByLabel('Description');
  await desc.fill('tide');
  await expect(panel.getByRole('listbox', { name: 'Wording already used' }).getByRole('option')).toHaveCount(1);
  await desc.press('Enter');
  await expect(desc).toHaveValue('Tide-mark staining to plaster approx. 0.6 m above floor level.');
  await expect(panel.getByTestId('description-link')).toContainText('G-002');
  await page.getByRole('button', { name: 'Save finding' }).click();
  await expect(page.getByTestId('finding-editor')).toBeVisible();
  const all = await dbAll(page, 'findings');
  const made = all.find((f) => f.title === 'Damp patch'), g2 = all.find((f) => f.reference === 'G-002');
  expect(made.descriptionLinkId).toBeTruthy();
  expect(made.descriptionLinkId).toBe(g2.descriptionLinkId);
  // ordinary typing in a new finding never links
  expect(all.filter((f) => f.descriptionLinkId)).toHaveLength(2);
});
