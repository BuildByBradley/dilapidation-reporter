import { describe, expect, it } from 'vitest';
import {
  ELEVATION_DEG, fitCamera, planeBounds, planeMatrix, panBy, planeSize, project, rotateYaw, screenToUv, unproject, uvToScreen,
  wrapYaw, zoomAbout, ZOOM_MAX_FACTOR, ZOOM_MIN_FACTOR, type Camera,
} from '../../src/lib/coords';

const base: Camera = { yaw: 0, elevation: ELEVATION_DEG, zoom: 3, panX: 10, panY: -20 };
const W = 120, H = 80;
const corners: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]];

describe('coordinate mapping', () => {
  it('maps plan size from aspect ratio', () => {
    expect(planeSize(100, 2000, 1000)).toEqual({ W: 100, H: 50 });
  });
  it.each([0, 37, 90, 180, 271.5])('round-trips corners and centre at yaw %f (2D and 3D) within 0.01px', (yaw) => {
    for (const elevation of [ELEVATION_DEG, 90]) {
      const cam = { ...base, yaw, elevation };
      for (const [u, v] of corners) {
        const s = uvToScreen(cam, u, v, W, H, 25, 400, 300);
        const back = screenToUv(cam, s.x, s.y, W, H, 25, 400, 300);
        expect(back).not.toBeNull();
        expect(Math.abs(s.x - uvToScreen(cam, back!.u, back!.v, W, H, 25, 400, 300).x)).toBeLessThan(0.01);
        expect(Math.abs(back!.u - u)).toBeLessThan(1e-9);
        expect(Math.abs(back!.v - v)).toBeLessThan(1e-9);
      }
    }
  });
  it('rejects hits outside the plan rather than clamping', () => {
    const cam: Camera = { yaw: 0, elevation: 90, zoom: 1, panX: 0, panY: 0 };
    expect(screenToUv(cam, 400 + W / 2 + 5, 300, W, H, 0, 400, 300)).toBeNull();
    expect(screenToUv(cam, 400, 300 + H / 2 + 0.1, W, H, 0, 400, 300)).toBeNull();
    expect(screenToUv(cam, 400 + W / 2 - 0.1, 300, W, H, 0, 400, 300)).not.toBeNull();
  });
  it('keeps reprojection error under 2 CSS px after pan, zoom, rotate and resize', () => {
    let cam = { ...base };
    const uv = { u: 0.31, v: 0.77 };
    const before = uvToScreen(cam, uv.u, uv.v, W, H, 10, 500, 400);
    cam = panBy(rotateYaw(cam, 123), 17, -9);
    cam = zoomAbout(cam, 1.7, 3, 300, 200, 500, 400);
    // resize: centre moves; world->screen must follow the new centre exactly
    const after = uvToScreen(cam, uv.u, uv.v, W, H, 10, 640, 480);
    const hit = screenToUv(cam, after.x, after.y, W, H, 10, 640, 480)!;
    const re = uvToScreen(cam, hit.u, hit.v, W, H, 10, 640, 480);
    expect(Math.hypot(re.x - after.x, re.y - after.y)).toBeLessThan(2);
    expect(before).not.toEqual(after);
  });
  it('plane image matrix agrees with point projection', () => {
    const cam = { ...base, yaw: 45 };
    const m = planeMatrix(cam, W, H, 5, 1000, 500, 400, 300);
    const px = 250, py = 125;
    const sx = m.a * px + m.c * py + m.e, sy = m.b * px + m.d * py + m.f;
    const s = uvToScreen(cam, px / 1000, py / 500, W, H, 5, 400, 300);
    expect(sx).toBeCloseTo(s.x, 6);
    expect(sy).toBeCloseTo(s.y, 6);
  });
  it('unproject inverts project at a given height', () => {
    const p = project(base, 12, 30, -7, 400, 300);
    const q = unproject(base, p.x, p.y, 30, 400, 300);
    expect(q.x).toBeCloseTo(12, 8);
    expect(q.z).toBeCloseTo(-7, 8);
  });
});

describe('camera constraints', () => {
  it('rotation changes only yaw and wraps', () => {
    const c = rotateYaw({ ...base, yaw: 350 }, 20);
    expect(c.yaw).toBeCloseTo(10);
    expect(c.elevation).toBe(base.elevation);
    expect(wrapYaw(-10)).toBe(350);
    const many = Array.from({ length: 500 }).reduce<Camera>((cam, i) => panBy(rotateYaw(cam, (i as number) % 7), 3, 2), base);
    expect(many.elevation).toBe(ELEVATION_DEG);
  });
  it('clamps zoom to 0.25x-16x of fitted zoom and zooms about the cursor', () => {
    const fit = 2;
    const hi = zoomAbout({ ...base, zoom: 30 }, 5, fit, 0, 0, 0, 0);
    expect(hi.zoom).toBeCloseTo(fit * ZOOM_MAX_FACTOR);
    const lo = zoomAbout({ ...base, zoom: 1 }, 0.01, fit, 0, 0, 0, 0);
    expect(lo.zoom).toBeCloseTo(fit * ZOOM_MIN_FACTOR);
    const cam = { ...base, yaw: 0, elevation: 90 };
    const anchor = screenToUv(cam, 450, 330, W, H, 0, 400, 300);
    const z = zoomAbout(cam, 2, 1, 450, 330, 400, 300);
    const a2 = uvToScreen(z, anchor!.u, anchor!.v, W, H, 0, 400, 300);
    expect(a2.x).toBeCloseTo(450, 6);
    expect(a2.y).toBeCloseTo(330, 6);
  });
  it('fit camera keeps all planes inside the canvas', () => {
    const planes: [number, number, number][] = [[100, 70, 0], [100, 70, 30], [100, 70, 60], [100, 70, 90], [100, 70, 120]];
    for (const yaw of [0, 60, 180]) {
      const cam = fitCamera({ ...base, yaw }, planes, 800, 600);
      for (const [pw, ph, y] of planes) {
        const b = planeBounds(cam, pw, ph, y, 400, 300);
        expect(b.minX).toBeGreaterThanOrEqual(0); expect(b.maxX).toBeLessThanOrEqual(800);
        expect(b.minY).toBeGreaterThanOrEqual(0); expect(b.maxY).toBeLessThanOrEqual(600);
      }
    }
  });
});

describe('fit with padding', () => {
  it('keeps planes inside the free region below the toolbar and above the help bar', () => {
    const planes: [number, number, number][] = [[100, 70, 0], [100, 70, 60]];
    const cam = fitCamera({ yaw: 30, elevation: ELEVATION_DEG, zoom: 1, panX: 0, panY: 0 }, planes, 700, 700, 0.9, { top: 80, bottom: 40 });
    for (const [pw, ph, y] of planes) {
      const b = planeBounds(cam, pw, ph, y, 350, 350);
      expect(b.minY).toBeGreaterThanOrEqual(80); expect(b.maxY).toBeLessThanOrEqual(660);
    }
  });
});
