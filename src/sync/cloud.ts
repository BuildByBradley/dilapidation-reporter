import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { db } from '../data/db';
import { uuid } from '../lib/ids';
import { SUPABASE_KEY, SUPABASE_URL, cloudConfigured } from './config';
import { SyncEngine, type SyncStatus } from './engine';
import { supabaseRemote } from './supabaseRemote';

/** What the UI shows about cloud sync. */
export type CloudState =
  | { kind: 'unavailable' }
  | { kind: 'signedOut' }
  | ({ email: string } & SyncStatus);

let state: CloudState = cloudConfigured ? { kind: 'signedOut' } : { kind: 'unavailable' };
const listeners = new Set<() => void>();
const set = (s: CloudState) => { state = s; listeners.forEach((l) => l()); };
export const getCloudState = () => state;
export const useCloudState = () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, getCloudState);

/** True after the user opened a password-reset email link: the app asks for a new password. */
let recovering = false;
const recoveryListeners = new Set<() => void>();
const setRecovering = (v: boolean) => { recovering = v; recoveryListeners.forEach((l) => l()); };
export const useRecovering = () => useSyncExternalStore((l) => { recoveryListeners.add(l); return () => { recoveryListeners.delete(l); }; }, () => recovering);

/** Where reset links return to: this page, without any route. */
const appUrl = () => location.origin + location.pathname;

/**
 * Per-device sync mode. Manual saves mobile data: nothing is sent or received until "Sync now".
 * Default: manual on phones, automatic (live) elsewhere.
 */
export type SyncMode = 'auto' | 'manual';
const MODE_KEY = 'di-sync-mode';
const defaultMode = (): SyncMode => (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse) and (max-width: 900px)').matches ? 'manual' : 'auto');
let mode: SyncMode = (() => { try { const v = localStorage.getItem(MODE_KEY); return v === 'auto' || v === 'manual' ? v : defaultMode(); } catch { return defaultMode(); } })();
const modeListeners = new Set<() => void>();
export const useSyncMode = () => useSyncExternalStore((l) => { modeListeners.add(l); return () => { modeListeners.delete(l); }; }, () => mode);
export function setSyncMode(next: SyncMode) {
  mode = next;
  try { localStorage.setItem(MODE_KEY, next); } catch { /* per-session only */ }
  modeListeners.forEach((l) => l());
  void engine?.setAuto(next === 'auto');
}

let client: SupabaseClient | undefined;
let engine: SyncEngine | undefined;
let engineUser: string | undefined;

/** Stable per-browser id, so a device ignores the echo of its own uploads. */
function deviceId(): string {
  try {
    let id = localStorage.getItem('di-device-id');
    if (!id) { id = uuid(); localStorage.setItem('di-device-id', id); }
    return id;
  } catch { return uuid(); }
}

function startEngine(session: Session | null) {
  const uid = session?.user.id;
  if (uid === engineUser) return;
  engine?.stop(); engine = undefined; engineUser = uid;
  if (!session || !client) { set({ kind: 'signedOut' }); return; }
  const email = session.user.email ?? 'signed in';
  engine = new SyncEngine(db, supabaseRemote(client, session.user.id), deviceId(), (s) => set({ ...s, email }), () => navigator.onLine, 1200, mode === 'auto');
  void engine.start();
}

/** Called once at startup. Resumes the saved sign-in and starts syncing. */
export function initCloud(): void {
  if (!cloudConfigured || client) return;
  // Implicit flow: a reset link opened on a different device from the one that asked for it still works.
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    setTimeout(() => startEngine(session), 0);
  });
  const kick = () => { if (engine && mode === 'auto') { void engine.pull().catch(() => {}); engine.schedulePush(0); } };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });
  setInterval(kick, 60_000); // safety net if a live event is missed
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(/invalid login/i.test(error.message) ? 'Wrong email or password.' : /not confirmed/i.test(error.message) ? 'Confirm your email first (check your inbox), then sign in.' : error.message);
}

/** Returns true when the account still needs its email confirmed before signing in. */
export async function signUp(email: string, password: string): Promise<boolean> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: appUrl() } });
  if (error) throw new Error(error.message);
  return !data.session;
}

/** Stops syncing on this device. Projects stay on the device; signing in again re-links them. */
export async function signOut(): Promise<void> {
  engine?.stop(); engine = undefined; engineUser = undefined;
  await db.transaction('rw', db.sync, db.meta, async () => { await db.sync.clear(); await db.meta.clear(); });
  await client?.auth.signOut();
  set({ kind: 'signedOut' });
}

export function syncNow(): void { void engine?.syncNow(); }

/** Email a password-reset link. The link opens the app, which then asks for a new password. */
export async function sendPasswordReset(email: string): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  if (!email.trim()) throw new Error('Enter your email address first.');
  const { error } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: appUrl() });
  if (error) throw new Error(/rate limit|too many/i.test(error.message) ? 'Too many emails requested. Wait a few minutes and try again.' : error.message);
}

/** Set a new password for the signed-in user (after a reset link, or from the account panel). */
export async function updatePassword(password: string): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  if (password.length < 6) throw new Error('Use at least 6 characters.');
  const { error } = await client.auth.updateUser({ password });
  if (error) throw new Error(/same/i.test(error.message) ? 'Choose a password different from the old one.' : error.message);
  setRecovering(false);
}
export const cancelRecovery = () => setRecovering(false);
