import { db } from './db';
import { tracked } from './saveStatus';
import { formatReference, nowIso, uuid } from '../lib/ids';
import { isValidUv } from '../lib/coords';
import {
  DEFAULT_FLOOR_NAMES, FLOOR_COUNT, STARTER_CATEGORIES,
  type Asset, type BlobRecord, type Category, type Finding, type Floor, type Photo, type Project, type Severity,
} from '../lib/types';

export type ProcessedImage = {
  filename: string; mime: string; width: number; height: number;
  original: Blob; display: Blob; thumbnail: Blob; report?: Blob;
  sourcePage?: number; orientation?: number;
};

export type ProjectBundle = {
  project: Project; floors: Floor[]; categories: Category[]; findings: Finding[];
  photos: Photo[]; assets: Asset[]; blobs: Map<string, Blob>;
};

export class RepoError extends Error {}

// ---------- projects ----------
export type ProjectInput = Partial<Pick<Project, 'name' | 'siteName' | 'address' | 'client' | 'inspector' | 'inspectionDate' | 'reference' | 'notes'>>;

export async function createProject(input: ProjectInput = {}, opts: { isSample?: boolean } = {}): Promise<Project> {
  return tracked(async () => {
    const t = nowIso();
    const project: Project = {
      id: uuid(), name: input.name?.trim() || 'Untitled inspection', siteName: input.siteName ?? '', address: input.address ?? '',
      client: input.client ?? '', inspector: input.inspector ?? '', inspectionDate: input.inspectionDate || t.slice(0, 10),
      reference: input.reference ?? '', notes: input.notes ?? '', nextFindingNumber: 1, isSample: opts.isSample, createdAt: t, updatedAt: t,
    };
    const floors: Floor[] = Array.from({ length: FLOOR_COUNT }, (_, i) => ({
      id: uuid(), projectId: project.id, name: DEFAULT_FLOOR_NAMES[i], order: i, displayWidth: 100, createdAt: t, updatedAt: t,
    }));
    const categories: Category[] = STARTER_CATEGORIES.map((c, i) => ({
      id: uuid(), projectId: project.id, name: c.name, colour: c.colour, order: i, archived: false,
    }));
    await db.transaction('rw', db.projects, db.floors, db.categories, async () => {
      await db.projects.add(project);
      await db.floors.bulkAdd(floors);
      await db.categories.bulkAdd(categories);
    });
    return project;
  });
}

export async function updateProject(id: string, patch: ProjectInput): Promise<void> {
  return tracked(async () => {
    const n = await db.projects.update(id, { ...patch, updatedAt: nowIso() });
    if (!n) throw new RepoError('Project not found');
  });
}
const touch = (projectId: string) => db.projects.update(projectId, { updatedAt: nowIso() });

export type ProjectSummary = Project & { floorCount: number; findingCount: number };
export async function listProjects(): Promise<ProjectSummary[]> {
  const projects = await db.projects.orderBy('updatedAt').reverse().toArray();
  return Promise.all(projects.map(async (p) => ({
    ...p,
    floorCount: (await db.floors.where('projectId').equals(p.id).toArray()).filter((f) => f.planAssetId).length,
    findingCount: await db.findings.where('projectId').equals(p.id).count(),
  })));
}
export const getProject = (id: string) => db.projects.get(id);

export async function deleteProject(id: string): Promise<void> {
  return tracked(() => db.transaction('rw', [db.projects, db.floors, db.findings, db.categories, db.photos, db.assets, db.blobs], async () => {
    await Promise.all([
      db.floors.where('projectId').equals(id).delete(), db.findings.where('projectId').equals(id).delete(),
      db.categories.where('projectId').equals(id).delete(), db.photos.where('projectId').equals(id).delete(),
      db.assets.where('projectId').equals(id).delete(), db.blobs.where('projectId').equals(id).delete(),
    ]);
    await db.projects.delete(id);
  }));
}

// ---------- bundles (duplicate / backup / restore) ----------
export async function loadBundle(projectId: string): Promise<ProjectBundle> {
  const project = await db.projects.get(projectId);
  if (!project) throw new RepoError('Project not found');
  const [floors, categories, findings, photos, assets, blobRows] = await Promise.all([
    db.floors.where('projectId').equals(projectId).sortBy('order'),
    db.categories.where('projectId').equals(projectId).sortBy('order'),
    db.findings.where('projectId').equals(projectId).sortBy('reference'),
    db.photos.where('projectId').equals(projectId).toArray(),
    db.assets.where('projectId').equals(projectId).toArray(),
    db.blobs.where('projectId').equals(projectId).toArray(),
  ]);
  return { project, floors, categories, findings, photos, assets, blobs: new Map(blobRows.map((b) => [b.id, b.data])) };
}

/** Validate that every reference in a bundle resolves. Throws RepoError describing the first problem. */
export function assertBundleIntegrity(b: ProjectBundle): void {
  const floorIds = new Set(b.floors.map((f) => f.id)), catIds = new Set(b.categories.map((c) => c.id));
  const assetIds = new Set(b.assets.map((a) => a.id)), findingIds = new Set(b.findings.map((f) => f.id));
  for (const a of b.assets) {
    for (const id of [a.originalBlobId, a.displayBlobId, a.thumbnailBlobId, a.reportBlobId]) {
      if (id && !b.blobs.has(id)) throw new RepoError(`Missing image data for asset "${a.filename}"`);
    }
  }
  for (const f of b.floors) if (f.planAssetId && !assetIds.has(f.planAssetId)) throw new RepoError(`Floor "${f.name}" references a missing plan`);
  for (const f of b.findings) {
    if (!floorIds.has(f.floorId)) throw new RepoError(`Finding ${f.reference} references a missing floor`);
    if (!catIds.has(f.categoryId)) throw new RepoError(`Finding ${f.reference} references a missing category`);
    if (!isValidUv(f.u, f.v)) throw new RepoError(`Finding ${f.reference} has coordinates outside the plan`);
  }
  for (const p of b.photos) {
    if (!findingIds.has(p.findingId)) throw new RepoError('A photo references a missing finding');
    if (!assetIds.has(p.assetId)) throw new RepoError('A photo references a missing image');
  }
}

/** Write a bundle as a brand-new project with fresh IDs (atomic). Returns the new project. */
export async function saveBundleAsNew(b: ProjectBundle, nameSuffix = ''): Promise<Project> {
  assertBundleIntegrity(b);
  return tracked(async () => {
    const map = new Map<string, string>();
    const m = (id: string) => { let n = map.get(id); if (!n) { n = uuid(); map.set(id, n); } return n; };
    const t = nowIso();
    const project: Project = { ...b.project, id: uuid(), name: b.project.name + nameSuffix, createdAt: t, updatedAt: t };
    const pid = project.id;
    const mo = (id?: string) => (id ? m(id) : undefined);
    const floors = b.floors.map((f): Floor => ({ ...f, id: m(f.id), projectId: pid, planAssetId: mo(f.planAssetId) }));
    const categories = b.categories.map((c): Category => ({ ...c, id: m(c.id), projectId: pid }));
    const findings = b.findings.map((f): Finding => ({ ...f, id: m(f.id), projectId: pid, floorId: m(f.floorId), categoryId: m(f.categoryId) }));
    const assets = b.assets.map((a): Asset => ({
      ...a, id: m(a.id), projectId: pid, originalBlobId: m(a.originalBlobId), displayBlobId: m(a.displayBlobId),
      thumbnailBlobId: m(a.thumbnailBlobId), reportBlobId: mo(a.reportBlobId),
    }));
    const photos = b.photos.map((p): Photo => ({ ...p, id: m(p.id), projectId: pid, findingId: m(p.findingId), assetId: m(p.assetId) }));
    const blobs: BlobRecord[] = [...b.blobs].map(([id, data]) => ({ id: m(id), projectId: pid, data }));
    await db.transaction('rw', [db.projects, db.floors, db.findings, db.categories, db.photos, db.assets, db.blobs], async () => {
      await db.projects.add(project);
      await db.floors.bulkAdd(floors); await db.categories.bulkAdd(categories); await db.findings.bulkAdd(findings);
      await db.assets.bulkAdd(assets); await db.photos.bulkAdd(photos); await db.blobs.bulkAdd(blobs);
    });
    return project;
  });
}
export async function duplicateProject(id: string): Promise<Project> {
  return saveBundleAsNew(await loadBundle(id), ' (copy)');
}

// ---------- floors & plans ----------
export async function listFloors(projectId: string): Promise<Floor[]> {
  return db.floors.where('projectId').equals(projectId).sortBy('order');
}
export async function updateFloor(id: string, patch: Partial<Pick<Floor, 'name' | 'displayWidth'>>): Promise<void> {
  return tracked(async () => {
    const f = await db.floors.get(id);
    if (!f) throw new RepoError('Floor not found');
    const next = { ...patch };
    if (next.name !== undefined) next.name = next.name.trim() || f.name;
    if (next.displayWidth !== undefined && !(next.displayWidth > 0 && Number.isFinite(next.displayWidth))) delete next.displayWidth;
    await db.floors.update(id, { ...next, updatedAt: nowIso() });
    await touch(f.projectId);
  });
}
/** Swap floor order with neighbour (-1 up / +1 down). */
export async function moveFloor(id: string, dir: -1 | 1): Promise<void> {
  return tracked(() => db.transaction('rw', db.floors, db.projects, async () => {
    const f = await db.floors.get(id);
    if (!f) throw new RepoError('Floor not found');
    const all = await db.floors.where('projectId').equals(f.projectId).sortBy('order');
    const i = all.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= all.length) return;
    await db.floors.update(all[i].id, { order: all[j].order });
    await db.floors.update(all[j].id, { order: all[i].order });
    await touch(f.projectId);
  }));
}

export type ReplaceMode = 'keep' | 'remove';
/**
 * Atomically install a processed plan on a floor. All blobs are written inside one transaction;
 * if anything fails the previous plan and findings are untouched.
 */
export async function setFloorPlan(floorId: string, img: ProcessedImage, mode: ReplaceMode = 'keep'): Promise<Asset> {
  return tracked(() => db.transaction('rw', [db.projects, db.floors, db.findings, db.photos, db.assets, db.blobs], async () => {
    const floor = await db.floors.get(floorId);
    if (!floor) throw new RepoError('Floor not found');
    const t = nowIso();
    const ids = { o: uuid(), d: uuid(), t: uuid(), r: img.report ? uuid() : undefined };
    const asset: Asset = {
      id: uuid(), projectId: floor.projectId, kind: 'plan', filename: img.filename, mime: img.mime, width: img.width, height: img.height,
      originalBlobId: ids.o, displayBlobId: ids.d, thumbnailBlobId: ids.t, reportBlobId: ids.r,
      sourcePage: img.sourcePage, orientation: img.orientation, sizeBytes: img.original.size, createdAt: t,
    };
    const rows: BlobRecord[] = [
      { id: ids.o, projectId: floor.projectId, data: img.original },
      { id: ids.d, projectId: floor.projectId, data: img.display },
      { id: ids.t, projectId: floor.projectId, data: img.thumbnail },
    ];
    if (ids.r && img.report) rows.push({ id: ids.r, projectId: floor.projectId, data: img.report });
    await db.blobs.bulkAdd(rows);
    await db.assets.add(asset);
    const old = floor.planAssetId;
    await db.floors.update(floorId, { planAssetId: asset.id, sourcePage: img.sourcePage, updatedAt: t });
    if (old) {
      await removeAsset(old);
      if (mode === 'remove') {
        const fs = await db.findings.where('floorId').equals(floorId).toArray();
        for (const f of fs) await deleteFindingInTx(f.id);
      } else {
        await db.findings.where('floorId').equals(floorId).modify({ locationNeedsReview: true, updatedAt: t });
      }
    }
    await touch(floor.projectId);
    return asset;
  }));
}
async function removeAsset(assetId: string) {
  const a = await db.assets.get(assetId);
  if (!a) return;
  const refs = await db.photos.where('assetId').equals(assetId).count();
  const floorRefs = await db.floors.where('projectId').equals(a.projectId).filter((f) => f.planAssetId === assetId).count();
  if (refs + floorRefs > 0) return; // still referenced
  await db.blobs.bulkDelete([a.originalBlobId, a.displayBlobId, a.thumbnailBlobId, ...(a.reportBlobId ? [a.reportBlobId] : [])]);
  await db.assets.delete(assetId);
}
export async function countFloorFindings(floorId: string) {
  return db.findings.where('floorId').equals(floorId).count();
}

// ---------- findings ----------
export type NewFinding = {
  floorId: string; u: number; v: number; categoryId: string; title: string;
  severity?: Severity; description?: string; locationNotes?: string;
};
export async function createFinding(input: NewFinding): Promise<Finding> {
  return tracked(() => db.transaction('rw', [db.projects, db.floors, db.findings, db.categories], async () => {
    if (!isValidUv(input.u, input.v)) throw new RepoError('Pin location is outside the floor plan');
    if (!input.title.trim()) throw new RepoError('A title is required');
    const floor = await db.floors.get(input.floorId);
    if (!floor) throw new RepoError('Floor not found');
    const cat = await db.categories.get(input.categoryId);
    if (!cat || cat.projectId !== floor.projectId) throw new RepoError('Choose a category');
    if (cat.archived) throw new RepoError('That category is archived');
    const project = await db.projects.get(floor.projectId);
    if (!project) throw new RepoError('Project not found');
    const t = nowIso();
    const finding: Finding = {
      id: uuid(), projectId: project.id, floorId: floor.id, reference: formatReference(project.nextFindingNumber),
      u: input.u, v: input.v, categoryId: cat.id, severity: input.severity ?? 'not_assessed', title: input.title.trim(),
      description: input.description ?? '', locationNotes: input.locationNotes ?? '', locationNeedsReview: false, createdAt: t, updatedAt: t,
    };
    await db.findings.add(finding);
    await db.projects.update(project.id, { nextFindingNumber: project.nextFindingNumber + 1, updatedAt: t });
    return finding;
  }));
}
export type FindingPatch = Partial<Pick<Finding, 'title' | 'description' | 'locationNotes' | 'severity' | 'categoryId' | 'floorId'>>;
export async function updateFinding(id: string, patch: FindingPatch): Promise<void> {
  return tracked(() => db.transaction('rw', [db.findings, db.categories, db.projects], async () => {
    const f = await db.findings.get(id);
    if (!f) throw new RepoError('Finding not found');
    if (patch.title !== undefined && !patch.title.trim()) throw new RepoError('A title is required');
    if (patch.categoryId && patch.categoryId !== f.categoryId) {
      const c = await db.categories.get(patch.categoryId);
      if (!c || c.archived) throw new RepoError('That category is not available');
    }
    await db.findings.update(id, { ...patch, updatedAt: nowIso() });
    await touch(f.projectId);
  }));
}
export async function relocateFinding(id: string, u: number, v: number): Promise<void> {
  return tracked(async () => {
    if (!isValidUv(u, v)) throw new RepoError('Pin location is outside the floor plan');
    const f = await db.findings.get(id);
    if (!f) throw new RepoError('Finding not found');
    await db.findings.update(id, { u, v, locationNeedsReview: false, updatedAt: nowIso() });
    await touch(f.projectId);
  });
}
export async function clearLocationReview(id: string): Promise<void> {
  return tracked(async () => { await db.findings.update(id, { locationNeedsReview: false, updatedAt: nowIso() }); });
}
async function deleteFindingInTx(id: string) {
  const f = await db.findings.get(id);
  if (!f) return;
  const photos = await db.photos.where('findingId').equals(id).toArray();
  await db.photos.bulkDelete(photos.map((p) => p.id));
  for (const p of photos) await removeAsset(p.assetId);
  await db.findings.delete(id);
}
export async function deleteFinding(id: string): Promise<void> {
  return tracked(() => db.transaction('rw', [db.findings, db.photos, db.assets, db.blobs, db.floors, db.projects], async () => {
    const f = await db.findings.get(id);
    await deleteFindingInTx(id);
    if (f) await touch(f.projectId);
  }));
}
export const listFindings = (projectId: string) => db.findings.where('projectId').equals(projectId).sortBy('reference');

// ---------- categories ----------
export const listCategories = (projectId: string) => db.categories.where('projectId').equals(projectId).sortBy('order');
function validateCategoryName(name: string, existing: Category[], selfId?: string) {
  const n = name.trim();
  if (!n) throw new RepoError('Category name cannot be blank');
  if (existing.some((c) => c.id !== selfId && !c.archived && c.name.trim().toLowerCase() === n.toLowerCase())) {
    throw new RepoError(`A category named "${n}" already exists`);
  }
  return n;
}
export async function createCategory(projectId: string, name: string, colour = '#555555'): Promise<Category> {
  return tracked(() => db.transaction('rw', db.categories, async () => {
    const all = await listCategories(projectId);
    const cat: Category = { id: uuid(), projectId, name: validateCategoryName(name, all), colour, order: all.length, archived: false };
    await db.categories.add(cat);
    return cat;
  }));
}
export async function updateCategory(id: string, patch: { name?: string; colour?: string }): Promise<void> {
  return tracked(() => db.transaction('rw', db.categories, async () => {
    const c = await db.categories.get(id);
    if (!c) throw new RepoError('Category not found');
    const next: Partial<Category> = {};
    if (patch.name !== undefined) next.name = validateCategoryName(patch.name, await listCategories(c.projectId), id);
    if (patch.colour) next.colour = patch.colour;
    await db.categories.update(id, next);
  }));
}
export async function setCategoryArchived(id: string, archived: boolean): Promise<void> {
  return tracked(() => db.transaction('rw', db.categories, async () => {
    const c = await db.categories.get(id);
    if (!c) throw new RepoError('Category not found');
    if (!archived) validateCategoryName(c.name, await listCategories(c.projectId), id);
    await db.categories.update(id, { archived });
  }));
}
export async function moveCategory(id: string, dir: -1 | 1): Promise<void> {
  return tracked(() => db.transaction('rw', db.categories, async () => {
    const c = await db.categories.get(id);
    if (!c) return;
    const all = await listCategories(c.projectId);
    const i = all.findIndex((x) => x.id === id), j = i + dir;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    await Promise.all(all.map((x, k) => db.categories.update(x.id, { order: k })));
  }));
}
/** Permanently delete; findings using it must be reassigned in the same transaction. */
export async function deleteCategory(id: string, reassignTo?: string): Promise<void> {
  return tracked(() => db.transaction('rw', [db.categories, db.findings], async () => {
    const c = await db.categories.get(id);
    if (!c) return;
    const used = await db.findings.where('categoryId').equals(id).toArray();
    if (used.length) {
      if (!reassignTo || reassignTo === id) throw new RepoError('Choose a category to reassign existing findings to');
      const target = await db.categories.get(reassignTo);
      if (!target || target.projectId !== c.projectId) throw new RepoError('Reassignment category not found');
      await db.findings.where('categoryId').equals(id).modify({ categoryId: reassignTo, updatedAt: nowIso() });
    }
    await db.categories.delete(id);
  }));
}

// ---------- photos ----------
export async function addPhoto(findingId: string, img: ProcessedImage, caption = ''): Promise<Photo> {
  return tracked(() => db.transaction('rw', [db.findings, db.photos, db.assets, db.blobs, db.projects], async () => {
    const f = await db.findings.get(findingId);
    if (!f) throw new RepoError('Finding not found');
    const t = nowIso();
    const ids = { o: uuid(), d: uuid(), t: uuid() };
    const shared = img.original === img.display; // storage saver: no separate original, store the image once
    const asset: Asset = {
      id: uuid(), projectId: f.projectId, kind: 'photo', filename: img.filename, mime: img.mime, width: img.width, height: img.height,
      originalBlobId: shared ? ids.d : ids.o, displayBlobId: ids.d, thumbnailBlobId: ids.t, orientation: img.orientation,
      sizeBytes: (shared ? 0 : img.original.size) + img.display.size + img.thumbnail.size, createdAt: t,
    };
    await db.blobs.bulkAdd([
      ...(shared ? [] : [{ id: ids.o, projectId: f.projectId, data: img.original }]),
      { id: ids.d, projectId: f.projectId, data: img.display },
      { id: ids.t, projectId: f.projectId, data: img.thumbnail },
    ]);
    await db.assets.add(asset);
    const existing = await db.photos.where('findingId').equals(findingId).toArray();
    const photo: Photo = {
      id: uuid(), findingId, projectId: f.projectId, assetId: asset.id, caption, order: existing.length,
      isCover: existing.length === 0, createdAt: t,
    };
    await db.photos.add(photo);
    await touch(f.projectId);
    return photo;
  }));
}
export const listPhotos = (findingId: string) => db.photos.where('findingId').equals(findingId).sortBy('order');
export async function updatePhotoCaption(id: string, caption: string): Promise<void> {
  return tracked(async () => { await db.photos.update(id, { caption }); });
}
export async function setPhotoCover(id: string): Promise<void> {
  return tracked(() => db.transaction('rw', db.photos, async () => {
    const p = await db.photos.get(id);
    if (!p) return;
    const sibs = await db.photos.where('findingId').equals(p.findingId).toArray();
    await Promise.all(sibs.map((s) => db.photos.update(s.id, { isCover: s.id === id })));
  }));
}
export async function movePhoto(id: string, dir: -1 | 1): Promise<void> {
  return tracked(() => db.transaction('rw', db.photos, async () => {
    const p = await db.photos.get(id);
    if (!p) return;
    const sibs = await listPhotos(p.findingId);
    const i = sibs.findIndex((s) => s.id === id), j = i + dir;
    if (j < 0 || j >= sibs.length) return;
    [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
    await Promise.all(sibs.map((s, k) => db.photos.update(s.id, { order: k })));
  }));
}
export async function deletePhoto(id: string): Promise<void> {
  return tracked(() => db.transaction('rw', [db.photos, db.assets, db.blobs, db.floors], async () => {
    const p = await db.photos.get(id);
    if (!p) return;
    await db.photos.delete(id);
    await removeAsset(p.assetId);
    const sibs = await listPhotos(p.findingId);
    await Promise.all(sibs.map((s, k) => db.photos.update(s.id, { order: k, isCover: p.isCover ? k === 0 : s.isCover })));
  }));
}

// ---------- blobs ----------
export async function getBlob(id: string): Promise<Blob | undefined> {
  return (await db.blobs.get(id))?.data;
}
