import { useEffect, useState } from 'react';
import { getBlob } from './repo';

/** Load a stored blob lazily (thumbnails/derivatives only — never originals during browsing). */
export function useStoredBlob(id: string | undefined): Blob | undefined {
  const [blob, setBlob] = useState<Blob>();
  useEffect(() => {
    let live = true;
    setBlob(undefined);
    if (id) getBlob(id).then((b) => { if (live) setBlob(b); });
    return () => { live = false; };
  }, [id]);
  return blob;
}
