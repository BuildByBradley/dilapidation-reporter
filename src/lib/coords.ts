/** Normalised plan coordinates: (0,0) top-left, (1,1) bottom-right of the orientation-corrected plan. */
export type UV = { u: number; v: number };
export type Vec2 = { x: number; y: number };

export const isValidUv = (u: number, v: number) =>
  Number.isFinite(u) && Number.isFinite(v) && u >= 0 && u <= 1 && v >= 0 && v <= 1;

/** Floor-plane local coordinates (x right, z down-plan) for a plane of size W x H. */
export function uvToLocal(u: number, v: number, W: number, H: number) {
  return { x: (u - 0.5) * W, z: (v - 0.5) * H };
}
export function localToUv(x: number, z: number, W: number, H: number): UV {
  return { u: x / W + 0.5, v: z / H + 0.5 };
}

/** Plane size from display width and image aspect ratio. */
export function planeSize(displayWidth: number, imgW: number, imgH: number) {
  return { W: displayWidth, H: (displayWidth * imgH) / imgW };
}

export const ELEVATION_DEG = 35.264;
export const TOPDOWN_DEG = 90;

export type Camera = {
  yaw: number; // degrees, wrapped to [0,360)
  elevation: number; // degrees above horizontal; fixed per mode
  zoom: number; // CSS pixels per world unit
  panX: number; // CSS px offset of world origin from canvas centre
  panY: number;
};

const rad = (d: number) => (d * Math.PI) / 180;

/** Orthographic projection of a world point to canvas CSS pixels (origin = canvas centre + pan). */
export function project(cam: Camera, x: number, y: number, z: number, cx: number, cy: number): Vec2 {
  const t = rad(cam.yaw), e = rad(cam.elevation);
  const a = x * Math.cos(t) + z * Math.sin(t);
  const b = -x * Math.sin(t) + z * Math.cos(t);
  return {
    x: cx + cam.panX + cam.zoom * a,
    y: cy + cam.panY + cam.zoom * (b * Math.sin(e) - y * Math.cos(e)),
  };
}

/** Inverse: canvas pixel -> point on the horizontal plane at height y. */
export function unproject(cam: Camera, sx: number, sy: number, y: number, cx: number, cy: number) {
  const t = rad(cam.yaw), e = rad(cam.elevation);
  const a = (sx - cx - cam.panX) / cam.zoom;
  const b = ((sy - cy - cam.panY) / cam.zoom + y * Math.cos(e)) / Math.sin(e);
  return { x: a * Math.cos(t) - b * Math.sin(t), z: a * Math.sin(t) + b * Math.cos(t) };
}

/** Affine matrix mapping image pixel (px,py) of an imgW x imgH plan on a plane at height y to canvas px. */
export function planeMatrix(cam: Camera, W: number, H: number, y: number, imgW: number, imgH: number, cx: number, cy: number) {
  const p = (px: number, py: number) => {
    const l = uvToLocal(px / imgW, py / imgH, W, H);
    return project(cam, l.x, y, l.z, cx, cy);
  };
  const o = p(0, 0), ex = p(imgW, 0), ey = p(0, imgH);
  return { a: (ex.x - o.x) / imgW, b: (ex.y - o.y) / imgW, c: (ey.x - o.x) / imgH, d: (ey.y - o.y) / imgH, e: o.x, f: o.y };
}

/** Screen position -> uv on a floor; null if outside plan bounds (never clamped). */
export function screenToUv(cam: Camera, sx: number, sy: number, W: number, H: number, y: number, cx: number, cy: number): UV | null {
  const l = unproject(cam, sx, sy, y, cx, cy);
  const uv = localToUv(l.x, l.z, W, H);
  const E = 1e-9; // float tolerance only; genuine out-of-bounds hits are rejected, never snapped
  if (uv.u < -E || uv.u > 1 + E || uv.v < -E || uv.v > 1 + E) return null;
  return { u: Math.min(1, Math.max(0, uv.u)), v: Math.min(1, Math.max(0, uv.v)) };
}
export function uvToScreen(cam: Camera, u: number, v: number, W: number, H: number, y: number, cx: number, cy: number): Vec2 {
  const l = uvToLocal(u, v, W, H);
  return project(cam, l.x, y, l.z, cx, cy);
}

export const ZOOM_MIN_FACTOR = 0.25;
export const ZOOM_MAX_FACTOR = 16;
export const YAW_PER_PX = 0.3;
export const wrapYaw = (d: number) => ((d % 360) + 360) % 360;

/** Zoom about a canvas point, clamped to [min,max] x fitted zoom. */
export function zoomAbout(cam: Camera, factor: number, fitZoom: number, sx: number, sy: number, cx: number, cy: number): Camera {
  const next = Math.min(fitZoom * ZOOM_MAX_FACTOR, Math.max(fitZoom * ZOOM_MIN_FACTOR, cam.zoom * factor));
  const k = next / cam.zoom;
  const dx = sx - cx - cam.panX, dy = sy - cy - cam.panY;
  return { ...cam, zoom: next, panX: cam.panX + dx * (1 - k), panY: cam.panY + dy * (1 - k) };
}

/** Screen-space bounding box of the plane corners. */
export function planeBounds(cam: Camera, W: number, H: number, y: number, cx: number, cy: number) {
  const pts = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => project(cam, u * W, y, v * H, cx, cy));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Camera that fits a set of planes (given as [W,H,y]) into the canvas with a margin, keeping yaw/elevation. */
export function fitCamera(base: Camera, planes: [number, number, number][], cw: number, ch: number, margin = 0.9, pad: { top: number; bottom: number } = { top: 0, bottom: 0 }): Camera {
  const unit: Camera = { ...base, zoom: 1, panX: 0, panY: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [W, H, y] of planes) {
    const b = planeBounds(unit, W, H, y, 0, 0);
    minX = Math.min(minX, b.minX); maxX = Math.max(maxX, b.maxX);
    minY = Math.min(minY, b.minY); maxY = Math.max(maxY, b.maxY);
  }
  const w = Math.max(1e-6, maxX - minX), h = Math.max(1e-6, maxY - minY);
  const avail = Math.max(50, ch - pad.top - pad.bottom);
  const zoom = Math.min((cw * margin) / w, (avail * margin) / h);
  // centre the content in the free region (between the toolbar and the help bar), relative to the canvas centre
  const shiftY = pad.top + avail / 2 - ch / 2;
  return { ...base, zoom, panX: -zoom * (minX + maxX) / 2, panY: shiftY - zoom * (minY + maxY) / 2 };
}

/** Camera operations. Note there is deliberately no way to change elevation. */
export const rotateYaw = (cam: Camera, deltaDeg: number): Camera => ({ ...cam, yaw: wrapYaw(cam.yaw + deltaDeg) });
export const panBy = (cam: Camera, dx: number, dy: number): Camera => ({ ...cam, panX: cam.panX + dx, panY: cam.panY + dy });
