import { useEffect, useRef, useState } from 'react';
import { go } from '../../app/App';
import { Confirm, Dialog, fmtTime, useToast } from '../../components/ui';
import * as repo from '../../data/repo';
import { createBackup, parseBackup, BackupError } from '../../lib/backup';
import { downloadBlob } from '../../lib/imaging';
import { useLive } from '../../lib/useLive';
import { loadSampleProject } from './sample';
import { SaveIndicator } from '../../components/SaveIndicator';
import { StorageBar } from '../../components/StorageBar';

type Details = Required<repo.ProjectInput>;
const empty = (): Details => ({ name: '', siteName: '', address: '', client: '', inspector: '', inspectionDate: new Date().toISOString().slice(0, 10), reference: '', notes: '' });

function DetailsDialog({ initial, title, onSave, onClose }: { initial: Details; title: string; onSave: (d: Details) => Promise<void>; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Details) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const submit = async () => { setBusy(true); try { await onSave(d); onClose(); } finally { setBusy(false); } };
  return (
    <Dialog title={title} onClose={onClose} footer={<><button onClick={onClose}>Cancel</button><button className="primary" disabled={busy} onClick={submit}>Save</button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label>Project name<input value={d.name} onChange={set('name')} autoFocus /></label>
        <label>Property / site name<input value={d.siteName} onChange={set('siteName')} /></label>
        <label className="span2">Address<input value={d.address} onChange={set('address')} /></label>
        <label>Client<input value={d.client} onChange={set('client')} /></label>
        <label>Inspector<input value={d.inspector} onChange={set('inspector')} /></label>
        <label>Inspection date<input type="date" value={d.inspectionDate} onChange={set('inspectionDate')} /></label>
        <label>Reference number<input value={d.reference} onChange={set('reference')} /></label>
        <label className="span2">General notes<textarea rows={3} value={d.notes} onChange={set('notes')} /></label>
      </form>
    </Dialog>
  );
}

function StoragePanel() {
  const [info, setInfo] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});
  const refresh = async () => {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    setInfo({ usage: est?.usage, quota: est?.quota, persisted });
  };
  useEffect(() => { void refresh(); }, []);
  const mb = (n?: number) => (n === undefined ? 'unknown' : `${(n / 1048576).toFixed(1)} MB`);
  return (
    <details className="panel storage">
      <summary>Storage &amp; backups</summary>
      <p>Everything is saved <strong>only in this browser</strong> (IndexedDB) — nothing is uploaded. Clearing site data, using a private window, or low-storage eviction can delete projects. Download a backup regularly.</p>
      <p>Used: {mb(info.usage)} of {mb(info.quota)} available. Persistent storage: {info.persisted === undefined ? 'not supported' : info.persisted ? 'granted' : 'not granted'}.
        {info.persisted === false && <> <button onClick={async () => { await navigator.storage.persist(); void refresh(); }}>Request persistent storage</button></>}</p>
    </details>
  );
}

export function ProjectHome() {
  const toast = useToast();
  const [projects] = useLive(() => repo.listProjects(), [], [] as repo.ProjectSummary[]);
  const [editing, setEditing] = useState<repo.ProjectSummary | 'new' | null>(null);
  const [deleting, setDeleting] = useState<repo.ProjectSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { void navigator.storage?.persist?.(); }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await fn(); } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };

  return (
    <div className="page home">
      <header className="topbar">
        <h1>Dilapidation Inspector</h1>
        <span className="tag">Prototype</span>
        <span className="spacer" />
        <SaveIndicator /><StorageBar />
      </header>
      <main className="content">
        <div className="toolbar-row">
          <button className="primary" onClick={() => setEditing('new')}>New inspection</button>
          <button onClick={() => fileRef.current?.click()}>Restore backup…</button>
          <button disabled={!!busy} onClick={() => run('Loading sample project…', async () => { const p = await loadSampleProject(setBusy); toast('ok', 'Sample project created'); go(`/p/${p.id}`); })}>Load sample project</button>
          <input ref={fileRef} type="file" accept=".zip,application/zip" hidden aria-label="Backup file" onChange={(e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            void run('Restoring backup…', async () => {
              try {
                const bundle = parseBackup(new Uint8Array(await f.arrayBuffer()));
                const p = await repo.saveBundleAsNew(bundle, ' (restored)');
                toast('ok', `Restored "${p.name}" as a new project`);
              } catch (err) {
                if (err instanceof BackupError) throw new Error(`Restore failed — nothing was changed. ${err.message}`);
                throw err;
              }
            });
          }} />
        </div>
        {busy && <p className="busy" role="status">{busy}</p>}
        {projects.length === 0 ? (
          <div className="empty"><h2>No inspections yet</h2><p>Create an inspection, or load the synthetic five-floor sample project to try the app.</p></div>
        ) : (
          <ul className="cards" aria-label="Projects">
            {projects.map((p) => (
              <li key={p.id} className="card" data-testid="project-card">
                <div className="card-main">
                  <h2><a href={`#/p/${p.id}`}>{p.name}</a>{p.isSample && <span className="tag">Sample</span>}</h2>
                  <p className="muted">{[p.siteName, p.address].filter(Boolean).join(' · ') || 'No site details'}</p>
                  <p className="muted small">{p.floorCount} of 5 floors imported · {p.findingCount} finding{p.findingCount === 1 ? '' : 's'} · saved {fmtTime(p.updatedAt)}</p>
                </div>
                <div className="card-actions">
                  <button className="primary" onClick={() => go(`/p/${p.id}`)}>Open</button>
                  <button onClick={() => setEditing(p)}>Rename / details</button>
                  <button onClick={() => run('Duplicating…', async () => { await repo.duplicateProject(p.id); toast('ok', 'Project duplicated'); })}>Duplicate</button>
                  <button onClick={() => run('Creating backup…', async () => { downloadBlob(new Blob([new Uint8Array(await createBackup(await repo.loadBundle(p.id)))], { type: 'application/zip' }), `${p.name.replace(/[^\w.-]+/g, '_')}-backup.zip`); })}>Back up</button>
                  <button className="danger" onClick={() => setDeleting(p)}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <StoragePanel />
      </main>
      {editing && (
        <DetailsDialog
          title={editing === 'new' ? 'New inspection' : 'Project details'}
          initial={editing === 'new' ? empty() : { name: editing.name, siteName: editing.siteName, address: editing.address, client: editing.client, inspector: editing.inspector, inspectionDate: editing.inspectionDate, reference: editing.reference, notes: editing.notes }}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            try {
              if (editing === 'new') { const p = await repo.createProject(d); go(`/p/${p.id}`); }
              else await repo.updateProject(editing.id, d);
            } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); throw e; }
          }}
        />
      )}
      {deleting && (
        <Confirm title="Delete project?" confirmLabel="Delete project" danger onCancel={() => setDeleting(null)} onConfirm={() => { const p = deleting; setDeleting(null); void run('Deleting…', () => repo.deleteProject(p.id)); }}>
          <p>This permanently removes <strong>{deleting.name}</strong> — its plans, {deleting.findingCount} finding(s) and all photos — from this browser. It cannot be undone. Back it up first if you may need it.</p>
        </Confirm>
      )}
    </div>
  );
}
