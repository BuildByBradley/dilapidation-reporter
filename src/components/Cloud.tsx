import { useState } from 'react';
import { Dialog } from './ui';
import {
  cancelRecovery, sendPasswordReset, setSyncMode, signIn, signOut, signUp, syncNow, updatePassword,
  useCloudState, useRecovering, useSyncMode, type CloudState,
} from '../sync/cloud';

const ago = (iso?: string) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};

function describe(s: CloudState): { text: string; tone: 'ok' | 'busy' | 'warn' | 'off' | 'bad'; detail?: string } {
  switch (s.kind) {
    case 'unavailable': return { text: 'This device only', tone: 'off' };
    case 'signedOut': return { text: 'Not syncing', tone: 'off', detail: 'Sign in on the projects page to sync between your phone and computer.' };
    case 'syncing': return { text: s.pending ? `Syncing ${s.pending}…` : 'Syncing…', tone: 'busy' };
    case 'synced': return { text: s.live ? 'Synced · live' : 'Synced', tone: 'ok', detail: `Signed in as ${s.email}. Last synced ${new Date(s.at).toLocaleTimeString()}.` };
    case 'offline': return { text: `Offline · ${s.pending} waiting`, tone: 'warn', detail: 'Changes are safe on this device and upload when you are back online.' };
    case 'error': return { text: 'Sync problem', tone: 'bad', detail: `${s.message}${s.pending ? ` — ${s.pending} changes waiting` : ''}.` };
    case 'manual': return s.pending
      ? { text: `Sync now · ${s.pending} waiting`, tone: 'warn', detail: `Manual sync (saves mobile data). ${s.pending} changes are saved on this device and not uploaded yet. Last synced ${ago(s.at)}.` }
      : { text: `Sync now · up to date`, tone: 'ok', detail: `Manual sync. Nothing waiting. Last synced ${ago(s.at)}. Tap to fetch changes from your other devices.` };
  }
}

/** Status pill for top bars. In manual mode it is the "Sync now" button. */
export function CloudStatus() {
  const s = useCloudState();
  if (s.kind === 'unavailable') return null;
  const d = describe(s);
  return (
    <button type="button" className={`cloud-status ${d.tone}${s.kind === 'manual' ? ' manual' : ''}`} data-testid="cloud-status" title={d.detail ?? d.text}
      disabled={s.kind === 'syncing'} onClick={() => (s.kind === 'signedOut' ? (window.location.hash = '/') : syncNow())}>
      <span className="dot" aria-hidden="true" />{s.kind === 'manual' && <span aria-hidden="true">⟳ </span>}{d.text}
    </button>
  );
}

/** Shown after opening a password-reset email link. */
export function PasswordRecoveryDialog() {
  const recovering = useRecovering();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!recovering) return null;
  const save = async () => {
    setErr(null);
    if (pw !== pw2) { setErr('The two passwords do not match.'); return; }
    setBusy(true);
    try { await updatePassword(pw); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Set a new password" onClose={cancelRecovery}
      footer={<><button onClick={cancelRecovery}>Later</button><button className="primary" disabled={busy || pw.length < 6} onClick={save}>Save new password</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <p className="small muted">You opened a password-reset link. Choose a new password for your account.</p>
        <label>New password<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={6} autoFocus /></label>
        <label>Repeat new password<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} minLength={6} /></label>
        {err && <p className="error" role="alert">{err}</p>}
      </form>
    </Dialog>
  );
}

function ModeChooser() {
  const mode = useSyncMode();
  return (
    <fieldset className="sync-mode" aria-label="Sync mode on this device">
      <legend className="small">On this device</legend>
      <label className="inline"><input type="radio" name="sync-mode" checked={mode === 'manual'} onChange={() => setSyncMode('manual')} /> <span><b>Manual</b> — sync only when I tap <i>Sync now</i> (saves mobile data)</span></label>
      <label className="inline"><input type="radio" name="sync-mode" checked={mode === 'auto'} onChange={() => setSyncMode('auto')} /> <span><b>Automatic</b> — live, continuous (best on the office computer / Wi-Fi)</span></label>
    </fieldset>
  );
}

/** Sign-in / account panel on the projects page. */
export function CloudPanel() {
  const s = useCloudState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState('');
  if (s.kind === 'unavailable') return null;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const ok = await fn(); if (ok) setMsg({ tone: 'ok', text: ok }); } catch (e) { setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };

  if (s.kind !== 'signedOut') {
    const d = describe(s);
    return (
      <section className="panel cloud-panel" aria-label="Cloud sync">
        <div className="row">
          <strong>Cloud sync is on</strong><span className={`cloud-status ${d.tone}`}><span className="dot" aria-hidden="true" />{d.text}</span>
          <span className="spacer" />
          <button className="primary" disabled={s.kind === 'syncing'} onClick={() => syncNow()}>Sync now</button>
          <button disabled={busy} onClick={() => run(async () => { await signOut(); })}>Sign out</button>
        </div>
        <p className="small muted">Signed in as <strong>{s.email}</strong>. {d.detail}</p>
        <ModeChooser />
        {changing ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await updatePassword(newPw); setChanging(false); setNewPw(''); return 'Password changed.'; }); }}>
            <label className="grow">New password<input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={6} autoFocus /></label>
            <button className="primary" type="submit" disabled={busy || newPw.length < 6}>Save</button>
            <button type="button" onClick={() => { setChanging(false); setNewPw(''); }}>Cancel</button>
          </form>
        ) : <button className="link" onClick={() => setChanging(true)}>Change password</button>}
        {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      </section>
    );
  }
  return (
    <section className="panel cloud-panel" aria-label="Cloud sync">
      <h2>Sync phone and computer</h2>
      <p className="small muted">Sign in with the same account on every device to share your inspections. Without signing in, projects stay only in this browser.</p>
      <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await signIn(email, password); }); }}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>Sign in</button>
          <button type="button" disabled={busy || !email || password.length < 6} onClick={() => run(async () => {
            const needsConfirm = await signUp(email, password);
            return needsConfirm ? 'Account created. Open the confirmation email we sent you, then come back and sign in.' : undefined;
          })}>Create account</button>
          <button type="button" className="link" disabled={busy} onClick={() => run(async () => {
            await sendPasswordReset(email);
            return `If ${email.trim()} has an account, a reset link is on its way. Open it on this device or any other — the app will ask for a new password.`;
          })}>Forgot password?</button>
        </div>
      </form>
      {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
    </section>
  );
}
