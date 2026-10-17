import type { InspectorDb, SyncRow } from '../data/db';
import type { Asset, Finding, Floor, Photo } from '../lib/types';

/**
 * Two-way sync between this browser's IndexedDB and the cloud.
 *
 * Local first: the app only ever reads and writes IndexedDB. The engine notices changes by comparing each row's
 * content hash with the hash last exchanged with the server (the `sync` table), uploads what differs, and applies
 * other devices' changes as they arrive. Files (plans, photos) go to file storage before the records that use them,
 * and incoming records wait for the files they reference, so a viewer never sees a floor without its plan.
 * Conflicts: an unsynced local edit wins over an incoming change to the same row; otherwise the latest write wins.
 */

/** Upload order: a record is always sent after the records it references. Deletions go in reverse. */
export const KINDS = ['projects', 'categories', 'assets', 'floors', 'findings', 'photos'] as const;
export type Kind = (typeof KINDS)[number];
const RANK = new Map<string, number>(KINDS.map((k, i) => [k, i]));

export type RecordRow = { kind: Kind; id: string; project_id: string; data: Record<string, unknown> | null; deleted: boolean; device: string | null };
export type RemoteRecord = RecordRow & { updated_at: string };

export interface Remote {
  upsert(rows: RecordRow[]): Promise<void>;
  /** Every record changed after `since` (exclusive), oldest first. `null` means everything. */
  fetchSince(since: string | null): Promise<RemoteRecord[]>;
  fetchOne(kind: Kind, id: string): Promise<RemoteRecord | null>;
  /** Files are stored per project (members of a shared project can all reach them). */
  uploadBlob(id: string, projectId: string, blob: Blob): Promise<void>;
  downloadBlob(id: string, projectId: string): Promise<Blob | null>;
  deleteBlobs(items: { id: string; projectId: string }[]): Promise<void>;
  /** Live feed of record changes. `onLive(true)` when connected (and again after each reconnect). */
  subscribe(onRecord: (r: RemoteRecord) => void, onLive: (live: boolean) => void): () => void;
}

export type SyncStatus =
  | { kind: 'syncing'; pending: number }
  | { kind: 'synced'; at: string; live: boolean }
  | { kind: 'offline'; pending: number }
  | { kind: 'error'; pending: number; message: string }
  /** Manual mode: nothing is sent or received until the user syncs. */
  | { kind: 'manual'; pending: number; at?: string };

// ---------- hashing ----------
/** JSON with sorted keys and undefined dropped, so a row hashes the same after a round trip through jsonb. */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stableJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
}
export function hashRow(v: unknown): string {
  const s = stableJson(v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}

const key = (kind: string, id: string) => `${kind}:${id}`;
const BLOB = 'blobs';
const CURSOR = 'cursor';
const MISSING = 'missingBlobs';
const LAST_SYNC = 'lastSync';
/** Re-read a little before the cursor: a transaction can commit after a later one started. Applying is idempotent. */
const CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const assetBlobIds = (a: Asset) => [a.originalBlobId, a.displayBlobId, a.thumbnailBlobId, a.reportBlobId].filter((x): x is string => !!x);

export class SyncEngine {
  private queue: Promise<unknown> = Promise.resolve();
  private pushTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private pushAgain = false;
  private stopped = false;
  private live = false;
  private pending = 0;
  private unsub: (() => void) | undefined;
  private countTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSync: string | undefined;
  private onChange = () => (this.auto ? this.schedulePush() : this.scheduleCount());

  constructor(
    private db: InspectorDb,
    private remote: Remote,
    private device: string,
    private report: (s: SyncStatus) => void = () => {},
    private isOnline: () => boolean = () => true,
    private pushDelayMs = 1200,
    /** Automatic: live, continuous. Manual: only counts local changes; sends/receives on syncNow(). */
    private auto = true,
  ) {}

  /** Automatic mode: download what changed elsewhere, upload local changes, then follow live updates. */
  async start(): Promise<void> {
    this.db.changeListeners.add(this.onChange);
    this.lastSync = (await this.db.meta.get(LAST_SYNC))?.value;
    if (!this.auto) { await this.count(); return; }
    this.report({ kind: 'syncing', pending: 0 });
    try { await this.pull(); } catch (e) { this.fail(e); }
    await this.push();
    if (this.stopped) return;
    this.followLive();
  }

  private followLive() {
    if (this.unsub || this.stopped) return;
    this.unsub = this.remote.subscribe(
      (r) => { void this.enqueue(() => this.apply(r)); },
      (live) => { this.live = live; if (live) void this.pull().catch((e) => this.fail(e)); this.reportIdle(); },
    );
  }

  /** Switch between automatic (live) and manual (sync on demand) without restarting. */
  async setAuto(auto: boolean): Promise<void> {
    if (auto === this.auto || this.stopped) return;
    this.auto = auto;
    if (auto) { await this.syncNow(); this.followLive(); return; }
    this.unsub?.(); this.unsub = undefined; this.live = false;
    clearTimeout(this.pushTimer);
    await this.count();
  }

  /** Send local changes and fetch other devices' changes now (the manual "Sync" button; also works in automatic mode). */
  async syncNow(): Promise<void> {
    if (this.stopped) return;
    this.report({ kind: 'syncing', pending: this.pending });
    try { await this.pull(); } catch (e) { this.fail(e); return; }
    await this.push();
  }

  stop(): void {
    this.stopped = true;
    this.db.changeListeners.delete(this.onChange);
    clearTimeout(this.pushTimer); clearTimeout(this.countTimer);
    this.unsub?.();
  }

  /** Manual mode: recount what is waiting (local only, no network). */
  private scheduleCount() {
    clearTimeout(this.countTimer);
    this.countTimer = setTimeout(() => { void this.count(); }, 400);
  }
  async count(): Promise<number> {
    if (this.running) return this.pending;
    await this.pushOnce(false);
    this.reportIdle();
    return this.pending;
  }

  schedulePush(delay = this.pushDelayMs): void {
    if (this.stopped || !this.auto) return;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => { void this.push(); }, delay);
  }

  /** Re-read everything this account can see (after joining a shared project, whose records are older than the cursor). */
  async resyncAll(): Promise<void> {
    await this.db.meta.delete(CURSOR);
    await this.syncNow();
  }

  /** Wait until queued incoming changes have been applied (tests, and before reporting "synced"). */
  idle(): Promise<unknown> { return this.queue; }

  // ---------- incoming ----------
  async pull(): Promise<void> {
    const cursor = (await this.db.meta.get(CURSOR))?.value ?? null;
    const since = cursor ? new Date(Date.parse(cursor) - CURSOR_OVERLAP_MS).toISOString() : null;
    const rows = await this.remote.fetchSince(since);
    await this.enqueue(() => this.retryMissing());
    if (!rows.length) return;
    // Parents before children; deletions after everything, children first.
    const ordered = [...rows].sort((a, b) =>
      Number(a.deleted) - Number(b.deleted)
      || (a.deleted ? RANK.get(b.kind)! - RANK.get(a.kind)! : RANK.get(a.kind)! - RANK.get(b.kind)!)
      || a.updated_at.localeCompare(b.updated_at));
    await this.enqueue(async () => { for (const r of ordered) await this.apply(r); });
    const latest = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), cursor ?? '');
    await this.db.meta.put({ key: CURSOR, value: latest });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((e) => this.fail(e));
    return run;
  }

  private async apply(r: RemoteRecord): Promise<void> {
    if (r.device === this.device || !RANK.has(r.kind)) return; // our own echo
    const table = this.db.table(r.kind);
    const k = key(r.kind, r.id);
    const [local, st] = await Promise.all([table.get(r.id), this.db.sync.get(k)]);
    if (local && st && hashRow(local) !== st.hash) return; // unsynced local edit wins; it is uploaded next
    if (!local && st && !r.deleted) return; // deleted here but not yet uploaded: the deletion wins
    if (r.deleted) {
      if (local) {
        if (r.kind === 'assets') await this.dropLocalBlobs(local as Asset);
        await table.delete(r.id);
      }
      await this.db.sync.delete(k);
      return;
    }
    if (!r.data) return;
    const h = hashRow(r.data);
    if (!(local && hashRow(local) === h)) {
      if (r.kind === 'assets') await this.fetchBlobs(r.data as Asset);
      if (r.kind === 'floors' && (r.data as Floor).planAssetId) await this.ensureAsset((r.data as Floor).planAssetId!);
      if (r.kind === 'photos') { await this.ensureAsset((r.data as Photo).assetId); await this.ensureRecord('findings', (r.data as Photo).findingId); }
      if (r.kind === 'findings') { await this.ensureRecord('floors', (r.data as Finding).floorId); await this.ensureRecord('categories', (r.data as Finding).categoryId); }
      await table.put(r.data);
    }
    await this.db.sync.put({ key: k, kind: r.kind, id: r.id, projectId: r.project_id, hash: h });
  }

  /** A floor or photo can arrive before its image record (e.g. live events racing a catch-up); fetch it first. */
  private async ensureAsset(id: string) { await this.ensureRecord('assets', id); }

  /** A record can arrive before the one it belongs to (a missed live event); fetch the parent directly. */
  private async ensureRecord(kind: Kind, id: string | undefined) {
    if (!id || (await this.db.table(kind).get(id))) return;
    const r = await this.remote.fetchOne(kind, id);
    if (r && !r.deleted) await this.apply(r);
  }

  private async fetchBlobs(a: Asset) {
    for (const id of assetBlobIds(a)) await this.fetchBlob(id, a.projectId);
  }

  /** Download one file. If it is not in the cloud yet, remember it and try again on later pulls. */
  private async fetchBlob(id: string, projectId: string): Promise<void> {
    if (await this.db.blobs.get(id)) { await this.setMissing(id, null); return; }
    const data = await this.remote.downloadBlob(id, projectId);
    if (!data) { await this.setMissing(id, projectId); return; }
    await this.db.blobs.put({ id, projectId, data });
    await this.db.sync.put({ key: key(BLOB, id), kind: BLOB, id, projectId, hash: 'stored' });
    await this.setMissing(id, null);
  }

  private async missing(): Promise<Record<string, string>> {
    return JSON.parse((await this.db.meta.get(MISSING))?.value ?? '{}');
  }
  private async setMissing(id: string, projectId: string | null) {
    const m = await this.missing();
    if (projectId) m[id] = projectId; else if (id in m) delete m[id]; else return;
    await this.db.meta.put({ key: MISSING, value: JSON.stringify(m) });
  }
  private async retryMissing() {
    const m = await this.missing();
    for (const [id, projectId] of Object.entries(m)) {
      if (!(await this.db.blobs.where('projectId').equals(projectId).count()) && !(await this.db.projects.get(projectId))) { await this.setMissing(id, null); continue; }
      await this.fetchBlob(id, projectId);
    }
  }

  private async dropLocalBlobs(a: Asset) {
    const ids = assetBlobIds(a);
    await this.db.blobs.bulkDelete(ids);
    await this.db.sync.bulkDelete(ids.map((id) => key(BLOB, id)));
    for (const id of ids) await this.setMissing(id, null);
  }

  // ---------- outgoing ----------
  /** Upload local changes. If an upload is already running, it runs once more and this resolves when it is done. */
  push(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.pushAgain = true; return this.running; }
    this.running = (async () => {
      try {
        do {
          this.pushAgain = false;
          await this.queue; // never upload a half-applied incoming change
          await this.pushOnce();
        } while (this.pushAgain && !this.stopped);
      } catch (e) {
        this.fail(e);
        this.schedulePush(15000); // automatic mode retries; also retried on reconnect
        return;
      } finally {
        this.running = undefined;
      }
      if (!this.pending) {
        this.lastSync = new Date().toISOString();
        await this.db.meta.put({ key: LAST_SYNC, value: this.lastSync });
      }
      this.reportIdle();
    })();
    return this.running;
  }

  /** Work out what differs from the server; with `upload`, send it. */
  private async pushOnce(upload = true) {
    // One consistent snapshot: a record must never be uploaded without the files written in the same transaction.
    const snap = await this.db.transaction('r', [this.db.sync, this.db.blobs, ...KINDS.map((k) => this.db.table(k))], async () => ({
      sync: await this.db.sync.toArray(),
      blobIds: (await this.db.blobs.toCollection().primaryKeys()) as string[],
      rows: await Promise.all(KINDS.map((k) => this.db.table(k).toArray())),
    }));
    const state = new Map<string, SyncRow>(snap.sync.map((s) => [s.key, s]));
    const seen = new Set<string>();

    // Plan the work first so the status can say how much is waiting.
    const newBlobs = snap.blobIds.filter((id) => { seen.add(key(BLOB, id)); return !state.has(key(BLOB, id)); });
    const changed: { kind: Kind; rows: { row: RecordRow; sync: SyncRow }[] }[] = [];
    for (const [ki, kind] of KINDS.entries()) {
      const rows: { row: RecordRow; sync: SyncRow }[] = [];
      for (const obj of snap.rows[ki] as ({ id: string; projectId?: string } & Record<string, unknown>)[]) {
        const k = key(kind, obj.id);
        seen.add(k);
        const h = hashRow(obj);
        if (state.get(k)?.hash === h) continue;
        const projectId = kind === 'projects' ? obj.id : String(obj.projectId ?? '');
        rows.push({ row: { kind, id: obj.id, project_id: projectId, data: obj, deleted: false, device: this.device }, sync: { key: k, kind, id: obj.id, projectId, hash: h } });
      }
      changed.push({ kind, rows });
    }
    const gone = [...state.values()].filter((s) => !seen.has(s.key));
    const goneRecords = gone.filter((s) => s.kind !== BLOB).sort((a, b) => RANK.get(b.kind)! - RANK.get(a.kind)!);
    const goneBlobs = gone.filter((s) => s.kind === BLOB);
    this.pending = newBlobs.length + changed.reduce((n, c) => n + c.rows.length, 0) + goneRecords.length + goneBlobs.length;
    if (!this.pending || !upload) return;
    if (!this.isOnline()) { this.report({ kind: 'offline', pending: this.pending }); return; }
    this.report({ kind: 'syncing', pending: this.pending });

    // 1. Files first, a few at a time.
    const work = [...newBlobs];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let id = work.shift(); id; id = work.shift()) {
        const b = await this.db.blobs.get(id);
        if (!b) continue;
        await this.remote.uploadBlob(id, b.projectId, b.data);
        await this.db.sync.put({ key: key(BLOB, id), kind: BLOB, id, projectId: b.projectId, hash: 'stored' });
        this.tick();
      }
    }));
    // 2. Records, parents before children.
    for (const { rows } of changed) {
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await this.remote.upsert(chunk.map((c) => c.row));
        await this.db.sync.bulkPut(chunk.map((c) => c.sync));
        this.tick(chunk.length);
      }
    }
    // 3. Deletions as tombstones, children first; then their files.
    for (let i = 0; i < goneRecords.length; i += 200) {
      const chunk = goneRecords.slice(i, i + 200);
      await this.remote.upsert(chunk.map((s) => ({ kind: s.kind as Kind, id: s.id, project_id: s.projectId, data: null, deleted: true, device: this.device })));
      await this.db.sync.bulkDelete(chunk.map((s) => s.key));
      this.tick(chunk.length);
    }
    if (goneBlobs.length) {
      await this.remote.deleteBlobs(goneBlobs.map((s) => ({ id: s.id, projectId: s.projectId })));
      await this.db.sync.bulkDelete(goneBlobs.map((s) => s.key));
    }
    this.pending = 0;
  }

  private tick(n = 1) {
    this.pending = Math.max(0, this.pending - n);
    this.report({ kind: 'syncing', pending: this.pending });
  }

  private reportIdle() {
    if (this.stopped || this.running) return;
    if (!this.auto) this.report({ kind: 'manual', pending: this.pending, at: this.lastSync });
    else if (this.pending && !this.isOnline()) this.report({ kind: 'offline', pending: this.pending });
    else if (!this.pending) this.report({ kind: 'synced', at: this.lastSync ?? new Date().toISOString(), live: this.live });
  }

  private fail(e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('sync failed', e);
    this.report(this.isOnline() ? { kind: 'error', pending: this.pending, message } : { kind: 'offline', pending: this.pending });
  }
}
