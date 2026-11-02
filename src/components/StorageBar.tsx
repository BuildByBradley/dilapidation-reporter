import { useEffect, useState } from 'react';
import { Dialog } from './ui';
import { measureStorage, type StorageUsage } from '../data/storage';
import { useLive } from '../lib/useLive';
import { fmtBytes, photosRemaining, setStoragePrefs, useStoragePrefs, usageLevel } from '../lib/storagePrefs';

const EMPTY: StorageUsage = { totalBytes: 0, projectBytes: 0, photoCount: 0, avgPhotoBytes: 0 };

export function useStorageUsage(projectId?: string) {
  const prefs = useStoragePrefs();
  const [usage] = useLive(() => measureStorage(projectId), [projectId], EMPTY);
  const ratio = prefs.budgetBytes > 0 ? usage.totalBytes / prefs.budgetBytes : 0;
  return { usage, budget: prefs.budgetBytes, ratio, level: usageLevel(usage.totalBytes, prefs.budgetBytes) };
}

/** Compact storage meter. Click it for details and the budget. */
export function StorageBar({ projectId }: { projectId?: string }) {
  const { usage, budget, ratio, level } = useStorageUsage(projectId);
  const [open, setOpen] = useState(false);
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <>
      <button className={`storage-bar ${level}`} onClick={() => setOpen(true)} aria-label={`Storage: ${fmtBytes(usage.totalBytes)} of ${fmtBytes(budget)} used. Open storage details`} data-testid="storage-bar">
        <span className="storage-track" aria-hidden="true"><span className="storage-fill" style={{ width: `${pct}%` }} /></span>
        <span className="storage-text" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Storage used">{fmtBytes(usage.totalBytes)} / {fmtBytes(budget)}</span>
      </button>
      {open && <StorageDialog projectId={projectId} onClose={() => setOpen(false)} />}
    </>
  );
}

function StorageDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const { usage, budget, ratio, level } = useStorageUsage(projectId);
  const [device, setDevice] = useState<{ usage?: number; quota?: number }>({});
  useEffect(() => { navigator.storage?.estimate?.().then((e) => setDevice({ usage: e.usage, quota: e.quota })).catch(() => {}); }, [usage.totalBytes]);
  const pct = Math.min(100, Math.round(ratio * 100));
  const left = photosRemaining(usage.totalBytes, budget, usage.avgPhotoBytes);
  return (
    <Dialog title="Storage" onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <div className={`storage-big ${level}`}>
        <div className="storage-track big" aria-hidden="true"><span className="storage-fill" style={{ width: `${pct}%` }} /></div>
        <p><strong>{fmtBytes(usage.totalBytes)}</strong> of {fmtBytes(budget)} used ({pct}%)</p>
      </div>
      {level !== 'ok' && <p className={level === 'crit' ? 'error' : 'small'} role="status">{level === 'crit' ? 'Almost full. Download a backup and remove finished projects before adding more photos.' : 'Getting full. Plan to back up and clear space soon.'}</p>}
      <ul className="small storage-facts">
        <li>About <strong>{left.toLocaleString()}</strong> more photos fit at the current average of {fmtBytes(usage.avgPhotoBytes)} each.</li>
        <li>{usage.photoCount.toLocaleString()} photo{usage.photoCount === 1 ? '' : 's'} stored{projectId ? <> · this project uses {fmtBytes(usage.projectBytes)}</> : null}.</li>
        {device.quota !== undefined && <li>This device/browser allows up to {fmtBytes(device.quota)}; {fmtBytes(device.usage ?? 0)} is in use by all sites.</li>}
      </ul>
      <label>Storage budget (MB)
        <input type="number" min={50} step={50} value={Math.round(budget / 1048576)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n >= 50) setStoragePrefs({ budgetBytes: Math.round(n * 1048576) }); }} />
      </label>
      <p className="small muted">The bar counts plans and photos stored in this browser, not what is in the cloud. Photos are saved compressed (1920&nbsp;px). Set the budget to suit your device so it warns you at 70% and 90%.</p>
    </Dialog>
  );
}
