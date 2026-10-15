import { useEffect, useState } from 'react';
import { SEVERITIES, type Category, type Severity } from '../../lib/types';

export type NewFindingForm = { title: string; categoryId: string; severity: Severity; description: string; locationNotes: string };
export const emptyForm = (categoryId = ''): NewFindingForm => ({ title: '', categoryId, severity: 'not_assessed', description: '', locationNotes: '' });

export function PlacementPanel({ mode, reference, floorName, u, v, assetWidth, assetHeight, categories, form, setForm, onNudge, onConfirm, onCancel, busy }: {
  mode: 'new' | 'relocate'; reference?: string; floorName: string; u: number; v: number; assetWidth: number; assetHeight: number;
  categories: Category[]; form: NewFindingForm; setForm(f: NewFindingForm): void;
  onNudge(dxPx: number, dyPx: number): void; onConfirm(): void; onCancel(): void; busy: boolean;
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

  return (
    <section className="editor placement" aria-label={mode === 'new' ? 'New finding' : `Relocate ${reference}`} data-testid="placement-panel" onKeyDown={onKey}>
      <h2>{mode === 'new' ? 'New finding' : `Relocate ${reference}`}</h2>
      <p className="muted small">{floorName} · position u {u.toFixed(4)}, v {v.toFixed(4)} · ≈ pixel {Math.round(u * assetWidth)}, {Math.round(v * assetHeight)} of {assetWidth}×{assetHeight}</p>
      <div className="nudge" role="group" aria-label="Fine adjust pin position">
        <button aria-label="Nudge up" onClick={() => onNudge(0, -step)}>↑</button>
        <button aria-label="Nudge left" onClick={() => onNudge(-step, 0)}>←</button>
        <button aria-label="Nudge right" onClick={() => onNudge(step, 0)}>→</button>
        <button aria-label="Nudge down" onClick={() => onNudge(0, step)}>↓</button>
        <label className="small"><input type="checkbox" checked={big} onChange={(e) => setBig(e.target.checked)} /> 10 px steps (Shift+arrow also)</label>
      </div>
      <p className="small muted">Arrows move the target in the plan’s own directions (up = toward the top of the drawing). Tap the plan again to move the proposal.</p>
      {mode === 'new' && (
        <>
          <label>Title *<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus /></label>
          <div className="two">
            <label>Category *<select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
              <option value="">Choose…</option>{active.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
            <label>Severity<select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as Severity })}>
              {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
          </div>
          <label>Description<textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>Location notes<textarea rows={2} value={form.locationNotes} onChange={(e) => setForm({ ...form, locationNotes: e.target.value })} /></label>
        </>
      )}
      <div className="row">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!canSave || busy} onClick={onConfirm}>{mode === 'new' ? 'Save finding' : 'Confirm new location'}</button>
      </div>
      {mode === 'new' && <p className="small muted">Photos can be added right after the finding is saved.</p>}
    </section>
  );
}
