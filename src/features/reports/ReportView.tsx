import { useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../../app/App';
import { fmtTime } from '../../components/ui';
import { flushAll } from '../../data/flush';
import * as repo from '../../data/repo';
import { downloadBlob, inHostFrame } from '../../lib/imaging';
import { insetBlob, planSnapshotBlob } from '../../lib/planSnapshot';
import { buildCsv, buildReportModel, draftSummary, floorSeverityMatrix, keyFindings, SEVERITIES_DESC, type ReportFinding, type ReportModel } from '../../lib/report';
import { severityLabel, type Asset, type Project, type Severity } from '../../lib/types';
import { SaveIndicator } from '../../components/SaveIndicator';

type Status = { loaded: number; total: number; failed: string[] };

// Limit simultaneous blob reads so a 500-photo report does not decode everything at once.
let active = 0; const waiting: (() => void)[] = [];
const acquire = () => new Promise<void>((res) => { if (active < 4) { active++; res(); } else waiting.push(() => { active++; res(); }); });
const release = () => { active--; waiting.shift()?.(); };

function useBlobUrl(load: () => Promise<Blob | undefined>, key: string, onDone: (ok: boolean, key: string) => void) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true, made: string | undefined;
    (async () => {
      await acquire();
      try {
        const b = await load();
        if (!live) return;
        if (!b) throw new Error('missing');
        made = URL.createObjectURL(b); setUrl(made);
      } catch { onDone(false, key); } finally { release(); }
    })();
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return url;
}

function ReportImage({ id, load, alt, className, track }: { id: string; load: () => Promise<Blob | undefined>; alt: string; className?: string; track: (ok: boolean, key: string) => void }) {
  const url = useBlobUrl(load, id, track);
  if (!url) return <div className={`report-img-placeholder ${className ?? ''}`}>Loading image…</div>;
  return <img className={className} src={url} alt={alt} decoding="sync" onLoad={() => track(true, id)} onError={() => track(false, id)} />;
}

export function ReportView({ projectId }: { projectId: string }) {
  const [bundle, setBundle] = useState<repo.ProjectBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ loaded: 0, total: 0, failed: [] });
  const [snaps, setSnaps] = useState<Record<string, Blob>>({});
  const [insets, setInsets] = useState<Record<string, Blob>>({});
  const [fontsReady, setFontsReady] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    (async () => {
      try { await flushAll(); setBundle(await repo.loadBundle(projectId)); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
    if (document.fonts?.ready) void document.fonts.ready.then(() => setFontsReady(true)); else setFontsReady(true);
  }, [projectId]);

  const model: ReportModel | null = useMemo(() => (bundle ? buildReportModel(bundle) : null), [bundle]);
  const assets = useMemo(() => new Map<string, Asset>((bundle?.assets ?? []).map((a) => [a.id, a])), [bundle]);

  // plan snapshots + insets are generated from stored coordinates only
  useEffect(() => {
    if (!bundle || !model) return;
    let live = true;
    (async () => {
      const s: Record<string, Blob> = {}, ins: Record<string, Blob> = {};
      for (const f of model.floors) {
        if (!f.planAssetId) continue;
        const a = assets.get(f.planAssetId);
        const blob = a && bundle.blobs.get(a.reportBlobId ?? a.displayBlobId);
        if (!blob) { setStatus((st) => ({ ...st, failed: [...st.failed, `Plan image for ${f.name}`] })); continue; }
        const bmp = await createImageBitmap(blob);
        try {
          s[f.id] = await planSnapshotBlob(bmp, f.findings.map((x) => ({ n: String(parseInt(x.reference.replace(/\D/g, ''), 10)), u: x.u, v: x.v, colour: x.categoryColour })));
          for (const x of f.findings) ins[x.id] = await insetBlob(bmp, x.u, x.v, x.categoryColour, x.reference);
        } finally { bmp.close(); }
        if (!live) return;
      }
      setSnaps(s); setInsets(ins);
    })().catch((e) => setStatus((st) => ({ ...st, failed: [...st.failed, `Plan rendering failed: ${e instanceof Error ? e.message : String(e)}`] })));
    return () => { live = false; };
  }, [bundle, model, assets]);

  // expected image count: snapshots + insets + photos
  const total = useMemo(() => {
    if (!model) return 0;
    return model.floors.filter((f) => f.planAssetId).length + model.floors.reduce((n, f) => n + f.findings.length + f.findings.reduce((m, x) => m + x.photos.length, 0), 0);
  }, [model]);
  const track = (ok: boolean, key: string) => {
    if (seen.current.has(key + (ok ? '+' : '-'))) return;
    seen.current.add(key + (ok ? '+' : '-'));
    setStatus((s) => ok ? { ...s, loaded: s.loaded + 1 } : { ...s, failed: [...s.failed, `Image ${key}`] });
  };
  const complete = !!model && fontsReady && status.loaded >= total && status.failed.length === 0;
  const keyedUrls = useRef(new Map<string, string>());
  useEffect(() => () => { keyedUrls.current.forEach((u) => URL.revokeObjectURL(u)); }, []);

  if (error) return <div className="page"><main className="content"><p className="error">{error}</p><a href="#/">Back to projects</a></main></div>;
  if (!bundle || !model) return <div className="page"><main className="content"><p role="status">Preparing report…</p></main></div>;
  const p = bundle.project;
  const photoLoader = (assetId: string) => async () => { const a = assets.get(assetId); return a ? bundle.blobs.get(a.displayBlobId) : undefined; };
  const sev = model.bySeverity;

  return (
    <div className="report-page">
      <div className="report-toolbar no-print">
        <button onClick={() => go(`/p/${projectId}`)}>← Back to inspection</button>
        <SaveIndicator />
        <span className="spacer" />
        <span className="small" role="status" data-testid="report-status">
          {status.failed.length ? `Report incomplete: ${status.failed.length} item(s) failed to render` : complete ? 'Ready to print' : `Preparing images (${Math.min(status.loaded, total)}/${total})…`}
        </span>
        <button onClick={() => downloadBlob(new Blob([buildCsv(model)], { type: 'text/csv;charset=utf-8' }), `${p.name.replace(/[^\w.-]+/g, '_')}-findings.csv`)}>Export findings CSV</button>
        <button className="primary" disabled={!complete || inHostFrame()} onClick={() => window.print()} title={inHostFrame() ? 'Printing is not available in this hosted preview' : 'Opens the print dialog — choose “Save as PDF”'}>Print / Save as PDF</button>
        {inHostFrame() && <span className="small muted">Printing is unavailable in this hosted preview — run the app locally to save a PDF.</span>}
      </div>
      {status.failed.length > 0 && <div className="banner warn no-print" role="alert">This report is incomplete and should not be issued: {status.failed.slice(0, 5).join('; ')}.</div>}
      <article className="report" data-testid="report">
        <header className="cover">
          <p className="eyebrow">Prototype inspection record</p>
          <h1>Dilapidation Inspection Report</h1>
          <h2>{p.name}</h2>
          <dl className="meta">
            <dt>Reference</dt><dd>{p.reference || '—'}</dd>
            <dt>Property / site</dt><dd>{p.siteName || '—'}</dd>
            <dt>Address</dt><dd>{p.address || '—'}</dd>
            <dt>Client</dt><dd>{p.client || '—'}</dd>
            <dt>Inspector</dt><dd>{p.inspector || '—'}</dd>
            <dt>Inspection date</dt><dd>{p.inspectionDate}</dd>
            <dt>Report generated</dt><dd>{fmtTime(new Date().toISOString())}</dd>
          </dl>
          {p.isSample && <p className="sample-note">SAMPLE DATA — invented drawings and findings for demonstration only.</p>}
        </header>

        <ExecutiveSummary model={model} project={p} />

        <section>
          <h2>Project notes and scope</h2>
          <p className="prewrap">{p.notes || 'No general notes recorded.'}</p>
          <p><strong>Scope of this report:</strong> the whole project — all {model.floors.length} floors and all {model.total} recorded finding{model.total === 1 ? '' : 's'}, regardless of any filters applied in the workspace.</p>
          <p className="small muted">This document records observations made by the inspector. It does not certify the safety or structural condition of the building. Severity labels are record-keeping categories, not safety determinations. Pin positions are positions on the supplied drawings, not surveyed measurements.</p>
        </section>

        <section>
          <h2>Summary</h2>
          <div className="summary-grid">
            <table><caption>By floor</caption><tbody>{model.byFloor.map((r) => <tr key={r.floor}><th scope="row">{r.floor}</th><td>{r.count}</td></tr>)}<tr className="total"><th scope="row">Total</th><td>{model.total}</td></tr></tbody></table>
            <table><caption>By category</caption><tbody>{model.byCategory.length ? model.byCategory.map((r) => <tr key={r.category}><th scope="row">{r.category}</th><td>{r.count}</td></tr>) : <tr><td colSpan={2}>None</td></tr>}</tbody></table>
            <table><caption>By severity</caption><tbody>{sev.map((r) => <tr key={r.severity}><th scope="row">{r.label}</th><td>{r.count}</td></tr>)}</tbody></table>
          </div>
          {model.needsReview.length > 0 && (
            <div className="warn-box" data-testid="report-review-warning">
              <strong>Location review required for {model.needsReview.length} finding(s)</strong> — the floor plan was replaced after the pin was placed: {model.needsReview.map((f) => f.reference).join(', ')}.
            </div>
          )}
        </section>

        <section>
          <h2>Floor plans</h2>
          {model.floors.map((f) => (
            <figure key={f.id} className="plan-figure">
              <figcaption><h3>{f.name}</h3></figcaption>
              {!f.hasPlan ? <p className="not-imported">Floor plan not imported — this floor was not recorded.</p> : (
                <>
                  <SnapImg blob={snaps[f.id]} alt={`${f.name} plan with ${f.findings.length} numbered pin(s)`} id={`plan-${f.id}`} track={track} keyed={keyedUrls.current} />
                  {f.findings.length === 0 ? <p>No findings recorded.</p> : (
                    <ol className="legend">{f.findings.map((x) => <li key={x.id} value={parseInt(x.reference.replace(/\D/g, ''), 10)}><strong>{x.reference}</strong> {x.title}{x.locationNeedsReview ? ' ⚠ location needs review' : ''}</li>)}</ol>
                  )}
                </>
              )}
            </figure>
          ))}
        </section>

        <section>
          <h2 className="findings-title">Findings <small>Positions are positions on the supplied drawings, not surveyed measurements.</small></h2>
          {model.total === 0 && <p>No findings recorded.</p>}
          {model.floors.filter((f) => f.findings.length).map((f) => (
            <div key={f.id} className="floor-findings">
              <h3 className="floor-head">{f.name}</h3>
              {f.findings.map((x) => <FindingBlock key={x.id} x={x} inset={insets[x.id]} track={track} photoLoader={photoLoader} keyed={keyedUrls.current} assets={assets} />)}
            </div>
          ))}
        </section>
        <footer className="report-foot small muted">Dilapidation Inspector — prototype inspection record. Generated {fmtTime(new Date().toISOString())}.</footer>
      </article>
    </div>
  );
}

function SnapImg({ blob, alt, id, track, keyed, className }: { blob?: Blob; alt: string; id: string; track: (ok: boolean, key: string) => void; keyed: Map<string, string>; className?: string }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob); keyed.set(id, u); setUrl(u);
    return () => { URL.revokeObjectURL(u); keyed.delete(id); };
  }, [blob, id, keyed]);
  if (!url) return <div className={`report-img-placeholder ${className ?? ''}`}>Rendering…</div>;
  return <img className={className ?? 'plan-img'} src={url} alt={alt} decoding="sync" onLoad={() => track(true, id)} onError={() => track(false, id)} />;
}

/** Rows in the key-findings table: enough to fill about one page, so the summary stays at 1–2 pages. */
const KEY_ROWS = 25;

/** The pages a client reads first: the inspector's overview, the numbers, and the major/moderate findings. */
function ExecutiveSummary({ model, project }: { model: ReportModel; project: Project }) {
  const written = project.summary?.trim();
  const text = written || draftSummary(model, project);
  const key = keyFindings(model);
  const shown = key.slice(0, KEY_ROWS), rest = key.slice(KEY_ROWS);
  const restMajor = rest.filter((f) => f.severity === 'major').length;
  const matrix = floorSeverityMatrix(model);
  const sevCount = new Map(model.bySeverity.map((s) => [s.severity, s.count]));
  const photos = model.floors.reduce((n, f) => n + f.findings.reduce((m, x) => m + x.photos.length, 0), 0);
  return (
    <section className="exec" data-testid="exec-summary">
      <h2 className="findings-title">Executive summary <small>{model.total} findings · {model.floors.filter((f) => f.hasPlan).length} floors · {photos} photos</small></h2>
      <p className="prewrap exec-text" data-testid="exec-text">{text}</p>
      {!written && <p className="small muted exec-auto">Summary generated automatically from the recorded findings. The inspector can edit it under Project details.</p>}
      <div className="sev-strip" aria-label="Findings by severity">
        {(['major', 'moderate', 'minor', 'not_assessed'] as Severity[]).map((s) => (
          <div key={s} className={`sev-tile ${s}`}><span className="n">{sevCount.get(s) ?? 0}</span><SeverityLabel severity={s} /></div>
        ))}
      </div>
      {matrix.length > 0 && (
        <table className="exec-matrix">
          <caption>Findings by floor and severity</caption>
          <thead><tr><th scope="col">Floor</th>{SEVERITIES_DESC.map((s) => <th key={s.value} scope="col">{s.label}</th>)}<th scope="col">Total</th></tr></thead>
          <tbody>
            {matrix.map((r) => <tr key={r.floor}><th scope="row">{r.floor}</th>{r.counts.map((c, i) => <td key={i} className={c ? '' : 'zero'}>{c || '–'}</td>)}<td><b>{r.total}</b></td></tr>)}
            <tr className="total"><th scope="row">Total</th>{SEVERITIES_DESC.map((s) => <td key={s.value}>{sevCount.get(s.value) ?? 0}</td>)}<td>{model.total}</td></tr>
          </tbody>
        </table>
      )}
      <h3 className="exec-h">Key findings <small>major and moderate, in order of severity</small></h3>
      {key.length === 0 ? <p>No major or moderate findings were recorded.</p> : (
        <table className="exec-key">
          <thead><tr><th scope="col">Ref</th><th scope="col">Floor</th><th scope="col">Finding</th><th scope="col">Category</th><th scope="col">Severity</th></tr></thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.id}><td className="ref">{f.reference}</td><td>{f.floorName}</td><td>{f.title}{f.locationNeedsReview ? ' ⚠' : ''}</td>
                <td><span className="sw" style={{ background: f.categoryColour }} aria-hidden="true" /> {f.categoryName}</td><td><SeverityLabel severity={f.severity} /></td></tr>
            ))}
            {rest.length > 0 && <tr className="more"><td colSpan={5}>+ {rest.length} further {restMajor ? `findings (${restMajor} major)` : 'moderate findings'} — see the Findings section for every item.</td></tr>}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** Severity as text plus a shape, so it reads in black-and-white print. */
function SeverityLabel({ severity }: { severity: Severity }) {
  const icon = {
    not_assessed: <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeDasharray="1.6 1.4" />,
    minor: <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" />,
    moderate: <><circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" /><path d="M5 1a4 4 0 0 1 0 8z" fill="currentColor" /></>,
    major: <circle cx="5" cy="5" r="4.2" fill="currentColor" />,
  }[severity];
  return <span className={`lbl sev ${severity}`}><svg viewBox="0 0 10 10" aria-hidden="true">{icon}</svg><b>{severityLabel(severity)}</b></span>;
}

/** "Ground" → G, "Level 1" → L1, otherwise the first letters. */
const floorBadge = (name: string) => {
  const m = /^level\s*(\S+)/i.exec(name.trim());
  if (m) return `L${m[1]}`.slice(0, 4).toUpperCase();
  if (/^ground/i.test(name.trim())) return 'G';
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '—';
};

/**
 * Photo rows on a 6-track grid: landscape photos span 3 (two per row), portrait span 2 (three per row).
 * The first row stays with the finding; later rows follow under a "continued" strip so a long set can flow to the next page.
 */
function photoRows<T extends { landscape: boolean }>(photos: T[]): T[][] {
  const rows: T[][] = [];
  let row: T[] = [], used = 0;
  for (const ph of photos) {
    const span = ph.landscape ? 3 : 2;
    if (used + span > 6) { rows.push(row); row = []; used = 0; }
    row.push(ph); used += span;
  }
  if (row.length) rows.push(row);
  return rows;
}

function FindingBlock({ x, inset, track, photoLoader, keyed, assets }: { x: ReportFinding; inset?: Blob; track: (ok: boolean, key: string) => void; photoLoader: (assetId: string) => () => Promise<Blob | undefined>; keyed: Map<string, string>; assets: Map<string, Asset> }) {
  const photos = x.photos.map((ph, i) => {
    const a = assets.get(ph.assetId);
    return { ...ph, n: i + 1, landscape: !a || a.width >= a.height };
  });
  const [firstRow = [], ...moreRows] = photoRows(photos);
  const photoFig = (ph: (typeof photos)[number]) => (
    <figure key={ph.id} className={`report-photo ${ph.landscape ? 'l' : 'p'}`}>
      <ReportImage id={`photo-${ph.id}`} load={photoLoader(ph.assetId)} alt={ph.caption || `${x.reference} photo ${ph.n}`} track={track} className="report-photo-img" />
      <figcaption><b>{x.reference} · Photo {ph.n}</b>{ph.caption ? ` — ${ph.caption}` : ''}</figcaption>
    </figure>
  );
  const corners = <><i className="tl" /><i className="tr" /><i className="bl" /><i className="br" /></>;
  return (
    <>
      <article className="finding-block bp" data-testid="report-finding">
        {corners}
        <div className="finding-lead">
          <header className="f-head">
            <div className="f-ref">{x.reference}</div>
            <div className="f-title">{x.title}</div>
            <div className="f-labels">
              <span className="lbl"><span className="sw" style={{ background: x.categoryColour }} aria-hidden="true" /><b>{x.categoryName}</b></span>
              <SeverityLabel severity={x.severity} />
              <span className="lbl"><span className="k">Floor</span><b>{x.floorName}</b></span>
            </div>
          </header>
          {x.locationNeedsReview && (
            <div className="f-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>Location needs review <span>— the floor plan was replaced after this pin was placed.</span></div>
          )}
          <div className="f-body">
            <div className="f-text">
              {x.locationNotes && <p className="loc"><b>Location</b><span className="prewrap">{x.locationNotes}</span></p>}
              {x.description ? <p className="desc prewrap">{x.description}</p> : <p className="none">No description recorded.</p>}
            </div>
            <figure className="plan-x">
              <div className="plan-frame">
                <SnapImg blob={inset} alt={`Local plan detail for ${x.reference}`} id={`inset-${x.id}`} track={track} keyed={keyed} className="inset-img" />
                <span className="floor-badge">{floorBadge(x.floorName)}</span>
              </div>
              <figcaption className="plan-cap"><span><b>Plan extract</b> · {x.floorName}</span><span>Not to scale</span></figcaption>
            </figure>
          </div>
          {firstRow.length > 0 && <div className="f-photos">{firstRow.map(photoFig)}</div>}
        </div>
      </article>
      {moreRows.length > 0 && (
        <article className="finding-block bp finding-cont">
          {corners}
          <header className="f-cont">
            <div className="f-ref">{x.reference}</div>
            <div className="f-title">{x.title}</div>
            <em>photos continued</em>
          </header>
          <div className="f-photos">{moreRows.flat().map(photoFig)}</div>
        </article>
      )}
    </>
  );
}
