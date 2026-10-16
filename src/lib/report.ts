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

const SEV_RANK: Record<Severity, number> = { major: 0, moderate: 1, minor: 2, not_assessed: 3 };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listJoin = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** Major first, then moderate (then the rest if asked): the findings a client should read first. */
export function keyFindings(model: ReportModel, includeMinor = false): ReportFinding[] {
  return model.floors.flatMap((f) => f.findings)
    .filter((f) => f.severity === 'major' || f.severity === 'moderate' || includeMinor)
    .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.reference.localeCompare(b.reference, undefined, { numeric: true }));
}

/** Severities most serious first, for client-facing tables. */
export const SEVERITIES_DESC = [...SEVERITIES].sort((a, b) => SEV_RANK[a.value] - SEV_RANK[b.value]);

/** Floor × severity counts for the summary matrix (columns in SEVERITIES_DESC order). */
export function floorSeverityMatrix(model: ReportModel) {
  return model.floors.filter((f) => f.hasPlan || f.findings.length).map((f) => ({
    floor: f.name,
    counts: SEVERITIES_DESC.map((s) => f.findings.filter((x) => x.severity === s.value).length),
    total: f.findings.length,
  }));
}

/** A neutral first draft of the executive summary, built only from the recorded data. The inspector edits it. */
export function draftSummary(model: ReportModel, p: { siteName: string; address: string; inspector: string; inspectionDate: string; name: string }): string {
  const sev = Object.fromEntries(model.bySeverity.map((s) => [s.severity, s.count])) as Record<Severity, number>;
  const inspected = model.floors.filter((f) => f.hasPlan);
  const where = p.siteName || p.address || p.name;
  const lines: string[] = [];
  lines.push(`${p.inspector ? `${p.inspector} inspected` : 'An inspection of'} ${where}${p.inspectionDate ? ` ${p.inspector ? 'on' : 'was carried out on'} ${p.inspectionDate}` : ''}${p.inspector ? '' : ''}. ${plural(model.total, 'condition')} ${model.total === 1 ? 'was' : 'were'} recorded across ${plural(inspected.length, 'floor')}${inspected.length ? ` (${listJoin(inspected.map((f) => f.name))})` : ''}.`);
  if (model.total) {
    lines.push(`Of these, ${sev.major} ${sev.major === 1 ? 'is' : 'are'} rated major, ${sev.moderate} moderate and ${sev.minor} minor${sev.not_assessed ? `; ${sev.not_assessed} ${sev.not_assessed === 1 ? 'has' : 'have'} not been assessed` : ''}.`);
    const top = model.byCategory.slice(0, 3);
    if (top.length) lines.push(`The most frequent ${top.length === 1 ? 'category is' : 'categories are'} ${listJoin(top.map((c) => `${c.category.toLowerCase()} (${c.count})`))}.`);
    const [busiest, next] = [...model.floors].sort((a, b) => b.findings.length - a.findings.length);
    if (busiest && next && busiest.findings.length > next.findings.length) lines.push(`${busiest.name} has the most findings (${busiest.findings.length}).`);
    const majors = keyFindings(model).filter((f) => f.severity === 'major');
    if (majors.length) {
      const shown = majors.slice(0, 5).map((f) => `${f.reference} ${f.title.toLowerCase()} (${f.floorName})`);
      lines.push(`Major items: ${listJoin(shown)}${majors.length > 5 ? `, and ${majors.length - 5} more listed below` : ''}.`);
    }
  }
  if (model.needsReview.length) lines.push(`${plural(model.needsReview.length, 'finding')} need${model.needsReview.length === 1 ? 's' : ''} its location reviewed because a floor plan was replaced after it was placed.`);
  lines.push('This summary describes recorded observations only; it is not a structural assessment.');
  return lines.join(' ');
}
