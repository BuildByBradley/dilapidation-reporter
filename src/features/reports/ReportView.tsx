import { useEffect, useMemo, useRef, useState } from 'react';
import { go } from '../../app/App';
import { fmtTime } from '../../components/ui';
import { flushAll } from '../../data/flush';
import * as repo from '../../data/repo';
import { downloadBlob, inHostFrame } from '../../lib/imaging';
import { insetBlob, planSnapshotBlob } from '../../lib/planSnapshot';
import { buildCsv, buildReportModel, type ReportFinding, type ReportModel } from '../../lib/report';
import { severityLabel, type Asset } from '../../lib/types';
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
          for (const x of f.findings) ins[x.id] = await insetBlob(bmp, x.u, x.v, x.categoryColour);
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
          <h2>Findings</h2>
          {model.total === 0 && <p>No findings recorded.</p>}
          {model.floors.filter((f) => f.findings.length).map((f) => (
            <div key={f.id} className="floor-findings">
              <h3>{f.name}</h3>
              {f.findings.map((x) => <FindingBlock key={x.id} x={x} inset={insets[x.id]} track={track} photoLoader={photoLoader} keyed={keyedUrls.current} />)}
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

function FindingBlock({ x, inset, track, photoLoader, keyed }: { x: ReportFinding; inset?: Blob; track: (ok: boolean, key: string) => void; photoLoader: (assetId: string) => () => Promise<Blob | undefined>; keyed: Map<string, string> }) {
  return (
    <section className="finding-block" data-testid="report-finding">
      <header>
        <h4><span className="swatch" style={{ background: x.categoryColour }} aria-hidden="true" /> {x.reference} — {x.title}</h4>
        <p className="small">{x.categoryName} · Severity: {severityLabel(x.severity)}</p>
      </header>
      {x.locationNeedsReview && <p className="warn-line">⚠ Location needs review: the floor plan was replaced after this pin was placed.</p>}
      <div className="finding-body">
        <div>
          {x.locationNotes && <p><strong>Location:</strong> <span className="prewrap">{x.locationNotes}</span></p>}
          <p className="prewrap">{x.description || <em>No description.</em>}</p>
        </div>
        <SnapImg blob={inset} alt={`Local plan detail for ${x.reference}`} id={`inset-${x.id}`} track={track} keyed={keyed} className="inset-img" />
      </div>
      {x.photos.length > 0 && (
        <div className="photo-grid">
          {x.photos.map((ph, i) => (
            <figure key={ph.id} className="report-photo">
              <ReportImage id={`photo-${ph.id}`} load={photoLoader(ph.assetId)} alt={ph.caption || `${x.reference} photo ${i + 1}`} track={track} className="report-photo-img" />
              <figcaption>{x.reference} · Photo {i + 1}{ph.caption ? ` — ${ph.caption}` : ''}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}
