import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use the pre-installed Chromium when PLAYWRIGHT_CHROMIUM_PATH is set (offline CI/containers);
// otherwise Playwright's own browser from `npx playwright install chromium` is used.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH && existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH)
    ? process.env.PLAYWRIGHT_CHROMIUM_PATH
    : undefined;

// E2E_MODE=dev runs the same suite against `vite` (dev server, React StrictMode) instead of the production build.
const dev = process.env.E2E_MODE === 'dev';
const port = dev ? 5273 : 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    launchOptions: { executablePath, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    permissions: ['camera'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: dev ? `npm run dev -- --port ${port} --strictPort` : `npm run build && npm run preview -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
