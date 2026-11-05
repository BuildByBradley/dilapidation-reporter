import { expect, test, type Page, type Route } from '@playwright/test';
import { dbAll, newProject } from './helpers';

// A stand-in for Supabase: password sign-in returns an already-verified (two-factor) session, and the cloud accepts every write.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER_ID = '22222222-2222-4222-8222-222222222222';
const EMAIL = 'owner@example.com';
const factor = { id: 'fac-1', friendly_name: 'Authenticator', factor_type: 'totp', status: 'verified', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
const user = { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: EMAIL, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z', factors: [factor] };
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', aal: 'aal2', email: EMAIL, exp: Math.floor(Date.now() / 1000) + 3600, session_id: 's1', amr: [{ method: 'totp', timestamp: 1 }] })}.sig`;
const session = { access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSupabase(page: Page, calls: string[] = []) {
  await page.route('**/auth/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/auth\/v1/, '');
    calls.push(path);
    if (path === '/token' || path === '/signup') return json(route, session);
    if (path === '/user') return json(route, user);
    return json(route, {});
  });
  await page.route('**/rest/v1/**', (route) => json(route, []));
  await page.route('**/storage/v1/**', (route) => json(route, {}));
  await page.route('**/realtime/**', (route) => route.abort());
}

async function signIn(page: Page) {
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill('secret1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

test('anyone can create an account without an invite; the button explains what is missing', async ({ page }) => {
  const calls: string[] = [];
  await mockSupabase(page, calls);
  await page.goto('/');
  await expect(page.getByText('No invite is needed')).toBeVisible();
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator('.cloud-panel [role=status]')).toContainText('Enter your email address first');
  await page.getByLabel('Email').fill('new.person@example.com');
  await page.getByLabel('Password').fill('abc');
  await create.click();
  await expect(page.locator('.cloud-panel [role=status]')).toContainText('at least 6 characters');
  await page.getByLabel('Password').fill('abcdef');
  await create.click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(calls).toContain('/signup');
});

test('signing out removes the account’s projects from this device', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await signIn(page);
  await newProject(page, 'Private building');
  await page.goto('/#/');
  await expect(page.getByRole('link', { name: 'Private building' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByTestId('project-card')).toHaveCount(0);
  expect(await dbAll(page, 'projects')).toHaveLength(0);
});

test('when the sign-in has lapsed, the account’s projects are locked until it signs in again', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await signIn(page);
  await newProject(page, 'Private building');
  const projectUrl = page.url();
  // The saved sign-in disappears (expired, cleared) without signing out.
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('sb-')) localStorage.removeItem(k); });
  await page.goto('/#/');
  await page.reload();
  await expect(page.getByTestId('device-locked')).toContainText(EMAIL);
  await expect(page.getByTestId('project-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New inspection' })).toHaveCount(0);
  // A direct link to the project lands on the sign-in page instead.
  await page.goto(projectUrl);
  await expect(page.getByTestId('device-locked')).toBeVisible();
  // Signing in again as the same account unlocks them.
  await page.getByLabel('Password').fill('secret1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.goto('/#/');
  await expect(page.getByRole('link', { name: 'Private building' })).toBeVisible();
});

test('someone else can remove a locked account’s projects from the device', async ({ page }) => {
  await mockSupabase(page);
  await page.goto('/');
  await signIn(page);
  await newProject(page, 'Private building');
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('sb-')) localStorage.removeItem(k); });
  await page.goto('/#/');
  await page.reload();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Remove from this device' }).click();
  await expect(page.getByTestId('device-locked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New inspection' })).toBeVisible();
  expect(await dbAll(page, 'projects')).toHaveLength(0);
});
