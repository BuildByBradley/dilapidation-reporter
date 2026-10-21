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
  /** Optional check before talking to the cloud (e.g. the sign-in is still valid). Throws with the reason. */
  ready?(): Promise<void>;
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
  /** `problems`: what could not be uploaded and why (everything else was). */
  | { kind: 'error'; pending: number; message: string; problems?: string[] }
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
/** Parallel file downloads: enough to hide the round trip to the cloud, few enough for a phone on mobile data. */
const DOWNLOADS_AT_ONCE = 6;
/**
 * Plain-language reason for a failed cloud call. Kept short: it is shown on a phone.
 */
export function explainSyncError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (isTransient(e)) return 'No connection to the cloud (weak or no signal). Try again when you have signal or Wi-Fi.';
  if (/row-level security|violates.*policy|permission denied|not authori[sz]ed|unauthori[sz]ed|\b403\b/i.test(m)) return 'Your account is not allowed to change this project (it belongs to another account, or you only have viewer access).';
  if (/jwt|token.*expired|refresh token|invalid claim|session/i.test(m)) return 'Your sign-in has expired. Sign out and sign in again on the projects page (nothing on this phone is lost).';
  if (/exceeded the maximum|too large|payload|413/i.test(m)) return 'A file is too large for the cloud.';
  if (/WebKitBlobResource|NotReadableError|could not be read|NotFoundError/i.test(m)) return 'A file stored on this device could not be read by the browser.';
  if (/quota|storage.*limit|exceeded.*quota/i.test(m)) return 'The cloud storage is full.';
  return m;
}
/** A network blip worth retrying (as opposed to a refusal that will fail again). */
export function isTransient(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /failed to fetch|load failed|networkerror|network request failed|network down|fetch failed|timed? ?out|timeout|aborted|ECONNRESET|socket|\b50[234]\b|bad gateway|service unavailable|gateway timeout/i.test(m);
}
/** Run a cloud call, retrying network blips a couple of times (site signal comes and goes). */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3, waitMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}

/** Some items could not be uploaded; everything else was. */
export class SyncProblems extends Error {
  constructor(readonly problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} items could not be uploaded. ${problems[0]}`);
  }
}

const assetBlobIds = (a: Asset) => [a.originalBlobId, a.displayBlobId, a.thumbnailBlobId, a.reportBlobId].filter((x): x is string => !!x);

async function readBlob(b: Blob): Promise<Blob> {
  if (typeof b.arrayBuffer !== 'function') return b;
  return new Blob([await b.arrayBuffer()], { type: b.type });
}

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
    let pullError: unknown;
    try { await this.pull(); } catch (e) { pullError = e; } // still upload: getting site data off the phone matters most
    await this.push();
    if (pullError && !this.running) this.fail(pullError);
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
    await this.remote.ready?.();
    const rows = await this.remote.fetchSince(since);
    await this.enqueue(() => this.retryMissing());
    if (!rows.length) return;
    // Files first, several at a time (one by one, a project with hundreds of photos takes many minutes on a phone).
    await this.prefetchBlobs(rows.filter((r) => r.kind === 'assets' && !r.deleted && r.data && r.device !== this.device)
      .flatMap((r) => assetBlobIds(r.data as Asset).map((id) => ({ id, projectId: (r.data as Asset).projectId }))));
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

  /**
   * Download files this device does not have yet, DOWNLOADS_AT_ONCE at a time, reporting progress. Files that are not
   * in the cloud yet, or fail, are left for the usual one-by-one path (which records and retries them).
   */
  private async prefetchBlobs(items: { id: string; projectId: string }[]) {
    const ids = new Set<string>();
    const todo: { id: string; projectId: string }[] = [];
    for (const it of items) {
      if (ids.has(it.id)) continue;
      ids.add(it.id);
      if (!(await this.db.blobs.get(it.id))) todo.push(it);
    }
    if (!todo.length) return;
    let left = todo.length;
    const work = [...todo];
    this.report({ kind: 'syncing', pending: left });
    await Promise.all(Array.from({ length: DOWNLOADS_AT_ONCE }, async () => {
      for (let it = work.shift(); it && !this.stopped; it = work.shift()) {
        try {
          const data = await withRetry(() => this.remote.downloadBlob(it.id, it.projectId));
          if (data) {
            await this.db.blobs.put({ id: it.id, projectId: it.projectId, data });
            await this.db.sync.put({ key: key(BLOB, it.id), kind: BLOB, id: it.id, projectId: it.projectId, hash: 'stored' });
          }
        } catch { /* retried by apply() */ }
        this.report({ kind: 'syncing', pending: --left });
      }
    }));
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
    await this.prefetchBlobs(Object.entries(m).map(([id, projectId]) => ({ id, projectId })));
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
    await this.remote.ready?.();

    // Anything that fails is skipped together with what depends on it; the rest still goes up, and the
    // failures are reported at the end (and retried on the next sync).
    const problems = new Map<string, string>();
    const blocked = new Set<string>(); // keys of items not uploaded this round
    const blockedProjects = new Set<string>();
    const describeItem = (kind: string, obj?: Record<string, unknown>) => {
      if (kind === BLOB) return 'a plan or photo file';
      if (kind === 'findings' && obj) return `finding ${String(obj.reference ?? '')} "${String(obj.title ?? '')}"`.replace(' ""', '');
      if (kind === 'floors' && obj) return `floor "${String(obj.name ?? '')}"`;
      if (kind === 'projects' && obj) return `project "${String(obj.name ?? '')}"`;
      return { categories: 'a category', assets: 'a plan or photo', photos: 'a photo' }[kind] ?? kind;
    };
    const problem = (what: string, e: unknown) => {
      console.error('sync: could not upload', what, e);
      const why = explainSyncError(e);
      const k = why + '|' + (what.startsWith('finding') || what.startsWith('floor') || what.startsWith('project') ? what : '');
      if (!problems.has(k)) problems.set(k, `${what[0].toUpperCase()}${what.slice(1)}: ${why}`);
    };

    // 1. Files first, a few at a time.
    const work = [...newBlobs];
    await Promise.all(Array.from({ length: 3 }, async () => {
      for (let id = work.shift(); id; id = work.shift()) {
        const b = await this.db.blobs.get(id);
        if (!b) continue;
        if (blockedProjects.has(b.projectId)) { blocked.add(key(BLOB, id)); continue; }
        try {
          // A fresh in-memory copy: Safari can fail to send a Blob straight out of IndexedDB.
          const data = await readBlob(b.data);
          await withRetry(() => this.remote.uploadBlob(id, b.projectId, data));
          await this.db.sync.put({ key: key(BLOB, id), kind: BLOB, id, projectId: b.projectId, hash: 'stored' });
          this.tick();
        } catch (e) {
          blocked.add(key(BLOB, id));
          problem(describeItem(BLOB), e);
          if (!isTransient(e) && /security|policy|permission|authori/i.test(String((e as Error)?.message))) blockedProjects.add(b.projectId);
        }
      }
    }));
    // 2. Records, parents before children. A record whose parent or file did not make it waits for the next round.
    const dependsOn = (kind: Kind, o: Record<string, unknown>): string[] => {
      switch (kind) {
        case 'assets': return assetBlobIds(o as unknown as Asset).map((id) => key(BLOB, id));
        case 'floors': return o.planAssetId ? [key('assets', String(o.planAssetId))] : [];
        case 'findings': return [key('floors', String(o.floorId)), key('categories', String(o.categoryId))];
        case 'photos': return [key('assets', String(o.assetId)), key('findings', String(o.findingId))];
        default: return [];
      }
    };
    for (const { kind, rows: all } of changed) {
      const rows = all.filter((c) => {
        const o = c.row.data!;
        if (blockedProjects.has(c.row.project_id) || dependsOn(kind, o).some((d) => blocked.has(d))) { blocked.add(c.sync.key); return false; }
        return true;
      });
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        try {
          await withRetry(() => this.remote.upsert(chunk.map((c) => c.row)));
          await this.db.sync.bulkPut(chunk.map((c) => c.sync));
          this.tick(chunk.length);
        } catch (e) {
          if (isTransient(e)) { chunk.forEach((c) => blocked.add(c.sync.key)); problem(describeItem(kind), e); continue; }
          // Find the row(s) that are refused; send the others.
          for (const c of chunk) {
            try {
              await withRetry(() => this.remote.upsert([c.row]));
              await this.db.sync.put(c.sync);
              this.tick();
            } catch (e1) {
              blocked.add(c.sync.key);
              problem(describeItem(kind, c.row.data!), e1);
              if (kind === 'projects') blockedProjects.add(c.row.id);
            }
          }
        }
      }
    }
    // 3. Deletions as tombstones, children first; then their files.
    try {
      for (let i = 0; i < goneRecords.length; i += 200) {
        const chunk = goneRecords.slice(i, i + 200);
        await withRetry(() => this.remote.upsert(chunk.map((s) => ({ kind: s.kind as Kind, id: s.id, project_id: s.projectId, data: null, deleted: true, device: this.device }))));
        await this.db.sync.bulkDelete(chunk.map((s) => s.key));
        this.tick(chunk.length);
      }
      if (goneBlobs.length) {
        await withRetry(() => this.remote.deleteBlobs(goneBlobs.map((s) => ({ id: s.id, projectId: s.projectId }))));
        await this.db.sync.bulkDelete(goneBlobs.map((s) => s.key));
        this.tick(goneBlobs.length);
      }
    } catch (e) { problem('a deletion', e); }
    if (problems.size) throw new SyncProblems([...problems.values()]);
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
    console.error('sync failed', e);
    if (!this.isOnline()) { this.report({ kind: 'offline', pending: this.pending }); return; }
    const problems = e instanceof SyncProblems ? e.problems : [explainSyncError(e)];
    this.report({ kind: 'error', pending: this.pending, message: e instanceof SyncProblems ? e.message : problems[0], problems });
  }
}
