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

export async function planSnapshotBlob(img: ImageBitmap, pins: SnapPin[], maxEdge = 1800) {
  return canvasToBlob(drawPlanWithPins(img, pins, maxEdge), 'image/jpeg', 0.88);
}

/** Local inset: a crop of the plan around one pin, so dense areas stay legible. */
export async function insetBlob(img: ImageBitmap, u: number, v: number, colour: string, outW = 420, outH = 300): Promise<Blob> {
  const cropW = Math.min(img.width, img.width * 0.22), cropH = cropW * (outH / outW);
  const cx = Math.min(img.width - cropW / 2, Math.max(cropW / 2, u * img.width));
  const cy = Math.min(img.height - cropH / 2, Math.max(cropH / 2, v * img.height));
  const c = newCanvas(outW, outH);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, cx - cropW / 2, cy - cropH / 2, cropW, cropH, 0, 0, outW, outH);
  const px = (u * img.width - (cx - cropW / 2)) * (outW / cropW), py = (v * img.height - (cy - cropH / 2)) * (outH / cropH);
  ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(px, py, 9, 0, 7); ctx.stroke();
  ctx.lineWidth = 2; ctx.strokeStyle = colour; ctx.beginPath(); ctx.arc(px, py, 9, 0, 7); ctx.stroke();
  ctx.fillStyle = colour; ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 7); ctx.fill();
  return canvasToBlob(c, 'image/jpeg', 0.85);
}
