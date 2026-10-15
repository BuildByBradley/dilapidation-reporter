import { db } from './db';
import { useLive } from '../lib/useLive';

/**
 * Load a stored blob lazily (thumbnails/derivatives only — never originals during browsing).
 * Live: if the image arrives later (cloud sync from another device), the component updates.
 */
export function useStoredBlob(id: string | undefined): Blob | undefined {
  const [blob] = useLive(async () => (id ? (await db.blobs.get(id))?.data : undefined), [id], undefined as Blob | undefined);
  return blob;
}
