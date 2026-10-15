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
  engine = new SyncEngine(db, supabaseRemote(client, session.user.id), deviceId(), (s) => set({ ...s, email }), () => navigator.onLine);
  void engine.start();
}

/** Called once at startup. Resumes the saved sign-in and starts syncing. */
export function initCloud(): void {
  if (!cloudConfigured || client) return;
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  client.auth.onAuthStateChange((_event, session) => { setTimeout(() => startEngine(session), 0); });
  const kick = () => { if (engine) { void engine.pull().catch(() => {}); engine.schedulePush(0); } };
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
  const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: location.origin + location.pathname } });
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

export function syncNow(): void { engine?.schedulePush(0); void engine?.pull().catch(() => {}); }
