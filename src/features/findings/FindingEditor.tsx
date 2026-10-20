import { useCallback, useEffect, useRef, useState } from 'react';
import { PhotoSection } from '../photos/PhotoSection';
import { Confirm, Dialog, useToast } from '../../components/ui';
import { registerFlush } from '../../data/flush';
import * as repo from '../../data/repo';
import { NEW_CATEGORY, promptNewCategory } from '../categories/newCategory';
import { SEVERITIES, type Category, type Finding, type Floor, type Photo, type Severity } from '../../lib/types';

type Fields = { title: string; description: string; locationNotes: string; severity: Severity; categoryId: string };
const pick = (f: Finding): Fields => ({ title: f.title, description: f.description, locationNotes: f.locationNotes, severity: f.severity, categoryId: f.categoryId });

export function FindingEditor({ finding, categories, floors, photos, readOnly, onRelocate, onDeleted, onClose }: {
  finding: Finding; categories: Category[]; floors: Floor[]; photos: Photo[]; readOnly: boolean;
  onRelocate(): void; onDeleted(): void; onClose(): void;
}) {
  const toast = useToast();
  const [copying, setCopying] = useState(false);
  const [f, setF] = useState<Fields>(pick(finding));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const latest = useRef({ f, dirty, id: finding.id, base: pick(finding) });
  latest.current = { f, dirty, id: finding.id, base: pick(finding) };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // reset when switching findings; adopt external changes only when not mid-edit
  useEffect(() => { setF(pick(finding)); setDirty(false); setError(null); }, [finding.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!latest.current.dirty) setF(pick(finding)); }, [finding.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const { f: cur, dirty: d, id, base } = latest.current;
    if (!d) return;
    const patch: repo.FindingPatch = {};
    (Object.keys(cur) as (keyof Fields)[]).forEach((k) => { if (cur[k] !== base[k]) (patch as Record<string, unknown>)[k] = cur[k]; });
    if (!Object.keys(patch).length) { setDirty(false); return; }
    try {
      await repo.updateFinding(id, patch);
      setError(null);
      if (latest.current.id === id && JSON.stringify(latest.current.f) === JSON.stringify(cur)) setDirty(false);
    } catch (e) {
      // keep the unsaved content on screen so it can be retried
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => registerFlush(save), [save]);
  useEffect(() => () => { void save(); }, [finding.id, save]);

  const change = (patch: Partial<Fields>, immediate = false) => {
    setF((p) => ({ ...p, ...patch })); setDirty(true);
    latest.current = { ...latest.current, f: { ...latest.current.f, ...patch }, dirty: true };
    clearTimeout(timer.current);
    if (immediate) void save(); else timer.current = setTimeout(() => void save(), 500);
  };
  const floor = floors.find((x) => x.id === finding.floorId);
  const selectable = categories.filter((c) => !c.archived || c.id === f.categoryId);

  return (
    <section className="editor" aria-label={`Finding ${finding.reference}`} data-testid="finding-editor">
      <header className="editor-head">
        <h2>{finding.reference}</h2><span className="muted small">{floor?.name}</span>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close finding editor" onClick={() => { void save(); onClose(); }}>×</button>
      </header>
      {finding.locationNeedsReview && (
        <div className="warn-box" role="alert" data-testid="review-warning">
          <strong>Location needs review.</strong> The floor plan was replaced after this pin was placed, so its position may no longer match the drawing.
          <div className="row"><button disabled={readOnly} onClick={onRelocate}>Relocate pin</button><button disabled={readOnly} onClick={() => repo.clearLocationReview(finding.id).catch((e) => toast('error', String(e)))}>Mark location as reviewed</button></div>
        </div>
      )}
      <label>Title<input value={f.title} disabled={readOnly} onChange={(e) => change({ title: e.target.value })} /></label>
      <div className="two">
        <label>Category<select value={f.categoryId} disabled={readOnly} onChange={async (e) => {
          if (e.target.value !== NEW_CATEGORY) { change({ categoryId: e.target.value }, true); return; }
          try { const id = await promptNewCategory(finding.projectId); if (id) change({ categoryId: id }, true); } catch (err) { toast('error', err instanceof Error ? err.message : String(err)); }
        }}>
          {selectable.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archived)' : ''}</option>)}
          <option value={NEW_CATEGORY}>+ New category…</option>
        </select></label>
        <label>Severity<select value={f.severity} disabled={readOnly} onChange={(e) => change({ severity: e.target.value as Severity }, true)}>
          {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select></label>
      </div>
      <p className="small muted">Severity is an observation label for this record, not a safety determination.</p>
      <label>Description<textarea rows={4} value={f.description} disabled={readOnly} onChange={(e) => change({ description: e.target.value })} /></label>
      <label>Location notes<textarea rows={2} value={f.locationNotes} disabled={readOnly} onChange={(e) => change({ locationNotes: e.target.value })} /></label>
      {error && <div className="error" role="alert">Not saved: {error} <button onClick={() => void save()}>Retry save</button></div>}
      {dirty && !error && <p className="small muted" aria-live="polite">Unsaved changes…</p>}
      <PhotoSection findingId={finding.id} photos={photos} readOnly={readOnly} />
      <div className="row">
        <button disabled={readOnly} onClick={onRelocate}>Relocate pin</button>
        <button disabled={readOnly} onClick={async () => { await save(); setCopying(true); }}>Copy to floor…</button>
        <button className="danger" disabled={readOnly} onClick={() => setConfirmDelete(true)}>Delete finding</button>
      </div>
      {copying && <CopyToFloorsDialog finding={finding} floors={floors} photoCount={photos.length} onClose={() => setCopying(false)} />}
      {confirmDelete && (
        <Confirm title="Delete finding?" danger confirmLabel="Delete finding" onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { setConfirmDelete(false); try { await repo.deleteFinding(finding.id); onDeleted(); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); } }}>
          <p>Delete <strong>{finding.reference} — {finding.title}</strong> and its {photos.length} photo(s)? The reference number is not reused. This cannot be undone.</p>
        </Confirm>
      )}
    </section>
  );
}

/** Pick floors to copy a finding to (same plan position, details and photos). */
function CopyToFloorsDialog({ finding, floors, photoCount, onClose }: { finding: Finding; floors: Floor[]; photoCount: number; onClose(): void }) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const others = floors.filter((f) => f.id !== finding.floorId);
  const run = async () => {
    setBusy(true);
    try {
      const ids = others.filter((f) => picked.has(f.id)).map((f) => f.id); // in floor order
      const copies = await repo.copyFindingToFloors(finding.id, ids);
      const name = new Map(floors.map((f) => [f.id, f.name]));
      toast('ok', `Copied to ${copies.map((c) => `${name.get(c.floorId)} (${c.reference})`).join(', ')}`);
      onClose();
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title={`Copy ${finding.reference} to other floors`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={!picked.size || busy} onClick={run}>{busy ? 'Copying…' : `Copy to ${picked.size || ''} floor${picked.size === 1 ? '' : 's'}`.replace('  ', ' ')}</button></>}>
      <p className="small">Each copy gets the same position on the plan, title, category, severity, description, location notes and {photoCount} photo{photoCount === 1 ? '' : 's'}, and the next number on its floor.</p>
      <ul className="copy-floors">
        {others.map((f) => (
          <li key={f.id}><label className="inline"><input type="checkbox" checked={picked.has(f.id)} disabled={!f.planAssetId} onChange={() => toggle(f.id)} />
            <span>{f.name}{!f.planAssetId && <span className="muted small"> — no plan yet</span>}</span></label></li>
        ))}
      </ul>
      {others.length > 1 && <button type="button" className="link" onClick={() => setPicked(new Set(others.filter((f) => f.planAssetId).map((f) => f.id)))}>Select all floors</button>}
      <p className="small muted">The position is the same spot on each floor’s drawing, so it lines up when the plans share a layout. Use Relocate pin on a copy if it needs moving.</p>
    </Dialog>
  );
}
