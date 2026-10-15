import * as repo from '../../data/repo';
import { processPhoto, processPlanRaster } from '../../lib/imaging';

const base = () => import.meta.env.BASE_URL.replace(/\/?$/, '/') + 'demo/';
async function fetchBlob(name: string) {
  const r = await fetch(base() + name);
  if (!r.ok) throw new Error(`Could not load sample file ${name}`);
  return r.blob();
}

/** Builds the synthetic five-floor sample. Sample findings live only in this clearly-labelled project. */
export async function loadSampleProject(onProgress?: (label: string) => void) {
  const files = ['plan-ground.png', 'plan-level1.png', 'plan-level2.png', 'plan-level3.png', 'plan-level4.png'];
  const processed = [] as Awaited<ReturnType<typeof processPlanRaster>>[];
  for (const f of files) { onProgress?.(`Preparing ${f}`); processed.push(await processPlanRaster(await fetchBlob(f), f)); }
  const photos = [] as Awaited<ReturnType<typeof processPhoto>>[];
  for (const f of ['photo-landscape.jpg', 'photo-portrait.jpg', 'photo-exif6.jpg']) { onProgress?.(`Preparing ${f}`); photos.push(await processPhoto(await fetchBlob(f), f)); }
  const project = await repo.createProject({
    name: 'Sample project (synthetic)', siteName: 'Synthetic Test Building', address: '1 Example Street, Nowhere',
    client: 'Sample Client', inspector: 'Sample Inspector', reference: 'SAMPLE-001',
    notes: 'This project contains invented drawings and invented findings for demonstration and testing only. It describes no real building.',
  }, { isSample: true });
  const floors = await repo.listFloors(project.id);
  for (let i = 0; i < floors.length; i++) await repo.setFloorPlan(floors[i].id, processed[i]);
  const cats = await repo.listCategories(project.id);
  const cat = (n: string) => cats.find((c) => c.name.startsWith(n))!.id;
  const data: [number, number, number, string, string, string, 'minor' | 'moderate' | 'major' | 'not_assessed', string, string][] = [
    [0, 0.18, 0.3, 'Cracks', 'Diagonal crack above lobby door', 'Hairline diagonal crack approx. 1.2 m long running from the door head toward the ceiling.', 'moderate', 'North wall of lobby, above the door', 'p'],
    [0, 0.72, 0.78, 'Moisture', 'Damp staining to kitchen wall', 'Tide-mark staining to plaster approx. 0.6 m above floor level.', 'moderate', 'Kitchen, south-east corner', 'p'],
    [1, 0.5, 0.25, 'Ceilings', 'Sagging ceiling board', 'Board visibly deflecting between joists; paint blistered.', 'major', 'Office 1 centre', 'p'],
    [1, 0.85, 0.7, 'Doors', 'Window will not close fully', 'Sash binds on frame; seal perished.', 'minor', 'Open plan, east window', 'p'],
    [2, 0.25, 0.5, 'Floors', 'Lifting floor finish', 'Vinyl lifting at seam over approx. 0.4 m.', 'minor', 'Bedroom 1', 'n'],
    [2, 0.8, 0.4, 'Finishes', 'Flaking paint', 'Paint flaking in patches to external-facing wall.', 'not_assessed', 'Bedroom 3', 'n'],
    [3, 0.4, 0.7, 'Cracks', 'Stepped crack in blockwork', 'Stepped crack following mortar joints, 0.8 m.', 'moderate', 'Store north wall', 'n'],
    [4, 0.5, 0.5, 'External', 'Ponding on terrace', 'Standing water after rain; outlet partially blocked.', 'major', 'Terrace centre', 'p'],
  ];
  let phIdx = 0;
  for (const [fl, u, v, c, title, description, severity, locationNotes, ph] of data) {
    const f = await repo.createFinding({ floorId: floors[fl].id, u, v, categoryId: cat(c), title, description, severity, locationNotes });
    if (ph === 'p') await repo.addPhoto(f.id, photos[phIdx++ % photos.length], `Synthetic photo for ${f.reference}`);
  }
  // one finding with two photos
  const first = (await repo.listFindings(project.id))[0];
  await repo.addPhoto(first.id, photos[2], 'Second synthetic photo (EXIF-rotated source)');
  return project;
}
