import Dexie, { type Table } from 'dexie';
import type { Asset, BlobRecord, Category, Finding, Floor, Photo, Project } from '../lib/types';

export const DB_NAME = 'dilapidation-inspector';

export class InspectorDb extends Dexie {
  projects!: Table<Project, string>;
  floors!: Table<Floor, string>;
  findings!: Table<Finding, string>;
  categories!: Table<Category, string>;
  photos!: Table<Photo, string>;
  assets!: Table<Asset, string>;
  blobs!: Table<BlobRecord, string>;

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
  }
}

export let db = new InspectorDb();
/** Swap the database (used by tests). */
export function useDb(next: InspectorDb) { db = next; }
