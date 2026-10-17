import { useMemo, useRef, useState, type ReactNode } from 'react';
import { HELP_GUIDE } from '../../supabase/functions/assistant/guide';
import { askAssistant, sendFeedback, useCloudState, type HelpTurn } from '../sync/cloud';
import { Dialog } from './ui';

type Tab = 'ask' | 'guide' | 'suggest';
type Section = { title: string; body: string };

/** Split the guide into its "## " sections. */
function sections(): Section[] {
  return HELP_GUIDE.split(/\n(?=## )/).slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    return { title: head.replace(/^##\s*/, ''), body: rest.join('\n').trim() };
  });
}

/** Tiny renderer for the guide's markdown subset: paragraphs, "- " bullets, "1. " steps, indented sub-bullets. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: ReactNode[] } | null = null;
  const flush = () => { if (list) { out.push(list.ordered ? <ol key={out.length}>{list.items}</ol> : <ul key={out.length}>{list.items}</ul>); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const sub = /^\s{2,}- (.*)$/.exec(line), bullet = /^- (.*)$/.exec(line), step = /^\d+\. (.*)$/.exec(line);
    if (sub && list) { list.items.push(<li key={list.items.length} className="sub">{sub[1]}</li>); continue; }
    if (bullet || step) {
      const ordered = !!step;
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(<li key={list.items.length}>{(bullet ?? step)![1]}</li>);
      continue;
    }
    flush();
    if (line.trim()) out.push(<p key={out.length}>{line}</p>);
  }
  flush();
  return <>{out}</>;
}

function Guide() {
  const all = useMemo(sections, []);
  const [q, setQ] = useState('');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? all.filter((s) => words.every((w) => `${s.title} ${s.body}`.toLowerCase().includes(w))) : all;
  return (
    <div className="help-guide">
      <input type="search" placeholder="Search the guide (e.g. sync, photo, share)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the guide" />
      {shown.length === 0 && <p className="muted">Nothing found. Try the Ask tab, or other words.</p>}
      {shown.map((s) => (
        <details key={s.title} open={words.length > 0}>
          <summary>{s.title}</summary>
          <Markdown text={s.body} />
        </details>
      ))}
    </div>
  );
}

function Ask({ signedIn }: { signedIn: boolean }) {
  const [turns, setTurns] = useState<HelpTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const ask = async () => {
    const q = draft.trim();
    if (!q || busy) return;
    const next = [...turns, { role: 'user' as const, content: q }].slice(-12);
    setTurns(next); setDraft(''); setBusy(true); setError(null);
    try {
      const answer = await askAssistant(next);
      setTurns([...next, { role: 'assistant', content: answer }]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally {
      setBusy(false);
      setTimeout(() => endRef.current?.scrollIntoView({ block: 'end' }), 0);
    }
  };
  if (!signedIn) return <p className="muted">Sign in on the projects page to ask the assistant. The <b>Guide</b> tab works without signing in.</p>;
  return (
    <div className="help-ask">
      {turns.length === 0 && (
        <div className="muted small">
          <p>Ask how to do something in the app, for example:</p>
          <div className="row">
            {['How do I share a project?', 'How do I get my phone findings onto my PC?', 'How do I draw on a photo?'].map((s) => <button key={s} className="chip" onClick={() => setDraft(s)}>{s}</button>)}
          </div>
        </div>
      )}
      <div className="chat" aria-live="polite">
        {turns.map((t, i) => <div key={i} className={`bubble ${t.role}`}>{t.role === 'assistant' ? <Markdown text={t.content} /> : t.content}</div>)}
        {busy && <div className="bubble assistant muted">Thinking…</div>}
        <div ref={endRef} />
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <textarea rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type your question…" aria-label="Your question"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
        <button className="primary" type="submit" disabled={busy || !draft.trim()}>Ask</button>
      </form>
      <p className="small muted">Answers come from an AI assistant using the app's guide and can be wrong — check before relying on them. Questions are sent to Anthropic to answer them.</p>
    </div>
  );
}

function Suggest({ signedIn }: { signedIn: boolean }) {
  const [kind, setKind] = useState<'idea' | 'bug' | 'question'>('idea');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!signedIn) return <p className="muted">Sign in on the projects page to send a suggestion, so the developer can reply to you.</p>;
  if (done) return <div><p className="ok" role="status">{done}</p><button onClick={() => { setDone(null); setMessage(''); }}>Send another</button></div>;
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await sendFeedback(kind, message, window.location.hash || '#/');
      setDone('Thank you — sent to the developer.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <form className="help-suggest" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <div className="row" role="radiogroup" aria-label="Type">
        <label className="inline"><input type="radio" checked={kind === 'idea'} onChange={() => setKind('idea')} /> Improvement idea</label>
        <label className="inline"><input type="radio" checked={kind === 'bug'} onChange={() => setKind('bug')} /> Something is wrong</label>
        <label className="inline"><input type="radio" checked={kind === 'question'} onChange={() => setKind('question')} /> Question</label>
      </div>
      <label>What should be better?<textarea rows={6} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000}
        placeholder={kind === 'bug' ? 'What did you do, what happened, and what did you expect? Which phone/computer and browser?' : 'Describe the change and why it would help on site or in the office.'} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy || message.trim().length < 3}>{busy ? 'Sending…' : 'Send to the developer'}</button>
      <p className="small muted">Your email address is included so the developer can reply.</p>
    </form>
  );
}

/** "?" button for top bars; opens Help with Ask / Guide / Suggest an improvement. */
export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('ask');
  const cloud = useCloudState();
  const signedIn = cloud.kind !== 'signedOut' && cloud.kind !== 'unavailable';
  return (
    <>
      <button className="help-btn" aria-label="Help" title="Help, guide and suggestions" onClick={() => setOpen(true)}>?</button>
      {open && (
        <Dialog title="Help" wide onClose={() => setOpen(false)}>
          <div className="tabs" role="tablist">
            {([['ask', 'Ask'], ['guide', 'Guide'], ['suggest', 'Suggest an improvement']] as [Tab, string][]).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          <div role="tabpanel">
            {tab === 'ask' && <Ask signedIn={signedIn} />}
            {tab === 'guide' && <Guide />}
            {tab === 'suggest' && <Suggest signedIn={signedIn} />}
          </div>
        </Dialog>
      )}
    </>
  );
}
