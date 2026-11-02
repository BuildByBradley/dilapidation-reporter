import { expect, test, type Page, type Route } from '@playwright/test';

// A stand-in for the Supabase sign-in service, so the compulsory two-factor screens run against the real supabase-js client.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const jwt = (aal: 'aal1' | 'aal2') => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, aud: 'authenticated', role: 'authenticated', aal, email: 'pilot@example.com', exp: Math.floor(Date.now() / 1000) + 3600, session_id: 's1', amr: [{ method: 'password', timestamp: 1 }] })}.sig`;
const user = (factors: unknown[]) => ({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'pilot@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z', factors });
const session = (aal: 'aal1' | 'aal2', factors: unknown[]) => ({ access_token: jwt(aal), refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user(factors) });
const factor = (status: 'verified' | 'unverified') => ({ id: 'fac-1', friendly_name: 'Authenticator', factor_type: 'totp', status, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockSupabase(page: Page, o: { enrolled: boolean; goodCode?: string }) {
  let enrolled = o.enrolled;
  const good = o.goodCode ?? '123456';
  await page.route('**/auth/v1/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname.replace(/^.*\/auth\/v1/, ''); const method = route.request().method();
    if (path === '/token') return json(route, session('aal1', enrolled ? [factor('verified')] : []));
    if (path === '/user') return json(route, user(enrolled ? [factor('verified')] : []));
    if (path === '/factors' && method === 'POST') return json(route, { id: 'fac-1', type: 'totp', friendly_name: 'Authenticator', totp: { qr_code: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/x' } });
    if (/\/factors\/.+\/challenge$/.test(path)) return json(route, { id: 'ch-1', expires_at: Math.floor(Date.now() / 1000) + 300 });
    if (/\/factors\/.+\/verify$/.test(path)) {
      const code = JSON.parse(route.request().postData() ?? '{}').code;
      if (code !== good) return json(route, { code: 400, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 400);
      enrolled = true;
      return json(route, session('aal2', [factor('verified')]));
    }
    if (/\/factors\/.+/.test(path) && method === 'DELETE') return json(route, { id: 'fac-1' });
    return json(route, {});
  });
  await page.route('**/rest/v1/**', (route) => json(route, []));
  await page.route('**/realtime/**', (route) => route.abort());
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('pilot@example.com');
  await page.getByLabel('Password').fill('secret1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('new account is made to set up two-factor before anything syncs', async ({ page }) => {
  await mockSupabase(page, { enrolled: false });
  await signIn(page);
  const setup = page.getByTestId('mfa-setup');
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();
  await expect(setup.getByAltText('QR code for your authenticator app')).toBeVisible();
  await expect(setup).toContainText('JBSWY3DPEHPK3PXP');
  await expect(page.getByTestId('cloud-status')).toContainText('Set up two-factor');
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0); // not syncing yet
  // wrong code is refused with a plain message and the screen stays
  await page.getByTestId('mfa-setup-code').fill('000000');
  await setup.getByRole('button', { name: 'Finish set-up' }).click();
  await expect(setup).toContainText('That code is not right');
  // right code finishes set-up and sync starts
  await page.getByTestId('mfa-setup-code').fill('123 456');
  await setup.getByRole('button', { name: 'Finish set-up' }).click();
  await expect(page.getByRole('button', { name: 'Sync now' }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toHaveCount(0);
  await expect(page.getByTestId('two-factor')).toContainText('cannot be turned off');
  await expect(page.getByRole('button', { name: /Turn off/ })).toHaveCount(0);
});

test('account with two-factor is asked for its code at sign-in', async ({ page }) => {
  await mockSupabase(page, { enrolled: true });
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();
  await expect(page.getByTestId('cloud-status')).toContainText('Enter your code');
  await expect(page.getByRole('button', { name: 'Sync now' })).toHaveCount(0);
  await page.getByTestId('mfa-code').fill('999999');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert').or(page.getByRole('status')).filter({ hasText: 'not right' })).toBeVisible();
  await page.getByTestId('mfa-code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('button', { name: 'Sync now' }).first()).toBeVisible();
});

test('cancelling the compulsory set-up signs the user out', async ({ page }) => {
  await mockSupabase(page, { enrolled: false });
  await signIn(page);
  await page.getByTestId('mfa-setup').getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
