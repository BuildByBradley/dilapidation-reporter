import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { confirmEnrolment, listAuthenticators, pendingFactor, removeAuthenticator, startEnrolment, verifySignIn } from '../../src/sync/mfa';

type Fx = { id: string; status: 'verified' | 'unverified'; factor_type?: string; friendly_name?: string };
function fake(o: { level?: { currentLevel: string; nextLevel: string }; factors?: Fx[]; verifyError?: string } = {}) {
  const mfa = {
    getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: o.level ?? { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null })),
    listFactors: vi.fn(async () => ({ data: { all: (o.factors ?? []).map((f) => ({ factor_type: 'totp', ...f })), totp: (o.factors ?? []).map((f) => ({ factor_type: 'totp', ...f })) }, error: null })),
    challengeAndVerify: vi.fn(async () => ({ data: {}, error: o.verifyError ? { message: o.verifyError } : null })),
    enroll: vi.fn(async () => ({ data: { id: 'new', totp: { qr_code: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD' } }, error: null })),
    unenroll: vi.fn(async () => ({ data: {}, error: null })),
  };
  return { client: { auth: { mfa } } as unknown as SupabaseClient, mfa };
}

describe('two-factor sign-in', () => {
  it('asks for no code when the account has no authenticator', async () => {
    expect(await pendingFactor(fake().client)).toBeNull();
  });
  it('asks for a code when the account has one and the session has not passed it yet', async () => {
    const { client } = fake({ level: { currentLevel: 'aal1', nextLevel: 'aal2' }, factors: [{ id: 'f1', status: 'verified' }] });
    expect(await pendingFactor(client)).toBe('f1');
  });
  it('asks for nothing once the code has been entered', async () => {
    const { client } = fake({ level: { currentLevel: 'aal2', nextLevel: 'aal2' }, factors: [{ id: 'f1', status: 'verified' }] });
    expect(await pendingFactor(client)).toBeNull();
  });
  it('strips spaces from the code and gives a plain message for a wrong one', async () => {
    const ok = fake();
    await verifySignIn(ok.client, 'f1', '123 456');
    expect(ok.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'f1', code: '123456' });
    await expect(verifySignIn(fake({ verifyError: 'Invalid TOTP code entered' }).client, 'f1', '000000')).rejects.toThrow(/not right/);
  });
  it('set-up clears abandoned attempts, then returns the QR code and key', async () => {
    const { client, mfa } = fake({ factors: [{ id: 'old', status: 'unverified' }, { id: 'keep', status: 'verified' }] });
    const e = await startEnrolment(client, 'Authenticator');
    expect(mfa.unenroll).toHaveBeenCalledTimes(1);
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: 'old' });
    expect(e).toEqual({ factorId: 'new', qrSvg: 'data:image/svg+xml;utf8,<svg/>', secret: 'ABCD' });
    await confirmEnrolment(client, 'new', '654321');
    expect(mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'new', code: '654321' });
  });
  it('lists only confirmed authenticators and can remove one', async () => {
    const { client, mfa } = fake({ factors: [{ id: 'a', status: 'verified', friendly_name: 'Phone' }, { id: 'b', status: 'unverified' }] });
    expect(await listAuthenticators(client)).toEqual([{ id: 'a', name: 'Phone' }]);
    await removeAuthenticator(client, 'a');
    expect(mfa.unenroll).toHaveBeenCalledWith({ factorId: 'a' });
  });
});
