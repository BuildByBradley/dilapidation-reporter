import { useEffect, useRef } from 'react';
import { db } from '../../data/db';
import { loadPdf, type LoadedPdf } from '../../lib/pdf';
import type { Floor } from '../../lib/types';
import type { ViewerEngine } from './engine';

/** Largest detail tile, in pixels (keeps memory modest on phones). */
const MAX_TILE_PX = 12_000_000;
const MAX_TILE_EDGE = 8192;
/** Extra plan rendered around the visible area, so small pans stay sharp without a re-render. */
const MARGIN = 0.3;
const SETTLE_MS = 220;

/**
 * Keeps PDF plans vector-sharp when zoomed in: once the view settles on one floor and the base image would be
 * magnified, the visible part of the original PDF page is re-rendered at screen resolution and laid over it.
 * Raster plans (PNG/JPEG) have no vector source and keep the base image.
 */
export function useVectorDetail(engine: ViewerEngine, floors: Floor[]) {
  const floorsRef = useRef(floors);
  floorsRef.current = floors;
  const planKey = floors.map((f) => `${f.id}:${f.planAssetId ?? ''}`).join('|');

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ac: AbortController | undefined;
    let disposed = false;
    let rendering = false;
    const docs = new Map<string, Promise<{ pdf: LoadedPdf; page: number } | null>>();

    const sourceOf = (assetId: string) => {
      let p = docs.get(assetId);
      if (!p) {
        p = (async () => {
          const a = await db.assets.get(assetId);
          const mime = a?.sourceMime ?? a?.mime ?? '';
          if (!a || !/pdf/i.test(mime)) return null;
          const blob = (await db.blobs.get(a.originalBlobId))?.data;
          if (!blob) return null;
          return { pdf: await loadPdf(blob, a.filename), page: a.sourcePage ?? 1 };
        })().catch(() => null);
        docs.set(assetId, p);
      }
      return p;
    };

    const run = async () => {
      if (disposed) return;
      if (engine.isBusy() || rendering) { schedule(); return; }
      const v = engine.viewOfFloor();
      const cur = engine.getDetail();
      if (!v) { if (cur) engine.setDetail(null); return; }
      if (cur && cur.floorId !== v.floorId) engine.setDetail(null);
      const img = engine.getFloorImage(v.floorId);
      const floor = floorsRef.current.find((f) => f.id === v.floorId);
      if (!img || !floor?.planAssetId) return;
      const need = v.devicePxPerImagePx;
      if (need <= 1.1) { if (engine.getDetail()) engine.setDetail(null); return; } // the base image is already sharp enough

      const mw = (v.u1 - v.u0) * MARGIN, mh = (v.v1 - v.v0) * MARGIN;
      const r = { u0: Math.max(0, v.u0 - mw), v0: Math.max(0, v.v0 - mh), u1: Math.min(1, v.u1 + mw), v1: Math.min(1, v.v1 + mh) };
      let outW = (r.u1 - r.u0) * img.width * need, outH = (r.v1 - r.v0) * img.height * need;
      const k = Math.min(1, Math.sqrt(MAX_TILE_PX / (outW * outH)), MAX_TILE_EDGE / Math.max(outW, outH));
      outW = Math.max(1, Math.round(outW * k)); outH = Math.max(1, Math.round(outH * k));

      const now = engine.getDetail();
      if (now && now.floorId === v.floorId && now.u0 <= v.u0 + 1e-6 && now.v0 <= v.v0 + 1e-6 && now.u1 >= v.u1 - 1e-6 && now.v1 >= v.v1 - 1e-6) {
        const res = now.bitmap.width / ((now.u1 - now.u0) * img.width); // tile px per base-image px
        if (res >= need * k * 0.85) return; // current tile covers the view at (nearly) the needed sharpness
      }
      const src = await sourceOf(floor.planAssetId);
      if (!src || disposed) return;
      ac?.abort(); ac = new AbortController();
      const signal = ac.signal;
      rendering = true;
      try {
        const canvas = await src.pdf.renderRegion(src.page, r, outW, outH, signal);
        if (disposed || signal.aborted) return;
        const bitmap = await createImageBitmap(canvas);
        canvas.width = 0; canvas.height = 0; // release the canvas memory now
        if (disposed || engine.viewOfFloor()?.floorId !== v.floorId) { bitmap.close(); return; }
        engine.setDetail({ floorId: v.floorId, bitmap, ...r });
      } catch { /* cancelled or failed: the base image stays */ } finally { rendering = false; }
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { void run(); }, SETTLE_MS); };
    const off = engine.onView(schedule);
    schedule();
    return () => {
      disposed = true; off(); clearTimeout(timer); ac?.abort();
      engine.setDetail(null);
      docs.forEach((p) => { void p.then((x) => x?.pdf.destroy()); });
    };
  }, [engine, planKey]);
}
