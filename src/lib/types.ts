export type Severity = 'not_assessed' | 'minor' | 'moderate' | 'major';
export const SEVERITIES: { value: Severity; label: string }[] = [
  { value: 'not_assessed', label: 'Not assessed' },
  { value: 'minor', label: 'Minor' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'major', label: 'Major' },
];
export const severityLabel = (s: Severity) => SEVERITIES.find((x) => x.value === s)?.label ?? s;

export type Project = {
  id: string; name: string; siteName: string; address: string;
  client: string; inspector: string; inspectionDate: string;
  reference: string; notes: string; nextFindingNumber: number;
  isSample?: boolean;
  createdAt: string; updatedAt: string;
};
export type Floor = {
  id: string; projectId: string; name: string; order: number;
  planAssetId?: string; displayWidth: number;
  sourcePage?: number; createdAt: string; updatedAt: string;
};
export type Finding = {
  id: string; projectId: string; floorId: string; reference: string;
  u: number; v: number; categoryId: string; severity: Severity;
  title: string; description: string; locationNotes: string;
  locationNeedsReview: boolean; createdAt: string; updatedAt: string;
};
export type Category = {
  id: string; projectId: string; name: string; colour: string;
  order: number; archived: boolean;
};
export type Photo = {
  id: string; findingId: string; projectId: string; assetId: string; caption: string;
  order: number; isCover: boolean; createdAt: string;
};
export type Asset = {
  id: string; projectId: string; kind: 'plan' | 'photo';
  filename: string; mime: string; width: number; height: number;
  originalBlobId: string; displayBlobId: string; thumbnailBlobId: string;
  reportBlobId?: string; orientation?: number; sizeBytes?: number;
  sourcePage?: number; sourceMime?: string; createdAt: string;
};
export type BlobRecord = { id: string; projectId: string; data: Blob };

export type ViewerMode =
  | { kind: 'overview3d' }
  | { kind: 'isolated3d'; floorId: string }
  | { kind: 'floor2d'; floorId: string };
export type InteractionMode =
  | { kind: 'navigate' }
  | { kind: 'placePin' }
  | { kind: 'relocatePin'; findingId: string };

export const DEFAULT_FLOOR_NAMES = ['Ground', 'Level 1', 'Level 2', 'Level 3', 'Level 4'];
export const FLOOR_COUNT = 5;
export const STARTER_CATEGORIES: { name: string; colour: string }[] = [
  { name: 'Cracks', colour: '#c0392b' },
  { name: 'Moisture / water damage', colour: '#1f77b4' },
  { name: 'Finishes', colour: '#8e44ad' },
  { name: 'Doors / windows', colour: '#d35400' },
  { name: 'Floors', colour: '#7f6000' },
  { name: 'Ceilings', colour: '#16807a' },
  { name: 'External works', colour: '#2e7d32' },
  { name: 'Other', colour: '#555555' },
];
export const LIMITS = {
  maxPlanBytes: 50 * 1024 * 1024,
  maxPlanMegapixels: 20,
  maxPhotoBytes: 20 * 1024 * 1024,
  planReportEdge: 4096,
  planViewerEdge: 2048,
  photoReportEdge: 2560,
  thumbEdge: 256,
  maxBackupExpandedBytes: 1024 * 1024 * 1024,
  pdfPreviewPageLimit: 60,
};
export const BACKUP_VERSION = 1;
