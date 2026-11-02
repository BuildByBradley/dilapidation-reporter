import { db } from './db';
import { LIMITS } from '../lib/types';

export type StorageUsage = {
  /** Bytes of every stored image across all projects in this browser (what counts against the budget). */
  totalBytes: number;
  /** Bytes belonging to one project. */
  projectBytes: number;
  photoCount: number;
  /** Average stored bytes per photo; falls back to a typical figure until there are photos to measure. */
  avgPhotoBytes: number;
};

export async function measureStorage(projectId?: string): Promise<StorageUsage> {
  const sizes = new Map<string, number>();
  let totalBytes = 0, projectBytes = 0;
  await db.blobs.each((b) => {
    const n = b.data.size;
    sizes.set(b.id, n); totalBytes += n;
    if (b.projectId === projectId) projectBytes += n;
  });
  let photoBytes = 0, photoCount = 0;
  await db.assets.each((a) => {
    if (a.kind !== 'photo') return;
    photoCount++;
    for (const id of new Set([a.originalBlobId, a.displayBlobId, a.thumbnailBlobId])) photoBytes += sizes.get(id) ?? 0;
  });
  return { totalBytes, projectBytes, photoCount, avgPhotoBytes: photoCount >= 3 ? photoBytes / photoCount : LIMITS.typicalPhotoBytes };
}
