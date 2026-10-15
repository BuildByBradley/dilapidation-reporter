import { expect, type Page, type Locator } from '@playwright/test';
import path from 'node:path';

export const demo = (f: string) => path.resolve('public/demo', f);
export const PLANS = ['plan-ground.png', 'plan-level1.png', 'plan-level2.png', 'plan-level3.png', 'plan-level4.png'].map(demo);

export const canvas = (page: Page) => page.getByTestId('viewer-canvas');
export type EngineState = { mode: string; floorId: string | null; camera: { yaw: number; elevation: number; zoom: number; panX: number; panY: number }; visible: string[]; interactive: string[]; size: { w: number; h: number }; animating: boolean; pointers: number };
export const state = (page: Page): Promise<EngineState> => page.evaluate(() => (window as any).__inspector.engine.debugState());
export const settle = (page: Page) => page.waitForFunction(() => { const e = (window as any).__inspector?.engine; return e && !e.debugState().animating; }, null, { timeout: 5000 });

export async function openSample(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load sample project' }).click();
  await page.waitForURL(/#\/p\//, { timeout: 90_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5, null, { timeout: 30_000 });
  await settle(page);
}
export async function newProject(page: Page, name = 'E2E project') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New inspection' }).click();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForURL(/#\/p\//);
}
export const floorButton = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name},`) });
export async function isolate(page: Page, name: string) {
  await floorButton(page, name).click();
  await page.waitForFunction(() => { const s = (window as any).__inspector.engine.debugState(); return s.mode !== 'overview3d' && s.visible.length === 1 && !s.animating; }, null, { timeout: 5000 });
}

/** Synthetic pointer events at canvas-relative coordinates. */
export async function pointer(page: Page, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', o: { id: number; x: number; y: number; pointerType?: string; button?: number; shiftKey?: boolean }) {
  await page.evaluate(({ type, o }) => {
    const c = document.querySelector('[data-testid=viewer-canvas]') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: o.id, pointerType: o.pointerType ?? 'touch', isPrimary: o.id === 1, clientX: r.left + o.x, clientY: r.top + o.y, button: o.button ?? 0, shiftKey: !!o.shiftKey }));
  }, { type, o });
}
export async function drag(page: Page, from: [number, number], to: [number, number], opts: { id?: number; pointerType?: string; steps?: number; shiftKey?: boolean; button?: number } = {}) {
  const id = opts.id ?? 1, steps = opts.steps ?? 6, pt = opts.pointerType ?? 'touch';
  await pointer(page, 'pointerdown', { id, x: from[0], y: from[1], pointerType: pt, shiftKey: opts.shiftKey, button: opts.button });
  for (let i = 1; i <= steps; i++) await pointer(page, 'pointermove', { id, x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps, pointerType: pt, shiftKey: opts.shiftKey });
  await pointer(page, 'pointerup', { id, x: to[0], y: to[1], pointerType: pt });
}
export const tap = async (page: Page, x: number, y: number, pointerType = 'touch') => {
  await pointer(page, 'pointerdown', { id: 1, x, y, pointerType });
  await pointer(page, 'pointerup', { id: 1, x, y, pointerType });
};
/** Canvas-relative screen position of a normalised point on a floor. */
export const screenOf = (page: Page, floorId: string, u: number, v: number) =>
  page.evaluate(({ floorId, u, v }) => (window as any).__inspector.engine.uvToScreen(floorId, u, v) as { x: number; y: number }, { floorId, u, v });

/** Read every record of an IndexedDB store (blobs replaced by their size). */
export async function dbAll<T = any>(page: Page, store: string): Promise<T[]> {
  return page.evaluate((store) => new Promise<any[]>((resolve, reject) => {
    const open = indexedDB.open('dilapidation-inspector');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => { db.close(); resolve(req.result.map((r) => (r && r.data instanceof Blob ? { ...r, data: r.data.size } : r))); };
      req.onerror = () => reject(req.error);
    };
  }), store);
}

export async function selectedFloorId(page: Page) { return (await state(page)).floorId!; }
export async function floorIdByName(page: Page, name: string) {
  const floors = await dbAll<{ id: string; name: string }>(page, 'floors');
  return floors.find((f) => f.name === name)!.id;
}
export async function expectNoPageErrors(page: Page, fn: () => Promise<void>) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await fn();
  expect(errors).toEqual([]);
}
export type L = Locator;
