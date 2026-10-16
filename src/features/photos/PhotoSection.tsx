import { useEffect, useRef, useState } from 'react';
import { Thumb } from '../../components/Thumb';
import { Dialog, useObjectUrl, useToast } from '../../components/ui';
import { db } from '../../data/db';
import * as repo from '../../data/repo';
import { useStoredBlob } from '../../data/useBlob';
import { processPhoto, ImportError } from '../../lib/imaging';
import { useLive } from '../../lib/useLive';
import type { Photo } from '../../lib/types';
import { PhotoMarkup } from './PhotoMarkup';

export function Lightbox({ photo, onClose }: { photo: Photo; onClose: () => void }) {
  const [asset] = useLive(() => db.assets.get(photo.assetId), [photo.assetId], undefined);
  const blob = useStoredBlob(asset?.displayBlobId);
  const url = useObjectUrl(blob);
  return (
    <Dialog title="Photo" wide onClose={onClose}>
      {url ? <img className="lightbox-img" src={url} alt={photo.caption || 'Finding photo'} /> : <p>Loading…</p>}
      {photo.caption && <p>{photo.caption}</p>}
    </Dialog>
  );
}

type CamState = { phase: 'starting' } | { phase: 'live' } | { phase: 'review'; blob: Blob; marked?: boolean } | { phase: 'markup'; blob: Blob } | { phase: 'error'; message: string };

function cameraErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (!window.isSecureContext) return 'The camera needs a secure context (HTTPS or localhost). A plain HTTP network address is not allowed by browsers. Use "Take photo with device camera" below or upload files instead.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. You can allow it in the browser settings, or use the device-camera file picker / upload instead.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Upload photos instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another application.';
  return 'The camera could not be started. Upload photos instead.';
}

export function CameraDialog({ onAccept, onClose, onFallback }: { onAccept(blob: Blob): Promise<void>; onClose(): void; onFallback(): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CamState>({ phase: 'starting' });
  const [saving, setSaving] = useState(false);
  const reviewUrl = useObjectUrl(state.phase === 'review' ? state.blob : null);
  const generation = useRef(0);
  const stop = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };

  const start = async () => {
    stop();
    const mine = ++generation.current;
    setState({ phase: 'starting' });
    if (!navigator.mediaDevices?.getUserMedia) { setState({ phase: 'error', message: cameraErrorMessage(null) }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 } }, audio: false });
      // A newer start/stop (retake, close, React StrictMode remount) superseded this request: release the camera now.
      if (mine !== generation.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play().catch(() => {}); }
      setState({ phase: 'live' });
    } catch (e) { if (mine === generation.current) setState({ phase: 'error', message: cameraErrorMessage(e) }); }
  };
  useEffect(() => { void start(); return () => { generation.current++; stop(); }; }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
    stop(); // release the camera as soon as a frame is captured
    if (blob) setState({ phase: 'review', blob }); else setState({ phase: 'error', message: 'Could not capture the frame.' });
  };

  return (
    <Dialog title={state.phase === 'markup' ? 'Draw on photo' : 'Take photo'} wide onClose={() => { stop(); onClose(); }}
      footer={state.phase === 'markup' ? undefined : <>
        <button onClick={() => { stop(); onClose(); }}>Cancel</button>
        {state.phase === 'live' && <button className="primary" onClick={capture}>Capture</button>}
        {state.phase === 'review' && <><button onClick={start}>Retake</button><button onClick={() => setState({ phase: 'markup', blob: state.blob })}>✎ {state.marked ? 'Edit drawing' : 'Draw on photo'}</button><button className="primary" disabled={saving} onClick={async () => { setSaving(true); try { await onAccept(state.blob); stop(); onClose(); } finally { setSaving(false); } }}>Use photo</button></>}
      </>}>
      {state.phase === 'error' && (
        <div role="alert"><p className="error">{state.message}</p><button className="primary" onClick={() => { stop(); onClose(); onFallback(); }}>Take photo with device camera (file picker)</button></div>
      )}
      <video ref={videoRef} className="camera-video" playsInline muted hidden={state.phase !== 'live' && state.phase !== 'starting'} aria-label="Camera preview" />
      {state.phase === 'starting' && <p role="status">Starting camera…</p>}
      {state.phase === 'review' && reviewUrl && <img className="camera-video" src={reviewUrl} alt="Captured photo preview" />}
      {state.phase === 'markup' && <PhotoMarkup src={state.blob} onCancel={() => setState({ phase: 'review', blob: state.blob })} onDone={(b) => setState({ phase: 'review', blob: b, marked: true })} />}
    </Dialog>
  );
}

export function PhotoSection({ findingId, photos, readOnly }: { findingId: string; photos: Photo[]; readOnly: boolean }) {
  const toast = useToast();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [viewing, setViewing] = useState<Photo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const guard = (p: Promise<unknown>) => p.catch((e) => toast('error', e instanceof Error ? e.message : String(e)));

  async function addFiles(files: File[]) {
    for (const f of files) {
      setBusy(`Processing ${f.name}…`);
      try {
        const img = await processPhoto(f, f.name || 'photo.jpg', { onProgress: (_p, l) => setBusy(`${f.name}: ${l}`) });
        await repo.addPhoto(findingId, img);
      } catch (e) {
        toast('error', e instanceof ImportError ? e.message : `Could not attach "${f.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
  }

  return (
    <section className="photos" aria-label="Photographs">
      <h3>Photographs ({photos.length})</h3>
      {!readOnly && (
        <div className="row">
          <button onClick={() => setCameraOpen(true)}>Take photo</button>
          <button onClick={() => uploadRef.current?.click()}>Upload photos</button>
          <input ref={uploadRef} hidden type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png,.heic,.heif" aria-label="Upload photos" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          <input ref={captureRef} hidden type="file" accept="image/*" capture="environment" aria-label="Device camera capture" onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>
      )}
      {busy && <p className="small" role="status">{busy}</p>}
      <ul className="photo-list">
        {photos.map((p, i) => (
          <li key={p.id} data-testid="photo-item">
            <button className="photo-open" onClick={() => setViewing(p)} aria-label={`Open photo ${i + 1} full size`}><Thumb assetId={p.assetId} alt={p.caption || `Photo ${i + 1}`} className="photo-thumb" /></button>
            <div className="photo-meta">
              <CaptionInput photo={p} readOnly={readOnly} />
              <div className="row small">
                {p.isCover ? <span className="tag">Cover</span> : <button disabled={readOnly} onClick={() => guard(repo.setPhotoCover(p.id))}>Make cover</button>}
                <button disabled={readOnly || i === 0} aria-label={`Move photo ${i + 1} earlier`} onClick={() => guard(repo.movePhoto(p.id, -1))}>←</button>
                <button disabled={readOnly || i === photos.length - 1} aria-label={`Move photo ${i + 1} later`} onClick={() => guard(repo.movePhoto(p.id, 1))}>→</button>
                <button className="danger" disabled={readOnly} onClick={() => guard(repo.deletePhoto(p.id))}>Delete</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {cameraOpen && <CameraDialog onClose={() => setCameraOpen(false)} onFallback={() => captureRef.current?.click()}
        onAccept={async (blob) => { await addFiles([new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })]); }} />}
      {viewing && <Lightbox photo={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

function CaptionInput({ photo, readOnly }: { photo: Photo; readOnly: boolean }) {
  const [v, setV] = useState(photo.caption);
  useEffect(() => setV(photo.caption), [photo.caption]);
  return <input aria-label="Photo caption" placeholder="Caption" value={v} disabled={readOnly} onChange={(e) => setV(e.target.value)} onBlur={() => { if (v !== photo.caption) void repo.updatePhotoCaption(photo.id, v); }} />;
}
