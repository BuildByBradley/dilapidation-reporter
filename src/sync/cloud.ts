import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';
import { db } from '../data/db';
import { uuid } from '../lib/ids';
import { SUPABASE_KEY, SUPABASE_URL, cloudConfigured } from './config';
import { SyncEngine, type SyncStatus } from './engine';
import { migrateLegacyBlobs, supabaseRemote } from './supabaseRemote';
import * as mfa from './mfa';
import * as repo from '../data/repo';
import { useLive } from '../lib/useLive';

/** What the UI shows about cloud sync. */
export type CloudState =
  | { kind: 'unavailable' }
  | { kind: 'signedOut' }
  | { kind: 'mfa'; email: string; factorId: string } // password accepted; waiting for the authenticator code
  | { kind: 'mfaSetup'; email: string } // password accepted; two-factor is compulsory and not set up yet
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
const defaultMode = (): SyncMode => (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse) and ((max-width: 900px) or (max-height: 560px))').matches ? 'manual' : 'auto');
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

// ---------- sharing ----------
export type Role = 'owner' | 'editor' | 'viewer';
let sharingAvailable = false;
let myUser: string | undefined;
let roles = new Map<string, Role>();
const roleListeners = new Set<() => void>();
const setRoles = (m: Map<string, Role>) => { roles = m; roleListeners.forEach((l) => l()); };
/** This user's role in a project, or undefined for a project that is only on this device (or not signed in). */
export const useProjectRole = (projectId: string) => useSyncExternalStore((l) => { roleListeners.add(l); return () => { roleListeners.delete(l); }; }, () => roles.get(projectId));
export const useSharingAvailable = () => useSyncExternalStore((l) => { roleListeners.add(l); return () => { roleListeners.delete(l); }; }, () => sharingAvailable && !!myUser);

/** Is supabase/sharing.sql installed on the project? (Older setups keep working without it.) */
async function detectSharing(c: SupabaseClient): Promise<boolean> {
  const r = await c.from('project_members').select('project_id').limit(1);
  return !r.error;
}
export async function refreshRoles(): Promise<void> {
  if (!client || !myUser || !sharingAvailable) { setRoles(new Map()); return; }
  const r = await client.from('project_members').select('project_id, role').eq('user_id', myUser);
  if (!r.error) setRoles(new Map((r.data as { project_id: string; role: Role }[]).map((x) => [x.project_id, x.role])));
}

// ---------- who is signed in: name and company (shown as the inspector) ----------
export type Profile = { email: string; name: string; company: string };
/** Accounts on this domain may put the Paragon Architects logo on their reports. */
export const PRACTICE_DOMAIN = 'paragon.co.za';
export const isPracticeEmail = (email?: string | null) => !!email && email.trim().toLowerCase().endsWith(`@${PRACTICE_DOMAIN}`);
let profile: Profile | null = null;
const profileListeners = new Set<() => void>();
function setProfileFrom(session: Session | null) {
  const u = session?.user;
  const next = u ? {
    email: u.email ?? '',
    name: String(u.user_metadata?.full_name ?? '').trim(),
    company: String(u.user_metadata?.company ?? '').trim() || (isPracticeEmail(u.email) ? 'Paragon Architects' : ''),
  } : null;
  if (JSON.stringify(next) === JSON.stringify(profile)) return;
  profile = next; profileListeners.forEach((l) => l());
}
const useProfileRaw = () => useSyncExternalStore((l) => { profileListeners.add(l); return () => { profileListeners.delete(l); }; }, () => profile);
/** The signed-in (and fully verified) account's profile, or null when not signed in. */
export function useProfile(): Profile | null {
  const s = useCloudState();
  const p = useProfileRaw();
  return syncing(s) ? p : null;
}
/** "John Jantjies - Easy Electricians" (whichever parts are filled in). */
export const inspectorLabel = (p: Profile | null) => (p ? [p.name, p.company].filter(Boolean).join(' - ') : '');
export const currentInspector = () => (syncing(state) ? inspectorLabel(profile) : '');
export async function saveProfile(name: string, company: string): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const { data, error } = await client.auth.updateUser({ data: { full_name: name.trim(), company: company.trim() } });
  if (error) throw new Error(error.message);
  const { data: sd } = await client.auth.getSession();
  setProfileFrom(sd.session ?? (data.user ? ({ user: data.user } as Session) : null));
}

// ---------- whose projects are on this device ----------
/**
 * Once an account has synced on this device, its projects stay locked behind that account: signed out (or with an
 * expired sign-in) they are hidden until the same account signs in again. A different account signing in clears them
 * first, so one person's projects are never shown to, or uploaded into, someone else's account.
 */
const OWNER = 'deviceOwner';
type DeviceOwner = { uid: string; email: string };
async function deviceOwner(): Promise<DeviceOwner | null> {
  const v = (await db.meta.get(OWNER))?.value;
  try { return v ? (JSON.parse(v) as DeviceOwner) : null; } catch { return null; }
}
/** Remove every project and all sync bookkeeping from this device (the cloud copy is untouched). */
export async function clearDevice(): Promise<void> {
  await db.transaction('rw', db.tables, async () => { await Promise.all(db.tables.map((t) => t.clear())); });
}
/** False until the saved sign-in (if any) has been checked at startup. */
let authReady = !cloudConfigured;
const readyListeners = new Set<() => void>();
const setAuthReady = () => { if (authReady) return; authReady = true; readyListeners.forEach((l) => l()); };
const useAuthReady = () => useSyncExternalStore((l) => { readyListeners.add(l); return () => { readyListeners.delete(l); }; }, () => authReady);
const syncing = (s: CloudState) => s.kind !== 'unavailable' && s.kind !== 'signedOut' && s.kind !== 'mfa' && s.kind !== 'mfaSetup';

/**
 * Projects on this device are locked when they belong to an account that is not signed in here right now.
 * `null`: not locked. `'checking'`: still restoring the saved sign-in. Otherwise the owning account's email.
 */
export function useDeviceLock(): null | 'checking' | { email: string } {
  const s = useCloudState();
  const ready = useAuthReady();
  const [owner, loaded] = useLive(deviceOwner, [], null as DeviceOwner | null);
  if (s.kind === 'unavailable') return null;
  if (syncing(s)) return null;
  if (!loaded) return 'checking';
  if (!owner) return null;
  if (!ready) return 'checking';
  return { email: owner.email };
}

async function startEngine(session: Session | null) {
  const uid = session?.user.id;
  if (uid === engineUser) return;
  engine?.stop(); engine = undefined; engineUser = uid; myUser = uid;
  if (!session || !client) { sharingAvailable = false; setRoles(new Map()); set({ kind: 'signedOut' }); return; }
  const email = session.user.email ?? 'signed in';
  // Two-factor is compulsory: nothing syncs until this session has passed its code (or the account has set one up).
  const step = await mfa.mfaStep(client).catch(() => null); // if the check itself cannot run (offline), the server rules still protect the data
  if (engineUser !== uid) return;
  if (step) {
    engineUser = undefined; myUser = undefined; sharingAvailable = false; setRoles(new Map());
    set(step.step === 'code' ? { kind: 'mfa', email, factorId: step.factorId } : { kind: 'mfaSetup', email });
    return;
  }
  const owner = await deviceOwner();
  if (owner && owner.uid !== uid) {
    // Another account's projects are on this device: clear them before this account syncs.
    const has = (await db.projects.count()) > 0;
    if (has && !window.confirm(`This device holds projects for ${owner.email}. Signing in as ${email} removes them from this device (anything ${owner.email} had not synced yet is lost; the cloud copy is kept).\n\nContinue?`)) {
      engineUser = undefined; myUser = undefined;
      await client.auth.signOut().catch(() => {});
      set({ kind: 'signedOut' });
      return;
    }
    await clearDevice();
  }
  if (engineUser !== uid) return;
  await db.meta.put({ key: OWNER, value: JSON.stringify({ uid, email }) });
  sharingAvailable = await detectSharing(client).catch(() => false);
  if (engineUser !== uid) return; // signed out meanwhile
  engine = new SyncEngine(db, supabaseRemote(client, session.user.id, sharingAvailable), deviceId(), (s) => set({ ...s, email }), () => navigator.onLine, 1200, mode === 'auto');
  void engine.start();
  void refreshRoles();
  if (sharingAvailable) void moveLegacyFiles(client, session.user.id);
  const pending = pendingInvite();
  if (pending) void acceptInvite(pending).catch(() => {});
}

/** Files uploaded before sharing existed are moved into per-project folders (once; retried until done). */
async function moveLegacyFiles(c: SupabaseClient, uid: string) {
  try {
    if ((await db.meta.get('blobLayout'))?.value === 'project') return;
    const { left } = await migrateLegacyBlobs(c, uid, async (id) => (await db.blobs.get(id))?.projectId ?? (await db.sync.get(`blobs:${id}`))?.projectId);
    if (!left) await db.meta.put({ key: 'blobLayout', value: 'project' });
  } catch (e) { console.warn('file move postponed', e); }
}

// invite links: #/join/<token>. The token is kept until the user has signed in.
const INVITE_KEY = 'di-pending-invite';
export function rememberInvite(token: string) { try { sessionStorage.setItem(INVITE_KEY, token); } catch { /* ignore */ } }
const pendingInvite = () => { try { return sessionStorage.getItem(INVITE_KEY); } catch { return null; } };
export const inviteLink = (token: string) => `${appUrl()}#/join/${token}`;

/** Join a shared project from an invite link. Returns the project id. */
export async function acceptInvite(token: string): Promise<{ projectId: string; role: Role; projectName: string | null }> {
  if (!client || !myUser) throw new Error('Sign in first.');
  if (!sharingAvailable) throw new Error('Project sharing is not set up on the server yet.');
  const r = await client.rpc('accept_invite', { t: token });
  if (r.error) throw new Error(r.error.message);
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* ignore */ }
  const row = (r.data as { project_id: string; role: Role; project_name: string | null }[])[0];
  await refreshRoles();
  void engine?.resyncAll(); // the shared project's records are older than this device's sync cursor
  return { projectId: row.project_id, role: row.role, projectName: row.project_name };
}

export type Member = { userId: string; email: string | null; role: Role; me: boolean };
export type Invite = { token: string; role: Role; createdAt: string; expiresAt: string };
const need = () => { if (!client || !myUser) throw new Error('Sign in first.'); if (!sharingAvailable) throw new Error('Project sharing is not set up on the server yet.'); return client; };

export async function listMembers(projectId: string): Promise<Member[]> {
  const r = await need().from('project_members').select('user_id, email, role').eq('project_id', projectId);
  if (r.error) throw new Error(r.error.message);
  const order = { owner: 0, editor: 1, viewer: 2 };
  return (r.data as { user_id: string; email: string | null; role: Role }[])
    .map((m) => ({ userId: m.user_id, email: m.email, role: m.role, me: m.user_id === myUser }))
    .sort((a, b) => order[a.role] - order[b.role] || (a.email ?? '').localeCompare(b.email ?? ''));
}
export async function listInvites(projectId: string): Promise<Invite[]> {
  const r = await need().from('project_invites').select('token, role, created_at, expires_at').eq('project_id', projectId).is('accepted_by', null).order('created_at');
  if (r.error) throw new Error(r.error.message);
  return (r.data as { token: string; role: Role; created_at: string; expires_at: string }[]).map((i) => ({ token: i.token, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at }));
}
/** Create a single-use invite link. The project is synced first so the invitee finds it in the cloud. */
export async function createInvite(projectId: string, projectName: string, role: 'editor' | 'viewer'): Promise<string> {
  const c = need();
  if (roles.get(projectId) !== 'owner') {
    await engine?.syncNow();
    await refreshRoles();
    if (roles.get(projectId) !== 'owner') throw new Error('Only the project owner can invite people, and the project must be synced to the cloud first (tap Sync now).');
  }
  const r = await c.from('project_invites').insert({ project_id: projectId, role, project_name: projectName }).select('token').single();
  if (r.error) throw new Error(r.error.message);
  return inviteLink((r.data as { token: string }).token);
}
export async function revokeInvite(token: string) { const r = await need().from('project_invites').delete().eq('token', token); if (r.error) throw new Error(r.error.message); }
export async function setMemberRole(projectId: string, userId: string, role: 'editor' | 'viewer') {
  const r = await need().from('project_members').update({ role }).eq('project_id', projectId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}
export async function removeMember(projectId: string, userId: string) {
  const r = await need().from('project_members').delete().eq('project_id', projectId).eq('user_id', userId);
  if (r.error) throw new Error(r.error.message);
}
/** Leave a project shared with you: your access ends and its copy is removed from this device (nothing is deleted for others). */
export async function leaveProject(projectId: string) {
  const r = await need().from('project_members').delete().eq('project_id', projectId).eq('user_id', myUser!);
  if (r.error) throw new Error(r.error.message);
  await repo.removeProjectLocally(projectId);
  await refreshRoles();
}

/** Called once at startup. Resumes the saved sign-in and starts syncing. */
export function initCloud(): void {
  if (!cloudConfigured || client) return;
  // Implicit flow: a reset link opened on a different device from the one that asked for it still works.
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  client.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') setRecovering(true);
    setProfileFrom(session);
    setTimeout(() => { void startEngine(session).finally(setAuthReady); }, 0);
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

/** Second step of sign-in for accounts with two-factor on. */
export async function submitMfaCode(code: string): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const s = state;
  if (s.kind !== 'mfa') throw new Error('No code is needed right now.');
  await mfa.verifySignIn(client, s.factorId, code);
  const { data } = await client.auth.getSession();
  await startEngine(data.session);
}

/** Called after the compulsory set-up is confirmed: the session is now verified, so sync can start. */
export async function completeMfaSetup(): Promise<void> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const { data } = await client.auth.getSession();
  await startEngine(data.session);
}

export const startTwoFactorSetup = () => { if (!client) throw new Error('Cloud sync is not available in this build.'); return mfa.startEnrolment(client, 'Authenticator'); };
export const finishTwoFactorSetup = (factorId: string, code: string) => { if (!client) throw new Error('Cloud sync is not available in this build.'); return mfa.confirmEnrolment(client, factorId, code); };
export const twoFactorDevices = () => { if (!client) throw new Error('Cloud sync is not available in this build.'); return mfa.listAuthenticators(client); };

/** Returns true when the account still needs its email confirmed before signing in. */
export async function signUp(email: string, password: string): Promise<boolean> {
  if (!client) throw new Error('Cloud sync is not available in this build.');
  const { data, error } = await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: appUrl() } });
  if (error) throw new Error(error.message);
  return !data.session;
}

/** Before signing out: upload what is waiting. Returns how many changes still have not reached the cloud. */
export async function syncBeforeSignOut(): Promise<number> {
  const e = engine;
  if (!e) return 0;
  await Promise.race([e.syncNow(), new Promise((r) => setTimeout(r, 30_000))]);
  return e.count();
}

/**
 * Stops syncing and removes this account's projects from the device, so the next person to use this browser
 * cannot see them. They stay in the cloud and come back when the account signs in again.
 * (Signing out half-way through sign-in, before anything synced, leaves the device as it was.)
 */
export async function signOut(): Promise<void> {
  const wasSyncing = !!engine;
  engine?.stop(); engine = undefined; engineUser = undefined; myUser = undefined; setRoles(new Map());
  if (wasSyncing) await clearDevice();
  await client?.auth.signOut();
  set({ kind: 'signedOut' });
}

export function syncNow(): void { void engine?.syncNow(); void refreshRoles(); }

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

// ---------- Help: assistant + suggestions (supabase/functions/assistant) ----------
export type HelpTurn = { role: 'user' | 'assistant'; content: string };

async function invokeAssistant(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!client || !myUser) throw new Error('Sign in (projects page) to use this.');
  const { data, error } = await client.functions.invoke('assistant', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      if (ctx.status === 404) throw new Error('NOT_DEPLOYED');
      const j = await ctx.json().catch(() => null) as { error?: string } | null;
      if (j?.error) throw new Error(j.error);
    }
    throw new Error(/fetch|network|failed to send/i.test(error.message) ? 'NOT_DEPLOYED' : error.message);
  }
  return data as Record<string, unknown>;
}

/** Ask the help assistant (answers from the user guide). */
export async function askAssistant(turns: HelpTurn[]): Promise<string> {
  try {
    const r = await invokeAssistant({ type: 'ask', messages: turns });
    return String(r.answer ?? '');
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_DEPLOYED') throw new Error('The assistant is not switched on yet. The Guide tab has the answers in the meantime.');
    throw e;
  }
}

/** Send a bug report / idea to the app owner. Falls back to storing it directly if the email function is not set up. */
export async function sendFeedback(kind: 'bug' | 'idea' | 'question', message: string, page: string): Promise<{ emailed: boolean }> {
  try {
    const r = await invokeAssistant({ type: 'feedback', kind, message, page });
    return { emailed: !!r.emailed };
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'NOT_DEPLOYED' || !client) throw e;
    const { error } = await client.from('feedback').insert({ user_id: myUser, kind, message, page });
    if (error) throw new Error('Could not send right now — please try again later.');
    return { emailed: false };
  }
}
