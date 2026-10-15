import { YAW_PER_PX } from './coords';

export const TAP_SLOP_PX = 6;

export type GestureCallbacks = {
  rotate(deltaYawDeg: number): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, x: number, y: number): void;
  tap(x: number, y: number): void;
  /** Called when a drag/multi-touch begins so owners can cancel transitions etc. */
  dragStart?(): void;
};
export type PointerSample = {
  id: number; x: number; y: number;
  pointerType: 'mouse' | 'touch' | 'pen' | string;
  button?: number; shiftKey?: boolean;
};

type Tracked = { id: number; x: number; y: number; lx: number; ly: number; sx: number; sy: number; type: string; button: number; shift: boolean };

/**
 * Pure pointer-gesture state machine (no DOM). Feed it down/move/up/cancel samples in canvas-relative CSS px.
 * 3D: one-pointer horizontal motion rotates yaw only; vertical motion is ignored (elevation is locked).
 * 2D: one pointer pans. Two pointers: centroid pans, pinch zooms, twist is ignored.
 */
export class GestureTracker {
  private pts = new Map<number, Tracked>();
  private tapEligible = false;
  private dragging = false;
  private multiPrev: { cx: number; cy: number; dist: number } | null = null;
  constructor(private cb: GestureCallbacks, public is3d: () => boolean) {}

  get pointerCount() { return this.pts.size; }
  get isDragging() { return this.dragging; }

  down(p: PointerSample) {
    this.pts.set(p.id, { id: p.id, x: p.x, y: p.y, lx: p.x, ly: p.y, sx: p.x, sy: p.y, type: p.pointerType, button: p.button ?? 0, shift: !!p.shiftKey });
    if (this.pts.size === 1) {
      this.tapEligible = (p.button ?? 0) === 0;
      this.dragging = false;
      this.multiPrev = null;
    } else {
      this.tapEligible = false; // a second pointer cancels tap/placement
      if (!this.dragging) { this.dragging = true; this.cb.dragStart?.(); }
      this.multiPrev = this.measure();
    }
  }

  private measure() {
    const [a, b] = [...this.pts.values()];
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  move(p: PointerSample): void {
    const t = this.pts.get(p.id);
    if (!t) return;
    t.x = p.x; t.y = p.y; t.shift = !!p.shiftKey || t.shift;
    if (this.pts.size >= 2) {
      const m = this.measure();
      if (this.multiPrev) {
        this.cb.pan(m.cx - this.multiPrev.cx, m.cy - this.multiPrev.cy);
        if (this.multiPrev.dist > 1 && m.dist > 1) this.cb.zoom(m.dist / this.multiPrev.dist, m.cx, m.cy);
      }
      this.multiPrev = m;
      return;
    }
    const dx = t.x - t.lx, dy = t.y - t.ly;
    if (!this.dragging) {
      if (Math.hypot(t.x - t.sx, t.y - t.sy) <= TAP_SLOP_PX) return;
      this.dragging = true;
      this.tapEligible = false;
      this.cb.dragStart?.();
      // consume movement from the start point so the threshold crossing does not jump
      t.lx = t.sx; t.ly = t.sy;
      this.move(p);
      return;
    }
    t.lx = t.x; t.ly = t.y;
    const panMode = t.type === 'mouse' ? t.shift || t.button === 1 : false;
    if (panMode || !this.is3d()) this.cb.pan(dx, dy);
    else this.cb.rotate(dx * YAW_PER_PX);
  }

  up(p: { id: number }) {
    const t = this.pts.get(p.id);
    if (!t) return;
    const wasSingle = this.pts.size === 1;
    this.pts.delete(p.id);
    if (wasSingle) {
      if (this.tapEligible && !this.dragging) this.cb.tap(t.x, t.y);
      this.tapEligible = false;
      this.dragging = false;
      this.multiPrev = null;
      return;
    }
    // 2 -> 1 (or more): rebase remaining pointers so nothing jumps
    for (const r of this.pts.values()) { r.lx = r.x; r.ly = r.y; r.sx = r.x; r.sy = r.y; }
    this.multiPrev = this.pts.size >= 2 ? this.measure() : null;
    this.tapEligible = false;
  }

  cancel() {
    this.pts.clear();
    this.tapEligible = false;
    this.dragging = false;
    this.multiPrev = null;
  }
}

export const wheelZoomFactor = (deltaY: number, deltaMode = 0) => {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-200, Math.min(200, px)) * 0.0015);
};

export type KeyAction =
  | { type: 'rotate'; deg: number } | { type: 'pan'; dx: number; dy: number }
  | { type: 'zoom'; factor: number } | { type: 'fit' } | { type: 'cancel' } | null;

export function keyToAction(key: string, shift: boolean, is3d: boolean): KeyAction {
  const step = 40, rot = 5;
  const arrow = key.startsWith('Arrow');
  if (arrow) {
    const dir = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[key] as [number, number];
    if (is3d && !shift) {
      if (key === 'ArrowLeft') return { type: 'rotate', deg: -rot };
      if (key === 'ArrowRight') return { type: 'rotate', deg: rot };
      return null;
    }
    return { type: 'pan', dx: dir[0] * step, dy: dir[1] * step };
  }
  if (key === '+' || key === '=') return { type: 'zoom', factor: 1.2 };
  if (key === '-' || key === '_') return { type: 'zoom', factor: 1 / 1.2 };
  if (key === 'f' || key === 'F') return { type: 'fit' };
  if (key === 'Escape') return { type: 'cancel' };
  return null;
}
