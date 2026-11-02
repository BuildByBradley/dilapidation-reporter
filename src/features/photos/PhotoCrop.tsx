import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useObjectUrl } from '../../components/ui';

/** Part of the photo to keep, in the photo's own pixels. */
export type CropRect = { x: number; y: number; w: number; h: number };

const ASPECTS = [{ label: 'Original', value: 0 }, { label: '4:3', value: 4 / 3 }, { label: '3:4', value: 3 / 4 }, { label: 'Square', value: 1 }];
const MAX_ZOOM = 8;

/**
 * Zoom and crop: the photo moves under a fixed frame (pinch / wheel / slider to zoom, drag to move);
 * whatever is inside the frame becomes the new photo.
 */
export function PhotoCrop({ src, onCancel, onDone }: { src: Blob; onCancel(): void; onDone(rect: CropRect): void | Promise<void> }) {
  const url = useObjectUrl(src);
  const stage = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ w: number; h: number } | null>(null);
  const [aspect, setAspect] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 }); // stage size
  const [zoom, setZoom] = useState(1); // 1 = photo just fills the frame
  const [pos, setPos] = useState({ x: 0, y: 0 }); // photo centre offset from frame centre, screen px
  const [busy, setBusy] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; zoom: number } | null>(null);

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Frame: the chosen shape, as large as fits the stage with a margin.
  const ratio = aspect || (img ? img.w / img.h : 4 / 3);
  const fw = Math.max(1, Math.min(box.w - 24, (box.h - 24) * ratio)), fh = fw / ratio;
  const cover = img ? Math.max(fw / img.w, fh / img.h) : 1; // screen px per photo px at zoom 1
  const k = cover * zoom;
  const clamp = (p: { x: number; y: number }, kk = k) => {
    if (!img) return p;
    const mx = Math.max(0, (img.w * kk - fw) / 2), my = Math.max(0, (img.h * kk - fh) / 2);
    return { x: Math.min(mx, Math.max(-mx, p.x)), y: Math.min(my, Math.max(-my, p.y)) };
  };
  useEffect(() => { setPos((p) => clamp(p)); }, [aspect, box.w, box.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const setZoomAt = (z: number) => {
    const nz = Math.min(MAX_ZOOM, Math.max(1, z));
    setPos((p) => clamp({ x: (p.x * nz) / zoom, y: (p.y * nz) / zoom }, cover * nz));
    setZoom(nz);
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      setZoomAt(gesture.current.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.current.dist)));
    } else if (pointers.current.size === 1) {
      setPos((p) => clamp({ x: p.x + cur.x - prev.x, y: p.y + cur.y - prev.y }));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gesture.current = null;
  };

  const rect = (): CropRect | null => {
    if (!img) return null;
    // Photo's top-left relative to the frame's top-left, in screen px.
    const left = fw / 2 + pos.x - (img.w * k) / 2, top = fh / 2 + pos.y - (img.h * k) / 2;
    const w = Math.min(img.w, fw / k), h = Math.min(img.h, fh / k);
    const x = Math.min(img.w - w, Math.max(0, -left / k)), y = Math.min(img.h - h, Math.max(0, -top / k));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  };
  const r = rect();

  return (
    <div className="markup crop">
      <div className="markup-tools">
        <div className="seg" role="group" aria-label="Frame shape">
          {ASPECTS.map((a) => <button key={a.label} type="button" aria-pressed={aspect === a.value} onClick={() => setAspect(a.value)}>{a.label}</button>)}
        </div>
        <label className="inline crop-zoom">Zoom
          <input type="range" min={1} max={MAX_ZOOM} step={0.05} value={zoom} aria-label="Zoom" onChange={(e) => setZoomAt(Number(e.target.value))} />
        </label>
        <button type="button" onClick={() => { setZoom(1); setPos({ x: 0, y: 0 }); }}>Reset</button>
      </div>
      <div ref={stage} className="markup-stage crop-stage" data-testid="crop-stage"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onWheel={(e) => setZoomAt(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))}>
        {url && (
          <img src={url} alt="Photo to crop" draggable={false} onLoad={(e) => setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={img ? { width: img.w * k, height: img.h * k, transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` } : { visibility: 'hidden' }} />
        )}
        <div className="crop-frame" style={{ width: fw, height: fh }} aria-hidden="true" />
      </div>
      <p className="small muted">Pinch or use the slider to zoom, drag to move. Everything inside the frame is kept{r ? ` (${r.w} × ${r.h} px)` : ''}.</p>
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={!r || busy} onClick={async () => { if (!r) return; setBusy(true); try { await onDone(r); } finally { setBusy(false); } }}>
          {busy ? 'Saving…' : 'Use cropped photo'}
        </button>
      </div>
    </div>
  );
}
