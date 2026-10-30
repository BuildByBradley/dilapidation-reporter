import { useState } from 'react';
import { Dialog, useToast } from '../../components/ui';
import * as repo from '../../data/repo';
import { useLive } from '../../lib/useLive';

/**
 * Renumber all findings per floor (G-001…, L1-001…), in floor-list order. Each floor's prefix can be set here.
 * Meant for before a report is issued: afterwards references should stay as they are.
 */
export function RenumberDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const toast = useToast();
  const [order, setOrder] = useState<repo.RenumberOrder>('position');
  const [busy, setBusy] = useState(false);
  const [plan] = useLive(() => repo.renumberPlan(projectId, order), [projectId, order], []);
  const changes = plan.reduce((n, f) => n + f.findings.filter((x) => x.finding.reference !== x.reference).length, 0);
  const run = async () => {
    setBusy(true);
    try {
      const n = await repo.renumberFindings(projectId, order);
      toast('ok', n ? `${n} finding${n === 1 ? '' : 's'} renumbered` : 'Numbers were already in order');
      onClose();
    } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Renumber findings per floor" wide onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={busy || !changes} onClick={run}>{busy ? 'Renumbering…' : changes ? `Renumber ${changes} finding${changes === 1 ? '' : 's'}` : 'Already in order'}</button></>}>
      <p>Each floor gets its own numbers, starting at 001, in the order of the floor list: <b>G-001, G-002… L1-001…</b> New findings carry on from the last number on their floor.</p>
      <fieldset className="sync-mode" aria-label="Order on each floor">
        <legend className="small">Order on each floor</legend>
        <label className="inline"><input type="radio" name="renumber-order" checked={order === 'position'} onChange={() => setOrder('position')} /> <span><b>By position on the plan</b> — top to bottom, left to right</span></label>
        <label className="inline"><input type="radio" name="renumber-order" checked={order === 'captured'} onChange={() => setOrder('captured')} /> <span><b>In the order they were captured</b> (your walk-around route)</span></label>
      </fieldset>
      <table className="renumber-table">
        <thead><tr><th>Floor</th><th>Prefix</th><th>Findings</th><th>New numbers</th></tr></thead>
        <tbody>
          {plan.map(({ floor, code, findings }) => (
            <tr key={floor.id}>
              <td>{floor.name}</td>
              <td><input key={`${floor.id}:${floor.code ?? ''}`} defaultValue={floor.code ?? ''} placeholder={code} maxLength={6} aria-label={`${floor.name} number prefix`}
                onBlur={(e) => { if (e.target.value !== (floor.code ?? '')) void repo.updateFloor(floor.id, { code: e.target.value }); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></td>
              <td>{findings.length}</td>
              <td className="muted">{findings.length ? `${findings[0].reference}${findings.length > 1 ? ` … ${findings.at(-1)!.reference}` : ''}` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Floors are taken in the order of the floor list — put them in order first (Ground at the top). Sync your other devices before renumbering so no finding is missed.
        Numbers in reports already sent, and any references typed into descriptions or the executive summary, are not changed.</p>
    </Dialog>
  );
}
