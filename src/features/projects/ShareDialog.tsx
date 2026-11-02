import { useEffect, useState } from 'react';
import { Dialog, useToast } from '../../components/ui';
import {
  createInvite, inviteLink, listInvites, listMembers, removeMember, revokeInvite, setMemberRole, useProjectRole, useSharingAvailable,
  type Invite, type Member,
} from '../../sync/cloud';

const ROLE_TEXT = { owner: 'Owner', editor: 'Editor — can add and change findings', viewer: 'Viewer — can look and print reports' };

/** Owner's view: who has access, pending invite links, and creating a new link to send (WhatsApp, email…). */
export function ShareDialog({ projectId, projectName, onClose }: { projectId: string; projectName: string; onClose(): void }) {
  const toast = useToast();
  const available = useSharingAvailable();
  const myRole = useProjectRole(projectId);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = myRole === 'owner';

  const load = async () => {
    try {
      setMembers(await listMembers(projectId));
      if (owner) setInvites(await listInvites(projectId));
    } catch (e) { setMembers([]); toast('error', e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { if (available && myRole) void load(); }, [available, myRole]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };

  const send = async (url: string) => {
    const text = `You're invited to the dilapidation inspection "${projectName}". Open this link, sign in (or create an account) and the project appears in your list:`;
    if (navigator.share) { try { await navigator.share({ title: projectName, text, url }); return; } catch { /* cancelled: fall back to copy */ } }
    try { await navigator.clipboard.writeText(`${text} ${url}`); toast('ok', 'Invite copied — paste it into WhatsApp or an email'); } catch { /* the link is shown to copy by hand */ }
  };

  if (!available) {
    return (
      <Dialog title="Share project" onClose={onClose} footer={<button onClick={onClose}>Close</button>}>
        <p>Sharing needs cloud sync. Sign in on the projects page first. If you are signed in, the server has not been set up for sharing yet (the app administrator runs <code>supabase/sharing.sql</code> once).</p>
      </Dialog>
    );
  }
  return (
    <Dialog title={`Share “${projectName}”`} wide onClose={onClose} footer={<button onClick={onClose}>Done</button>}>
      {!myRole && (
        <div className="warn-box">This project has not been uploaded yet. Creating an invite uploads it first.</div>
      )}
      {myRole && myRole !== 'owner' && <p className="muted">This project is shared with you as <strong>{myRole}</strong>. Only the owner can invite people or change access.</p>}

      <h3>People with access</h3>
      {members === null ? <p role="status">Loading…</p> : members.length === 0 ? <p className="muted">Only you, on this device.</p> : (
        <ul className="member-list" data-testid="member-list">
          {members.map((m) => (
            <li key={m.userId}>
              <span className="who">{m.email ?? 'Unknown'}{m.me && <span className="tag">you</span>}</span>
              {owner && m.role !== 'owner' ? (
                <>
                  <select aria-label={`Access for ${m.email}`} value={m.role} disabled={busy} onChange={(e) => act(() => setMemberRole(projectId, m.userId, e.target.value as 'editor' | 'viewer'))}>
                    <option value="editor">Editor</option><option value="viewer">Viewer</option>
                  </select>
                  <button className="danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${m.email} from this project?`)) void act(() => removeMember(projectId, m.userId)); }}>Remove</button>
                </>
              ) : <span className="muted small">{ROLE_TEXT[m.role].split(' —')[0]}</span>}
            </li>
          ))}
        </ul>
      )}

      {(owner || !myRole) && (
        <>
          <h3>Invite someone</h3>
          <p className="small muted">Create a link and send it to the person (WhatsApp, email, SMS). It works once and expires in 14 days. They open it, sign in or create an account, and the project appears in their list — live, like on your own devices.</p>
          <div className="row">
            <label className="inline"><input type="radio" name="invite-role" checked={role === 'editor'} onChange={() => setRole('editor')} /> {ROLE_TEXT.editor}</label>
            <label className="inline"><input type="radio" name="invite-role" checked={role === 'viewer'} onChange={() => setRole('viewer')} /> {ROLE_TEXT.viewer}</label>
          </div>
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => act(async () => { const url = await createInvite(projectId, projectName, role); setLink(url); await send(url); })}>Create invite link</button>
          </div>
          {link && (
            <div className="invite-link" data-testid="invite-link">
              <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
              <button onClick={() => void send(link)}>{'share' in navigator ? 'Send…' : 'Copy'}</button>
            </div>
          )}
          {invites.length > 0 && (
            <>
              <h3>Links not used yet</h3>
              <ul className="member-list">
                {invites.map((i) => (
                  <li key={i.token}>
                    <span className="who">{i.role === 'editor' ? 'Editor' : 'Viewer'} link · expires {new Date(i.expiresAt).toLocaleDateString()}</span>
                    <button onClick={() => void send(inviteLink(i.token))}>Send again</button>
                    <button className="danger" disabled={busy} onClick={() => act(() => revokeInvite(i.token))}>Revoke</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
