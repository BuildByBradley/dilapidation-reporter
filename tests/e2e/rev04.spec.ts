import { expect, test } from '@playwright/test';
import { openSample } from './helpers';

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
