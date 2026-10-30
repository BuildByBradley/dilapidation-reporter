import { useEffect, useRef, useState } from 'react';
import { db } from '../../data/db';
import { getBlob } from '../../data/repo';
import { useLive } from '../../lib/useLive';
import type { Floor } from '../../lib/types';

/** Decodes each floor's viewer derivative once, and closes bitmaps (releasing memory) when replaced or unmounted. */
export function usePlanBitmaps(floors: Floor[]) {
  const cache = useRef(new Map<string, { assetId: string; bitmap: ImageBitmap }>());
  const [, setTick] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const assetKey = floors.map((f) => `${f.id}:${f.planAssetId ?? ''}`).join('|');
  // How many plan images are actually stored: changes when a plan arrives later (cloud sync), triggering a retry.
  const [stored] = useLive(async () => {
    const assets = await db.assets.bulkGet(floors.flatMap((f) => (f.planAssetId ? [f.planAssetId] : [])));
    const ids = assets.flatMap((a) => (a ? [a.displayBlobId] : []));
    return ids.length ? (await db.blobs.where('id').anyOf(ids).primaryKeys()).length : 0;
  }, [assetKey], 0);
  const key = `${assetKey}#${stored}`;
  useEffect(() => {
    let live = true;
    const wanted = new Map(floors.filter((f) => f.planAssetId).map((f) => [f.id, f.planAssetId!]));
    for (const [id, entry] of cache.current) {
      if (wanted.get(id) !== entry.assetId) { entry.bitmap.close(); cache.current.delete(id); }
    }
    (async () => {
      for (const [floorId, assetId] of wanted) {
        if (cache.current.get(floorId)?.assetId === assetId) continue;
        try {
          const asset = await db.assets.get(assetId);
          const blob = asset && (await getBlob(asset.displayBlobId));
          if (!blob) throw new Error('Plan image data is missing.');
          const bitmap = await createImageBitmap(blob);
          if (!live) { bitmap.close(); return; }
          cache.current.set(floorId, { assetId, bitmap });
          setErrors((e) => { const { [floorId]: _drop, ...rest } = e; return rest; });
          setTick((t) => t + 1);
        } catch (err) {
          if (live) setErrors((e) => ({ ...e, [floorId]: err instanceof Error ? err.message : String(err) }));
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => () => { for (const e of cache.current.values()) e.bitmap.close(); cache.current.clear(); }, []);
  return { bitmaps: cache.current, errors };
}
