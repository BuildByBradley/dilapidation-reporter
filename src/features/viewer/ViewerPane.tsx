import { useEffect, useMemo, useRef, useState } from 'react';
import { ViewerEngine, type Draft, type ViewFloor, type ViewPin } from './engine';
import { usePlanBitmaps } from './usePlanBitmaps';
import { useVectorDetail } from './useVectorDetail';
import type { Category, Finding, Floor, InteractionMode, ViewerMode } from '../../lib/types';
import type { UV } from '../../lib/coords';

declare global { interface Window { __inspector?: { engine: ViewerEngine } } }

export type ViewerPaneProps = {
  floors: Floor[]; findings: Finding[]; categories: Category[];
  mode: ViewerMode; interaction: InteractionMode; selectedId: string | null; draft: Draft;
  readOnly: boolean;
  compact?: boolean;
  onFloorPick(id: string): void;
  onSelect(id: string): void;
  onPlace(floorId: string, uv: UV): void;
  onEscape(): void;
  onReturn(): void;
  onToggle2D(): void;
  onTogglePlace(): void;
  onNotice(text: string): void;
  /** Optional second magnifier (the phone placement sheet), drawn with a wider crop for context. */
  sheetMagnifier?: HTMLCanvasElement | null;
  /** Crop of the panel magnifier, in plan pixels. */
  magCrop?: number;
};

export function ViewerPane(p: ViewerPaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const magRef = useRef<HTMLCanvasElement>(null);
  const drawMags = () => {
    const d = cbs.current.draft;
    if (!d) return;
    if (magRef.current) engine.drawMagnifier(magRef.current, d.floorId, d.u, d.v);
    const sm = cbs.current.sheetMagnifier;
    if (sm) engine.drawMagnifier(sm, d.floorId, d.u, d.v, cbs.current.magCrop ?? 120);
  };
  const cbs = useRef(p);
  cbs.current = p;
  const [chooser, setChooser] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const [helpOpen, setHelpOpen] = useState(() => { try { return localStorage.getItem('gestureHelp') !== 'closed'; } catch { return true; } });
  const { bitmaps, errors } = usePlanBitmaps(p.floors);

  const engine = useMemo(() => new ViewerEngine({
    floorPick: (id) => cbs.current.onFloorPick(id),
    pinPick: (ids, x, y) => { if (ids.length === 1) cbs.current.onSelect(ids[0]); else setChooser({ ids, x, y }); },
    place: (floorId, uv) => cbs.current.onPlace(floorId, uv),
    placeRejected: () => cbs.current.onNotice('That point is outside the floor plan — tap inside the drawing.'),
    escape: () => cbs.current.onEscape(),
    change: () => {},
  }), []);

  // lifecycle
  useEffect(() => {
    const canvas = canvasRef.current!, wrap = wrapRef.current!;
    engine.attach(canvas);
    engine.setInsets(cbs.current.compact ? 48 : 64, cbs.current.compact ? 76 : 40, cbs.current.compact ? 44 : 0);
    window.__inspector = { engine };
    const measure = () => { const r = wrap.getBoundingClientRect(); engine.resize(Math.round(r.width), Math.round(r.height), window.devicePixelRatio || 1); };
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    let mq: MediaQueryList | null = null;
    const watchDpr = () => {
      mq?.removeEventListener('change', onDpr);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mq.addEventListener('change', onDpr);
    };
    const onDpr = () => { measure(); watchDpr(); };
    watchDpr(); measure();
    return () => { ro.disconnect(); mq?.removeEventListener('change', onDpr); engine.detach(); if (window.__inspector?.engine === engine) delete window.__inspector; };
  }, [engine]);

  const detail = useVectorDetail(engine, p.floors);

  // data -> engine
  const viewFloors: ViewFloor[] = useMemo(() => p.floors.map((f) => ({
    id: f.id, name: f.name, image: f.planAssetId && bitmaps.get(f.id)?.assetId === f.planAssetId ? bitmaps.get(f.id)!.bitmap : null,
    displayWidth: f.displayWidth, findingCount: p.findings.filter((x) => x.floorId === f.id).length,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [p.floors, p.findings, bitmaps.size, [...bitmaps.values()].map((b) => b.assetId).join()]);
  useEffect(() => { engine.setFloors(viewFloors); }, [engine, viewFloors]);
  // a replaced plan may have a different aspect ratio: forget saved navigation for it
  const planKey = p.floors.map((f) => `${f.id}:${f.planAssetId ?? ''}`).join('|');
  const prevPlans = useRef(planKey);
  useEffect(() => {
    if (prevPlans.current !== planKey) {
      const before = new Map(prevPlans.current.split('|').map((s) => s.split(':') as [string, string]));
      for (const f of p.floors) if (before.get(f.id) !== (f.planAssetId ?? '')) engine.resetNav(f.id);
      prevPlans.current = planKey;
    }
  }, [planKey, engine, p.floors]);
  useEffect(() => { engine.setInsets(p.compact ? 48 : 64, p.compact ? 76 : 40, p.compact ? 44 : 0); engine.fit(true); }, [engine, p.compact]);
  const catColour = useMemo(() => new Map(p.categories.map((c) => [c.id, c.colour])), [p.categories]);
  const pins: ViewPin[] = useMemo(() => p.findings.map((f) => ({ id: f.id, floorId: f.floorId, u: f.u, v: f.v, colour: catColour.get(f.categoryId) ?? '#555', reference: f.reference, needsReview: f.locationNeedsReview })), [p.findings, catColour]);
  useEffect(() => { engine.setPins(pins); }, [engine, pins]);
  useEffect(() => { engine.setSelectedPin(p.selectedId); }, [engine, p.selectedId]);
  useEffect(() => { engine.setInteraction(p.interaction); }, [engine, p.interaction]);
  useEffect(() => { engine.setDraft(p.draft); }, [engine, p.draft]);
  const modeKey = p.mode.kind + ('floorId' in p.mode ? p.mode.floorId : '');
  useEffect(() => { engine.setMode(p.mode); setChooser(null); }, [engine, modeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    drawMags();
  }, [engine, p.draft, viewFloors, p.sheetMagnifier, p.magCrop]); // eslint-disable-line react-hooks/exhaustive-deps
  // redraw when the sharp PDF tile arrives or the view changes, so the magnifier shows the sharpest source
  useEffect(() => engine.onView(() => drawMags()), [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  const modeFloorId = 'floorId' in p.mode ? p.mode.floorId : undefined;
  const floorName = modeFloorId ? p.floors.find((f) => f.id === modeFloorId)?.name : undefined;
  const importedCount = p.floors.filter((f) => f.planAssetId).length;
  const is2d = p.mode.kind === 'floor2d';
  const overview = p.mode.kind === 'overview3d';
  const placing = p.interaction.kind !== 'navigate';
  const errList = Object.values(errors);

  return (
    <div className="viewer" ref={wrapRef} data-testid="viewer">
      <canvas
        ref={canvasRef} className="viewer-canvas" tabIndex={0} data-testid="viewer-canvas"
        data-mode={p.mode.kind} data-placing={placing ? 'true' : 'false'}
        aria-label={overview ? 'Building overview: stacked floor plans. Tap a floor to isolate it. Drag horizontally to rotate, two fingers to pan and zoom.' : `${floorName ?? 'Floor'} plan, ${is2d ? '2D top-down' : '3D axonometric'} view. Arrow keys ${is2d ? 'pan' : 'rotate'}, plus and minus zoom, F fits.`}
      />
      {importedCount === 0 && <div className="viewer-empty"><p>No floor plans yet. Use <strong>Import</strong> on a floor to add a PNG, JPEG or PDF plan.</p></div>}
      {errList.length > 0 && <div className="viewer-error" role="alert">{errList[0]}</div>}
      {floorName && <div className="viewer-title">{floorName}<span className="muted small"> · {is2d ? '2D' : '3D'}</span>
        {detail.kind === 'sharp' && <span className="small detail-ok" data-testid="detail-status" title="Zoomed areas are re-drawn from the original PDF"> · PDF sharp</span>}
        {detail.kind === 'failed' && <span className="small detail-bad" data-testid="detail-status" title={detail.reason}> · ⚠ not sharp</span>}
      </div>}
      {detail.kind === 'failed' && <div className="viewer-note" role="status">Zoomed plan is not sharp on this device: {detail.reason}.</div>}
      {placing && <div className="viewer-banner" role="status">{p.interaction.kind === 'relocatePin' ? 'Relocating pin' : 'Add pin'}: tap the plan to propose a location, adjust, then confirm. Press Esc to cancel.</div>}

      <div className="viewer-tools" role="toolbar" aria-label="Viewer tools">
        {/* phones show the short labels so the whole bar fits the screen width; names stay the full words */}
        <button aria-label="Navigate" aria-pressed={!placing} onClick={() => placing && p.onTogglePlace()} title="Navigate"><span className="lbl-full">Navigate</span><span className="lbl-short">Move</span></button>
        <button aria-label="Add pin" aria-pressed={placing} disabled={overview || p.readOnly} onClick={p.onTogglePlace} title={overview ? 'Select a floor first' : 'Add a condition pin'}><span className="lbl-full">Add pin</span><span className="lbl-short">Pin</span></button>
        <button aria-label="Zoom in" onClick={() => engine.zoomBy(1.3)}>+</button>
        <button aria-label="Zoom out" onClick={() => engine.zoomBy(1 / 1.3)}>−</button>
        <button aria-label="Fit view" onClick={() => engine.fit()}><span className="lbl-full">Fit view</span><span className="lbl-short">Fit</span></button>
        <button aria-label="Return to building" onClick={p.onReturn} disabled={overview}><span className="lbl-full">Return to building</span><span className="lbl-short">Building</span></button>
        <button aria-label={is2d ? 'Show 3D' : '2D view'} onClick={p.onToggle2D} aria-pressed={is2d} title="Switch between 2D plan and 3D view"><span className="lbl-full">{is2d ? 'Show 3D' : '2D view'}</span><span className="lbl-short">{is2d ? '3D' : '2D'}</span></button>
      </div>

      <div className="gesture-help" data-testid="gesture-help">
        <button className="link" aria-expanded={helpOpen} onClick={() => { setHelpOpen(!helpOpen); try { localStorage.setItem('gestureHelp', helpOpen ? 'closed' : 'open'); } catch { /* ignore */ } }}>
          {helpOpen ? 'Hide help' : 'Gesture help'}
        </button>
        {helpOpen && (
          <span className="help-line">
            {is2d ? <><b>1 finger</b> pan</> : <><b>1 finger</b> drag sideways to rotate (angle locked)</>} · <b>2 fingers</b> pan &amp; pinch zoom · mouse: drag {is2d ? 'pans' : 'rotates'}, Shift-drag pans, wheel zooms
          </span>
        )}
      </div>

      {p.draft && !p.sheetMagnifier && (
        <div className="magnifier" aria-label="Magnified view of the proposed pin location">
          <canvas ref={magRef} width={140} height={140} />
          <span className="small">Target (4× zoom)</span>
        </div>
      )}
      {chooser && (
        <div className="chooser" role="dialog" aria-label="Choose finding" style={{ left: Math.min(chooser.x, (wrapRef.current?.clientWidth ?? 300) - 230), top: Math.min(chooser.y, (wrapRef.current?.clientHeight ?? 300) - 40 - chooser.ids.length * 40) }}>
          <p className="small">{chooser.ids.length} findings overlap here:</p>
          {chooser.ids.map((id) => {
            const f = p.findings.find((x) => x.id === id);
            return f && <button key={id} onClick={() => { setChooser(null); p.onSelect(id); }}>{f.reference} — {f.title}</button>;
          })}
          <button className="link" onClick={() => setChooser(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
