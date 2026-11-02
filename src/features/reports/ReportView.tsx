import { useEffect, useMemo, useRef, useState } from 'react';
import { referenceNumber, referencePrefix } from '../../lib/ids';
import { go } from '../../app/App';
import { flushAll } from '../../data/flush';
import * as repo from '../../data/repo';
import { downloadBlob, inHostFrame } from '../../lib/imaging';
import { DETAIL_SPAN, KEY_PLAN_SPAN, insetBlob, planSnapshotBlob } from '../../lib/planSnapshot';
import { buildCsv, buildReportModel, draftSummary, type ReportFinding, type ReportModel } from '../../lib/report';
import type { Asset, Project } from '../../lib/types';
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
  const [details, setDetails] = useState<Record<string, Blob>>({});
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
      const s: Record<string, Blob> = {}, ins: Record<string, Blob> = {}, det: Record<string, Blob> = {};
      for (const f of model.floors) {
        if (!f.planAssetId) continue;
        const a = assets.get(f.planAssetId);
        const blob = a && bundle.blobs.get(a.reportBlobId ?? a.displayBlobId);
        if (!blob) { setStatus((st) => ({ ...st, failed: [...st.failed, `Plan image for ${f.name}`] })); continue; }
        const bmp = await createImageBitmap(blob);
        try {
          s[f.id] = await planSnapshotBlob(bmp, f.findings.map((x) => ({ n: String(referenceNumber(x.reference)), u: x.u, v: x.v, colour: x.categoryColour })));
          for (const x of f.findings) {
            // Key plan (the wider extract, with the detail area outlined) and a closer detail view of the same spot.
            ins[x.id] = await insetBlob(bmp, x.u, x.v, x.categoryColour, undefined, 720, 540, KEY_PLAN_SPAN, DETAIL_SPAN);
            det[x.id] = await insetBlob(bmp, x.u, x.v, x.categoryColour, undefined, 720, 540, DETAIL_SPAN); // no tag: the reference heads the block
          }
        } finally { bmp.close(); }
        if (!live) return;
      }
      setSnaps(s); setInsets(ins); setDetails(det);
    })().catch((e) => setStatus((st) => ({ ...st, failed: [...st.failed, `Plan rendering failed: ${e instanceof Error ? e.message : String(e)}`] })));
    return () => { live = false; };
  }, [bundle, model, assets]);

  // expected image count: snapshots + insets + photos
  const total = useMemo(() => {
    if (!model) return 0;
    // per finding: key plan + detail (on floors with a plan) and its photos
    return model.floors.filter((f) => f.planAssetId).length
      + model.floors.reduce((n, f) => n + (f.planAssetId ? 2 : 1) * f.findings.length + f.findings.reduce((m, x) => m + x.photos.length, 0), 0);
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
          <h1>Conditioning Report</h1>
          <h2>{p.name}</h2>
          <dl className="meta">
            <dt>Reference</dt><dd>{p.reference || '—'}</dd>
            <dt>Property / site</dt><dd>{p.siteName || '—'}</dd>
            <dt>Address</dt><dd>{p.address || '—'}</dd>
            <dt>Client</dt><dd>{p.client || '—'}</dd>
            <dt>Inspector</dt><dd>{p.inspector || '—'}</dd>
            <dt>Inspection date</dt><dd>{p.inspectionDate}</dd>
          </dl>
          {p.isSample && <p className="sample-note">SAMPLE DATA — invented drawings and findings for demonstration only.</p>}
        </header>

        <ExecutiveSummary model={model} project={p} />

        {p.notes.trim() && (
          <section>
            <h2>Project notes</h2>
            <p className="prewrap">{p.notes}</p>
          </section>
        )}

        <section>
          <h2>Floor plans</h2>
          {model.floors.map((f) => (
            <figure key={f.id} className="plan-figure">
              <figcaption><h3>{f.name}</h3></figcaption>
              {!f.hasPlan ? <p className="not-imported">Floor plan not imported — this floor was not recorded.</p> : (
                <>
                  <SnapImg blob={snaps[f.id]} alt={`${f.name} plan with ${f.findings.length} numbered pin(s)`} id={`plan-${f.id}`} track={track} keyed={keyedUrls.current} />
                  {f.findings.length === 0 ? <p>No findings recorded.</p> : (
                    <ol className="legend">{f.findings.map((x) => <li key={x.id} value={referenceNumber(x.reference)}><strong>{x.reference}</strong> {x.title}{x.locationNeedsReview ? ' ⚠ location needs review' : ''}</li>)}</ol>
                  )}
                </>
              )}
            </figure>
          ))}
        </section>

        <section>
          <h2 className="findings-title">Findings <small>Positions are indicative on the supplied drawings, not surveyed measurements.</small></h2>
          {model.total === 0 && <p>No findings recorded.</p>}
          {model.floors.filter((f) => f.findings.length).map((f) => (
            <div key={f.id} className="floor-findings">
              <h3 className="floor-head">{f.name}</h3>
              {f.findings.map((x) => <FindingBlock key={x.id} x={x} inset={insets[x.id]} detail={details[x.id]} track={track} photoLoader={photoLoader} keyed={keyedUrls.current} assets={assets} />)}
            </div>
          ))}
        </section>
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


/** The page a client reads first: the inspector's summary and the findings per floor and per category. */
function ExecutiveSummary({ model, project }: { model: ReportModel; project: Project }) {
  const written = project.summary?.trim();
  const text = written || draftSummary(model, project);
  const photos = model.floors.reduce((n, f) => n + f.findings.reduce((m, x) => m + x.photos.length, 0), 0);
  return (
    <section className="exec" data-testid="exec-summary">
      <h2 className="findings-title">Summary <small>{model.total} findings · {model.floors.filter((f) => f.hasPlan).length} floors · {photos} photos</small></h2>
      <p className="prewrap exec-text" data-testid="exec-text">{text}</p>
      {!written && <p className="small muted exec-auto">Summary generated automatically from the recorded findings. The inspector can edit it under Project details.</p>}
      <div className="summary-grid">
        <table><caption>By floor</caption><tbody>{model.byFloor.map((r) => <tr key={r.floor}><th scope="row">{r.floor}</th><td>{r.count}</td></tr>)}<tr className="total"><th scope="row">Total</th><td>{model.total}</td></tr></tbody></table>
        <table><caption>By category</caption><tbody>{model.byCategory.length ? model.byCategory.map((r) => <tr key={r.category}><th scope="row">{r.category}</th><td>{r.count}</td></tr>) : <tr><td colSpan={2}>None</td></tr>}</tbody></table>
      </div>
      {model.needsReview.length > 0 && (
        <div className="warn-box" data-testid="report-review-warning">
          <strong>Location review required for {model.needsReview.length} finding(s)</strong> — the floor plan was replaced after the pin was placed: {model.needsReview.map((f) => f.reference).join(', ')}.
        </div>
      )}
    </section>
  );
}

/** The floor's reference prefix (G-001 → G, L1-004 → L1); for older references, from the floor name. */
const floorBadge = (reference: string, name: string) => {
  const prefix = referencePrefix(reference);
  if (prefix && prefix !== 'D') return prefix.toUpperCase().slice(0, 5);
  const m = /^level\s*(\S+)/i.exec(name.trim());
  if (m) return `L${m[1]}`.slice(0, 4).toUpperCase();
  if (/^ground/i.test(name.trim())) return 'G';
  return name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase() || '—';
};

/**
 * Split photos into rows of a grid with `tracks` columns, each photo taking `spanOf` of them.
 * The first rows stay with the finding; later rows follow under a "continued" strip so a long set can flow to the next page.
 */
function photoRows<T>(photos: T[], tracks: number, spanOf: (ph: T) => number): T[][] {
  const rows: T[][] = [];
  let row: T[] = [], used = 0;
  for (const ph of photos) {
    const span = spanOf(ph);
    if (used + span > tracks) { rows.push(row); row = []; used = 0; }
    row.push(ph); used += span;
  }
  if (row.length) rows.push(row);
  return rows;
}

function FindingBlock({ x, inset, detail, track, photoLoader, keyed, assets }: { x: ReportFinding; inset?: Blob; detail?: Blob; track: (ok: boolean, key: string) => void; photoLoader: (assetId: string) => () => Promise<Blob | undefined>; keyed: Map<string, string>; assets: Map<string, Asset> }) {
  const photos = x.photos.map((ph, i) => {
    const a = assets.get(ph.assetId);
    return { ...ph, n: i + 1, landscape: !a || a.width >= a.height };
  });
  const sideSpan = (ph: (typeof photos)[number]) => (ph.landscape || photos.length === 1 ? 2 : 1);
  // Beside the plans: two photo tracks (landscape spans both, portrait one), at most two rows; the rest follow full width.
  const sideRows = photoRows(photos, 2, (ph) => sideSpan(ph));
  const firstRow = sideRows.slice(0, 2).flat();
  const moreRows = photoRows(sideRows.slice(2).flat(), 6, (ph) => (ph.landscape ? 3 : 2));
  const photoFig = (ph: (typeof photos)[number], span: number) => (
    <figure key={ph.id} className={`report-photo ${ph.landscape ? 'l' : 'p'}`} style={{ gridColumn: `span ${span}` }}>
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
              <span className="lbl"><span className="k">Floor</span><b>{x.floorName}</b></span>
            </div>
          </header>
          {x.locationNeedsReview && (
            <div className="f-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>Location needs review <span>— the floor plan was replaced after this pin was placed.</span></div>
          )}
          <div className="f-body">
            <div className="f-main">
              <div className="f-text">
                {x.locationNotes && <p className="loc"><b>Location</b><span className="prewrap">{x.locationNotes}</span></p>}
                {x.description ? <p className="desc prewrap">{x.description}</p> : <p className="none">No description recorded.</p>}
              </div>
              {firstRow.length > 0 && <div className="f-photos side">{firstRow.map((ph) => photoFig(ph, sideSpan(ph)))}</div>}
            </div>
            <div className="f-plans">
              <figure className="plan-x">
                <div className="plan-frame">
                  <SnapImg blob={inset} alt={`Key plan for ${x.reference}`} id={`inset-${x.id}`} track={track} keyed={keyed} className="inset-img" />
                  <span className="floor-badge">{floorBadge(x.reference, x.floorName)}</span>
                </div>
                <figcaption className="plan-cap"><span><b>Key plan</b> · {x.floorName}</span><span>Not to scale</span></figcaption>
              </figure>
              <figure className="plan-x">
                <div className="plan-frame">
                  <SnapImg blob={detail} alt={`Close-up plan for ${x.reference}`} id={`detail-${x.id}`} track={track} keyed={keyed} className="inset-img" />
                </div>
                <figcaption className="plan-cap"><span><b>Close-up</b> · dashed area on the key plan</span><span>Not to scale</span></figcaption>
              </figure>
            </div>
          </div>
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
          <div className="f-photos">{moreRows.flat().map((ph) => photoFig(ph, ph.landscape ? 3 : 2))}</div>
        </article>
      )}
    </>
  );
}
