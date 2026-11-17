import { useId, useMemo, useState } from 'react';
import * as repo from '../../data/repo';
import type { Finding } from '../../lib/types';

/**
 * Description box that offers wording already used in the project as you type. Picking one links this finding to
 * it (like a SketchUp component): editing linked wording changes it on every finding that shares it, until
 * "Make unique" gives this finding its own copy.
 */
export function DescriptionField({ value, onType, onPick, onUnlink, link, findings, selfId, rows, disabled, unsaved }: {
  value: string;
  /** Free typing. */
  onType(text: string): void;
  onPick(choice: repo.DescriptionChoice): void;
  onUnlink(): void;
  /** The wording this finding is linked to, if any. */
  link?: repo.DescriptionChoice;
  /** Every finding in the project (the source of suggestions). */
  findings: Finding[];
  /** The finding being edited (left out of suggestions and the linked count). */
  selfId?: string;
  rows: number; disabled?: boolean;
  /** A finding still being created: typing gives it its own wording rather than editing the shared one. */
  unsaved?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const others = useMemo(() => findings.filter((f) => f.id !== selfId), [findings, selfId]);
  const all = useMemo(() => repo.descriptionSuggestions(others), [others]);
  const matches = useMemo(() => (open && !disabled && !link ? repo.matchDescriptions(all, value) : []), [all, value, link, open, disabled]);
  const linkedTo = !link ? [] : link.linkId ? others.filter((f) => f.descriptionLinkId === link.linkId) : others.filter((f) => !f.descriptionLinkId && f.description === link.text);
  const pick = (s: repo.DescriptionSuggestion) => { setOpen(false); onPick({ text: s.text, linkId: s.linkId }); };

  return (
    <div className="desc-field">
      <label>Description
        <textarea rows={rows} value={value} disabled={disabled} role="combobox" aria-autocomplete="list" aria-expanded={matches.length > 0}
          aria-controls={`${id}-list`} aria-activedescendant={matches.length ? `${id}-${active}` : undefined}
          onChange={(e) => { onType(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (!matches.length) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pick(matches[Math.min(active, matches.length - 1)]); }
            else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
          }} />
      </label>
      {matches.length > 0 && (
        <ul className="desc-suggest" role="listbox" id={`${id}-list`} aria-label="Wording already used">
          <li className="desc-suggest-head small muted" aria-hidden="true">Used before — pick to reuse (linked)</li>
          {matches.map((s, i) => (
            <li key={s.linkId ?? s.text} id={`${id}-${i}`} role="option" aria-selected={i === active} className={i === active ? 'active' : ''}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setActive(i)}>
              <span className="desc-suggest-text">{s.text}</span>
              <span className="small muted">{s.linkId ? '🔗 ' : ''}used {s.count}× · {s.references.slice(0, 3).join(', ')}{s.references.length > 3 ? '…' : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {link && linkedTo.length > 0 && (
        <div className="desc-link small" role="status" data-testid="description-link">
          <span>🔗 Linked wording, shared with {linkedTo.length} other finding{linkedTo.length === 1 ? '' : 's'} ({linkedTo.slice(0, 4).map((f) => f.reference).join(', ')}{linkedTo.length > 4 ? '…' : ''}). {unsaved ? ' Typing here gives this finding its own wording instead.' : ' Editing it changes all of them.'}</span>
          <button type="button" disabled={disabled} onClick={onUnlink} title="Keep this wording but stop sharing it, so this finding can say something different">Make unique</button>
        </div>
      )}
    </div>
  );
}
