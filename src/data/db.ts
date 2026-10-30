import Dexie, { type Table } from 'dexie';
import type { Asset, BlobRecord, Category, Finding, Floor, Photo, Project } from '../lib/types';

/** Cloud sync bookkeeping: the content hash last exchanged with the server for each synced row. */
export type SyncRow = { key: string; kind: string; id: string; projectId: string; hash: string };
export type MetaRow = { key: string; value: string };
/** Tables whose rows are mirrored to the cloud (blobs travel separately through file storage). */
export const SYNC_TABLES = ['projects', 'categories', 'assets', 'floors', 'findings', 'photos', 'blobs'] as const;

export const DB_NAME = 'dilapidation-inspector';

export class InspectorDb extends Dexie {
  projects!: Table<Project, string>;
  floors!: Table<Floor, string>;
  findings!: Table<Finding, string>;
  categories!: Table<Category, string>;
  photos!: Table<Photo, string>;
  assets!: Table<Asset, string>;
  blobs!: Table<BlobRecord, string>;
  sync!: Table<SyncRow, string>;
  meta!: Table<MetaRow, string>;
  /** Called after any committed-or-pending write to a synced table (used to schedule an upload). */
  readonly changeListeners = new Set<() => void>();

  constructor(name: string = DB_NAME) {
    super(name);
    const stores = {
      projects: 'id, updatedAt',
      floors: 'id, projectId, [projectId+order]',
      findings: 'id, projectId, floorId, categoryId',
      categories: 'id, projectId',
      photos: 'id, findingId, projectId, assetId',
      assets: 'id, projectId',
      blobs: 'id, projectId',
    };
    this.version(1).stores(stores);
    // v2: findings gain locationNeedsReview + severity defaults; photos gain projectId.
    this.version(2)
      .stores(stores)
      .upgrade(async (tx) => {
        await tx.table('findings').toCollection().modify((f: Partial<Finding>) => {
          if (typeof f.locationNeedsReview !== 'boolean') f.locationNeedsReview = false;
          if (!f.severity) f.severity = 'not_assessed';
          if (f.description === undefined) f.description = '';
          if (f.locationNotes === undefined) f.locationNotes = '';
        });
        const findings = await tx.table('findings').toArray();
        const byId = new Map(findings.map((f: Finding) => [f.id, f.projectId]));
        await tx.table('photos').toCollection().modify((p: Partial<Photo>) => {
          if (!p.projectId && p.findingId) p.projectId = byId.get(p.findingId);
        });
      });
    // v3: cloud sync state.
    this.version(3).stores({ ...stores, sync: 'key, kind', meta: 'key' });
    const synced = new Set<string>(SYNC_TABLES);
    const listeners = this.changeListeners;
    this.use({
      stack: 'dbcore', name: 'sync-notify',
      create: (down) => ({
        ...down,
        table: (name) => {
          const t = down.table(name);
          if (!synced.has(name)) return t;
          return { ...t, mutate: async (req) => { const r = await t.mutate(req); listeners.forEach((l) => l()); return r; } };
        },
      }),
    });
  }
}

export let db = new InspectorDb();
/** Swap the database (used by tests). */
export function useDb(next: InspectorDb) { db = next; }
