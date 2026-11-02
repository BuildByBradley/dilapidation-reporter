import type { SupabaseClient } from '@supabase/supabase-js';
import type { Kind, RecordRow, Remote, RemoteRecord } from './engine';

const COLS = 'kind,id,project_id,data,deleted,device,updated_at';
const BUCKET = 'blobs';

/**
 * The engine's Remote, backed by the `records` table, the `blobs` bucket and Realtime (see supabase/setup.sql and
 * supabase/sharing.sql). Row-level security decides what this user sees: their own projects and projects shared with them.
 * Files live at "<projectId>/<fileId>"; files uploaded before sharing existed live at "<userId>/<fileId>" until moved.
 */
export function supabaseRemote(client: SupabaseClient, user: string, sharing = true): Remote {
  // Before supabase/sharing.sql is run, files stay in the per-user folder and records are keyed per user.
  const path = (id: string, projectId: string) => (sharing ? `${projectId}/${id}` : `${user}/${id}`);
  const legacy = (id: string) => `${user}/${id}`;
  const ok = <T>(r: { data: T; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data; };
  const notFound = (e: { message: string; status?: number; statusCode?: string | number }) => {
    const status = e.status ?? Number(e.statusCode);
    return status === 400 || status === 404 || /not.?found/i.test(e.message);
  };
  return {
    async ready() {
      // Refreshes an expired access token; without a session every upload would be refused as "not allowed".
      const { data, error } = await client.auth.getSession();
      if (error) throw new Error(error.message);
      if (!data.session) throw new Error('Sign-in session expired');
      if (data.session.user.id !== user) throw new Error('Signed in as a different account on this device; sign-in session expired');
    },
    async upsert(rows: RecordRow[]) {
      ok(await client.from('records').upsert(rows.map((r) => ({ ...r, owner: user })), { onConflict: sharing ? 'kind,id' : 'owner,kind,id' }));
    },
    async fetchSince(since) {
      const out: RemoteRecord[] = [];
      for (let from = 0; ; from += 1000) {
        let q = client.from('records').select(COLS);
        if (since) q = q.gt('updated_at', since);
        const page = ok(await q.order('updated_at').order('kind').order('id').range(from, from + 999)) as RemoteRecord[];
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    async fetchOne(kind: Kind, id) {
      return ok(await client.from('records').select(COLS).eq('kind', kind).eq('id', id).maybeSingle()) as RemoteRecord | null;
    },
    async uploadBlob(id, projectId, blob) {
      ok(await client.storage.from(BUCKET).upload(path(id, projectId), blob, { upsert: true, contentType: blob.type || 'application/octet-stream' }));
    },
    async downloadBlob(id, projectId) {
      for (const p of new Set([path(id, projectId), legacy(id)])) {
        const r = await client.storage.from(BUCKET).download(p);
        if (!r.error) return r.data;
        if (!notFound(r.error as { message: string })) throw new Error(r.error.message);
      }
      return null;
    },
    async deleteBlobs(items) {
      const paths = [...new Set(items.flatMap((x) => [path(x.id, x.projectId), legacy(x.id)]))];
      for (let i = 0; i < paths.length; i += 100) ok(await client.storage.from(BUCKET).remove(paths.slice(i, i + 100)));
    },
    subscribe(onRecord, onLive) {
      // No filter: Realtime applies the same row-level security, so each member hears about their projects only.
      const channel = client.channel(`records:${user}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'records' },
          (p) => { if (p.new && 'kind' in p.new) onRecord(p.new as RemoteRecord); })
        .subscribe((status) => onLive(status === 'SUBSCRIBED'));
      return () => { void client.removeChannel(channel); };
    },
  };
}

/**
 * One-time move of this user's files from the old per-user folder to per-project folders, so people a project is
 * shared with can reach them. Uses this device's knowledge of which project each file belongs to; files it cannot
 * place are left where they are (the owner can still read them) and retried next time.
 */
export async function migrateLegacyBlobs(client: SupabaseClient, user: string, projectOf: (id: string) => Promise<string | undefined>): Promise<{ moved: number; left: number }> {
  let moved = 0, left = 0;
  for (;;) {
    const r = await client.storage.from(BUCKET).list(user, { limit: 100, offset: left });
    if (r.error) throw new Error(r.error.message);
    const files = (r.data ?? []).filter((f) => f.id); // folders have no id
    if (!files.length) return { moved, left };
    for (const f of files) {
      const projectId = await projectOf(f.name);
      if (!projectId) { left++; continue; }
      const m = await client.storage.from(BUCKET).move(`${user}/${f.name}`, `${projectId}/${f.name}`);
      if (m.error) {
        // already copied by another device: remove the old copy
        if (/exist/i.test(m.error.message)) { await client.storage.from(BUCKET).remove([`${user}/${f.name}`]); moved++; } else left++;
      } else moved++;
    }
  }
}
