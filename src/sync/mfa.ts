import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Two-factor sign-in (authenticator-app codes, TOTP) on top of Supabase Auth.
 * A password sign-in gives an "aal1" session; entering the 6-digit code upgrades it to "aal2".
 * Which accounts must use a code is decided by whether they have enrolled an authenticator.
 * The database rules in supabase/mfa.sql refuse an aal1 session for enrolled accounts.
 */
type Mfa = SupabaseClient['auth']['mfa'];
const fail = (e: { message: string } | null) => { if (e) throw new Error(friendly(e.message)); };

const friendly = (m: string) =>
  /invalid.*(code|totp)|code.*invalid/i.test(m) ? 'That code is not right. Check the 6-digit code in your authenticator app and try again.'
  : /expired|challenge/i.test(m) ? 'That code has expired. Enter the newest code from your authenticator app.'
  : /rate|too many/i.test(m) ? 'Too many attempts. Wait a minute and try again.'
  : /disabled|not enabled|mfa.*enroll/i.test(m) ? 'Two-factor sign-in is not switched on for this project yet. Ask the administrator to enable authenticator-app (TOTP) MFA in Supabase.'
  : m;

/** The verified authenticator this account must use at sign-in, or null when no code is needed. */
export async function pendingFactor(client: SupabaseClient): Promise<string | null> {
  const lvl = await client.auth.mfa.getAuthenticatorAssuranceLevel();
  fail(lvl.error);
  if (lvl.data?.nextLevel !== 'aal2' || lvl.data.currentLevel === 'aal2') return null;
  const f = await client.auth.mfa.listFactors();
  fail(f.error);
  return f.data?.totp.find((x) => x.status === 'verified')?.id ?? null;
}

/** Completes sign-in: checks the 6-digit code against the account's authenticator. */
export async function verifySignIn(client: SupabaseClient, factorId: string, code: string): Promise<void> {
  const r = await (client.auth.mfa as Mfa).challengeAndVerify({ factorId, code: code.replace(/\s/g, '') });
  fail(r.error);
}

export type Enrolment = { factorId: string; qrSvg: string; secret: string };

/** Starts setting up an authenticator: returns the QR code and the typed-in secret to show the user. */
export async function startEnrolment(client: SupabaseClient, label: string): Promise<Enrolment> {
  const list = await client.auth.mfa.listFactors();
  fail(list.error);
  // abandoned, never-confirmed set-ups would block a new one with the same name
  for (const f of list.data?.all ?? []) if (f.factor_type === 'totp' && f.status === 'unverified') await client.auth.mfa.unenroll({ factorId: f.id });
  const r = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `${label} ${new Date().toISOString().slice(0, 10)}`, issuer: 'Dilapidation Inspector' });
  fail(r.error);
  return { factorId: r.data!.id, qrSvg: r.data!.totp.qr_code, secret: r.data!.totp.secret };
}

/** Finishes set-up: the first correct code switches two-factor on for the account. */
export async function confirmEnrolment(client: SupabaseClient, factorId: string, code: string): Promise<void> {
  await verifySignIn(client, factorId, code);
}

/** Verified authenticators on the account (for the account panel). */
export async function listAuthenticators(client: SupabaseClient): Promise<{ id: string; name: string }[]> {
  const f = await client.auth.mfa.listFactors();
  fail(f.error);
  return (f.data?.totp ?? []).filter((x) => x.status === 'verified').map((x) => ({ id: x.id, name: x.friendly_name ?? 'Authenticator app' }));
}

/** Turns two-factor off. Supabase only allows this from a session that already passed a code. */
export async function removeAuthenticator(client: SupabaseClient, factorId: string): Promise<void> {
  const r = await client.auth.mfa.unenroll({ factorId });
  fail(r.error);
}
