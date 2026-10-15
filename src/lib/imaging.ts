import { exifOrientation, sniffDimensions } from './orientation';
import { LIMITS } from './types';
import type { ProcessedImage } from '../data/repo';

export class ImportError extends Error {}
export const CANCELLED = 'Cancelled';
export type Progress = (fraction: number, label: string) => void;
type Opts = { signal?: AbortSignal; onProgress?: Progress };

const check = (s?: AbortSignal) => { if (s?.aborted) throw new ImportError(CANCELLED); };
const mb = (n: number) => Math.round(n / 1024 / 1024);

export function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
export const canvasToBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new ImportError('Could not encode image (out of memory?)'))), type, q));

/** Draw any source scaled so its long edge <= maxEdge (never upscales), flattening onto white if asked. */
export function scaled(src: CanvasImageSource, sw: number, sh: number, maxEdge: number, flatten: boolean): HTMLCanvasElement {
  const k = Math.min(1, maxEdge / Math.max(sw, sh));
  const c = newCanvas(sw * k, sh * k);
  const ctx = c.getContext('2d');
  if (!ctx) throw new ImportError('Canvas is unavailable in this browser.');
  if (flatten) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Decode with the browser's EXIF orientation applied (default `from-image`), so width/height are upright. */
export async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob); } catch {
    throw new ImportError('This image could not be decoded. It may be corrupt, or in a format this browser cannot read (HEIC is not supported — export as JPEG or PNG).');
  }
}

async function validateRaster(file: Blob, name: string, maxBytes: number, kind: 'plan' | 'photo') {
  if (file.size === 0) throw new ImportError(`"${name}" is empty.`);
  if (file.size > maxBytes) throw new ImportError(`"${name}" is ${mb(file.size)} MB; the limit is ${mb(maxBytes)} MB.`);
  const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const info = sniffDimensions(head);
  if (!info) {
    const heic = /\.(heic|heif)$/i.test(name) || /heic|heif/.test(file.type);
    throw new ImportError(heic
      ? `"${name}" is HEIC/HEIF, which is not supported. Export it as JPEG or PNG first.`
      : `"${name}" is not a supported ${kind === 'plan' ? 'plan' : 'photo'} file. Use PNG or JPEG${kind === 'plan' ? ' (or PDF for plans)' : ''}.`);
  }
  if ((info.width * info.height) / 1e6 > LIMITS.maxPlanMegapixels) {
    throw new ImportError(`"${name}" is ${(info.width * info.height / 1e6).toFixed(1)} megapixels; the limit is ${LIMITS.maxPlanMegapixels}.`);
  }
  return { mime: info.mime, orientation: info.mime === 'image/jpeg' ? exifOrientation(head) : 1 };
}

export async function processPlanRaster(file: Blob, filename: string, o: Opts = {}): Promise<ProcessedImage> {
  o.onProgress?.(0.05, 'Checking file');
  const { mime, orientation } = await validateRaster(file, filename, LIMITS.maxPlanBytes, 'plan');
  check(o.signal);
  const bmp = await decodeBitmap(file);
  try {
    check(o.signal); o.onProgress?.(0.4, 'Creating viewer image');
    return await derive(bmp, bmp.width, bmp.height, file, mime, filename, orientation, undefined, o);
  } finally { bmp.close(); }
}
export async function processPlanCanvas(canvas: HTMLCanvasElement, sourceFile: Blob, filename: string, page: number, o: Opts = {}): Promise<ProcessedImage> {
  return derive(canvas, canvas.width, canvas.height, sourceFile, sourceFile.type || 'application/pdf', filename, 1, page, o);
}
async function derive(src: CanvasImageSource, w: number, h: number, original: Blob, mime: string, filename: string, orientation: number, page: number | undefined, o: Opts): Promise<ProcessedImage> {
  const report = scaled(src, w, h, LIMITS.planReportEdge, true);
  check(o.signal); o.onProgress?.(0.6, 'Encoding report image');
  const reportBlob = await canvasToBlob(report, 'image/png');
  const display = report.width > LIMITS.planViewerEdge ? scaled(report, report.width, report.height, LIMITS.planViewerEdge, true) : report;
  check(o.signal);
  const displayBlob = display === report ? reportBlob : await canvasToBlob(display, 'image/png');
  const thumb = await canvasToBlob(scaled(report, report.width, report.height, LIMITS.thumbEdge, true), 'image/jpeg', 0.8);
  check(o.signal); o.onProgress?.(1, 'Done');
  return {
    filename, mime, width: report.width, height: report.height, original, display: displayBlob, report: reportBlob, thumbnail: thumb,
    sourcePage: page, orientation,
  };
}

export async function processPhoto(file: Blob, filename: string, o: Opts = {}): Promise<ProcessedImage> {
  o.onProgress?.(0.05, 'Checking photo');
  const { mime, orientation } = await validateRaster(file, filename, LIMITS.maxPhotoBytes, 'photo');
  check(o.signal);
  const bmp = await decodeBitmap(file);
  try {
    o.onProgress?.(0.4, 'Processing');
    // re-encoding through a canvas drops EXIF/GPS from the derivatives
    const disp = scaled(bmp, bmp.width, bmp.height, LIMITS.photoReportEdge, true);
    const display = await canvasToBlob(disp, 'image/jpeg', 0.85);
    check(o.signal);
    const thumbnail = await canvasToBlob(scaled(disp, disp.width, disp.height, LIMITS.thumbEdge, true), 'image/jpeg', 0.8);
    o.onProgress?.(1, 'Done');
    return { filename, mime, width: disp.width, height: disp.height, original: file, display, thumbnail, orientation };
  } finally { bmp.close(); }
}

declare global { interface Window { claude?: { use?: (name: string) => Promise<unknown> } } }

/** True when running inside a locked-down host frame (e.g. a hosted preview) that has no window.print() and no direct downloads. */
export const inHostFrame = () => typeof window !== 'undefined' && typeof window.claude?.use === 'function';

/** Save a generated file. Uses the host's confirmed-download capability when present, otherwise a normal download link. */
export async function downloadBlob(blob: Blob, filename: string): Promise<void> {
  if (inHostFrame()) {
    try {
      const dl = (await window.claude!.use!('downloads')) as { save(r: { filename: string; data: Blob }): Promise<unknown> } | null;
      if (dl) { await dl.save({ filename, data: blob }); return; }
    } catch (e) {
      if ((e as { code?: string })?.code === 'declined') return;
      throw new Error(`The file could not be saved here (${(e as { message?: string })?.message ?? 'unavailable'}).`);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
