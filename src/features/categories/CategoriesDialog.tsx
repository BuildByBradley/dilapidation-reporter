import { useState } from 'react';
import { Dialog, useToast } from '../../components/ui';
import * as repo from '../../data/repo';
import { db } from '../../data/db';
import { useLive } from '../../lib/useLive';
import type { Category } from '../../lib/types';

export function CategoriesDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const toast = useToast();
  const [cats] = useLive(() => repo.listCategories(projectId), [projectId], [] as Category[]);
  const [usage] = useLive(async () => {
    const f = await db.findings.where('projectId').equals(projectId).toArray();
    return f.reduce<Record<string, number>>((m, x) => ({ ...m, [x.categoryId]: (m[x.categoryId] ?? 0) + 1 }), {});
  }, [projectId], {} as Record<string, number>);
  const [newName, setNewName] = useState('');
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [target, setTarget] = useState('');
  const guard = async (p: Promise<unknown>) => { try { await p; return true; } catch (e) { toast('error', e instanceof Error ? e.message : String(e)); return false; } };

  return (
    <Dialog title="Categories" wide onClose={onClose} footer={<button className="primary" onClick={onClose}>Done</button>}>
      <p className="muted">Renaming updates every linked finding. Categories in use are archived rather than deleted so historical findings keep their label. Colour is always paired with the name.</p>
      <ul className="cat-list">
        {cats.map((c, i) => (
          <li key={c.id} className={c.archived ? 'archived' : ''}>
            <input type="color" value={c.colour} aria-label={`${c.name} colour`} onChange={(e) => void guard(repo.updateCategory(c.id, { colour: e.target.value }))} />
            <input defaultValue={c.name} key={c.name} aria-label={`Category name ${c.name}`} onBlur={(e) => { if (e.target.value !== c.name) void guard(repo.updateCategory(c.id, { name: e.target.value })).then((ok) => { if (!ok) e.target.value = c.name; }); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            <span className="muted small">{usage[c.id] ?? 0} in use{c.archived ? ' · archived' : ''}</span>
            <button aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => guard(repo.moveCategory(c.id, -1))}>↑</button>
            <button aria-label={`Move ${c.name} down`} disabled={i === cats.length - 1} onClick={() => guard(repo.moveCategory(c.id, 1))}>↓</button>
            <button onClick={() => guard(repo.setCategoryArchived(c.id, !c.archived))}>{c.archived ? 'Restore' : 'Archive'}</button>
            <button className="danger" aria-label={`Delete ${c.name}`} onClick={() => { setDeleting(c); setTarget(cats.find((x) => x.id !== c.id && !x.archived)?.id ?? ''); }}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await guard(repo.createCategory(projectId, newName))) setNewName(''); }}>
        <input placeholder="New category name" aria-label="New category name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="primary" type="submit">Add category</button>
      </form>
      {deleting && (
        <div className="warn-box" role="alertdialog" aria-label="Delete category">
          <p>Delete <strong>{deleting.name}</strong> permanently? {(usage[deleting.id] ?? 0) > 0 ? `${usage[deleting.id]} finding(s) use it and must be reassigned.` : 'No findings use it.'}</p>
          {(usage[deleting.id] ?? 0) > 0 && (
            <label>Reassign to<select value={target} onChange={(e) => setTarget(e.target.value)}>
              {cats.filter((c) => c.id !== deleting.id && !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
          )}
          <div className="row">
            <button onClick={() => setDeleting(null)}>Cancel</button>
            <button className="danger" onClick={async () => { if (await guard(repo.deleteCategory(deleting.id, target || undefined))) setDeleting(null); }}>Delete category</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
