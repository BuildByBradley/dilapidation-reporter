import { useRef, useState } from 'react';
import { prepareLogo } from '../../lib/imaging';
import { inspectorLabel, useProfile } from '../../sync/cloud';

/** Inspector: the signed-in person's "Name - Company" is offered with one tap. */
export function InspectorField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const me = inspectorLabel(useProfile());
  return (
    <label>Inspector
      <input value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} placeholder={me || 'Name - Company'} />
      {me && me !== value && !disabled && <button type="button" className="link small" onClick={() => onChange(me)}>Use “{me}”</button>}
    </label>
  );
}

/** Company logo for the report cover: shown top right, beside the title. */
export function LogoField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="span2 logo-field">
      <span className="field-label">Company logo <span className="muted small">(top right of the report cover — optional)</span></span>
      <div className="row">
        {value ? <img src={value} alt="Company logo" className="logo-preview" data-testid="logo-preview" /> : <span className="muted small">No logo.</span>}
        <button type="button" disabled={disabled || busy} onClick={() => file.current?.click()}>{busy ? 'Preparing…' : value ? 'Replace logo…' : 'Add logo…'}</button>
        {value && <button type="button" className="danger" disabled={disabled || busy} onClick={() => onChange('')}>Remove</button>}
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Logo file" onChange={(e) => {
        const f = e.target.files?.[0]; e.target.value = '';
        if (!f) return;
        setBusy(true); setError(null);
        prepareLogo(f).then(onChange).catch((err) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
      }} />
      {error && <p className="error small" role="alert">{error}</p>}
    </div>
  );
}
