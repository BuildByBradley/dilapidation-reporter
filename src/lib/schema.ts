import { z } from 'zod';
import { BACKUP_VERSION } from './types';

const uv = z.number().finite().min(0).max(1);
const str = z.string();
export const manifestSchema = z.object({
  app: z.literal('dilapidation-inspector'),
  version: z.number().int().min(1).max(BACKUP_VERSION),
  exportedAt: str,
  project: z.object({
    id: str, name: str, siteName: str, address: str, client: str, inspector: str, inspectionDate: str,
    reference: str, notes: str, nextFindingNumber: z.number().int().min(1), isSample: z.boolean().optional(), createdAt: str, updatedAt: str,
  }),
  floors: z.array(z.object({
    id: str, projectId: str, name: str, order: z.number().int(), planAssetId: str.optional(),
    displayWidth: z.number().positive().finite(), sourcePage: z.number().int().optional(), createdAt: str, updatedAt: str,
  })),
  categories: z.array(z.object({ id: str, projectId: str, name: str, colour: str, order: z.number().int(), archived: z.boolean() })),
  findings: z.array(z.object({
    id: str, projectId: str, floorId: str, reference: str, u: uv, v: uv, categoryId: str,
    severity: z.enum(['not_assessed', 'minor', 'moderate', 'major']), title: str, description: str, locationNotes: str,
    locationNeedsReview: z.boolean(), createdAt: str, updatedAt: str,
  })),
  photos: z.array(z.object({
    id: str, findingId: str, projectId: str, assetId: str, caption: str, order: z.number().int(), isCover: z.boolean(), createdAt: str,
  })),
  assets: z.array(z.object({
    id: str, projectId: str, kind: z.enum(['plan', 'photo']), filename: str, mime: str,
    width: z.number().int().positive(), height: z.number().int().positive(),
    originalBlobId: str, displayBlobId: str, thumbnailBlobId: str, reportBlobId: str.optional(),
    sourcePage: z.number().int().optional(), sourceMime: str.optional(), orientation: z.number().int().optional(),
    sizeBytes: z.number().optional(), createdAt: str,
  })),
  /** blobId -> relative path inside the zip */
  blobs: z.record(str, str),
});
export type Manifest = z.infer<typeof manifestSchema>;
