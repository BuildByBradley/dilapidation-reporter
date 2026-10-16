import { useEffect, useRef, useState } from 'react';
import { Dialog, useObjectUrl } from '../../components/ui';
import { canvasToBlob, scaled } from '../../lib/imaging';
import { createRecognizer, speechSupported, type Recognizer } from '../../lib/speech';
import { SEVERITIES, LIMITS, type Category, type Severity } from '../../lib/types';
import { suggestFromSpeech, tidyTranscript } from '../../lib/voiceDraft';

export type QuickCaptureResult = { frames: Blob[]; transcript: string; categoryId?: string; severity?: Severity };
type Frame = { blob: Blob; keep: boolean };
type Phase = 'starting' | 'ready' | 'recording' | 'review' | 'error';

const MAX_FRAMES = 3;

function Preview({ blob, keep, onToggle, index }: { blob: Blob; keep: boolean; onToggle(): void; index: number }) {
  const url = useObjectUrl(blob);
  return (
    <label className="qc-frame">
      {url && <img src={url} alt={`Captured frame ${index + 1}`} style={{ opacity: keep ? 1 : 0.35 }} />}
      <input type="checkbox" checked={keep} onChange={onToggle} aria-label={`Keep frame ${index + 1}`} /> Keep
    </label>
  );
}

/**
 * Hold the button while pointing the camera and speaking. Nothing is recorded to disk: a few still frames are
 * taken from the live preview and the speech is transcribed, so there is no video file to store.
 */
export function QuickCaptureDialog({ categories, currentCategoryId, currentSeverity, onAccept, onClose }: {
  categories: Category[]; currentCategoryId: string; currentSeverity: Severity;
  onAccept(r: QuickCaptureResult): Promise<void>; onClose(): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const recRef = useRef<Recognizer | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const framesRef = useRef<Frame[]>([]);
  const pressedAt = useRef(0);
  const [phase, setPhase] = useState<Phase>('starting');
  const [message, setMessage] = useState('');
  const [live, setLive] = useState('');
  const [frames, setFrames] = useState<Frame[]>([]);
  const [text, setText] = useState('');
  const [catId, setCatId] = useState('');
  const [sev, setSev] = useState<Severity | ''>('');
  const [saving, setSaving] = useState(false);
  const speech = speechSupported();

  const stopStream = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const startCamera = async () => {
    stopStream();
    const mine = ++generation.current;
    setPhase('starting');
    if (!navigator.mediaDevices?.getUserMedia) { setMessage('The camera is not available here. Add photos with the normal buttons instead.'); setPhase('error'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
      if (mine !== generation.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      setPhase('ready');
    } catch (e) {
      if (mine !== generation.current) return;
      const name = (e as { name?: string })?.name;
      setMessage(!window.isSecureContext ? 'The camera needs HTTPS (or localhost).' : name === 'NotAllowedError' || name === 'SecurityError' ? 'Camera permission was denied. Allow it in the browser settings, or add photos with the normal buttons.' : 'The camera could not be started. Add photos with the normal buttons instead.');
      setPhase('error');
    }
  };
  useEffect(() => { void startCamera(); return () => { generation.current++; clearTimers(); recRef.current?.abort(); stopStream(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grab = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || framesRef.current.length >= MAX_FRAMES) return;
    const blob = await canvasToBlob(scaled(v, v.videoWidth, v.videoHeight, LIMITS.photoSaverEdge, false), 'image/jpeg', 0.85);
    framesRef.current = [...framesRef.current, { blob, keep: true }];
  };

  const begin = () => {
    if (phase !== 'ready') return;
    framesRef.current = []; setLive(''); pressedAt.current = Date.now();
    setPhase('recording');
    void grab();
    timers.current = [setTimeout(() => void grab(), 2500), setTimeout(() => void grab(), 5000)];
    recRef.current = createRecognizer((final, interim) => setLive(`${final} ${interim}`.trim()), (code) => setMessage(`Voice-to-text stopped (${code}). You can type the note instead.`));
    recRef.current?.start();
  };
  const finish = async () => {
    if (phase !== 'recording') return;
    clearTimers();
    const held = Date.now() - pressedAt.current;
    await grab(); // always include a frame from the moment of release
    const raw = (await recRef.current?.stop()) ?? '';
    recRef.current = null;
    if (held < 400 && !raw) { // an accidental tap, not a capture
      framesRef.current = []; setPhase('ready'); setMessage('Hold the button down while you speak.'); return;
    }
    const spoken = tidyTranscript(raw || live);
    const sug = suggestFromSpeech(spoken, categories);
    setFrames(framesRef.current); setText(spoken);
    setCatId(sug.categoryId && sug.categoryId !== currentCategoryId ? sug.categoryId : '');
    setSev(sug.severity && currentSeverity === 'not_assessed' && sug.severity !== currentSeverity ? sug.severity : '');
    stopStream(); setMessage(''); setPhase('review');
  };

  const kept = frames.filter((f) => f.keep);
  const usable = categories.filter((c) => !c.archived || c.id === currentCategoryId);
  const accept = async () => {
    setSaving(true);
    try { await onAccept({ frames: kept.map((f) => f.blob), transcript: text.trim(), categoryId: catId || undefined, severity: sev || undefined }); onClose(); }
    finally { setSaving(false); }
  };

  return (
    <Dialog title="Quick capture" wide dismissible={phase !== 'recording'} onClose={onClose}
      footer={phase === 'review' ? <>
        <button onClick={() => { framesRef.current = []; setFrames([]); setText(''); setLive(''); void startCamera(); }}>Redo</button>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" disabled={saving || (!kept.length && !text.trim())} onClick={accept}>Add to finding</button>
      </> : <button onClick={onClose} disabled={phase === 'recording'}>Cancel</button>}>
      {phase === 'error' && <div role="alert"><p className="error">{message}</p></div>}
      {phase !== 'review' && phase !== 'error' && (
        <>
          <video ref={videoRef} className="qc-video" playsInline muted aria-label="Camera preview" />
          <button
            className={`qc-hold${phase === 'recording' ? ' rec' : ''}`} disabled={phase === 'starting'}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); begin(); }}
            onPointerUp={() => void finish()} onPointerCancel={() => void finish()}
            onContextMenu={(e) => e.preventDefault()}
            onClick={(e) => { if (e.detail === 0) { if (phase === 'recording') void finish(); else begin(); } }} // keyboard: press to start, press again to stop
            aria-pressed={phase === 'recording'}>
            {phase === 'starting' ? 'Starting camera…' : phase === 'recording' ? 'Recording… release to finish' : 'Hold to capture and speak'}
          </button>
          <p className="qc-live small" aria-live="polite" data-testid="qc-live">{live || (speech ? 'Point at the defect, hold the button and describe it.' : 'Voice-to-text is not available in this browser. Frames will be captured and you can type the note next.')}</p>
          {message && <p className="small" role="status">{message}</p>}
        </>
      )}
      {phase === 'review' && (
        <>
          <div className="qc-frames">{frames.map((f, i) => <Preview key={i} index={i} blob={f.blob} keep={f.keep} onToggle={() => setFrames((s) => s.map((x, j) => (j === i ? { ...x, keep: !x.keep } : x)))} />)}</div>
          <label>What you said (edit freely)<textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="two">
            <label>Category<select value={catId} onChange={(e) => setCatId(e.target.value)}>
              <option value="">Keep current</option>
              {usable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
            <label>Severity<select value={sev} onChange={(e) => setSev(e.target.value as Severity | '')}>
              <option value="">Keep current</option>
              {SEVERITIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
          </div>
          <p className="small muted">Category and severity are only suggestions picked up from your words. Nothing changes until you press Add. No video is stored — only the frames you keep.</p>
        </>
      )}
      {speech && phase !== 'review' && <p className="small muted">Voice-to-text uses your browser&apos;s speech service, which may send audio to its provider.</p>}
    </Dialog>
  );
}
