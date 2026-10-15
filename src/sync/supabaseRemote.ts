import type { SupabaseClient } from '@supabase/supabase-js';
import type { Kind, RecordRow, Remote, RemoteRecord } from './engine';

const COLS = 'kind,id,project_id,data,deleted,device,updated_at';
const BUCKET = 'blobs';

/** The engine's Remote, backed by the `records` table, the `blobs` bucket and Realtime (see supabase/setup.sql). */
export function supabaseRemote(client: SupabaseClient, owner: string): Remote {
  const path = (id: string) => `${owner}/${id}`;
  const ok = <T>(r: { data: T; error: { message: string } | null }): T => { if (r.error) throw new Error(r.error.message); return r.data; };
  return {
    async upsert(rows: RecordRow[]) {
      ok(await client.from('records').upsert(rows.map((r) => ({ ...r, owner })), { onConflict: 'owner,kind,id' }));
    },
    async fetchSince(since) {
      const out: RemoteRecord[] = [];
      for (let from = 0; ; from += 1000) {
        let q = client.from('records').select(COLS).eq('owner', owner);
        if (since) q = q.gt('updated_at', since);
        const page = ok(await q.order('updated_at').order('kind').order('id').range(from, from + 999)) as RemoteRecord[];
        out.push(...page);
        if (page.length < 1000) return out;
      }
    },
    async fetchOne(kind: Kind, id) {
      return ok(await client.from('records').select(COLS).eq('owner', owner).eq('kind', kind).eq('id', id).maybeSingle()) as RemoteRecord | null;
    },
    async uploadBlob(id, blob) {
      ok(await client.storage.from(BUCKET).upload(path(id), blob, { upsert: true, contentType: blob.type || 'application/octet-stream' }));
    },
    async downloadBlob(id) {
      const r = await client.storage.from(BUCKET).download(path(id));
      if (r.error) {
        const status = (r.error as { status?: number; statusCode?: string | number }).status ?? Number((r.error as { statusCode?: string }).statusCode);
        if (status === 400 || status === 404 || /not.?found/i.test(r.error.message)) return null;
        throw new Error(r.error.message);
      }
      return r.data;
    },
    async deleteBlobs(ids) {
      for (let i = 0; i < ids.length; i += 100) ok(await client.storage.from(BUCKET).remove(ids.slice(i, i + 100).map(path)));
    },
    subscribe(onRecord, onLive) {
      const channel = client.channel(`records:${owner}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'records', filter: `owner=eq.${owner}` },
          (p) => { if (p.new && 'kind' in p.new) onRecord(p.new as RemoteRecord); })
        .subscribe((status) => onLive(status === 'SUBSCRIBED'));
      return () => { void client.removeChannel(channel); };
    },
  };
}
