import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../../app/App';
import { SaveIndicator } from '../../components/SaveIndicator';
import { Confirm, Dialog, useToast } from '../../components/ui';
import { db } from '../../data/db';
import { flushAll } from '../../data/flush';
import { acquireProjectLock, locksSupported, type LockHandle } from '../../data/projectLock';
import * as repo from '../../data/repo';
import type { UV } from '../../lib/coords';
import { createBackup } from '../../lib/backup';
import { downloadBlob } from '../../lib/imaging';
import { useLive } from '../../lib/useLive';
import type { Asset, Category, Finding, Floor, InteractionMode, Photo, ViewerMode } from '../../lib/types';
import { CategoriesDialog } from '../categories/CategoriesDialog';
import { FindingEditor } from '../findings/FindingEditor';
import { FindingsList } from '../findings/FindingsList';
import { PlacementPanel, emptyForm, type NewFindingForm } from '../findings/PlacementPanel';
import { ImportDialog } from '../imports/ImportDialog';
import { FloorList } from './FloorList';
import { ViewerPane } from './ViewerPane';
import type { Draft } from './engine';

type LockState = 'pending' | 'held' | 'readonly';

export function Workspace({ projectId }: { projectId: string }) {
  const toast = useToast();
  const [project, projectReady] = useLive(() => db.projects.get(projectId), [projectId], undefined);
  const [floors] = useLive(() => repo.listFloors(projectId), [projectId], [] as Floor[]);
  const [findings] = useLive(() => repo.listFindings(projectId), [projectId], [] as Finding[]);
  const [categories] = useLive(() => repo.listCategories(projectId), [projectId], [] as Category[]);
  const [photos] = useLive(() => db.photos.where('projectId').equals(projectId).sortBy('order'), [projectId], [] as Photo[]);
  const [assets] = useLive(() => db.assets.where('projectId').equals(projectId).toArray(), [projectId], [] as Asset[]);

  const [viewer, setViewer] = useState<ViewerMode>({ kind: 'overview3d' });
  const [interaction, setInteraction] = useState<InteractionMode>({ kind: 'navigate' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [form, setForm] = useState<NewFindingForm>(emptyForm());
  const [importFor, setImportFor] = useState<string | null>(null);
  const [showCats, setShowCats] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discard, setDiscard] = useState<null | (() => void)>(null);
  const [lock, setLock] = useState<LockState>('pending');
  const lockRef = useRef<LockHandle | null>(null);
  const lastCategory = useRef('');

  const readOnly = lock === 'readonly';
  useEffect(() => {
    let cancelled = false;
    const attempt = async () => {
      const h = await acquireProjectLock(projectId);
      if (cancelled) { h?.release(); return; }
      lockRef.current = h; setLock(h ? 'held' : 'readonly');
    };
    void attempt();
    return () => { cancelled = true; lockRef.current?.release(); lockRef.current = null; };
  }, [projectId]);
  const retryLock = async () => {
    const h = await acquireProjectLock(projectId);
    if (h) { lockRef.current = h; setLock('held'); } else toast('error', 'The project is still open for editing in another tab.');
  };

  const floorMap = useMemo(() => new Map(floors.map((f) => [f.id, f])), [floors]);
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const counts = useMemo(() => findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.floorId]: (m[f.floorId] ?? 0) + 1 }), {}), [findings]);
  const selected = findings.find((f) => f.id === selectedId) ?? null;
  const placing = interaction.kind !== 'navigate';
  const formDirty = interaction.kind === 'placePin' && !!(form.title || form.description || form.locationNotes);
  const currentFloorId = 'floorId' in viewer ? viewer.floorId : null;

  // clear the selection only when a finding we have seen disappears (a just-created one may not be in the live list yet)
  const seenIds = useRef(new Set<string>());
  useEffect(() => {
    if (selectedId && seenIds.current.has(selectedId) && !findings.some((f) => f.id === selectedId)) setSelectedId(null);
    findings.forEach((f) => seenIds.current.add(f.id));
  }, [findings, selectedId]);
  // if the displayed floor loses its plan or is removed, return to overview
  useEffect(() => {
    if (currentFloorId && floors.length && !floorMap.get(currentFloorId)?.planAssetId) setViewer({ kind: 'overview3d' });
  }, [floors, currentFloorId, floorMap]);

  const cancelPlacement = useCallback(() => { setInteraction({ kind: 'navigate' }); setDraft(null); setForm(emptyForm(lastCategory.current)); }, []);
  const guardDiscard = (proceed: () => void) => { if (formDirty && draft) setDiscard(() => proceed); else proceed(); };

  const selectFloor = (id: string) => {
    const f = floorMap.get(id);
    if (!f) return;
    if (!f.planAssetId) { setImportFor(id); return; }
    guardDiscard(() => {
      cancelPlacement();
      setViewer((v) => ({ kind: v.kind === 'floor2d' ? 'floor2d' : 'isolated3d', floorId: id }));
      setSelectedId((s) => (s && findings.find((x) => x.id === s)?.floorId === id ? s : null));
    });
  };
  const toOverview = () => guardDiscard(() => { cancelPlacement(); setViewer({ kind: 'overview3d' }); setSelectedId(null); });
  const toggle2D = () => {
    if (viewer.kind === 'overview3d') { toast('info', 'Select a floor first, then switch to 2D.'); return; }
    setViewer(viewer.kind === 'floor2d' ? { kind: 'isolated3d', floorId: viewer.floorId } : { kind: 'floor2d', floorId: viewer.floorId });
  };
  const selectFinding = (id: string) => {
    const f = findings.find((x) => x.id === id);
    if (!f) return;
    const go2 = () => {
      cancelPlacement();
      setSelectedId(id); setPanelOpen(true);
      if (currentFloorId !== f.floorId) setViewer({ kind: viewer.kind === 'floor2d' ? 'floor2d' : 'isolated3d', floorId: f.floorId });
    };
    if (currentFloorId !== f.floorId) guardDiscard(go2); else go2();
  };
  const togglePlace = () => {
    if (readOnly || viewer.kind === 'overview3d') return;
    if (placing) { guardDiscard(cancelPlacement); return; }
    setSelectedId(null); setInteraction({ kind: 'placePin' }); setDraft(null); setForm(emptyForm(lastCategory.current)); setPanelOpen(true);
  };
  const startRelocate = (id: string) => {
    const f = findings.find((x) => x.id === id);
    if (!f || readOnly) return;
    if (currentFloorId !== f.floorId) setViewer({ kind: viewer.kind === 'floor2d' ? 'floor2d' : 'isolated3d', floorId: f.floorId });
    setInteraction({ kind: 'relocatePin', findingId: id }); setDraft({ floorId: f.floorId, u: f.u, v: f.v, relocating: true }); setPanelOpen(true);
  };
  const onPlace = (floorId: string, uv: UV) => setDraft({ floorId, u: uv.u, v: uv.v, relocating: interaction.kind === 'relocatePin' });
  const onEscape = () => { if (placing) guardDiscard(cancelPlacement); };

  const draftAsset = draft ? assetMap.get(floorMap.get(draft.floorId)?.planAssetId ?? '') : undefined;
  const nudge = (dx: number, dy: number) => {
    if (!draft || !draftAsset) return;
    setDraft({ ...draft, u: Math.min(1, Math.max(0, draft.u + dx / draftAsset.width)), v: Math.min(1, Math.max(0, draft.v + dy / draftAsset.height)) });
  };
  const confirmPlacement = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (interaction.kind === 'relocatePin') {
        await repo.relocateFinding(interaction.findingId, draft.u, draft.v);
        setSelectedId(interaction.findingId);
        toast('ok', 'Pin relocated');
      } else {
        const f = await repo.createFinding({ floorId: draft.floorId, u: draft.u, v: draft.v, categoryId: form.categoryId, title: form.title, severity: form.severity, description: form.description, locationNotes: form.locationNotes });
        lastCategory.current = form.categoryId;
        setSelectedId(f.id);
        toast('ok', `${f.reference} saved — add photos below`);
      }
      setInteraction({ kind: 'navigate' }); setDraft(null); setForm(emptyForm(lastCategory.current));
    } catch (e) {
      toast('error', `Not saved: ${e instanceof Error ? e.message : String(e)} Your entries are still here — try again.`);
    } finally { setSaving(false); }
  };

  const leave = async () => { await flushAll(); go('/'); };
  const openReport = async () => { await flushAll(); go(`/p/${projectId}/report`); };
  const backup = async () => {
    try { await flushAll(); downloadBlob(new Blob([new Uint8Array(await createBackup(await repo.loadBundle(projectId)))], { type: 'application/zip' }), `${(project?.name ?? 'project').replace(/[^\w.-]+/g, '_')}-backup.zip`); }
    catch (e) { toast('error', e instanceof Error ? e.message : String(e)); }
  };

  if (!project) return <div className="page"><header className="topbar"><a href="#/">← Projects</a></header><main className="content">{projectReady ? <p>This project was not found. It may have been deleted. <a href="#/">Back to projects</a></p> : <p role="status">Loading…</p>}</main></div>;

  const placementFloor = draft ? floorMap.get(draft.floorId) : undefined;
  const relocFinding = interaction.kind === 'relocatePin' ? findings.find((f) => f.id === interaction.findingId) : undefined;
  const reviewCount = findings.filter((f) => f.locationNeedsReview).length;

  return (
    <div className="page workspace">
      <header className="topbar">
        <button className="link" onClick={leave} aria-label="Back to projects">← Projects</button>
        <h1 title={project.name}>{project.name}</h1>
        <SaveIndicator />
        <span className="spacer" />
        <button onClick={toggle2D} aria-pressed={viewer.kind === 'floor2d'}>{viewer.kind === 'floor2d' ? '3D view' : '2D view'}</button>
        <button className="primary" onClick={openReport}>Report</button>
        <div className="menu">
          <button aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Project ▾</button>
          {menuOpen && (
            <div className="menu-list" role="menu" onClick={() => setMenuOpen(false)}>
              <button role="menuitem" onClick={() => setShowDetails(true)}>Project details</button>
              <button role="menuitem" onClick={() => setShowCats(true)}>Categories</button>
              <button role="menuitem" onClick={backup}>Back up project</button>
              <button role="menuitem" onClick={() => repo.duplicateProject(projectId).then(() => toast('ok', 'Project duplicated')).catch((e) => toast('error', String(e)))}>Duplicate project</button>
            </div>
          )}
        </div>
      </header>
      {readOnly && (
        <div className="banner warn" role="alert" data-testid="readonly-banner">
          This project is open for editing in another tab or window, so this tab is <strong>read-only</strong> to avoid overwriting changes. <button onClick={retryLock}>Try again</button>
        </div>
      )}
      {!locksSupported() && <div className="banner warn small">This browser cannot prevent the same project being edited in two tabs. Keep it open in one tab only.</div>}
      {reviewCount > 0 && <div className="banner warn small" data-testid="review-banner">⚠ {reviewCount} finding{reviewCount === 1 ? ' needs' : 's need'} a location review after a plan replacement. They are flagged in the list and in the report.</div>}

      <div className={`ws-body${panelOpen ? '' : ' panel-closed'}`}>
        <aside className="ws-left">
          <FloorList floors={floors} counts={counts} mode={viewer} readOnly={readOnly} onSelect={selectFloor} onImport={setImportFor} onOverview={toOverview} />
        </aside>
        <main className="ws-main">
          <ViewerPane
            floors={floors} findings={findings} categories={categories} mode={viewer} interaction={interaction} selectedId={selectedId} draft={draft} readOnly={readOnly}
            onFloorPick={selectFloor} onSelect={selectFinding} onPlace={onPlace} onEscape={onEscape} onReturn={toOverview} onToggle2D={toggle2D} onTogglePlace={togglePlace}
            onNotice={(t) => toast('info', t)}
          />
        </main>
        <aside className="ws-right" aria-label="Findings panel">
          <button className="sheet-toggle" aria-expanded={panelOpen} onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? 'Hide panel ▼' : `Findings (${findings.length}) ▲`}</button>
          {panelOpen && (
            <div className="ws-right-scroll">
              {draft && placementFloor && draftAsset ? (
                <PlacementPanel
                  mode={interaction.kind === 'relocatePin' ? 'relocate' : 'new'} reference={relocFinding?.reference} floorName={placementFloor.name}
                  u={draft.u} v={draft.v} assetWidth={draftAsset.width} assetHeight={draftAsset.height} categories={categories} form={form} setForm={setForm}
                  onNudge={nudge} onConfirm={confirmPlacement} onCancel={() => guardDiscard(cancelPlacement)} busy={saving}
                />
              ) : placing ? (
                <section className="editor"><h2>{interaction.kind === 'relocatePin' ? 'Relocate pin' : 'Add pin'}</h2><p>Tap the plan where the condition is. A target and magnifier will appear so you can fine-tune before saving.</p>
                  {formDirty && <p className="small">Draft entries are kept until you cancel.</p>}<button onClick={() => guardDiscard(cancelPlacement)}>Cancel</button></section>
              ) : selected ? (
                <FindingEditor key={selected.id} finding={selected} categories={categories} floors={floors} photos={photos.filter((p) => p.findingId === selected.id)} readOnly={readOnly}
                  onRelocate={() => startRelocate(selected.id)} onDeleted={() => setSelectedId(null)} onClose={() => setSelectedId(null)} />
              ) : null}
              <FindingsList findings={findings} floors={floors} categories={categories} selectedId={selectedId} onSelect={selectFinding} />
            </div>
          )}
        </aside>
      </div>
      <div className="sr-only" aria-live="polite" data-testid="sr-selection">
        {selected ? `Selected ${selected.reference}: ${selected.title}. ${floorMap.get(selected.floorId)?.name}. ${categories.find((c) => c.id === selected.categoryId)?.name}. Severity ${selected.severity.replace('_', ' ')}.` : ''}
      </div>

      {importFor && <ImportDialog floors={floors} startFloorId={importFor} findingCounts={counts} onClose={() => setImportFor(null)} />}
      {showCats && <CategoriesDialog projectId={projectId} onClose={() => setShowCats(false)} />}
      {showDetails && <ProjectDetails project={project} onClose={() => setShowDetails(false)} readOnly={readOnly} />}
      {discard && (
        <Confirm title="Discard the pin you are placing?" confirmLabel="Discard" danger onCancel={() => setDiscard(null)} onConfirm={() => { const d = discard; setDiscard(null); d(); }}>
          <p>You have drafted finding details that have not been saved. Discarding removes them.</p>
        </Confirm>
      )}
    </div>
  );
}

function ProjectDetails({ project, onClose, readOnly }: { project: ProjectT; onClose: () => void; readOnly: boolean }) {
  const toast = useToast();
  const [d, setD] = useState({ name: project.name, siteName: project.siteName, address: project.address, client: project.client, inspector: project.inspector, inspectionDate: project.inspectionDate, reference: project.reference, notes: project.notes });
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <Dialog title="Project details" onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={readOnly} onClick={async () => { try { await repo.updateProject(project.id, d); onClose(); } catch (e) { toast('error', String(e)); } }}>Save</button></>}>
      <div className="form-grid">
        <label>Project name<input value={d.name} onChange={set('name')} /></label>
        <label>Property / site<input value={d.siteName} onChange={set('siteName')} /></label>
        <label className="span2">Address<input value={d.address} onChange={set('address')} /></label>
        <label>Client<input value={d.client} onChange={set('client')} /></label>
        <label>Inspector<input value={d.inspector} onChange={set('inspector')} /></label>
        <label>Inspection date<input type="date" value={d.inspectionDate} onChange={set('inspectionDate')} /></label>
        <label>Reference<input value={d.reference} onChange={set('reference')} /></label>
        <label className="span2">Notes<textarea rows={3} value={d.notes} onChange={set('notes')} /></label>
      </div>
    </Dialog>
  );
}
type ProjectT = import('../../lib/types').Project;
