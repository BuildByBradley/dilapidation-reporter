import { useEffect, useRef, useState } from 'react';

/**
 * Draw on a photo before it is used: freehand pen, circle (ellipse) and arrow, in a few high-visibility colours.
 * Shapes are stored in image-relative coordinates (0..1) and stroke widths relative to the image's short edge,
 * so the burned-in result at full resolution looks exactly like the preview.
 */
type Tool = 'pen' | 'circle' | 'arrow';
type Pt = { x: number; y: number };
type Shape = { tool: Tool; colour: string; width: number; pts: Pt[] };

const COLOURS = [
  { value: '#e5212b', label: 'Red' },
  { value: '#ffd400', label: 'Yellow' },
  { value: '#ffffff', label: 'White' },
  { value: '#111111', label: 'Black' },
];
const WIDTHS = [{ value: 0.006, label: 'Thin' }, { value: 0.012, label: 'Thick' }];

function drawShape(ctx: CanvasRenderingContext2D, s: Shape, w: number, h: number) {
  const lw = Math.max(1.5, s.width * Math.min(w, h));
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = lw; ctx.strokeStyle = s.colour; ctx.fillStyle = s.colour;
  // a thin dark halo keeps light colours readable on bright backgrounds
  ctx.shadowColor = s.colour === '#111111' ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.45)'; ctx.shadowBlur = lw * 0.6;
  const P = s.pts.map((p) => ({ x: p.x * w, y: p.y * h }));
  if (s.tool === 'pen') {
    ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (P.length === 1) ctx.lineTo(P[0].x + 0.1, P[0].y);
    ctx.stroke();
  } else if (P.length >= 2) {
    const [a, b] = [P[0], P[P.length - 1]];
    if (s.tool === 'circle') {
      ctx.beginPath(); ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2 || 1, Math.abs(b.y - a.y) / 2 || 1, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      const ang = Math.atan2(b.y - a.y, b.x - a.x), head = lw * 4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x - Math.cos(ang) * head * 0.6, b.y - Math.sin(ang) * head * 0.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
      ctx.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}

/** Burn shapes into the image at full resolution. */
export async function renderMarkup(src: Blob, shapes: Shape[], quality = 0.9): Promise<Blob> {
  const bmp = await createImageBitmap(src);
  try {
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    for (const s of shapes) drawShape(ctx, s, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the drawing'))), 'image/jpeg', quality));
  } finally { bmp.close(); }
}

export function PhotoMarkup({ src, onDone, onCancel }: { src: Blob; onDone(result: Blob): void | Promise<void>; onCancel(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [colour, setColour] = useState(COLOURS[0].value);
  const [width, setWidth] = useState(WIDTHS[0].value);
  const [busy, setBusy] = useState(false);
  const drawing = useRef<Shape | null>(null);

  useEffect(() => {
    let live = true, made: ImageBitmap | null = null;
    void createImageBitmap(src).then((b) => { made = b; if (live) setBmp(b); else b.close(); });
    return () => { live = false; made?.close(); };
  }, [src]);

  // Fit the preview canvas to the available space, keeping the photo's aspect ratio.
  const redraw = () => {
    const c = canvasRef.current, wrap = wrapRef.current;
    if (!c || !wrap || !bmp) return;
    const dpr = window.devicePixelRatio || 1;
    const maxW = wrap.clientWidth, maxH = Math.max(200, wrap.clientHeight);
    const k = Math.min(maxW / bmp.width, maxH / bmp.height);
    const cssW = Math.floor(bmp.width * k), cssH = Math.floor(bmp.height * k);
    c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
    c.width = Math.floor(cssW * dpr); c.height = Math.floor(cssH * dpr);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    for (const s of shapes) drawShape(ctx, s, c.width, c.height);
    if (drawing.current) drawShape(ctx, drawing.current, c.width, c.height);
  };
  useEffect(redraw);
  useEffect(() => {
    const on = () => redraw();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  });

  const pt = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const down = (e: React.PointerEvent) => {
    if (e.button > 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drawing.current = { tool, colour, width, pts: [pt(e)] };
    redraw();
  };
  const move = (e: React.PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    const p = pt(e);
    if (d.tool === 'pen') d.pts.push(p); else d.pts = [d.pts[0], p];
    redraw();
  };
  const up = () => {
    const d = drawing.current;
    drawing.current = null;
    if (d && (d.tool === 'pen' || Math.hypot(d.pts[0].x - d.pts.at(-1)!.x, d.pts[0].y - d.pts.at(-1)!.y) > 0.01)) setShapes((s) => [...s, d]);
    else redraw();
  };

  const done = async () => {
    if (!shapes.length) { await onDone(src); return; }
    setBusy(true);
    try { await onDone(await renderMarkup(src, shapes)); } finally { setBusy(false); }
  };

  return (
    <div className="markup" data-testid="photo-markup">
      <div className="markup-tools" role="toolbar" aria-label="Drawing tools">
        <div className="seg" role="group" aria-label="Tool">
          {(['pen', 'circle', 'arrow'] as Tool[]).map((t) => (
            <button key={t} aria-pressed={tool === t} onClick={() => setTool(t)}>{t === 'pen' ? '✎ Pen' : t === 'circle' ? '◯ Circle' : '➚ Arrow'}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Colour">
          {COLOURS.map((c) => (
            <button key={c.value} className="swatch-btn" aria-label={c.label} aria-pressed={colour === c.value} onClick={() => setColour(c.value)}>
              <span style={{ background: c.value }} />
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Line width">
          {WIDTHS.map((w) => <button key={w.value} aria-pressed={width === w.value} onClick={() => setWidth(w.value)}>{w.label}</button>)}
        </div>
        <div className="seg">
          <button disabled={!shapes.length} onClick={() => setShapes((s) => s.slice(0, -1))}>↶ Undo</button>
          <button disabled={!shapes.length} onClick={() => setShapes([])}>Clear</button>
        </div>
      </div>
      <div className="markup-stage" ref={wrapRef}>
        {bmp ? <canvas ref={canvasRef} aria-label="Photo — draw on it to mark the defect" data-testid="markup-canvas"
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} /> : <p role="status">Loading photo…</p>}
      </div>
      <div className="row">
        <button onClick={onCancel}>Back</button>
        <span className="spacer" />
        <button className="primary" disabled={busy || !bmp} onClick={done}>{busy ? 'Saving…' : 'Done drawing'}</button>
      </div>
    </div>
  );
}
