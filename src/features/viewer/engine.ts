import {
  ELEVATION_DEG, TOPDOWN_DEG, fitCamera, panBy, planeBounds, planeMatrix, planeSize, rotateYaw, screenToUv, uvToScreen, wrapYaw,
  zoomAbout, project, type Camera, type UV,
} from '../../lib/coords';
import { GestureTracker, keyToAction, wheelZoomFactor } from '../../lib/gestures';
import type { InteractionMode, ViewerMode } from '../../lib/types';

export type ViewFloor = { id: string; name: string; image: ImageBitmap | null; displayWidth: number; findingCount: number };
export type ViewPin = { id: string; floorId: string; u: number; v: number; colour: string; reference: string; needsReview: boolean };
export type Draft = { floorId: string; u: number; v: number; relocating?: boolean } | null;

export type EngineEvents = {
  floorPick(id: string): void;
  pinPick(ids: string[], x: number, y: number): void;
  place(floorId: string, uv: UV): void;
  placeRejected(): void;
  escape(): void;
  change(): void;
};

const PIN_HIT = 24;
const FADE_MS = 320;
const TWEEN_MS = 320;
const DEFAULT_OVERVIEW_YAW = 40;
const palette = { bg: '#e9edf2', outline: '#8a96a6', accent: '#1f5fbf', label: '#15202b', labelBg: 'rgba(255,255,255,0.92)', white: '#ffffff' };

type Store = Map<string, Camera>;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export class ViewerEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private w = 0; private h = 0; private dpr = 1;
  private floors: ViewFloor[] = [];
  private pins: ViewPin[] = [];
  private mode: ViewerMode = { kind: 'overview3d' };
  private interaction: InteractionMode = { kind: 'navigate' };
  private selectedPin: string | null = null;
  private draft: Draft = null;
  private hoverFloor: string | null = null;
  private cam: Camera = { yaw: DEFAULT_OVERVIEW_YAW, elevation: ELEVATION_DEG, zoom: 1, panX: 0, panY: 0 };
  private overviewCam: Camera | null = null;
  private nav3d: Store = new Map();
  private nav2d: Store = new Map();
  private alpha = new Map<string, number>();
  private targetAlpha = new Map<string, number>();
  private tween: { from: Camera; to: Camera; t0: number } | null = null;
  private raf = 0;
  private lastFrame = 0;
  private reduced = false;
  private gestures: GestureTracker;
  private cleanup: (() => void)[] = [];

  constructor(private events: EngineEvents) {
    this.gestures = new GestureTracker({
      rotate: (d) => this.mutate((c) => rotateYaw(c, d)),
      pan: (dx, dy) => this.mutate((c) => panBy(c, dx, dy)),
      zoom: (f, x, y) => this.mutate((c) => zoomAbout(c, f, this.fitZoom(), x, y, this.w / 2, this.h / 2)),
      tap: (x, y) => this.handleTap(x, y),
      dragStart: () => { this.tween = null; },
    }, () => this.mode.kind !== 'floor2d');
  }

  // ---------- lifecycle ----------
  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reduced = !!mq?.matches;
    const rel = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, pointerType: e.pointerType, button: e.button, shiftKey: e.shiftKey }; };
    const down = (e: PointerEvent) => {
      canvas.focus({ preventScroll: true });
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (e.button === 1) e.preventDefault();
      this.gestures.down(rel(e));
    };
    const move = (e: PointerEvent) => {
      const p = rel(e);
      if (this.gestures.pointerCount === 0 && e.pointerType === 'mouse') {
        const h = this.mode.kind === 'overview3d' ? this.pickFloor(p.x, p.y) : null;
        if (h !== this.hoverFloor) { this.hoverFloor = h; canvas.style.cursor = h ? 'pointer' : ''; this.invalidate(); }
      }
      this.gestures.move(p);
    };
    const up = (e: PointerEvent) => { this.gestures.up({ id: e.pointerId }); try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    const cancel = (e: PointerEvent) => { this.gestures.cancel(); try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
    const lost = () => this.gestures.cancel();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      this.tween = null;
      this.mutate((c) => zoomAbout(c, wheelZoomFactor(e.deltaY, e.deltaMode), this.fitZoom(), e.clientX - r.left, e.clientY - r.top, this.w / 2, this.h / 2));
    };
    const key = (e: KeyboardEvent) => {
      if (e.target !== canvas) return;
      const a = keyToAction(e.key, e.shiftKey, this.mode.kind !== 'floor2d');
      if (!a) return;
      e.preventDefault();
      this.tween = null;
      if (a.type === 'rotate') this.mutate((c) => rotateYaw(c, a.deg));
      else if (a.type === 'pan') this.mutate((c) => panBy(c, a.dx, a.dy));
      else if (a.type === 'zoom') this.mutate((c) => zoomAbout(c, a.factor, this.fitZoom(), this.w / 2, this.h / 2, this.w / 2, this.h / 2));
      else if (a.type === 'fit') this.fit();
      else if (a.type === 'cancel') this.events.escape();
    };
    const add = <K extends keyof HTMLElementEventMap>(t: K, f: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      canvas.addEventListener(t, f as EventListener, o); this.cleanup.push(() => canvas.removeEventListener(t, f as EventListener, o));
    };
    add('pointerdown', down); add('pointermove', move); add('pointerup', up); add('pointercancel', cancel);
    add('lostpointercapture', lost); add('wheel', wheel, { passive: false }); add('keydown', key);
    add('contextmenu', (e) => e.preventDefault());
    add('pointerleave', () => { if (this.hoverFloor) { this.hoverFloor = null; canvas.style.cursor = ''; this.invalidate(); } });
  }
  detach() {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f()); this.cleanup = [];
    this.gestures.cancel();
    this.canvas = null; this.ctx = null;
  }
  resize(w: number, h: number, dpr: number) {
    const first = this.w === 0;
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.canvas) { this.canvas.width = Math.max(1, Math.round(w * dpr)); this.canvas.height = Math.max(1, Math.round(h * dpr)); }
    if (first && w > 0) this.fit(true);
    this.invalidate();
  }

  // ---------- data ----------
  setFloors(floors: ViewFloor[]) {
    const had = this.populated().length;
    this.floors = floors;
    for (const f of floors) if (!this.alpha.has(f.id)) { this.alpha.set(f.id, 1); this.targetAlpha.set(f.id, 1); }
    // drop navigation state of replaced/removed planes only when floor set changes shape
    if (this.populated().length !== had && this.w > 0 && this.mode.kind === 'overview3d') this.fit(true);
    this.applyTargets(false);
    this.invalidate();
  }
  setPins(pins: ViewPin[]) { this.pins = pins; this.invalidate(); }
  setSelectedPin(id: string | null) { this.selectedPin = id; this.invalidate(); }
  setDraft(d: Draft) { this.draft = d; this.invalidate(); }
  setInteraction(i: InteractionMode) { this.interaction = i; this.invalidate(); }
  getFloorImage(id: string) { return this.floors.find((f) => f.id === id)?.image ?? null; }

  private populated() { return this.floors.filter((f) => f.image); }
  private size(f: ViewFloor) { return planeSize(f.displayWidth, f.image!.width, f.image!.height); }
  private gap() { const ps = this.populated(); return ps.length ? 0.85 * Math.max(...ps.map((f) => this.size(f).H)) : 60; }
  private elevationOf(id: string) { const i = this.populated().findIndex((f) => f.id === id); return Math.max(0, i) * this.gap(); }
  private planesFor(ids: string[]): [number, number, number][] {
    return ids.map((id) => { const f = this.floors.find((x) => x.id === id)!; const s = this.size(f); return [s.W, s.H, this.elevationOf(id)]; });
  }
  private modeFloorIds(m: ViewerMode) { return m.kind === 'overview3d' ? this.populated().map((f) => f.id) : this.populated().some((f) => f.id === m.floorId) ? [m.floorId] : []; }

  // ---------- camera ----------
  private fitFor(m: ViewerMode, base: Camera): Camera {
    const ids = this.modeFloorIds(m);
    if (!ids.length || !this.w) return base;
    return fitCamera(base, this.planesFor(ids), this.w, this.h, m.kind === 'overview3d' ? 0.86 : 0.92, { top: this.w < 760 ? 100 : 64, bottom: 40 });
  }
  private fitZoom() { return this.fitFor(this.mode, this.cam).zoom || 1; }
  private store(): Store | null { return this.mode.kind === 'isolated3d' ? this.nav3d : this.mode.kind === 'floor2d' ? this.nav2d : null; }
  private persist() {
    if (this.mode.kind === 'overview3d') this.overviewCam = this.cam;
    else this.store()?.set((this.mode as { floorId: string }).floorId, this.cam);
  }
  private mutate(fn: (c: Camera) => Camera) { this.tween = null; this.cam = fn(this.cam); this.persist(); this.invalidate(); this.events.change(); }

  fit(immediate = false) {
    const target = this.fitFor(this.mode, this.cam);
    this.setCamera(target, !immediate);
  }
  zoomBy(f: number) { this.mutate((c) => zoomAbout(c, f, this.fitZoom(), this.w / 2, this.h / 2, this.w / 2, this.h / 2)); }
  rotateBy(d: number) { if (this.mode.kind !== 'floor2d') this.mutate((c) => rotateYaw(c, d)); }
  private setCamera(to: Camera, animate: boolean) {
    if (!animate || this.reduced || to.elevation !== this.cam.elevation) { this.tween = null; this.cam = to; }
    else this.tween = { from: this.cam, to, t0: performance.now() };
    if (!this.tween) { this.persist(); } else this.persistTarget(to);
    this.invalidate(); this.events.change();
  }
  private persistTarget(to: Camera) {
    if (this.mode.kind === 'overview3d') this.overviewCam = to; else this.store()?.set((this.mode as { floorId: string }).floorId, to);
  }

  /** Forget saved navigation for a floor (e.g. after its plan was replaced) or everything when omitted. */
  resetNav(floorId?: string) {
    if (floorId) { this.nav3d.delete(floorId); this.nav2d.delete(floorId); } else { this.nav3d.clear(); this.nav2d.clear(); }
    this.overviewCam = null;
  }
  getMode() { return this.mode; }
  /** Switch viewer mode. Other floors fade fully out when isolated; hit-testing is disabled immediately. */
  setMode(next: ViewerMode) {
    const prev = this.mode;
    this.persist();
    this.gestures.cancel();
    this.mode = next;
    let to: Camera;
    if (next.kind === 'overview3d') {
      to = this.overviewCam ?? this.fitFor(next, { yaw: prev.kind === 'floor2d' ? DEFAULT_OVERVIEW_YAW : this.cam.yaw, elevation: ELEVATION_DEG, zoom: 1, panX: 0, panY: 0 });
    } else if (next.kind === 'isolated3d') {
      to = this.nav3d.get(next.floorId) ?? this.fitFor(next, { yaw: prev.kind === 'floor2d' ? DEFAULT_OVERVIEW_YAW : this.cam.yaw, elevation: ELEVATION_DEG, zoom: 1, panX: 0, panY: 0 });
    } else {
      to = this.nav2d.get(next.floorId) ?? this.fitFor(next, { yaw: 0, elevation: TOPDOWN_DEG, zoom: 1, panX: 0, panY: 0 });
    }
    this.applyTargets(true);
    this.setCamera(to, true);
    if (this.reduced) this.applyTargets(false);
  }
  private applyTargets(animate: boolean) {
    const m = this.mode;
    for (const f of this.floors) {
      const show = m.kind === 'overview3d' || m.floorId === f.id;
      this.targetAlpha.set(f.id, show ? 1 : 0);
      if (!animate || this.reduced) this.alpha.set(f.id, show ? 1 : 0);
    }
    this.invalidate();
  }
  /** Visible (alpha > 0) and interactive floors — exposed for tests/diagnostics. */
  visibleFloorIds() { return this.populated().filter((f) => (this.alpha.get(f.id) ?? 0) > 0.001).map((f) => f.id); }
  interactiveFloorIds() { return this.populated().filter((f) => (this.targetAlpha.get(f.id) ?? 0) > 0).map((f) => f.id); }
  debugState() {
    return {
      mode: this.mode.kind, floorId: 'floorId' in this.mode ? this.mode.floorId : null, camera: { ...this.cam },
      visible: this.visibleFloorIds(), interactive: this.interactiveFloorIds(), size: { w: this.w, h: this.h },
      animating: !!this.tween || this.populated().some((f) => (this.alpha.get(f.id) ?? 0) !== (this.targetAlpha.get(f.id) ?? 0)),
      pointers: this.gestures.pointerCount,
    };
  }

  // ---------- projection helpers ----------
  uvToScreen(floorId: string, u: number, v: number) {
    const f = this.floors.find((x) => x.id === floorId);
    if (!f?.image) return null;
    const s = this.size(f);
    return uvToScreen(this.cam, u, v, s.W, s.H, this.elevationOf(floorId), this.w / 2, this.h / 2);
  }
  screenToUv(floorId: string, x: number, y: number): UV | null {
    const f = this.floors.find((q) => q.id === floorId);
    if (!f?.image) return null;
    const s = this.size(f);
    return screenToUv(this.cam, x, y, s.W, s.H, this.elevationOf(floorId), this.w / 2, this.h / 2);
  }
  /** Topmost interactive floor under a canvas point. Non-interactive (hidden) floors are never considered. */
  pickFloor(x: number, y: number): string | null {
    const ids = this.interactiveFloorIds().sort((a, b) => this.elevationOf(b) - this.elevationOf(a));
    for (const id of ids) if (this.screenToUv(id, x, y)) return id;
    return null;
  }
  pinScreen(p: ViewPin) { return this.uvToScreen(p.floorId, p.u, p.v); }
  private pickPins(x: number, y: number): string[] {
    if (this.mode.kind === 'overview3d') return [];
    const fid = this.mode.floorId;
    const hits: { id: string; d: number }[] = [];
    for (const p of this.pins) {
      if (p.floorId !== fid) continue;
      const s = this.pinScreen(p);
      if (!s) continue;
      const d = Math.min(Math.hypot(s.x - x, s.y - y), Math.hypot(s.x - x, s.y - 12 - y));
      if (d <= PIN_HIT) hits.push({ id: p.id, d });
    }
    return hits.sort((a, b) => a.d - b.d).map((h) => h.id);
  }
  private handleTap(x: number, y: number) {
    if (this.mode.kind === 'overview3d') {
      const id = this.pickFloor(x, y);
      if (id) this.events.floorPick(id);
      return;
    }
    // In Navigate mode a tap selects pins; while placing/relocating a tap always proposes a location (even over a pin).
    if (this.interaction.kind === 'navigate') {
      const pins = this.pickPins(x, y);
      if (pins.length) this.events.pinPick(pins, x, y);
      return;
    }
    const uv = this.screenToUv(this.mode.floorId, x, y);
    if (!uv) this.events.placeRejected(); else this.events.place(this.mode.floorId, uv);
  }

  // ---------- rendering ----------
  invalidate() { if (!this.raf && this.canvas) this.raf = requestAnimationFrame((t) => this.frame(t)); }
  private frame(t: number) {
    this.raf = 0;
    const dt = this.lastFrame ? Math.min(100, t - this.lastFrame) : 16;
    this.lastFrame = t;
    let busy = false;
    if (this.tween) {
      const k = Math.min(1, (performance.now() - this.tween.t0) / TWEEN_MS);
      const e = ease(k), { from, to } = this.tween;
      let dyaw = ((to.yaw - from.yaw + 540) % 360) - 180;
      if (Math.abs(dyaw) < 1e-9) dyaw = 0;
      this.cam = { yaw: wrapYaw(from.yaw + dyaw * e), elevation: to.elevation, zoom: lerp(from.zoom, to.zoom, e), panX: lerp(from.panX, to.panX, e), panY: lerp(from.panY, to.panY, e) };
      if (k >= 1) { this.cam = to; this.tween = null; } else busy = true;
      this.events.change();
    }
    for (const f of this.floors) {
      const a = this.alpha.get(f.id) ?? 1, tg = this.targetAlpha.get(f.id) ?? 1;
      if (a !== tg) {
        const step = dt / FADE_MS;
        this.alpha.set(f.id, a < tg ? Math.min(tg, a + step) : Math.max(tg, a - step));
        busy = true;
      }
    }
    this.draw();
    if (busy) this.invalidate();
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = palette.bg; ctx.fillRect(0, 0, this.w, this.h);
    const cx = this.w / 2, cy = this.h / 2;
    const mode = this.mode;
    const ordered = this.populated().sort((a, b) => this.elevationOf(a.id) - this.elevationOf(b.id));
    for (const f of ordered) {
      const a = this.alpha.get(f.id) ?? 0;
      if (a <= 0.001) continue; // fully faded floors are not drawn at all
      const s = this.size(f), y = this.elevationOf(f.id), img = f.image!;
      const m = planeMatrix(this.cam, s.W, s.H, y, img.width, img.height, cx, cy);
      ctx.save();
      ctx.globalAlpha = a;
      if (mode.kind === 'overview3d') { ctx.shadowColor = 'rgba(20,30,50,0.28)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 6; }
      ctx.setTransform(this.dpr * m.a, this.dpr * m.b, this.dpr * m.c, this.dpr * m.d, this.dpr * m.e, this.dpr * m.f);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, img.width, img.height);
      ctx.shadowColor = 'transparent';
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
      ctx.restore();
      // outline
      const corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => project(this.cam, u * s.W, y, v * s.H, cx, cy));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.beginPath(); corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
      const sel = mode.kind !== 'overview3d' || this.hoverFloor === f.id;
      ctx.strokeStyle = sel ? palette.accent : palette.outline; ctx.lineWidth = sel ? 2.5 : 1;
      ctx.stroke();
      ctx.restore();
      if (mode.kind === 'overview3d') this.drawFloorLabel(ctx, f, corners, a);
    }
    // pins
    for (const p of this.pins) {
      const f = this.floors.find((x) => x.id === p.floorId);
      const a = this.alpha.get(p.floorId) ?? 0;
      if (!f?.image || a <= 0.001) continue;
      const sp = this.pinScreen(p);
      if (!sp) continue;
      ctx.globalAlpha = a;
      if (mode.kind === 'overview3d') { ctx.fillStyle = p.colour; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(sp.x, sp.y, 3.5, 0, 7); ctx.fill(); ctx.stroke(); }
      else this.drawPin(ctx, sp.x, sp.y, p);
      ctx.globalAlpha = 1;
    }
    if (this.draft && mode.kind !== 'overview3d' && 'floorId' in mode && mode.floorId === this.draft.floorId) {
      const sp = this.uvToScreen(this.draft.floorId, this.draft.u, this.draft.v);
      if (sp) this.drawCrosshair(ctx, sp.x, sp.y);
    }
  }

  private drawFloorLabel(ctx: CanvasRenderingContext2D, f: ViewFloor, corners: { x: number; y: number }[], a: number) {
    const front = corners.reduce((m, p) => (p.y > m.y ? p : m), corners[0]);
    const text = `${f.name} · ${f.findingCount}`;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '600 13px system-ui, sans-serif';
    const tw = ctx.measureText(text).width + 16;
    const x = Math.min(this.w - tw / 2 - 6, Math.max(tw / 2 + 6, front.x)), y = Math.min(this.h - 16, front.y - 18);
    ctx.fillStyle = palette.labelBg; ctx.strokeStyle = palette.outline; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x - tw / 2, y - 12, tw, 24, 12); ctx.fill(); ctx.stroke();
    ctx.fillStyle = palette.label; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }

  /** Teardrop pin: the tip is exactly at (x,y). */
  private drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, p: ViewPin) {
    const selected = p.id === this.selectedPin;
    const r = selected ? 11 : 9, cy = y - (selected ? 25 : 21);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x - r * 0.35, y - (cy < y ? (y - cy) * 0.45 : 0), x - r, cy + r * 0.9, x - r, cy);
    ctx.arc(x, cy, r, Math.PI, 0);
    ctx.bezierCurveTo(x + r, cy + r * 0.9, x + r * 0.35, y - (y - cy) * 0.45, x, y);
    ctx.closePath();
    ctx.fillStyle = p.colour; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = selected ? 3 : 2; ctx.strokeStyle = selected ? palette.accent : palette.white; ctx.stroke();
    if (selected) { ctx.lineWidth = 1.5; ctx.strokeStyle = palette.white; ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, cy, 3.2, 0, 7); ctx.fill();
    if (p.needsReview) {
      ctx.fillStyle = '#e8a100'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x + r, cy - r, 6, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', x + r, cy - r + 0.5);
    }
    if (selected) {
      ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(p.reference).width + 12;
      ctx.fillStyle = palette.labelBg; ctx.strokeStyle = palette.accent; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x - tw / 2, cy - r - 24, tw, 20, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = palette.label; ctx.fillText(p.reference, x, cy - r - 13.5);
    }
    ctx.restore();
  }
  private drawCrosshair(ctx: CanvasRenderingContext2D, x: number, y: number) {
    ctx.save();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.moveTo(x - 24, y); ctx.lineTo(x + 24, y); ctx.moveTo(x, y - 24); ctx.lineTo(x, y + 24); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#d6246e';
    ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.moveTo(x - 24, y); ctx.lineTo(x + 24, y); ctx.moveTo(x, y - 24); ctx.lineTo(x, y + 24); ctx.stroke();
    ctx.fillStyle = '#d6246e'; ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fill();
    ctx.restore();
  }

  /** Magnified crop of the plan around a normalised point (for precise touch placement). */
  drawMagnifier(target: HTMLCanvasElement, floorId: string, u: number, v: number, cropPx = 64) {
    const img = this.getFloorImage(floorId);
    const ctx = target.getContext('2d');
    if (!img || !ctx) return;
    const cx = u * img.width, cy = v * img.height, half = cropPx / 2;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, target.width, target.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, cx - half, cy - half, cropPx, cropPx, 0, 0, target.width, target.height);
    const c = target.width / 2;
    ctx.lineWidth = 1; ctx.strokeStyle = '#d6246e';
    ctx.beginPath(); ctx.moveTo(c, 0); ctx.lineTo(c, target.height); ctx.moveTo(0, c); ctx.lineTo(target.width, c); ctx.stroke();
    ctx.beginPath(); ctx.arc(c, c, 10, 0, 7); ctx.stroke();
  }

  /** Test/diagnostic: screen-space bounds of the plane for a floor. */
  planeScreenBounds(floorId: string) {
    const f = this.floors.find((x) => x.id === floorId);
    if (!f?.image) return null;
    const s = this.size(f);
    return planeBounds(this.cam, s.W, s.H, this.elevationOf(floorId), this.w / 2, this.h / 2);
  }
}
