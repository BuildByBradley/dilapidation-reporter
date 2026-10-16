import { ImportError, newCanvas, CANCELLED } from './imaging';
import { LIMITS } from './types';

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;
let libPromise: Promise<typeof import('pdfjs-dist')> | null = null;
async function lib() {
  if (!libPromise) {
    libPromise = (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
  }
  return libPromise;
}

export type LoadedPdf = {
  numPages: number;
  renderPage(page: number, maxEdge: number, signal?: AbortSignal): Promise<HTMLCanvasElement>;
  destroy(): void;
};

export async function loadPdf(file: Blob, name: string): Promise<LoadedPdf> {
  const pdfjs = await lib();
  let doc: PdfDoc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    const msg = (e as { name?: string })?.name === 'PasswordException' ? 'is password-protected' : 'is not a valid PDF or is corrupt';
    throw new ImportError(`"${name}" ${msg}.`);
  }
  return {
    numPages: doc.numPages,
    async renderPage(page, maxEdge, signal) {
      if (page < 1 || page > doc.numPages) throw new ImportError(`Page ${page} does not exist.`);
      const p = await doc.getPage(page);
      const v1 = p.getViewport({ scale: 1 });
      // As large as asked, but within the canvas area mobile browsers allow (vector line work stays crisp).
      const scale = Math.min(maxEdge / Math.max(v1.width, v1.height), Math.sqrt(LIMITS.maxCanvasPixels / (v1.width * v1.height)));
      const vp = p.getViewport({ scale });
      const canvas = newCanvas(vp.width, vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new ImportError('Canvas is unavailable in this browser.');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const task = p.render({ canvasContext: ctx, viewport: vp });
      signal?.addEventListener('abort', () => task.cancel(), { once: true });
      try { await task.promise; } catch (e) {
        if (signal?.aborted) throw new ImportError(CANCELLED);
        throw new ImportError(`Page ${page} could not be rendered (${(e as Error).message}).`);
      }
      p.cleanup();
      return canvas;
    },
    destroy() { void doc.destroy(); },
  };
}
