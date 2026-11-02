import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Toast = { id: number; kind: 'info' | 'error' | 'ok'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, kind, text }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
            {t.text}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setItems((s) => s.filter((x) => x.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Dialog({ title, onClose, children, wide, footer, dismissible = true }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; dismissible?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[autofocus], input, select, textarea, button.primary, button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); prev?.focus?.(); };
  }, [onClose, dismissible]);
  // Rendered at the top of the page: a dialog opened from inside a panel (e.g. the camera from the new-pin sheet)
  // must not stay under the panel's layer or the plan's tool bar.
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissible) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="dialog-head"><h2>{title}</h2>{dismissible && <button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>}</header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, children, confirmLabel, danger, onConfirm, onCancel, extra }: { title: string; children: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void; extra?: ReactNode }) {
  return (
    <Dialog title={title} onClose={onCancel} footer={<>
      <button onClick={onCancel}>Cancel</button>
      {extra}
      <button className={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</button>
    </>}>{children}</Dialog>
  );
}

export function useObjectUrl(blob: Blob | undefined | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) { setUrl(undefined); return; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
