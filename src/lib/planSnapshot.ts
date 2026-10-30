import { canvasToBlob, newCanvas } from './imaging';

export type SnapPin = { n: string; u: number; v: number; colour: string };

/**
 * Draws a floor plan with numbered markers at authoritative (u,v) positions. Independent of any viewer camera.
 * Markers sit exactly on the point; number bubbles are displaced with leader lines when they would overlap.
 */
export function drawPlanWithPins(img: ImageBitmap, pins: SnapPin[], maxEdge: number): HTMLCanvasElement {
  const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const c = newCanvas(img.width * k, img.height * k);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const s = Math.max(0.8, c.width / 1100);
  const r = 11 * s;
  const placed: { x: number; y: number }[] = [];
  const angles = [-90, -45, 0, 45, 90, 135, 180, -135];
  const radii = [r * 1.5, r * 3, r * 4.8, r * 7, r * 9.5];
  ctx.font = `700 ${Math.round(12 * s)}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of pins) {
    const x = p.u * c.width, y = p.v * c.height;
    let best = { x: x, y: y - r * 1.5 };
    search: for (const rad of radii) for (const a of angles) {
      const bx = x + Math.cos((a * Math.PI) / 180) * rad, by = y + Math.sin((a * Math.PI) / 180) * rad;
      if (bx < r || by < r || bx > c.width - r || by > c.height - r) continue;
      if (placed.every((q) => Math.hypot(q.x - bx, q.y - by) >= r * 2.2)) { best = { x: bx, y: by }; break search; }
    }
    placed.push(best);
    ctx.lineWidth = 1.5 * s; ctx.strokeStyle = '#222';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(best.x, best.y); ctx.stroke();
    ctx.fillStyle = p.colour; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * s;
    ctx.beginPath(); ctx.arc(x, y, 3.5 * s, 0, 7); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(best.x, best.y, r, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.fillText(p.n, best.x, best.y + 0.5 * s);
  }
  return c;
}

export async function planSnapshotBlob(img: ImageBitmap, pins: SnapPin[], maxEdge = 3000) {
  return canvasToBlob(drawPlanWithPins(img, pins, maxEdge), 'image/jpeg', 0.9);
}

/** Teardrop pin with its tip exactly at (x, y), as drawn in the plan viewer. */
export function drawTeardropPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string, opacity = 1) {
  const cy = y - r * 2.35;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - r * 0.35, y - (y - cy) * 0.45, x - r, cy + r * 0.9, x - r, cy);
  ctx.arc(x, cy, r, Math.PI, 0);
  ctx.bezierCurveTo(x + r, cy + r * 0.9, x + r * 0.35, y - (y - cy) * 0.45, x, y);
  ctx.closePath();
  ctx.fillStyle = colour; ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.18); ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, cy, r * 0.36, 0, 7); ctx.fill();
  ctx.restore();
}

/** Width of the key plan around a pin, and of the closer detail view, as a share of the plan's width. */
export const KEY_PLAN_SPAN = 0.22, DETAIL_SPAN = 0.08;

/** The part of the plan an inset shows (plan pixels): `span` of the plan's width around the pin, kept inside the plan. */
export function insetRect(img: { width: number; height: number }, u: number, v: number, outW = 720, outH = 540, span = KEY_PLAN_SPAN) {
  const cropW = Math.min(img.width, img.width * span), cropH = cropW * (outH / outW);
  const cx = Math.min(img.width - cropW / 2, Math.max(cropW / 2, u * img.width));
  const cy = Math.min(img.height - cropH / 2, Math.max(cropH / 2, v * img.height));
  return { x: cx - cropW / 2, y: cy - cropH / 2, w: cropW, h: cropH };
}

/**
 * Local plan detail around a pin, with the pin (as on the plans, half transparent) and, optionally, a reference tag under it.
 * `span`: how much of the plan's width it covers (smaller = closer). `outlineSpan`: outline the area a closer view shows.
 */
export async function insetBlob(img: ImageBitmap, u: number, v: number, colour: string, label?: string, outW = 720, outH = 540,
  span = KEY_PLAN_SPAN, outlineSpan?: number): Promise<Blob> {
  const r = insetRect(img, u, v, outW, outH, span);
  const cropW = r.w, cropH = r.h, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const c = newCanvas(outW, outH);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, cx - cropW / 2, cy - cropH / 2, cropW, cropH, 0, 0, outW, outH);
  const px = (u * img.width - (cx - cropW / 2)) * (outW / cropW), py = (v * img.height - (cy - cropH / 2)) * (outH / cropH);
  if (outlineSpan) {
    const d = insetRect(img, u, v, outW, outH, outlineSpan), k = outW / cropW;
    ctx.setLineDash([10, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#1d1f20';
    ctx.strokeRect((d.x - r.x) * k, (d.y - r.y) * k, d.w * k, d.h * k);
    ctx.setLineDash([]);
  }
  // The same teardrop pin as on the plans, half transparent so the drawing under it stays readable.
  drawTeardropPin(ctx, px, py, 22, colour, 0.5);
  if (label) {
    ctx.font = 'bold 34px "Barlow Condensed", "Arial Narrow", Arial, sans-serif';
    const w = ctx.measureText(label).width + 20, h = 44;
    const below = py + 21 + h <= outH;
    const tx = Math.min(outW - w - 2, Math.max(2, px - w / 2)), ty = below ? py + 21 : py - 21 - h;
    ctx.fillStyle = '#1d1f20'; ctx.fillRect(tx, ty, w, h);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(label, tx + 10, ty + h / 2 + 1);
  }
  return canvasToBlob(c, 'image/jpeg', 0.88);
}
