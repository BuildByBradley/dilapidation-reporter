import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { manifestSchema, type Manifest } from './schema';
import { BACKUP_VERSION, LIMITS } from './types';
import { assertBundleIntegrity, RepoError, type ProjectBundle } from '../data/repo';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf', 'image/webp': 'webp' };

export class BackupError extends Error {}

export function isSafePath(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && !/^[a-zA-Z]:/.test(p) && !p.split('/').some((s) => s === '..' || s === '' || s === '.');
}

export async function createBackup(b: ProjectBundle): Promise<Uint8Array> {
  const files: Zippable = {};
  const blobs: Record<string, string> = {};
  for (const [id, blob] of b.blobs) {
    const path = `blobs/${id}.${EXT[blob.type] ?? 'bin'}`;
    blobs[id] = path;
    files[path] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]; // already-compressed images
  }
  const manifest: Manifest = {
    app: 'dilapidation-inspector', version: BACKUP_VERSION, exportedAt: new Date().toISOString(),
    project: b.project, floors: b.floors, categories: b.categories, findings: b.findings, photos: b.photos, assets: b.assets, blobs,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  files['README.txt'] = strToU8(
    'Dilapidation Inspector project backup.\nmanifest.json describes the project; blobs/ holds original plans, display derivatives, thumbnails and photo originals.\n' +
    'Original photo files are retained as captured and may contain embedded location (GPS) metadata. Report/display derivatives do not.\n');
  return zipSync(files);
}

/** Parse and validate a backup. Throws BackupError with a user-readable reason; never touches the database. */
export function parseBackup(data: Uint8Array): ProjectBundle {
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (f) => {
        total += f.originalSize;
        if (total > LIMITS.maxBackupExpandedBytes) throw new BackupError('Backup is too large when expanded and was rejected for safety.');
        if (!isSafePath(f.name)) throw new BackupError(`Backup contains an unsafe file path: "${f.name}".`);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('This file is not a valid backup archive (it could not be read as a zip file).');
  }
  const raw = files['manifest.json'];
  if (!raw) throw new BackupError('Backup is missing manifest.json.');
  let json: unknown;
  try { json = JSON.parse(strFromU8(raw)); } catch { throw new BackupError('Backup manifest is corrupt (invalid JSON).'); }
  const v = (json as { version?: unknown })?.version;
  if (typeof v === 'number' && v > BACKUP_VERSION) {
    throw new BackupError(`This backup was made by a newer version of the app (format ${v}); this version supports up to ${BACKUP_VERSION}.`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BackupError(`Backup manifest is invalid at "${issue.path.join('.')}": ${issue.message}`);
  }
  const m = parsed.data;
  const blobs = new Map<string, Blob>();
  const mimeOf = new Map<string, string>();
  for (const a of m.assets) {
    mimeOf.set(a.originalBlobId, a.mime);
    mimeOf.set(a.displayBlobId, a.kind === 'plan' ? 'image/png' : 'image/jpeg');
    mimeOf.set(a.thumbnailBlobId, 'image/jpeg');
    if (a.reportBlobId) mimeOf.set(a.reportBlobId, 'image/png');
  }
  for (const [id, path] of Object.entries(m.blobs)) {
    if (!isSafePath(path)) throw new BackupError(`Backup lists an unsafe asset path: "${path}".`);
    const bytes = files[path];
    if (!bytes) throw new BackupError(`Backup is missing an asset file: ${path}.`);
    const ext = path.split('.').pop() ?? '';
    const type = Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? mimeOf.get(id) ?? 'application/octet-stream';
    blobs.set(id, new Blob([bytes as BlobPart], { type }));
  }
  const bundle: ProjectBundle = {
    project: m.project, floors: m.floors, categories: m.categories, findings: m.findings,
    photos: m.photos, assets: m.assets, blobs,
  };
  try { assertBundleIntegrity(bundle); } catch (e) {
    throw new BackupError(`Backup is inconsistent: ${e instanceof RepoError ? e.message : String(e)}`);
  }
  // a project must not point at ids from another project
  const pid = m.project.id;
  if ([...m.floors, ...m.findings, ...m.categories, ...m.assets, ...m.photos].some((x) => x.projectId !== pid)) {
    throw new BackupError('Backup is inconsistent: records belong to a different project.');
  }
  return bundle;
}
