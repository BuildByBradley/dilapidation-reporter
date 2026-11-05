import { useEffect, useRef, useState } from 'react';
import { Dialog } from './ui';
import {
  cancelRecovery, finishTwoFactorSetup, sendPasswordReset, setSyncMode, signIn, signOut, signUp, syncBeforeSignOut, saveProfile, useProfile, inspectorLabel, startTwoFactorSetup, submitMfaCode, syncNow,
  twoFactorDevices, updatePassword, completeMfaSetup,
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
    case 'mfa': return { text: 'Enter your code', tone: 'warn', detail: 'Open the projects page and enter the 6-digit code from your authenticator app to finish signing in.' };
    case 'mfaSetup': return { text: 'Set up two-factor', tone: 'warn', detail: 'Two-factor sign-in is required. Open the projects page to set it up.' };
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
  const [details, setDetails] = useState(false);
  if (s.kind === 'unavailable') return null;
  const d = describe(s);
  return (
    <>
      <button type="button" className={`cloud-status ${d.tone}${s.kind === 'manual' ? ' manual' : ''}`} data-testid="cloud-status" title={d.detail ?? d.text}
        disabled={s.kind === 'syncing'} onClick={() => (s.kind === 'signedOut' || s.kind === 'mfa' || s.kind === 'mfaSetup' ? (window.location.hash = '/') : s.kind === 'error' ? setDetails(true) : syncNow())}>
        <span className="dot" aria-hidden="true" />{s.kind === 'manual' && <span aria-hidden="true">⟳ </span>}{d.text}
      </button>
      {details && <SyncProblemDialog onClose={() => setDetails(false)} />}
    </>
  );
}

/** Opened by tapping "Sync problem": what did not upload and why (a phone has no hover text). */
function SyncProblemDialog({ onClose }: { onClose(): void }) {
  const s = useCloudState();
  const [copied, setCopied] = useState(false);
  const problems = s.kind === 'error' ? (s.problems?.length ? s.problems : [s.message]) : [];
  const email = 'email' in s ? s.email : '';
  const report = [`Sync problem (${new Date().toLocaleString()})`, `Account: ${email}`, `Waiting: ${'pending' in s ? s.pending : 0}`,
    ...problems.map((p) => `- ${p}`), `App: ${location.href.split('#')[0]} · ${navigator.userAgent}`].join('\n');
  const copy = async () => { try { await navigator.clipboard.writeText(report); setCopied(true); } catch { setCopied(false); } };
  return (
    <Dialog title="Sync" onClose={onClose}
      footer={<><button onClick={copy}>{copied ? 'Copied ✓' : 'Copy details'}</button><button onClick={onClose}>Close</button>
        <button className="primary" disabled={s.kind === 'syncing'} onClick={() => syncNow()}>{s.kind === 'syncing' ? 'Syncing…' : 'Try again'}</button></>}>
      {s.kind === 'error' && <>
        <p><b>Some changes have not reached the cloud yet.</b> They are safe on this device{s.pending ? ` (${s.pending} waiting)` : ''}; everything else was uploaded.</p>
        <ul className="sync-problems" data-testid="sync-problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        <p className="small muted">Signed in as {email}. Use the same account on your phone and computer.</p>
      </>}
      {s.kind === 'syncing' && <p role="status">Syncing{s.pending ? ` · ${s.pending} to go` : ''}…</p>}
      {(s.kind === 'synced' || (s.kind === 'manual' && !s.pending)) && <p className="ok" role="status">All changes are uploaded ✓</p>}
      {s.kind === 'manual' && s.pending > 0 && <p role="status">{s.pending} changes still waiting. Tap Try again.</p>}
      {s.kind === 'offline' && <p role="status">No connection. {s.pending} changes wait on this device and upload when you are back online.</p>}
    </Dialog>
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

/** Name and company of the signed-in person: filled in as the inspector on their inspections. */
function ProfileForm() {
  const p = useProfile();
  const [name, setName] = useState(p?.name ?? '');
  const [company, setCompany] = useState(p?.company ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [open, setOpen] = useState(!p?.name);
  useEffect(() => { setName(p?.name ?? ''); setCompany(p?.company ?? ''); }, [p?.name, p?.company]);
  if (!p) return null;
  if (!open) {
    return (
      <p className="small" data-testid="profile-line"><strong>Inspector name:</strong> {inspectorLabel(p) || '—'} <button className="link" onClick={() => setOpen(true)}>Change</button></p>
    );
  }
  return (
    <form className="profile-form" data-testid="profile-form" onSubmit={(e) => {
      e.preventDefault();
      if (!name.trim()) { setMsg({ tone: 'error', text: 'Enter your name.' }); return; }
      setBusy(true); setMsg(null);
      saveProfile(name, company).then(() => setOpen(false)).catch((err) => setMsg({ tone: 'error', text: err instanceof Error ? err.message : String(err) })).finally(() => setBusy(false));
    }}>
      <p className="small muted">Your name and company are filled in as the <b>Inspector</b> on the inspections you capture, e.g. “John Jantjies - Easy Electricians”.</p>
      <div className="row">
        <label className="grow">Your name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
        <label className="grow">Company<input value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" /></label>
        <button className="primary" type="submit" disabled={busy}>Save name</button>
        {p.name && <button type="button" onClick={() => setOpen(false)}>Cancel</button>}
      </div>
      {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
    </form>
  );
}

/** Sign-in / account panel on the projects page. */
export function CloudPanel({ defaultEmail = '' }: { defaultEmail?: string } = {}) {
  const s = useCloudState();
  const [email, setEmail] = useState(defaultEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState('');
  const [code, setCode] = useState('');
  if (s.kind === 'unavailable') return null;

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const ok = await fn(); if (ok) setMsg({ tone: 'ok', text: ok }); } catch (e) { setMsg({ tone: 'error', text: e instanceof Error ? e.message : String(e) }); } finally { setBusy(false); }
  };

  if (s.kind === 'mfaSetup') {
    return (
      <section className="panel cloud-panel" aria-label="Set up two-factor sign-in">
        <h2>Set up two-factor sign-in</h2>
        <p className="small muted">Signing in as <strong>{s.email}</strong>. Two-factor sign-in is required for everyone. It takes about a minute, and you only do it once.</p>
        <TwoFactorSetup onDone={() => completeMfaSetup()} onCancel={() => { void signOut(); }} />
      </section>
    );
  }
  if (s.kind === 'mfa') {
    return (
      <section className="panel cloud-panel" aria-label="Two-factor sign-in">
        <h2>Enter your code</h2>
        <p className="small muted">Signing in as <strong>{s.email}</strong>. Open your authenticator app and type the 6-digit code for Dilapidation Inspector.</p>
        <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await submitMfaCode(code); setCode(''); }); }}>
          <label>6-digit code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} autoFocus required data-testid="mfa-code" /></label>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || code.replace(/\s/g, '').length < 6}>Verify</button>
            <button type="button" disabled={busy} onClick={() => run(async () => { await signOut(); })}>Cancel</button>
          </div>
        </form>
        {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      </section>
    );
  }
  if (s.kind !== 'signedOut') {
    const d = describe(s);
    return (
      <section className="panel cloud-panel" aria-label="Cloud sync">
        <div className="row">
          <strong>Cloud sync is on</strong><span className={`cloud-status ${d.tone}`}><span className="dot" aria-hidden="true" />{d.text}</span>
          <span className="spacer" />
          <button className="primary" disabled={s.kind === 'syncing'} onClick={() => syncNow()}>Sync now</button>
          <button disabled={busy} onClick={() => run(async () => {
            const left = await syncBeforeSignOut();
            if (left > 0 && !window.confirm(`${left} change${left === 1 ? ' has' : 's have'} not reached the cloud yet (no connection?). Signing out now removes ${left === 1 ? 'it' : 'them'} from this device for good.\n\nSign out anyway?`)) return;
            await signOut();
          })}>Sign out</button>
        </div>
        <p className="small muted">Signed out, this device keeps none of your projects: they stay in the cloud and come back when you sign in again.</p>
        <p className="small muted">Signed in as <strong>{s.email}</strong>. {d.detail}</p>
        <ProfileForm />
        <ModeChooser />
        {changing ? (
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { await updatePassword(newPw); setChanging(false); setNewPw(''); return 'Password changed.'; }); }}>
            <label className="grow">New password<input type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} minLength={6} autoFocus /></label>
            <button className="primary" type="submit" disabled={busy || newPw.length < 6}>Save</button>
            <button type="button" onClick={() => { setChanging(false); setNewPw(''); }}>Cancel</button>
          </form>
        ) : <button className="link" onClick={() => setChanging(true)}>Change password</button>}
        <TwoFactor />
        {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
      </section>
    );
  }
  return (
    <section className="panel cloud-panel" aria-label="Cloud sync">
      <h2>Sign in or create an account</h2>
      <p className="small muted">Sign in with the same account on every device to sync your inspections. Without signing in, projects stay only in this browser.</p>
      <p className="small muted"><strong>New here?</strong> Type your email, choose a password (at least 6 characters) and tap <i>Create account</i>. No invite is needed.</p>
      <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await signIn(email, password); }); }}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>Sign in</button>
          <button type="button" disabled={busy} onClick={() => run(async () => {
            if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error('Enter your email address first.');
            if (password.length < 6) throw new Error('Choose a password of at least 6 characters.');
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

/** Compulsory set-up: scan the QR code, then confirm with the first 6-digit code. */
function TwoFactorSetup({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [setup, setSetup] = useState<{ factorId: string; qrSvg: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const begin = async () => { setBusy(true); setMsg(null); try { setSetup(await startTwoFactorSetup()); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const started = useRef(false);
  useEffect(() => { if (started.current) return; started.current = true; void begin(); }, []);
  const confirm = async () => {
    if (!setup) return;
    setBusy(true); setMsg(null);
    try { await finishTwoFactorSetup(setup.factorId, code); await onDone(); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <form className="cloud-form" data-testid="mfa-setup" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
      {!setup && !msg && <p role="status">Preparing…</p>}
      {setup && <>
        <p className="small">1. Install an authenticator app on your phone (for example Microsoft Authenticator), add an account and scan this code.</p>
        <img src={setup.qrSvg} alt="QR code for your authenticator app" width={180} height={180} />
        <p className="small muted">Cannot scan? Type this key into the app: <code>{setup.secret}</code></p>
        <label>2. Type the 6-digit code the app shows<input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required data-testid="mfa-setup-code" /></label>
      </>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !setup || code.replace(/\s/g, '').length < 6}>Finish set-up</button>
        {!setup && msg && <button type="button" disabled={busy} onClick={() => void begin()}>Try again</button>}
        <button type="button" disabled={busy} onClick={onCancel}>Sign out</button>
      </div>
      {msg && <p className="error" role="status">{msg}</p>}
    </form>
  );
}

/** Account panel line: two-factor is compulsory, so this only shows its state. */
function TwoFactor() {
  const [devices, setDevices] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => { void twoFactorDevices().then(setDevices).catch(() => setDevices([])); }, []);
  if (!devices?.length) return null;
  return <p className="two-factor small" data-testid="two-factor"><strong>Two-factor sign-in:</strong> <span className="ok">On</span> <span className="muted">({devices[0].name}). It is required and cannot be turned off.</span></p>;
}
