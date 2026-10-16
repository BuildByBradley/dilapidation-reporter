import { useEffect, useRef, useState, type Ref } from 'react';
import { useObjectUrl, useToast } from '../../components/ui';
import type { ProcessedImage } from '../../data/repo';
import { ImportError, processPhoto } from '../../lib/imaging';
import { SEVERITIES, type Category, type Severity } from '../../lib/types';
import { CameraDialog } from '../photos/PhotoSection';
import { PhotoMarkup } from '../photos/PhotoMarkup';
import { Dialog } from '../../components/ui';

export type NewFindingForm = { title: string; categoryId: string; severity: Severity; description: string; locationNotes: string };
export const emptyForm = (categoryId = ''): NewFindingForm => ({ title: '', categoryId, severity: 'not_assessed', description: '', locationNotes: '' });

/**
 * Placing or relocating a pin, as three steps in one panel:
 *   1. Position — magnified target and a direction pad (no keyboard yet).
 *   2. Details — title, category, severity, notes.
 *   3. Photos — taken or uploaded now, attached when the finding is saved.
 * On a phone it fills the screen (`compact`); "Show plan" collapses it so the plan can be tapped again.
 */
export function PlacementPanel({ mode, reference, floorName, u, v, assetWidth, assetHeight, categories, form, setForm, onNudge, onConfirm, onCancel, busy,
  compact = false, magnifierRef, onShowPlan, pendingPhotos, setPendingPhotos }: {
  mode: 'new' | 'relocate'; reference?: string; floorName: string; u: number; v: number; assetWidth: number; assetHeight: number;
  categories: Category[]; form: NewFindingForm; setForm(f: NewFindingForm): void;
  onNudge(dxPx: number, dyPx: number): void; onConfirm(): void; onCancel(): void; busy: boolean;
  compact?: boolean; magnifierRef?: Ref<HTMLCanvasElement>; onShowPlan?(): void;
  pendingPhotos: ProcessedImage[]; setPendingPhotos(p: ProcessedImage[]): void;
}) {
  const [big, setBig] = useState(false);
  const step = big ? 10 : 1;
  const active = categories.filter((c) => !c.archived);
  useEffect(() => { /* keep form category valid when categories change */
    if (mode === 'new' && form.categoryId && !active.some((c) => c.id === form.categoryId)) setForm({ ...form, categoryId: '' });
  }, [categories]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSave = mode === 'relocate' || (form.title.trim() && form.categoryId);

  const onKey = (e: React.KeyboardEvent) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || (e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'SELECT') return;
    e.preventDefault();
    const k = e.shiftKey ? 10 : step;
    onNudge(d[0] * k, d[1] * k);
  };
  const stepNo = (n: number) => <span className="step-no" aria-hidden="true">{n}</span>;

  return (
    <section className={`editor placement${compact ? ' placement-compact' : ''}`} aria-label={mode === 'new' ? 'New finding' : `Relocate ${reference}`} data-testid="placement-panel" onKeyDown={onKey}>
      {!compact && <h2>{mode === 'new' ? 'New finding' : `Relocate ${reference}`}</h2>}

      <div className="place-step" aria-label="Position">
        <h3>{stepNo(1)}Position the pin</h3>
        <div className="position-row">
          {compact && magnifierRef && (
            <div className="sheet-magnifier">
              <canvas ref={magnifierRef} width={220} height={220} aria-label="Magnified view of the pin location" />
            </div>
          )}
          <div className="dpad" role="group" aria-label="Fine adjust pin position">
            <button className="up" aria-label="Nudge up" onClick={() => onNudge(0, -step)}>↑</button>
            <button className="left" aria-label="Nudge left" onClick={() => onNudge(-step, 0)}>←</button>
            <button className="right" aria-label="Nudge right" onClick={() => onNudge(step, 0)}>→</button>
            <button className="down" aria-label="Nudge down" onClick={() => onNudge(0, step)}>↓</button>
          </div>
        </div>
        <div className="row small">
          <label className="inline"><input type="checkbox" checked={big} onChange={(e) => setBig(e.target.checked)} /> Bigger steps (10 px)</label>
          {compact && onShowPlan && <button onClick={onShowPlan}>Show plan to re-tap</button>}
        </div>
        <p className="small muted">{floorName} · ≈ pixel {Math.round(u * assetWidth)}, {Math.round(v * assetHeight)} of {assetWidth}×{assetHeight}
          {!compact && <> · u {u.toFixed(4)}, v {v.toFixed(4)}. Arrows move the target in the plan’s own directions; tap the plan again to move the proposal.</>}</p>
      </div>

      {mode === 'new' && (
        <>
          <div className="place-step" aria-label="Details">
            <h3>{stepNo(2)}Details</h3>
            <label>Title *<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus={!compact} enterKeyHint="done" /></label>
            <div className="two">
              <label>Category *<select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
                <option value="">Choose…</option>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
              <label>Severity<select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
                {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select></label>
            </div>
            <label>Description<textarea rows={compact ? 2 : 3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <label>Location notes<textarea rows={2} value={form.locationNotes} onChange={(e) => setForm({ ...form, locationNotes: e.target.value })} /></label>
          </div>
          <PendingPhotos photos={pendingPhotos} setPhotos={setPendingPhotos} stepNo={stepNo(3)} />
        </>
      )}

      <div className={`row place-actions${compact ? ' sticky' : ''}`}>
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!canSave || busy} onClick={onConfirm}>
          {mode === 'new' ? (pendingPhotos.length ? `Save finding + ${pendingPhotos.length} photo${pendingPhotos.length === 1 ? '' : 's'}` : 'Save finding') : 'Confirm new location'}
        </button>
      </div>
    </section>
  );
}

function PendingPhotos({ photos, setPhotos, stepNo }: { photos: ProcessedImage[]; setPhotos(p: ProcessedImage[]): void; stepNo: React.ReactNode }) {
  const toast = useToast();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<number | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const latest = useRef(photos);
  latest.current = photos;

  async function addFiles(files: File[]) {
    for (const f of files) {
      setBusy(`Processing ${f.name}…`);
      try {
        const img = await processPhoto(f, f.name || 'photo.jpg', { onProgress: (_p, l) => setBusy(`${f.name}: ${l}`) });
        latest.current = [...latest.current, img];
        setPhotos(latest.current);
      } catch (e) {
        toast('error', e instanceof ImportError ? e.message : `Could not use "${f.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
  }

  return (
    <div className="place-step" aria-label="Photos">
      <h3>{stepNo}Photos <span className="muted small">(optional)</span></h3>
      <div className="row">
        <button onClick={() => setCameraOpen(true)}>Take photo</button>
        <button onClick={() => uploadRef.current?.click()}>Upload photos</button>
        <input ref={uploadRef} hidden type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png,.heic,.heif" aria-label="Upload photos" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <input ref={captureRef} hidden type="file" accept="image/*" capture="environment" aria-label="Device camera capture" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      </div>
      {busy && <p className="small" role="status">{busy}</p>}
      {photos.length > 0 && (
        <ul className="pending-photos" data-testid="pending-photos">
          {photos.map((p, i) => <PendingThumb key={i} img={p} index={i} onRemove={() => setPhotos(photos.filter((_, j) => j !== i))} onDraw={() => setDrawing(i)} />)}
        </ul>
      )}
      {drawing !== null && photos[drawing] && (
        <Dialog title="Draw on photo" wide onClose={() => setDrawing(null)}>
          <PhotoMarkup src={photos[drawing].original} onCancel={() => setDrawing(null)} onDone={async (b) => {
            const i = drawing;
            setDrawing(null);
            if (b === photos[i].original) return;
            try {
              const img = await processPhoto(b, photos[i].filename);
              latest.current = latest.current.map((x, j) => (j === i ? img : x));
              setPhotos(latest.current);
            } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
          }} />
        </Dialog>
      )}
      {cameraOpen && <CameraDialog onClose={() => setCameraOpen(false)} onFallback={() => captureRef.current?.click()}
        onAccept={async (blob) => { await addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })]); }} />}
    </div>
  );
}

function PendingThumb({ img, index, onRemove, onDraw }: { img: ProcessedImage; index: number; onRemove(): void; onDraw(): void }) {
  const url = useObjectUrl(img.thumbnail);
  return (
    <li>
      {url && <img src={url} alt={`New photo ${index + 1}`} />}
      <button className="remove" aria-label={`Remove new photo ${index + 1}`} onClick={onRemove}>×</button>
      <button className="draw" aria-label={`Draw on new photo ${index + 1}`} onClick={onDraw}>✎</button>
    </li>
  );
}
