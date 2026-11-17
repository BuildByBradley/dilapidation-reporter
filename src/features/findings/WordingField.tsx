import { useId, useMemo, useState } from 'react';
import * as repo from '../../data/repo';
import type { Finding } from '../../lib/types';

const NOUN: Record<repo.WordingField, string> = { title: 'title', description: 'wording' };

/**
 * Title or description box that offers wording already used in the project as you type. Picking one links this
 * finding to it (like a SketchUp component): editing linked wording changes it on every finding that shares it,
 * until "Make unique" gives this finding its own copy.
 */
export function WordingField({ field, label, value, onType, onPick, onUnlink, link, findings, selfId, rows = 1, disabled, unsaved, autoFocus }: {
  field: repo.WordingField;
  /** Visible label, e.g. "Title *". */
  label: string;
  value: string;
  /** Free typing. */
  onType(text: string): void;
  onPick(choice: repo.WordingChoice): void;
  onUnlink(): void;
  /** The wording this finding is linked to, if any. */
  link?: repo.WordingChoice;
  /** Every finding in the project (the source of suggestions). */
  findings: Finding[];
  /** The finding being edited (left out of suggestions and the linked count). */
  selfId?: string;
  /** Lines for a description; 1 gives a single-line box (titles). */
  rows?: number;
  disabled?: boolean;
  /** A finding still being created: typing gives it its own wording rather than editing the shared one. */
  unsaved?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const others = useMemo(() => findings.filter((f) => f.id !== selfId), [findings, selfId]);
  const all = useMemo(() => repo.wordingSuggestions(others, field), [others, field]);
  // no suggestions while linked: typing then edits the shared wording, it is not a search
  const matches = useMemo(() => (open && !disabled && !link ? repo.matchWording(all, value) : []), [all, value, link, open, disabled]);
  const linkKey = field === 'title' ? 'titleLinkId' : 'descriptionLinkId';
  const linkedTo = !link ? [] : link.linkId ? others.filter((f) => f[linkKey] === link.linkId) : others.filter((f) => !f[linkKey] && f[field] === link.text);
  const pick = (s: repo.WordingSuggestion) => { setOpen(false); onPick({ text: s.text, linkId: s.linkId }); };

  const boxProps = {
    value, disabled, autoFocus, role: 'combobox', 'aria-autocomplete': 'list' as const, 'aria-expanded': matches.length > 0,
    'aria-controls': `${id}-list`, 'aria-activedescendant': matches.length ? `${id}-${active}` : undefined,
    onChange: (e: { target: { value: string } }) => { onType(e.target.value); setOpen(true); setActive(0); },
    onFocus: () => setOpen(true), onBlur: () => setOpen(false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (!matches.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pick(matches[Math.min(active, matches.length - 1)]); }
      else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    },
  };

  return (
    <div className="desc-field" data-field={field}>
      <label>{label}
        {rows > 1 ? <textarea rows={rows} {...boxProps} /> : <input enterKeyHint="done" {...boxProps} />}
      </label>
      {matches.length > 0 && (
        <ul className="desc-suggest" role="listbox" id={`${id}-list`} aria-label={field === 'title' ? 'Titles already used' : 'Wording already used'}>
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
        <div className="desc-link small" role="status" data-testid={`${field}-link`}>
          <span>🔗 Linked {NOUN[field]}, shared with {linkedTo.length} other finding{linkedTo.length === 1 ? '' : 's'} ({linkedTo.slice(0, 4).map((f) => f.reference).join(', ')}{linkedTo.length > 4 ? '…' : ''}).
            {unsaved ? ' Typing here gives this finding its own instead.' : ' Editing it changes all of them.'}</span>
          <button type="button" disabled={disabled} onClick={onUnlink} aria-label={`Make ${field} unique`}
            title={`Keep this ${NOUN[field]} but stop sharing it, so this finding can say something different`}>Make unique</button>
        </div>
      )}
    </div>
  );
}
