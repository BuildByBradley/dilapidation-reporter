import { useState } from 'react';
import { signIn, signOut, signUp, syncNow, useCloudState, type CloudState } from '../sync/cloud';

function describe(s: CloudState): { text: string; tone: 'ok' | 'busy' | 'warn' | 'off' | 'bad'; detail?: string } {
  switch (s.kind) {
    case 'unavailable': return { text: 'This device only', tone: 'off' };
    case 'signedOut': return { text: 'Not syncing', tone: 'off', detail: 'Sign in on the projects page to sync between your phone and computer.' };
    case 'syncing': return { text: s.pending ? `Syncing ${s.pending}…` : 'Syncing…', tone: 'busy' };
    case 'synced': return { text: s.live ? 'Synced · live' : 'Synced', tone: 'ok', detail: `Signed in as ${s.email}. Last synced ${new Date(s.at).toLocaleTimeString()}.` };
    case 'offline': return { text: `Offline · ${s.pending} waiting`, tone: 'warn', detail: 'Changes are safe on this device and upload automatically when you are back online.' };
    case 'error': return { text: 'Sync problem', tone: 'bad', detail: `${s.message}${s.pending ? ` — ${s.pending} changes waiting` : ''}. Retrying automatically.` };
  }
}

/** Small status light for top bars. */
export function CloudStatus() {
  const s = useCloudState();
  if (s.kind === 'unavailable') return null;
  const d = describe(s);
  return (
    <button type="button" className={`cloud-status ${d.tone}`} data-testid="cloud-status" title={d.detail ?? d.text} onClick={() => (s.kind === 'signedOut' ? (window.location.hash = '/') : syncNow())}>
      <span className="dot" aria-hidden="true" />{d.text}
    </button>
  );
}

/** Sign-in / account panel on the projects page. */
export function CloudPanel() {
  const s = useCloudState();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
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
          <button onClick={() => syncNow()}>Sync now</button>
          <button disabled={busy} onClick={() => run(async () => { await signOut(); })}>Sign out</button>
        </div>
        <p className="small muted">Signed in as <strong>{s.email}</strong>. Sign in with the same account on your phone and computer — findings and photos appear on the other device within seconds. Projects are kept on this device too, so you can keep working without signal.</p>
      </section>
    );
  }
  return (
    <section className="panel cloud-panel" aria-label="Cloud sync">
      <h2>Sync phone and computer</h2>
      <p className="small muted">Sign in with the same account on every device to see your inspections live everywhere. Without signing in, projects stay only in this browser.</p>
      <form className="cloud-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await signIn(email, password); }); }}>
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} /></label>
        <div className="row">
          <button className="primary" type="submit" disabled={busy}>Sign in</button>
          <button type="button" disabled={busy || !email || password.length < 6} onClick={() => run(async () => {
            const needsConfirm = await signUp(email, password);
            return needsConfirm ? 'Account created. Open the confirmation email we sent you, then come back and sign in.' : undefined;
          })}>Create account</button>
        </div>
      </form>
      {msg && <p className={msg.tone === 'error' ? 'error' : 'ok'} role="status">{msg.text}</p>}
    </section>
  );
}
