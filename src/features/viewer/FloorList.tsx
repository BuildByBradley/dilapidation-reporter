import { useState } from 'react';
import { Thumb } from '../../components/Thumb';
import * as repo from '../../data/repo';
import { useToast } from '../../components/ui';
import type { Floor, ViewerMode } from '../../lib/types';

export function FloorList({ floors, counts, mode, readOnly, onSelect, onImport, onOverview, projectId }: {
  floors: Floor[]; counts: Record<string, number>; mode: ViewerMode; readOnly: boolean;
  onSelect(id: string): void; onImport(id: string): void; onOverview(): void; projectId: string;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const currentId = 'floorId' in mode ? mode.floorId : null;
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
                <span className="muted small">{f.planAssetId ? `${counts[f.id] ?? 0} finding${(counts[f.id] ?? 0) === 1 ? '' : 's'}` : 'No plan'}</span>
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
                  {!(counts[f.id] ?? 0) && floors.length > 1 && (
                    <button className="danger" disabled={readOnly} aria-label={`Remove ${f.name}`}
                      onClick={() => { if (window.confirm(`Remove "${f.name}"${f.planAssetId ? ' and its plan' : ''}?`)) void guard(repo.deleteFloor(f.id)); }}>Remove</button>
                  )}
                </>
              )}
            </div>
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
      <p className="small muted">Names are labels only. Display width aligns the stack visually — it is display calibration, not survey data.</p>
      {currentId && <button onClick={onOverview}>Return to building</button>}
    </nav>
  );
}
