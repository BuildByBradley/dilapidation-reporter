import { useEffect, useRef, useState } from 'react';
import { Dialog, useObjectUrl, useToast } from '../../components/ui';
import * as repo from '../../data/repo';
import { CANCELLED, ImportError, canvasToBlob, processPlanCanvas, processPlanRaster, scaled } from '../../lib/imaging';
import { loadPdf, type LoadedPdf } from '../../lib/pdf';
import { LIMITS, type Floor } from '../../lib/types';

type Entry = {
  id: number; file: File; kind: 'image' | 'pdf'; pdf?: LoadedPdf; page: number; floorId: string;
  preview?: Blob; status: 'ready' | 'working' | 'done' | 'error'; error?: string; progress?: string; mode?: repo.ReplaceMode;
};
let counter = 0;

function Preview({ blob, alt }: { blob?: Blob; alt: string }) {
  const url = useObjectUrl(blob);
  return url ? <img className="import-preview" src={url} alt={alt} /> : <div className="import-preview placeholder" aria-label="Preview loading" />;
}

function PdfPages({ entry, onPick }: { entry: Entry; onPick: (page: number) => void }) {
  const [thumbs, setThumbs] = useState<Record<number, Blob>>({});
  const n = Math.min(entry.pdf!.numPages, LIMITS.pdfPreviewPageLimit);
  useEffect(() => {
    let live = true;
    (async () => {
      for (let i = 1; i <= n; i++) {
        try {
          const c = await entry.pdf!.renderPage(i, 220);
          const b = await canvasToBlob(c, 'image/jpeg', 0.7);
          if (!live) return;
          setThumbs((t) => ({ ...t, [i]: b }));
        } catch { /* a bad page just has no thumbnail */ }
      }
    })();
    return () => { live = false; };
  }, [entry.pdf, n]);
  return (
    <div className="pdf-pages" role="radiogroup" aria-label={`Pages of ${entry.file.name}`}>
      {Array.from({ length: n }, (_, i) => i + 1).map((i) => (
        <button key={i} role="radio" aria-checked={entry.page === i} className={entry.page === i ? 'sel' : ''} onClick={() => onPick(i)}>
          <Preview blob={thumbs[i]} alt={`Page ${i}`} /><span>Page {i}</span>
        </button>
      ))}
      {entry.pdf!.numPages > n && <p className="small muted">Showing the first {n} of {entry.pdf!.numPages} pages.</p>}
    </div>
  );
}

export function ImportDialog({ floors, startFloorId, findingCounts, onClose }: { floors: Floor[]; startFloorId: string; findingCounts: Record<string, number>; onClose: () => void }) {
  const toast = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const update = (id: number, patch: Partial<Entry>) => setEntries((es) => es.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  useEffect(() => () => { abort.current?.abort(); }, []);
  useEffect(() => () => { for (const e of entries) if (!entries.some((x) => x !== e && x.pdf === e.pdf)) e.pdf?.destroy(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nextFloorId = (taken: string[], preferred?: string) => {
    if (preferred && !taken.includes(preferred)) return preferred;
    return (floors.find((f) => !taken.includes(f.id) && !f.planAssetId) ?? floors.find((f) => !taken.includes(f.id)) ?? floors[0]).id;
  };

  async function addFiles(list: FileList | File[]) {
    setMessage(null);
    const taken = entries.map((e) => e.floorId);
    const added: Entry[] = [];
    for (const file of Array.from(list)) {
      try {
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (file.size > LIMITS.maxPlanBytes) throw new ImportError(`"${file.name}" is ${Math.round(file.size / 1048576)} MB; the limit is ${LIMITS.maxPlanBytes / 1048576} MB.`);
        const floorId = nextFloorId([...taken, ...added.map((a) => a.floorId)], added.length === 0 && entries.length === 0 ? startFloorId : undefined);
        if (isPdf) {
          const pdf = await loadPdf(file, file.name);
          added.push({ id: ++counter, file, kind: 'pdf', pdf, page: 1, floorId, status: 'ready' });
        } else {
          if (!/^image\/(png|jpeg)$/.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
            throw new ImportError(/\.(heic|heif)$/i.test(file.name) ? `"${file.name}" is HEIC/HEIF, which is not supported. Export it as JPEG or PNG.` : `"${file.name}" is not supported. Use PNG, JPEG or PDF.`);
          }
          const bmp = await createImageBitmap(file).catch(() => { throw new ImportError(`"${file.name}" could not be read — it may be corrupt.`); });
          const prev = await canvasToBlob(scaled(bmp, bmp.width, bmp.height, 320, true), 'image/jpeg', 0.75);
          bmp.close();
          added.push({ id: ++counter, file, kind: 'image', page: 1, floorId, status: 'ready', preview: prev });
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
      }
    }
    setEntries((es) => [...es, ...added]);
  }
  // PDF page previews for the selected page
  useEffect(() => {
    for (const e of entries) {
      if (e.kind !== 'pdf' || !e.pdf) continue;
      const pg = e.page;
      e.pdf.renderPage(pg, 320).then((c) => canvasToBlob(c, 'image/jpeg', 0.75)).then((b) => {
        setEntries((es) => es.map((x) => (x.id === e.id && x.page === pg ? { ...x, preview: b } : x)));
      }).catch(() => {});
    }
  }, [entries.map((e) => `${e.id}:${e.page}`).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const floorHasPlan = (id: string) => !!floors.find((f) => f.id === id)?.planAssetId;
  const needsChoice = (e: Entry) => floorHasPlan(e.floorId) && (findingCounts[e.floorId] ?? 0) > 0 && !e.mode;
  const dupFloors = new Set(entries.map((e) => e.floorId).filter((id, i, a) => a.indexOf(id) !== i));
  const canRun = entries.length > 0 && !busy && entries.every((e) => e.status !== 'working') && dupFloors.size === 0 && !entries.some(needsChoice) && entries.some((e) => e.status !== 'done');

  async function run() {
    setBusy(true); setMessage(null);
    const ac = new AbortController(); abort.current = ac;
    let ok = 0;
    for (const e of entries) {
      if (e.status === 'done') continue;
      if (ac.signal.aborted) break;
      update(e.id, { status: 'working', error: undefined, progress: 'Starting…' });
      try {
        const onProgress = (_f: number, label: string) => update(e.id, { progress: label });
        let processed: repo.ProcessedImage;
        if (e.kind === 'pdf') {
          onProgress(0.1, `Rendering page ${e.page}`);
          const canvas = await e.pdf!.renderPage(e.page, LIMITS.planReportEdge, ac.signal);
          processed = await processPlanCanvas(canvas, e.file, e.file.name, e.page, { signal: ac.signal, onProgress });
        } else processed = await processPlanRaster(e.file, e.file.name, { signal: ac.signal, onProgress });
        if (ac.signal.aborted) throw new ImportError(CANCELLED);
        onProgress(1, 'Saving');
        await repo.setFloorPlan(e.floorId, processed, e.mode ?? 'keep');
        update(e.id, { status: 'done', progress: 'Imported' }); ok++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        update(e.id, { status: 'error', error: msg === CANCELLED ? 'Cancelled — the existing plan was left unchanged.' : `${msg} The existing plan and findings were left unchanged.` });
      }
    }
    abort.current = null;
    setBusy(false);
    if (ok) toast('ok', `${ok} plan${ok === 1 ? '' : 's'} imported`);
    if (ok && ok === entries.length) onClose();
  }

  return (
    <Dialog title="Import floor plans" wide onClose={() => { abort.current?.abort(); onClose(); }} dismissible={!busy}
      footer={<>
        {busy ? <button onClick={() => abort.current?.abort()}>Cancel import</button> : <button onClick={onClose}>Close</button>}
        <button className="primary" disabled={!canRun} onClick={run}>Import {entries.length > 1 ? `${entries.length} plans` : 'plan'}</button>
      </>}>
      <p className="muted">PNG, JPEG or PDF (one page per floor). Up to {LIMITS.maxPlanBytes / 1048576} MB and {LIMITS.maxPlanMegapixels} megapixels per file. PDF pages are rendered at high resolution for crisp line work. Drawings are stored in this browser (and in your cloud account when signed in); no scale is inferred.</p>
      <div className="toolbar-row">
        <button onClick={() => fileRef.current?.click()} disabled={busy}>Choose files…</button>
        <input ref={fileRef} type="file" multiple hidden aria-label="Plan files" accept="image/png,image/jpeg,application/pdf,.png,.jpg,.jpeg,.pdf"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      </div>
      {message && <p className="error" role="alert">{message}</p>}
      <ul className="import-queue">
        {entries.map((e) => (
          <li key={e.id} className={`import-item ${e.status}`} data-testid="import-item">
            <Preview blob={e.preview} alt={`Preview of ${e.file.name}${e.kind === 'pdf' ? ` page ${e.page}` : ''}`} />
            <div className="import-info">
              <strong>{e.file.name}{e.kind === 'pdf' ? ` — page ${e.page} of ${e.pdf!.numPages}` : ''}</strong>
              <label>Assign to floor
                <select value={e.floorId} disabled={busy || e.status === 'done'} onChange={(ev) => update(e.id, { floorId: ev.target.value, mode: undefined })}>
                  {floors.map((f) => <option key={f.id} value={f.id}>{f.name}{f.planAssetId ? ' (replaces current plan)' : ''}</option>)}
                </select>
              </label>
              {dupFloors.has(e.floorId) && <p className="error small">Two files target this floor — each floor takes one plan.</p>}
              {e.kind === 'pdf' && e.pdf!.numPages > 1 && e.status !== 'done' && <PdfPages entry={e} onPick={(pg) => update(e.id, { page: pg, preview: undefined })} />}
              {e.kind === 'pdf' && e.status !== 'done' && !busy && (
                <button className="link" onClick={() => setEntries((es) => [...es, { ...e, id: ++counter, floorId: nextFloorId(es.map((x) => x.floorId)), status: 'ready', mode: undefined, error: undefined }])}>
                  Use another page of this PDF for a different floor
                </button>
              )}
              {floorHasPlan(e.floorId) && (findingCounts[e.floorId] ?? 0) > 0 && e.status !== 'done' && (
                <fieldset className="warn" disabled={busy}>
                  <legend>This floor has {findingCounts[e.floorId]} finding(s). A different drawing can invalidate pin locations.</legend>
                  <label><input type="radio" name={`mode-${e.id}`} checked={e.mode === 'keep'} onChange={() => update(e.id, { mode: 'keep' })} /> Replace and keep pin positions for manual review</label>
                  <label><input type="radio" name={`mode-${e.id}`} checked={e.mode === 'remove'} onChange={() => update(e.id, { mode: 'remove' })} /> Replace and <strong>remove this floor&apos;s findings</strong> and their photos</label>
                </fieldset>
              )}
              {e.progress && e.status === 'working' && <p className="small" role="status">{e.progress}</p>}
              {e.status === 'done' && <p className="small ok">Imported</p>}
              {e.error && <p className="error small" role="alert">{e.error}</p>}
            </div>
            {!busy && e.status !== 'done' && <button className="icon-btn" aria-label={`Remove ${e.file.name} from queue`} onClick={() => setEntries((es) => es.filter((x) => x.id !== e.id))}>×</button>}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
