import { useSaveState } from '../data/saveStatus';

export function SaveIndicator() {
  const s = useSaveState();
  const text = s.kind === 'saving' ? 'Saving…' : s.kind === 'saved' ? `Saved ${new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : s.kind === 'failed' ? 'Save failed' : 'All changes saved';
  return (
    <span className={`save-status ${s.kind}`} role="status" aria-live="polite" data-testid="save-status" title={s.kind === 'failed' ? s.message : undefined}>
      <span className="dot" aria-hidden="true" />{text}{s.kind === 'failed' && <span className="save-msg"> — {s.message}</span>}
    </span>
  );
}
