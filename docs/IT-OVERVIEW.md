# Dilapidation Inspector: build breakdown for IT review

Prepared 30 Oct 2026 from the code in this repository (branch `claude/brave-planck-suamqd`). Everything below was
checked against the code and test runs. Where something has **not** been verified, it says so.

## 1. Summary

**What it is.** A web app for recording building-condition ("dilapidation") inspections. An inspector imports up to five
floor plans, views them as a 3D stack or flat 2D, drops numbered pins where defects are, attaches photos, and produces a
printable report and CSV.

**Current status: working prototype, not yet ready for company-wide rollout.** It is a single-user, single-device tool.
There is **no login, no server and no shared database**. All data is stored in the browser on the device being used. The
gaps IT would need to see closed before wider use are in section 7.

## 2. What it does today

* Create projects with site, client, inspector and reference details.
* Import plans (PNG, JPEG, or a chosen page of a PDF) for up to 5 floors; replace plans without losing pins (pins are flagged for review).
* Navigate in 3D (rotate, pan, zoom, isolate a floor) or 2D; phone layout with edge drawers and a bottom sheet.
* Place and relocate pins precisely (crosshair, magnifier, nudge buttons); categories, severity, description, location notes.
* Photos: take with the camera, upload, caption, reorder, cover photo.
* **New this session:** storage meter with budget warnings; photos stored compressed by default (about 5 to 10 times smaller);
  "film and speak" capture (hold a button, take up to 3 frames, speech-to-text note, editable before saving).
* Report preview, print / save as PDF, CSV export, project backup (.zip) and restore, duplicate project.

## 3. How it was built

The app was built with **Claude Code (an AI coding assistant) working to a written specification** ("Dilapidation Inspector
Prototype Implementation Specification", 15 Oct 2026) under the direction of the project owner, who reviewed behaviour in the
running app and steered requirements. The code has **not** had an independent human code review or a penetration test.

| Step | What was done |
|---|---|
| 1. Foundation | Storage layer, coordinate maths, touch/mouse gesture logic, backup format, report model, with unit tests first. |
| 2. Workspace | Screens, canvas 3D/2D viewer, plan import, pins, photos, categories, report view, browser tests. |
| 3. Hardening | Bug fixes found under React development mode, PDF and dev-server tests, lock fallbacks, hosted-frame handling. |
| 4. Acceptance record | `ACCEPTANCE.md` lists 24 scenarios with pass / partial / not-tested and the evidence for each. |
| 5. Phone layout | Full-screen plan with drawers and bottom sheet, with tests. |
| 6. Storage and capture | Storage bar, photo storage saver, hold-to-capture, with unit and browser tests (this session). |
| 7. Research | `docs/MULTI-USER.md`: proposed design for shared projects and live sync (not built). |

## 4. Architecture and technology

| Layer | Choice |
|---|---|
| Language / UI | TypeScript, React 19 |
| Build tool | Vite (produces static files only) |
| Local database | Dexie over the browser's IndexedDB |
| 3D / 2D view | Hand-written Canvas 2D engine (no WebGL, no Three.js) |
| PDF import | pdf.js (loaded only when a PDF is imported) |
| Backup zip | fflate |
| Backup validation | zod |
| Tests | Vitest (unit), Playwright with Chromium (browser) |

Runtime dependencies are only: `react`, `react-dom`, `dexie`, `pdfjs-dist`, `fflate`, `zod`. Roughly 4,300 lines of app code
and 1,800 lines of tests. The output is a folder of static files that any web server can host.

## 5. Data, privacy and security properties

**Where data lives.** Entirely in the user's browser (IndexedDB database `dilapidation-inspector`). Nothing is uploaded.
There is no backend, no accounts, no analytics and no tracking in the code.

**Network activity.** The app makes **no calls to any API**. The only `fetch` loads bundled sample images from its own origin.
Two exceptions to be aware of:
* **Speech-to-text** (the "speak" feature) uses the browser's built-in service. In Chrome and Edge this typically sends the
  audio to the browser vendor's servers. If the company's policy forbids that, the voice feature can be switched off in
  code and everything else still works.
* Whoever hosts the static files can see normal web-server logs (who loaded the app), but not any inspection data.

**Device permissions requested.** Camera (photos and film-and-speak). Microphone only through the browser's speech service.
Location is **not** requested or used.

**Photos and GPS.** Photos are re-encoded in the browser, which strips location metadata from the saved images. If the
"Keep full-size originals" option is turned on, the untouched camera file is stored and included in backups, and it may
contain GPS coordinates. The backup README says this.

**Backups.** The backup .zip is not encrypted. Anyone holding the file can read the whole project.

**Input handling.** Imported files are size-checked and sniffed (not trusted by extension). Backup files are validated
before anything is written: bad structure, unsafe paths (`../`), missing assets, future versions and oversized archives are
rejected. CSV export neutralises spreadsheet formula injection.

**Secrets.** None in the repository. The optional local HTTPS certificates folder is git-ignored.

**Dependency check.** `npm audit` (production dependencies) reports **one high-severity advisory in `zod`** (memory
exhaustion when validating oversized collections). In this app zod only validates backup files a user chooses to import, so
exposure is a user importing a hostile file into their own browser. The fix is an upgrade to zod 4.x, which is a breaking
change and has not been done yet. Licences are believed to be MIT or Apache-2.0 for all runtime dependencies; IT should
confirm with its own licence scanner.

## 6. Quality evidence

| Check | Result (last run) |
|---|---|
| TypeScript type check | Clean |
| Lint | Clean |
| Unit tests (Vitest) | 55 passing |
| Browser tests (Playwright, Chromium) | 44 tests: 43 passed in the full run; the one failure was caused by a new button's name and was fixed, then the affected spec files re-ran green. The whole suite was not re-run afterwards. |
| Acceptance checklist | `ACCEPTANCE.md`: 24 scenarios, mostly pass; touch gestures are tested with synthetic events only |

**Not tested:** real tablets and phones, Safari, Firefox, real camera hardware, real storage exhaustion, printing in
browsers other than Chromium, accessibility audit with assistive technology, load or performance on low-end devices.
`docs/MANUAL-CHECKLIST.md` lists the physical-device checks that still need a person.

## 7. Gaps IT is likely to raise, and the proposed response

| # | Gap | Why it matters | Proposed action |
|---|---|---|---|
| 1 | No authentication or user identity | Anyone with the URL and the device can open the data on that device | Sign-in via the company identity provider once a backend exists |
| 2 | Data only on one device | Lost phone, cleared browser data or private window means lost inspections; no shared access | Cloud storage and sync (`docs/MULTI-USER.md`); until then, mandatory regular backups |
| 3 | Backups are unencrypted files | Client property data in plain zips | Policy on where backups may be stored, or add encryption |
| 4 | No backend audit trail | Dilapidation records can be evidence | Add change history (who, when, what) with the multi-user phase |
| 5 | One `zod` high advisory | Dependency hygiene | Upgrade to zod 4.x with regression tests |
| 6 | Speech service sends audio to the browser vendor | Possible data-handling policy issue | Decide allow / disable; feature can be removed without touching the rest |
| 7 | No security headers or content-security policy | Standard hardening for a hosted app | Set in the web server or hosting layer (CSP, HSTS, no-sniff, frame rules) |
| 8 | No independent code review or pen test | Normal sign-off requirement | Schedule one before company-wide release |
| 9 | Hosted today on GitHub Pages (public URL per README) | Company policy on hosting client-related tools | Move to company-controlled hosting behind SSO |
| 10 | Not verified on target devices and browsers | Field use is on phones and tablets | Run the manual checklist on the actual company devices |
| 11 | No error monitoring | IT cannot see failures | Add logging to a company-approved service if wanted |
| 12 | AI-assisted code provenance | Some organisations require disclosure | Disclosed in section 3; independent review recommended |

## 8. Hosting and deployment

Current: the README describes a static build published to GitHub Pages. For company use the same build can be served from
any static host (internal web server, Azure Static Web Apps, S3 plus CDN, Supabase, etc.). It must be served over **HTTPS**
because browsers only allow the camera on secure origins. Build: `npm ci`, then `npm run build` (output in `dist/`).
Requires Node 20.11 or newer.

## 9. Roadmap (not built)

Shared projects with sign-in, live sync between office and site, cloud photo storage, change history, and presence. The
design, options, risks and open questions are in `docs/MULTI-USER.md`. A cloud backup and "free up space" workflow was
considered and deliberately dropped in favour of this.

## 10. Decisions needed from IT

1. Acceptable hosting location and domain; access via SSO?
2. Allowed or blocked: browser speech-to-text, camera, local storage of client photos on personal devices.
3. Approved cloud platform for the multi-user phase (Supabase or the company standard), region and data residency (POPIA).
4. Required controls before go-live: code review, pen test, backup policy, logging, device management.
5. Pilot scope: how many users and projects before the multi-user phase.

## 11. Where things are in the repository

| Path | Contents |
|---|---|
| `README.md` | How to run, use, back up; limitations |
| `ACCEPTANCE.md` | Acceptance scenarios with evidence |
| `docs/MANUAL-CHECKLIST.md` | Physical-device test checklist |
| `docs/MULTI-USER.md` | Proposed shared / live-sync design |
| `src/data/` | Database layer (Dexie), save status, storage measurement |
| `src/lib/` | Pure logic: coordinates, gestures, backup, report, imaging, voice suggestions |
| `src/features/` | Screens: projects, viewer, findings, photos, imports, reports, quick capture |
| `tests/unit`, `tests/e2e` | Automated tests |
