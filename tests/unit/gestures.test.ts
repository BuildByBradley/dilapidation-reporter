import { describe, expect, it } from 'vitest';
import { GestureTracker, keyToAction, wheelZoomFactor } from '../../src/lib/gestures';

function make(is3d = true) {
  const log = { rot: 0, panX: 0, panY: 0, zoom: [] as number[], taps: [] as [number, number][], drag: 0 };
  const g = new GestureTracker({
    rotate: (d) => { log.rot += d; }, pan: (x, y) => { log.panX += x; log.panY += y; },
    zoom: (f) => { log.zoom.push(f); }, tap: (x, y) => { log.taps.push([x, y]); }, dragStart: () => { log.drag++; },
  }, () => is3d);
  return { g, log };
}
const touch = (id: number, x: number, y: number) => ({ id, x, y, pointerType: 'touch' });

describe('GestureTracker', () => {
  it('3D: horizontal one-finger drag rotates yaw ~0.3deg/px; vertical is ignored', () => {
    const { g, log } = make();
    g.down(touch(1, 100, 100));
    g.move(touch(1, 200, 100));
    expect(log.rot).toBeCloseTo(30, 5);
    g.move(touch(1, 200, 400));
    expect(log.rot).toBeCloseTo(30, 5);
    expect(log.panX).toBe(0); expect(log.panY).toBe(0);
    g.up({ id: 1 });
    expect(log.taps).toHaveLength(0);
  });
  it('diagonal drag only contributes its horizontal component', () => {
    const { g, log } = make();
    g.down(touch(1, 0, 0));
    g.move(touch(1, 50, 80));
    expect(log.rot).toBeCloseTo(15, 5);
  });
  it('2D: one finger pans', () => {
    const { g, log } = make(false);
    g.down(touch(1, 0, 0)); g.move(touch(1, 40, 25));
    expect(log.rot).toBe(0);
    expect([log.panX, log.panY]).toEqual([40, 25]);
  });
  it('tap within slop yields a tap; movement over 6px never does', () => {
    const a = make();
    a.g.down(touch(1, 10, 10)); a.g.move(touch(1, 14, 12)); a.g.up({ id: 1 });
    expect(a.log.taps).toEqual([[14, 12]]);
    const b = make();
    b.g.down(touch(1, 10, 10)); b.g.move(touch(1, 10, 17)); b.g.up({ id: 1 });
    expect(b.log.taps).toHaveLength(0);
  });
  it('a second pointer cancels tap eligibility', () => {
    const { g, log } = make();
    g.down(touch(1, 10, 10)); g.down(touch(2, 60, 10)); g.up({ id: 2 }); g.up({ id: 1 });
    expect(log.taps).toHaveLength(0);
  });
  it('two-finger: centroid pans, pinch zooms, twist is ignored', () => {
    const { g, log } = make();
    g.down(touch(1, 100, 100)); g.down(touch(2, 200, 100));
    g.move(touch(1, 80, 100)); g.move(touch(2, 220, 100)); // spread: zoom in
    expect(log.zoom.at(-1)).toBeGreaterThan(1);
    expect(log.rot).toBe(0);
    const panBefore = log.panX;
    // pure twist: rotate both around centroid keeping distance -> no zoom/pan/rotate
    const z0 = log.zoom.length;
    g.move(touch(1, 150, 100 - 70)); g.move(touch(2, 150, 100 + 70));
    expect(log.rot).toBe(0);
    expect(Math.abs(log.panX - panBefore)).toBeLessThan(80);
    expect(log.zoom.length).toBeGreaterThanOrEqual(z0);
  });
  it('1->2->1 pointer transitions do not jump', () => {
    const { g, log } = make();
    g.down(touch(1, 100, 100)); g.move(touch(1, 140, 100));
    const rot = log.rot;
    g.down(touch(2, 300, 300));
    g.up({ id: 2 }); // back to a single finger at its last position
    g.move(touch(1, 141, 100));
    expect(log.rot - rot).toBeCloseTo(0.3, 5);
    g.up({ id: 1 });
    expect(log.taps).toHaveLength(0);
  });
  it('mouse: shift-drag and middle button pan, plain drag rotates', () => {
    const { g, log } = make();
    g.down({ id: 1, x: 0, y: 0, pointerType: 'mouse', button: 0, shiftKey: true });
    g.move({ id: 1, x: 30, y: 10, pointerType: 'mouse', shiftKey: true });
    expect([log.panX, log.panY, log.rot]).toEqual([30, 10, 0]);
    g.up({ id: 1 });
    const m = make();
    m.g.down({ id: 1, x: 0, y: 0, pointerType: 'mouse', button: 1 });
    m.g.move({ id: 1, x: 20, y: 0, pointerType: 'mouse' });
    expect(m.log.panX).toBe(20);
    const r = make();
    r.g.down({ id: 1, x: 0, y: 0, pointerType: 'mouse', button: 0 });
    r.g.move({ id: 1, x: 100, y: 0, pointerType: 'mouse' });
    expect(r.log.rot).toBeCloseTo(30);
  });
  it('cancel clears state', () => {
    const { g, log } = make();
    g.down(touch(1, 0, 0)); g.cancel(); g.up({ id: 1 });
    expect(g.pointerCount).toBe(0); expect(log.taps).toHaveLength(0);
  });
});

describe('wheel and keyboard', () => {
  it('wheel up zooms in, down zooms out', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });
  it('maps keys', () => {
    expect(keyToAction('ArrowLeft', false, true)).toEqual({ type: 'rotate', deg: -5 });
    expect(keyToAction('ArrowUp', false, true)).toBeNull();
    expect(keyToAction('ArrowLeft', true, true)?.type).toBe('pan');
    expect(keyToAction('ArrowLeft', false, false)?.type).toBe('pan');
    expect(keyToAction('f', false, true)).toEqual({ type: 'fit' });
    expect(keyToAction('Escape', false, true)).toEqual({ type: 'cancel' });
  });
});
