# Dilapidation Reporter — Dilapidation Inspector prototype

A local-first web app for recording building condition ("dilapidation") inspections on floor plans.
Import up to five floor plans, view them as an axonometric stack, isolate one floor, place precise condition pins,
attach photos, edit categories, and produce a printable report — all stored in your browser, with a portable backup.

> Prototype inspection record. It records observations; it does not certify building safety, infer structural
> diagnoses, or measure anything. Pin positions are positions **on the supplied drawings**, not surveyed measurements.

Source specification: *Dilapidation Inspector — Prototype Implementation Specification* (15 Oct 2026).
Status of every acceptance criterion: see [`ACCEPTANCE.md`](ACCEPTANCE.md).

## Requirements

* Node.js **20.11 or newer** (developed and tested on Node 22; `.nvmrc` says 20, `engines` enforces ≥ 20.11).
* A current Chromium-based browser for development/testing. Tablet Safari is a target but is **not yet verified** (see Limitations).

## Quick start

```sh
npm ci
npm run dev -- --host 0.0.0.0     # prints the URL, normally http://localhost:5173/ (the next free port if 5173 is taken)
```

Other commands (all work in Windows PowerShell and Unix shells):

```sh
npm run typecheck
npm run lint
npm run test -- --run             # unit + data tests (Vitest, fake-indexeddb)
npx playwright install chromium   # once, for the browser tests
npm run test:e2e                  # builds, starts `vite preview` on http://localhost:4173, runs Playwright
npm run test:e2e:dev              # same suite against the dev server (React StrictMode on) — catches dev-only bugs
npm run build
npm run preview -- --host 0.0.0.0 # serves dist/ on http://localhost:4173/
```

`npm run test:e2e` starts its own server (`playwright.config.ts` → `webServer`). If you cannot download Playwright's
browser (offline container), point it at an installed Chromium:
`PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e` (PowerShell: `$env:PLAYWRIGHT_CHROMIUM_PATH="C:\path\chrome.exe"`).
The long-report print test additionally needs poppler (`pdftotext`, `pdfinfo`, `pdfimages`) and is skipped without it.

## Using the app

1. **Project home** — *New inspection* (name, site, address, client, inspector, date, reference, notes), or
   **Load sample project** to create a clearly-labelled *synthetic* five-floor project (invented plans, 8 invented findings,
   6 photos). Sample findings are never mixed into real projects. You can also rename, duplicate, back up, restore and delete.
2. **Import plans** — each floor slot has *Import / Replace*. Choose several files at once; each is assigned to a slot.
   For a PDF, pick the page from thumbnails; **use another page of the same PDF** to feed a different floor.
   Replacing a plan that has findings forces an explicit choice: *keep pin positions for manual review* (pins are flagged
   until you relocate or mark them reviewed) or *remove that floor’s findings*. A failed import changes nothing.
3. **Navigate** — overview shows the stack. Tap a floor (or its list entry) to isolate it: every other floor fades out
   completely and is removed from rendering and hit-testing. Return with **Return to building**. **2D view** shows the same
   floor top-down using the same stored coordinates.

   | Input | 3D | 2D |
   |---|---|---|
   | one-finger horizontal drag | rotate (yaw, 360°) | pan |
   | one-finger vertical drag | ignored (elevation locked) | pan |
   | two fingers: move / pinch | pan / zoom (twist ignored) | pan / zoom |
   | mouse drag · Shift/middle drag · wheel | rotate · pan · zoom | pan · pan · zoom |
   | keys (canvas focused) | ←/→ rotate, Shift+arrows pan, +/− zoom, F fit | arrows pan, +/− zoom, F fit |

   The camera elevation is fixed at 35.264°; no gesture can tilt, roll or invert the view.

   **On a phone (screens ≤ 900 px wide)** the plan fills the whole screen and everything else is tucked behind edge tabs:
   **Floors** (left), **Findings** (right), the project menu (top tab) and a bottom toolbar. Finding details and the new-pin form open as a
   collapsible bottom sheet. Larger screens keep the three-column layout.
4. **Pins** — choose **Add pin** (never created while navigating), tap the plan, check the crosshair and the 4× magnifier,
   fine-tune with the nudge buttons (1 source-image pixel; 10 with Shift) and save with a title and category. Photos can be
   taken or uploaded in the same panel and are attached when the finding is saved. On a phone the panel fills the screen as
   three steps — **position** (zoomed target + arrow pad, no keyboard), **details**, **photos** — and *Show plan to re-tap*
   collapses it so you can tap a new spot. Photos can be drawn on (pen, circle, arrow; four colours; undo) before they are used.
   Photos are stored compactly: one 1920 px JPEG (quality 0.75, roughly 250–400 KB) plus a thumbnail; the camera original is not kept.
   Relocation uses the same flow. In Navigate mode a tap selects a pin; overlapping pins open a chooser. `Esc` cancels.
5. **Photos** — in a finding: *Take photo* (rear camera, preview → capture → retake/accept), *Upload photos*, or the
   device-camera file picker fallback. Captions, order, cover photo, full-size preview and delete are supported.
6. **Categories** — *Project ▾ → Categories*: create, rename, recolour, reorder, archive/restore, delete with reassignment.
7. **Report** — *Report* opens the preview. **Print / Save as PDF** uses the browser’s print dialog (choose "Save as PDF") —
   this is not a direct PDF download. **Export findings CSV** exports the full project. Reports always cover the whole project
   regardless of workspace filters.

## Hosted copy (GitHub Pages)

A static build is published on the `gh-pages` branch, served at `https://buildbybradley.github.io/dilapidation-reporter/` once
Pages is enabled (repo **Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / `(root)`**). It is HTTPS, so the live
camera works on a phone. Data stays in each visitor's own browser; there is no server. To republish after changing the code:
`npm run build:pages`, then push the contents of `dist-pages/` (plus an empty `.nojekyll` file) to the `gh-pages` branch.

## Cloud sync (rev 02): phone ↔ computer

Sign in with the same account on every device (projects page → *Sync phone and computer*). Findings, plans and photos then
appear on your other devices within seconds; the status light in the top bar shows *Synced · live*, *Syncing N…*,
*Offline · N waiting* or *Sync problem*.

* **Local first.** The app still saves everything to the browser first and works with no signal. Changes upload when a
  connection is available (on reconnect, when the app comes back to the foreground, and every minute as a safety net).
* **Backend:** a Supabase project (URL and publishable key in `src/sync/config.ts`; override with `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY`, or `VITE_SUPABASE_URL=off` to build without sync). One-time database setup:
  run [`supabase/setup.sql`](supabase/setup.sql) in the Supabase SQL Editor. It creates one `records` table (row-level
  security: each user sees only their own rows), a private `blobs` storage bucket and the live-update feed.
* **How it works** (`src/sync/engine.ts`): every synced row's content hash is compared with the hash last exchanged with
  the server; differences are uploaded files-first, then records parent-before-child; deletions travel as tombstones.
  Incoming records wait for the plan/photo files they reference. An unsynced local edit wins over an incoming change to
  the same row; otherwise the latest write wins.
* **Sync mode (per device).** *Manual* (default on phones): nothing is sent or received until you tap **Sync now** in the top
  bar, which also shows how many changes are waiting — saves mobile data on site. *Automatic* (default on computers): live.
* **Passwords:** *Forgot password?* emails a reset link (set the Supabase **Site URL** to the app's address so the link returns
  here); *Change password* is in the account panel.
* **Signing out** stops syncing on that device and keeps its projects locally.

## Where data lives, backups

* Everything is stored in this browser’s **IndexedDB** database `dilapidation-inspector` (blobs for plans/photos, records for the rest).
  Nothing is uploaded anywhere; there is no server. The home screen shows storage usage and asks the browser for persistent storage.
* **Clearing site data, private windows, or low-storage eviction can delete projects.** Use *Back up* regularly.
* *Back up* downloads a `.zip` (versioned `manifest.json` + `blobs/`). *Restore backup…* imports it as a **new** project with fresh IDs;
  corrupt, future-version, missing-asset, unsafe-path or oversized archives are rejected before anything is written.
  Backups keep original photo files (which may contain GPS metadata); the displayed/report derivatives are re-encoded without it.
* Only one tab can edit a project at a time (Web Locks). A second tab opens read-only with a warning.

## Supported inputs and limits

* Plans: PNG, JPEG, PDF (one page per floor). Photos: JPEG, PNG. HEIC/HEIF is rejected with a clear message.
* Limits: 50 MB per plan file, 20 megapixels per decoded image, 20 MB per photo. Plan report raster ≤ 4096 px, viewer raster ≤ 2048 px,
  photo report derivative ≤ 2560 px, thumbnails 256 px. Backup expansion cap 1 GB.
* No scale is inferred; "display width" per floor only aligns the stack visually.

## Camera access

Browsers allow `getUserMedia` only in a secure context: `http://localhost` works on the same machine; a **tablet reaching your
computer by LAN IP over plain HTTP will not get camera access.** (The file-picker fallback and uploads still work.)
To test the live camera on a physical tablet use trusted HTTPS — no browser security needs to be disabled:

```sh
# one-time: install mkcert (https://github.com/FiloSottile/mkcert) then
mkcert -install
mkdir .certs
mkcert -key-file .certs/dev-key.pem -cert-file .certs/dev.pem localhost 127.0.0.1 ::1 <YOUR-LAN-IP>
npm run dev -- --host 0.0.0.0      # now serves https://<YOUR-LAN-IP>:5173/  (vite.config.ts picks up .certs/ automatically)
```

Then make the tablet trust the mkcert root CA: run `mkcert -CAROOT`, send `rootCA.pem` to the tablet (AirDrop/e-mail), install the profile and
enable it under **Settings → General → About → Certificate Trust Settings** (iPadOS) or install it as a CA certificate (Android).
`HTTPS_CERT` / `HTTPS_KEY` environment variables point at other certificate files. `.certs/` is git-ignored — never commit keys.

## Architecture and deviations from the recommended stack

* React 19 + TypeScript + Vite, Dexie (IndexedDB), PDF.js (lazy-loaded), `fflate` (zip), `zod` (backup validation), Vitest, Playwright.
* **Deviation: no Three.js / React Three Fiber.** An orthographic projection of horizontal textured planes is an exact *affine*
  map, so the viewer (`src/features/viewer/engine.ts`) draws each plan with Canvas 2D `setTransform`, painter-sorted by elevation.
  This keeps the locked-elevation, yaw/pan/zoom-only camera trivially testable, needs no WebGL (so there is nothing to fall back
  from), and avoids GPU-texture lifecycle issues. The spec explicitly allows equivalent tools.
* Pins, labels, crosshair and the hit-testing are drawn/computed in the same engine from the authoritative `(u,v)` coordinates,
  so a pin tip is exactly at its stored point (`src/lib/coords.ts`, covered by unit tests).
* Pure, unit-tested modules: coordinates & camera (`lib/coords.ts`), gesture state machine (`lib/gestures.ts`), CSV, EXIF
  orientation, schema validation, backup, report aggregation. Persisted data (Dexie) is kept apart from interaction state (React).
* Image orientation: the browser’s `createImageBitmap` applies EXIF orientation while decoding; the app records the EXIF value.
* `window.__inspector.engine` exposes read-only diagnostics used by the browser tests.
* Light theme only.

## Verification and handover

* `ACCEPTANCE.md` — pass / fail / not-tested for A01–A24 with evidence and the exact commands run.
* `docs/MANUAL-CHECKLIST.md` — the physical touch-device and print checklist that automated tests cannot replace.

## Known limitations (read before relying on this)

* **Not verified on tablet Safari or any physical touch device.** Gestures are tested with synthetic Pointer Events in headless
  desktop Chromium only. Camera capture was tested with Chromium’s fake video device, not real hardware.
* Performance numbers (see `ACCEPTANCE.md`) come from headless, software-rendered Chromium in a container; they say nothing about
  real tablets.
* Viewer camera state (per-floor 2D/3D) is kept in memory for the session; it is not persisted across reloads.
* The sample photo fixtures reuse three images, so the 500-photo scale test did not exercise 500 distinct large photos in memory.
* No offline cold-start / PWA install, no undo, no multi-user sync, no HEIC, no OCR or CAD parsing.
* The Web Locks API protects against two-tab edits; browsers without it get a warning instead.
* The PDF.js worker adds ~1.4 MB to the build (loaded only when a PDF is imported).
* Browser Save-as-PDF output varies by browser; only Chromium’s print engine has been inspected.
