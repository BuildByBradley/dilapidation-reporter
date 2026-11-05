import { expect, test, type Page, type Route } from '@playwright/test';
import zlib from 'node:zlib';

// Supabase stand-in: password sign-in gives an already two-factor-verified session for the given email; profile edits are kept.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function signInAs(page: Page, email: string) {
  const id = email.startsWith('john') ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444';
  let meta: Record<string, unknown> = {};
  const factor = { id: 'fac-1', friendly_name: 'Authenticator', factor_type: 'totp', status: 'verified', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  const user = () => ({ id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: meta, created_at: '2026-10-01T00:00:00Z', factors: [factor] });
  const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, aud: 'authenticated', role: 'authenticated', aal: 'aal2', email, exp: Math.floor(Date.now() / 1000) + 3600, session_id: 's1', amr: [{ method: 'totp', timestamp: 1 }] })}.sig`;
  const session = () => ({ access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: user() });
  await page.route('**/auth/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/auth\/v1/, '');
    if (path === '/token') return json(route, session());
    if (path === '/user' && route.request().method() === 'PUT') { meta = { ...meta, ...(JSON.parse(route.request().postData() ?? '{}').data ?? {}) }; return json(route, user()); }
    if (path === '/user') return json(route, user());
    return json(route, {});
  });
  await page.route('**/rest/v1/**', (route) => json(route, []));
  await page.route('**/storage/v1/**', (route) => json(route, {}));
  await page.route('**/realtime/**', (route) => route.abort());
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('secret1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

async function newInspection(page: Page, name: string) {
  await page.getByRole('button', { name: 'New inspection' }).click();
  await page.getByLabel('Project name').fill(name);
}
async function openReport(page: Page) {
  await page.getByRole('button', { name: 'Report' }).click();
  await page.waitForURL(/report$/);
  await expect(page.getByTestId('report-title')).toBeVisible();
}

/** A 300 × 100 PNG: red block on a wide white margin (the margin should be trimmed off). */
function pngWithMargin(): Buffer {
  const w = 300, h = 100, raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) if (x >= 100 && x < 200 && y >= 25 && y < 75) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = 200; raw[i + 1] = 0; raw[i + 2] = 0; } }
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a paragon.co.za account gets the Paragon logo; its inspector name is filled in', async ({ page }) => {
  await signInAs(page, 'bradley@paragon.co.za');
  const form = page.getByTestId('profile-form');
  await expect(form.getByLabel('Company')).toHaveValue('Paragon Architects');
  await form.getByLabel('Your name').fill('Bradley Brits');
  await form.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByTestId('profile-line')).toContainText('Bradley Brits - Paragon Architects');
  await newInspection(page, 'Paragon job');
  await expect(page.getByLabel('Inspector')).toHaveValue('Bradley Brits - Paragon Architects');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/#\/p\//);
  await openReport(page);
  const logo = page.getByTestId('report-logo');
  await expect(logo).toHaveAttribute('alt', 'Paragon Architects');
  await expect(logo).toBeVisible();
});

test('a contractor gets no Paragon logo, is the inspector, and can add their own logo', async ({ page }) => {
  await signInAs(page, 'john@easyelectricians.co.za');
  const form = page.getByTestId('profile-form');
  await form.getByLabel('Your name').fill('John Jantjies');
  await form.getByLabel('Company').fill('Easy Electricians');
  await form.getByRole('button', { name: 'Save name' }).click();
  await newInspection(page, 'Contractor job');
  await expect(page.getByLabel('Inspector')).toHaveValue('John Jantjies - Easy Electricians');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/#\/p\//);
  await openReport(page);
  await expect(page.getByTestId('report-logo')).toHaveCount(0);
  await expect(page.getByTestId('report')).toContainText('John Jantjies - Easy Electricians');
  // add a logo under Project details: margins are trimmed, and it shows on the cover
  await page.goBack();
  await page.getByRole('button', { name: 'Project ▾' }).click();
  await page.getByRole('menuitem', { name: 'Project details' }).click();
  await page.getByLabel('Logo file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: pngWithMargin() });
  await expect(page.getByTestId('logo-preview')).toBeVisible();
  const size = await page.getByTestId('logo-preview').evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]);
  expect(size).toEqual([100, 50]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await openReport(page);
  const logo = page.getByTestId('report-logo');
  await expect(logo).toHaveAttribute('alt', 'Company logo');
  await expect(logo).toBeVisible();
});
