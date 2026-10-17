import { useEffect, useState } from 'react';
import { go } from '../../app/App';
import { CloudPanel } from '../../components/Cloud';
import { db } from '../../data/db';
import { useLive } from '../../lib/useLive';
import { acceptInvite, rememberInvite, useCloudState } from '../../sync/cloud';

/** Opened from an invite link (#/join/<token>): sign in if needed, join, then open the project once it has arrived. */
export function JoinPage({ token }: { token: string }) {
  const cloud = useCloudState();
  const signedIn = cloud.kind !== 'signedOut' && cloud.kind !== 'unavailable';
  const [joined, setJoined] = useState<{ projectId: string; role: string; projectName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { rememberInvite(token); }, [token]);
  useEffect(() => {
    if (!signedIn || joined || error) return;
    acceptInvite(token).then(setJoined).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [signedIn, token, joined, error]);
  const [arrived] = useLive(async () => (joined ? !!(await db.projects.get(joined.projectId)) : false), [joined?.projectId], false);
  useEffect(() => { if (arrived && joined) go(`/p/${joined.projectId}`); }, [arrived, joined]);

  return (
    <div className="page home">
      <header className="topbar"><a href="#/">← Projects</a><h1>Join a shared project</h1></header>
      <main className="content">
        {!signedIn && cloud.kind !== 'unavailable' && (
          <>
            <p>You have been invited to a dilapidation inspection. Sign in, or create an account (any email and a password), to join it.</p>
            <CloudPanel />
          </>
        )}
        {cloud.kind === 'unavailable' && <p className="error">This version of the app has no cloud sync, so it cannot join shared projects.</p>}
        {signedIn && !joined && !error && <p role="status">Joining…</p>}
        {error && <div className="warn-box" role="alert"><p><strong>Could not join:</strong> {error}</p><p><a href="#/">Go to your projects</a></p></div>}
        {joined && !arrived && <p role="status">Joined <strong>{joined.projectName ?? 'the project'}</strong> as {joined.role}. Downloading it to this device…</p>}
      </main>
    </div>
  );
}
