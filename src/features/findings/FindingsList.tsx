import { useMemo, useRef, useState } from 'react';
import { severityLabel, SEVERITIES, type Category, type Finding, type Floor } from '../../lib/types';

export function FindingsList({ findings, floors, categories, selectedId, onSelect }: {
  findings: Finding[]; floors: Floor[]; categories: Category[]; selectedId: string | null; onSelect(id: string): void;
}) {
  const [floor, setFloor] = useState(''), [cat, setCat] = useState(''), [sev, setSev] = useState(''), [q, setQ] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const floorMap = useMemo(() => new Map(floors.map((f) => [f.id, f])), [floors]);
  const shown = findings.filter((f) =>
    (!floor || f.floorId === floor) && (!cat || f.categoryId === cat) && (!sev || f.severity === sev) &&
    (!q || `${f.reference} ${f.title} ${f.description} ${f.locationNotes}`.toLowerCase().includes(q.toLowerCase())));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button.finding-row') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  };

  return (
    <section className="findings" aria-label="Findings">
      <h2>Findings <span className="muted small">({shown.length}{shown.length !== findings.length ? ` of ${findings.length}` : ''})</span></h2>
      <div className="filters">
        <input type="search" placeholder="Search findings" aria-label="Search findings" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by floor" value={floor} onChange={(e) => setFloor(e.target.value)}><option value="">All floors</option>{floors.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select>
        <select aria-label="Filter by category" value={cat} onChange={(e) => setCat(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archived)' : ''}</option>)}</select>
        <select aria-label="Filter by severity" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">All severities</option>{SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</select>
      </div>
      {findings.length === 0 && <p className="muted">No findings yet. Isolate a floor, choose <strong>Add pin</strong> and tap the plan.</p>}
      {findings.length > 0 && shown.length === 0 && <p className="muted">No findings match these filters.</p>}
      <ul ref={listRef} onKeyDown={onKey} className="finding-list">
        {shown.map((f) => (
          <li key={f.id}>
            <button className={`finding-row${f.id === selectedId ? ' selected' : ''}`} aria-pressed={f.id === selectedId} onClick={() => onSelect(f.id)} data-testid="finding-row">
              <span className="swatch" style={{ background: catMap.get(f.categoryId)?.colour }} aria-hidden="true" />
              <span className="finding-text">
                <span><strong>{f.reference}</strong> {f.title}</span>
                <span className="muted small">{floorMap.get(f.floorId)?.name} · {catMap.get(f.categoryId)?.name} · {severityLabel(f.severity)}{f.locationNeedsReview ? ' · ⚠ location needs review' : ''}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
