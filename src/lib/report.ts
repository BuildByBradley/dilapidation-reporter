import { csvRow } from './csv';
import { severityLabel, SEVERITIES, type Severity } from './types';
import type { ProjectBundle } from '../data/repo';

export type ReportFloor = {
  id: string; name: string; hasPlan: boolean; planAssetId?: string;
  findings: ReportFinding[];
};
export type ReportFinding = {
  id: string; reference: string; title: string; categoryName: string; categoryColour: string; severity: Severity;
  description: string; locationNotes: string; u: number; v: number; locationNeedsReview: boolean;
  photos: { id: string; assetId: string; caption: string; order: number }[]; createdAt: string; updatedAt: string; floorName: string;
};
export type ReportModel = {
  floors: ReportFloor[]; total: number;
  byFloor: { floor: string; count: number }[];
  byCategory: { category: string; count: number }[];
  bySeverity: { severity: Severity; label: string; count: number }[];
  needsReview: ReportFinding[];
};

/** Derives the report entirely from stored data — independent of workspace filters and camera. */
export function buildReportModel(b: ProjectBundle): ReportModel {
  const cats = new Map(b.categories.map((c) => [c.id, c]));
  const floors = [...b.floors].sort((a, c) => a.order - c.order);
  const outFloors: ReportFloor[] = floors.map((f) => {
    const findings = b.findings.filter((x) => x.floorId === f.id).sort((x, y) => x.reference.localeCompare(y.reference, undefined, { numeric: true }))
      .map((x): ReportFinding => ({
        id: x.id, reference: x.reference, title: x.title, categoryName: cats.get(x.categoryId)?.name ?? 'Unknown category',
        categoryColour: cats.get(x.categoryId)?.colour ?? '#555', severity: x.severity, description: x.description,
        locationNotes: x.locationNotes, u: x.u, v: x.v, locationNeedsReview: x.locationNeedsReview, createdAt: x.createdAt, updatedAt: x.updatedAt,
        floorName: f.name,
        photos: b.photos.filter((p) => p.findingId === x.id).sort((p, q) => p.order - q.order)
          .map((p) => ({ id: p.id, assetId: p.assetId, caption: p.caption, order: p.order })),
      }));
    return { id: f.id, name: f.name, hasPlan: !!f.planAssetId, planAssetId: f.planAssetId, findings };
  });
  const all = outFloors.flatMap((f) => f.findings);
  const catCount = new Map<string, number>();
  for (const f of all) catCount.set(f.categoryName, (catCount.get(f.categoryName) ?? 0) + 1);
  return {
    floors: outFloors, total: all.length,
    byFloor: outFloors.map((f) => ({ floor: f.name, count: f.findings.length })),
    byCategory: [...catCount].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    bySeverity: SEVERITIES.map((s) => ({ severity: s.value, label: s.label, count: all.filter((f) => f.severity === s.value).length })),
    needsReview: all.filter((f) => f.locationNeedsReview),
  };
}

export const CSV_HEADER = ['reference', 'floor', 'title', 'category', 'severity', 'description', 'location notes', 'u', 'v', 'photo count', 'location review required', 'created time', 'updated time'];
export function buildCsv(model: ReportModel): string {
  const rows = [csvRow(CSV_HEADER)];
  for (const f of model.floors) {
    for (const x of f.findings) {
      rows.push(csvRow([x.reference, f.name, x.title, x.categoryName, severityLabel(x.severity), x.description, x.locationNotes,
        x.u.toFixed(5), x.v.toFixed(5), x.photos.length, x.locationNeedsReview ? 'yes' : 'no', x.createdAt, x.updatedAt]));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
