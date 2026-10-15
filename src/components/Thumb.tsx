import { useLive } from '../lib/useLive';
import { db } from '../data/db';
import { useStoredBlob } from '../data/useBlob';
import { useObjectUrl } from './ui';

export function Thumb({ assetId, variant = 'thumbnail', alt, className, onClick }: { assetId?: string; variant?: 'thumbnail' | 'display'; alt: string; className?: string; onClick?: () => void }) {
  const [asset] = useLive(() => (assetId ? db.assets.get(assetId) : Promise.resolve(undefined)), [assetId], undefined);
  const blob = useStoredBlob(variant === 'thumbnail' ? asset?.thumbnailBlobId : asset?.displayBlobId);
  const url = useObjectUrl(blob);
  if (!url) return <div className={`thumb placeholder ${className ?? ''}`} aria-label={alt} />;
  return <img className={`thumb ${className ?? ''}`} src={url} alt={alt} loading="lazy" decoding="async" onClick={onClick} draggable={false} />;
}
