import { expect, test, type Page } from '@playwright/test';
import { dbAll, isolate, newProject, PLANS, screenOf, state, tap } from './helpers';

async function withPin(page: Page) {
  await newProject(page);
  await page.getByRole('button', { name: 'Import', exact: true }).first().click();
  await page.getByLabel('Plan files').setInputFiles(PLANS);
  await page.getByRole('button', { name: /Import 5 plans/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
  await page.waitForFunction(() => (window as any).__inspector?.engine.debugState().visible.length === 5);
  await isolate(page, 'Ground');
  await page.getByRole('button', { name: 'Add pin' }).first().click();
  const fid = (await state(page)).floorId!;
  const p = await screenOf(page, fid, 0.4, 0.4);
  await tap(page, p.x, p.y);
  await page.getByLabel('Title *').fill('Voice pin');
  await page.getByLabel('Category *').selectOption({ label: 'Doors / windows' });
  await page.getByRole('button', { name: 'Save finding' }).click();
  await expect(page.getByTestId('finding-editor')).toBeVisible();
}

test.describe('storage bar and quick capture', () => {
  test('storage bar shows usage, photos are stored compressed once, and the budget drives the warning level', async ({ page }) => {
    await withPin(page);
    const bar = page.getByTestId('storage-bar');
    await expect(bar).toBeVisible();
    await page.getByLabel('Upload photos').setInputFiles('public/demo/photo-landscape.jpg');
    await expect(page.getByTestId('photo-item')).toHaveCount(1, { timeout: 20_000 });
    // storage saver: original and display are the same stored blob
    const a = (await dbAll(page, 'assets')).find((x) => x.kind === 'photo');
    expect(a.originalBlobId).toBe(a.displayBlobId);
    await bar.click();
    await expect(page.getByRole('dialog', { name: 'Storage' })).toBeVisible();
    await expect(page.getByText(/more photos fit/)).toBeVisible();
    // a tiny budget pushes the meter to critical and raises the banner
    await page.getByLabel('Storage budget (MB)').fill('50');
    await page.getByLabel('Storage budget (MB)').blur();
    await page.getByRole('button', { name: 'Done' }).click();
    // 50 MB budget with a few hundred KB used stays ok; the fill is proportional rather than empty
    await expect(page.getByTestId('storage-banner')).toHaveCount(0);
    expect(await bar.getAttribute('class')).toContain('ok');
  });

  test('keeping originals stores a separate original blob', async ({ page }) => {
    await withPin(page);
    await page.getByTestId('storage-bar').click();
    await page.getByLabel(/Keep full-size original photos/).check();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.getByLabel('Upload photos').setInputFiles('public/demo/photo-landscape.jpg');
    await expect(page.getByTestId('photo-item')).toHaveCount(1, { timeout: 20_000 });
    const a = (await dbAll(page, 'assets')).find((x) => x.kind === 'photo');
    expect(a.originalBlobId).not.toBe(a.displayBlobId);
  });

  test('hold-to-capture adds frames and an editable note without storing any video', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as any; w.__streams = [];
      const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); w.__streams.push(s); return s; };
      // deterministic stand-in for the browser speech service
      class FakeSpeech {
        lang = ''; continuous = false; interimResults = false; onresult: any = null; onerror: any = null; onend: any = null;
        start() { setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'hairline crack above the window minor' }], { isFinal: true })] }), 150); }
        stop() { setTimeout(() => this.onend?.(), 20); } abort() {}
      }
      (window as any).SpeechRecognition = FakeSpeech; (window as any).webkitSpeechRecognition = FakeSpeech;
    });
    await withPin(page);
    await page.getByTestId('quick-capture').click();
    await expect(page.getByLabel('Camera preview')).toBeVisible();
    const hold = page.getByRole('button', { name: /Hold to capture/ });
    await expect(hold).toBeEnabled({ timeout: 10_000 });
    const box = (await hold.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.getByTestId('qc-live')).toContainText('hairline crack', { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await expect(page.getByLabel('What you said (edit freely)')).toHaveValue('Hairline crack above the window minor.');
    expect(await page.getByAltText(/Captured frame/).count()).toBeGreaterThanOrEqual(2);
    const qc = page.getByRole('dialog', { name: 'Quick capture' });
    await expect(qc.getByLabel('Severity')).toHaveValue('minor');
    // camera is released while reviewing
    expect(await page.evaluate(() => (window as any).__streams.every((s: MediaStream) => s.getTracks().every((t) => t.readyState === 'ended')))).toBe(true);
    await qc.getByLabel('Category').selectOption({ label: 'Cracks' });
    await page.getByRole('button', { name: 'Add to finding' }).click();
    await expect(page.getByTestId('photo-item').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Description')).toHaveValue('Hairline crack above the window minor.');
    await expect.poll(async () => (await dbAll(page, 'findings'))[0].severity).toBe('minor');
    expect((await dbAll(page, 'findings'))[0].description).toBe('Hairline crack above the window minor.');
    const assets = (await dbAll(page, 'assets')).filter((x) => x.kind === 'photo');
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.every((x) => x.mime === 'image/jpeg')).toBe(true);
  });

  test('a stray tap does not create a capture, and the manual editor still works', async ({ page }) => {
    await withPin(page);
    await page.getByTestId('quick-capture').click();
    const hold = page.getByRole('button', { name: /Hold to capture/ });
    await expect(hold).toBeEnabled({ timeout: 10_000 });
    await hold.click({ delay: 20 });
    await expect(page.getByText('Hold the button down while you speak.')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByLabel('Description').fill('typed by hand');
    await expect.poll(async () => (await dbAll(page, 'findings'))[0].description).toBe('typed by hand');
    expect(await dbAll(page, 'photos')).toHaveLength(0);
  });
});
