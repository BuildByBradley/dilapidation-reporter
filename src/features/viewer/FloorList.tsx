import { useState } from 'react';
import { Thumb } from '../../components/Thumb';
import * as repo from '../../data/repo';
import { useToast } from '../../components/ui';
import type { Floor, ViewerMode } from '../../lib/types';

/**
 * One remove button that works in steps, each with its own confirmation:
 * pins on the floor → "Remove pins"; then a plan → "Remove plan"; then an empty floor → "Remove floor".
 */
function RemoveStep({ floor: f, findings: n, isLast, readOnly, guard }: {
  floor: Floor; findings: number; isLast: boolean; readOnly: boolean; guard(p: Promise<unknown>): void;
}) {
  const toast = useToast();
  const s = n === 1 ? '' : 's';
  const step = n > 0 ? {
    label: 'Remove pins',
    confirm: `Are you sure you want to remove all ${n} pin${s} from "${f.name}"?\n\nThe ${n} finding${s} and their photos will be deleted. The floor plan stays. This cannot be undone.`,
    run: () => repo.removeFloorFindings(f.id).then(() => toast('ok', `Pins removed from ${f.name}`)),
  } : f.planAssetId ? {
    label: 'Remove plan',
    confirm: `Are you sure you want to remove the plan from "${f.name}"?\n\nThe floor stays, so you can import a new plan later.`,
    run: () => repo.removeFloorPlan(f.id).then(() => toast('ok', `Plan removed from ${f.name}`)),
  } : isLast ? null : {
    label: 'Remove floor',
    confirm: `Are you sure you want to remove the floor "${f.name}"?`,
    run: () => repo.deleteFloor(f.id).then(() => toast('ok', `${f.name} removed`)),
  };
  if (!step) return null;
  return (
    <button className="danger" disabled={readOnly} aria-label={`${step.label}: ${f.name}`}
      onClick={() => { if (window.confirm(step.confirm)) guard(step.run()); }}>{step.label}</button>
  );
}

export function FloorList({ floors, counts, mode, readOnly, onSelect, onImport, onOverview, projectId }: {
  floors: Floor[]; counts: Record<string, number>; mode: ViewerMode; readOnly: boolean;
  onSelect(id: string): void; onImport(id: string): void; onOverview(): void; projectId: string;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const currentId = 'floorId' in mode ? mode.floorId : null;
  const codes = repo.floorCodes(floors);
  const guard = (p: Promise<unknown>) => p.catch((e) => toast('error', e instanceof Error ? e.message : String(e)));
  return (
    <nav className="floor-list" aria-label="Floors">
      <h2>Floors</h2>
      <ol>
        {floors.map((f, i) => (
          <li key={f.id} className={f.id === currentId ? 'current' : ''} data-testid="floor-slot">
            <button className="floor-main" onClick={() => onSelect(f.id)} aria-current={f.id === currentId ? 'true' : undefined}
              aria-label={f.planAssetId ? `${f.name}, ${counts[f.id] ?? 0} findings. Isolate floor` : `${f.name}, empty. Import a plan`}>
              {f.planAssetId ? <Thumb assetId={f.planAssetId} alt="" className="floor-thumb" /> : <span className="floor-thumb empty">+</span>}
              <span className="floor-text">
                <span className="floor-name">{f.name}</span>
                <span className="muted small">{f.planAssetId ? `${counts[f.id] ?? 0} finding${(counts[f.id] ?? 0) === 1 ? '' : 's'}` : 'No plan'}{f.excludeFromReport ? ' · not in report' : ''}</span>
              </span>
            </button>
            <div className="floor-actions">
              {editing === f.id ? (
                <form onSubmit={(e) => { e.preventDefault(); setEditing(null); void guard(repo.updateFloor(f.id, { name })); }}>
                  <input aria-label="Floor name" value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={() => { setEditing(null); void guard(repo.updateFloor(f.id, { name })); }} />
                </form>
              ) : (
                <>
                  <button disabled={readOnly} onClick={() => onImport(f.id)}>{f.planAssetId ? 'Replace' : 'Import'}</button>
                  <button disabled={readOnly} aria-label={`Rename ${f.name}`} onClick={() => { setEditing(f.id); setName(f.name); }}>Rename</button>
                  <button disabled={readOnly || i === 0} aria-label={`Move ${f.name} up`} onClick={() => guard(repo.moveFloor(f.id, -1))}>↑</button>
                  <button disabled={readOnly || i === floors.length - 1} aria-label={`Move ${f.name} down`} onClick={() => guard(repo.moveFloor(f.id, 1))}>↓</button>
                  <RemoveStep floor={f} findings={counts[f.id] ?? 0} isLast={floors.length === 1} readOnly={readOnly} guard={guard} />
                </>
              )}
            </div>
            <label className="in-report small" title="Untick to leave this floor and all its findings out of the report">
              <input type="checkbox" key={`${f.id}:${!!f.excludeFromReport}`} defaultChecked={!f.excludeFromReport} disabled={readOnly} aria-label={`Include ${f.name} in report`}
                onChange={(e) => void guard(repo.updateFloor(f.id, { excludeFromReport: !e.target.checked }))} />
              Include in report
            </label>
            <label className="display-width small muted" title="Finding numbers on this floor start with this, e.g. G-001, L1-001, Roof-001">Number prefix
              <input key={`${f.id}:${f.code ?? ''}`} defaultValue={f.code ?? ''} placeholder={codes.get(f.id)} maxLength={6} disabled={readOnly} aria-label={`${f.name} number prefix`}
                onBlur={(e) => { if (e.target.value !== (f.code ?? '')) void guard(repo.updateFloor(f.id, { code: e.target.value })); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </label>
            {f.planAssetId && (
              <label className="display-width small muted">Display width
                <input type="number" min={20} max={400} step={5} value={f.displayWidth} disabled={readOnly} aria-label={`${f.name} display width`}
                  onChange={(e) => void guard(repo.updateFloor(f.id, { displayWidth: Number(e.target.value) }))} />
              </label>
            )}
          </li>
        ))}
      </ol>
      <button className="add-floor" disabled={readOnly} onClick={() => guard(repo.addFloor(projectId).then((f) => toast('ok', `${f.name} added — import its plan`)))}>+ Add floor</button>
      <p className="small muted">Findings are numbered per floor with its prefix (G-001, L1-001…). Names are labels only. Display width aligns the stack visually — it is display calibration, not survey data.</p>
      {currentId && <button onClick={onOverview}>Return to building</button>}
    </nav>
  );
}
