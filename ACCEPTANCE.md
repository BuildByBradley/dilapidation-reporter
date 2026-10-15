# Acceptance checklist and handover log

Built 15 Oct 2026. Environment: Linux container, Node v22.22.0, npm 10.9.4, headless Chromium 141 (Playwright 1.56 build 1194,
software rendering). **No physical tablet, Safari or Firefox was available — those rows are "Not tested".**

Legend: **Pass** = automated test (or inspection) ran and passed here · **Partial** = tested, with a stated gap · **Not tested** = no evidence.

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| A01 | Create project, import five different plans | **Pass** | e2e `A01` (five different aspect ratios preserved, ordered stack of 5, survives reload); unit `A01` |
| A02 | Selected page of multipage PDF | **Pass** | e2e `A02` (page 2 stored: `sourcePage=2`, other pages not substituted), `A02b` (pages 1 and 3 to different floors) |
| A03 | Invalid / cancelled import or replacement | **Pass** | e2e `A03` (txt, HEIC, corrupt PNG, corrupt PDF → clear errors, no assets written), `A03b` (replace requires explicit choice); unit "failed replacement leaves previous plan and findings intact". *Cancel mid-import* is implemented (AbortController) but only the failure path is automated. |
| A04 | Isolate floor: only it, its pins, labels visible; hidden floors get no raycasts | **Pass** | e2e `A04` (visible == interactive == [floor]; 1,760-point `pickFloor` sweep returns only the active floor), `A04b` (reduced motion = immediate) |
| A05 | One-finger horizontal drag rotates, elevation/roll locked | **Pass (synthetic touch)** | e2e `A05` (0.3°/px, 360°+ continuous, elevation constant). Synthetic Pointer Events only — see A07/manual checklist |
| A06 | Vertical/diagonal drags and two-finger twist | **Pass (synthetic touch)** | e2e `A06` (vertical = no change; diagonal = horizontal part only; twist = no yaw/zoom change); unit gesture tests |
| A07 | Two-finger pan/pinch, pointer-count changes | **Pass (synthetic touch)** | e2e `A07` (no pin created in Add-pin mode, no page scroll, 2→1 finger without jump); unit "1->2->1 pointer transitions do not jump" |
| A08 | Toggle 2D/3D repeatedly | **Pass** | e2e `A08` (selection and all finding rows byte-identical in DB; per-view camera restored) |
| A09 | Place/relocate at corners and centre under transforms | **Pass** | unit coordinate round trips (yaw 0/37/90/180/271.5, 2D+3D, <0.01 px); e2e `A09` (5 points, 3D, after rotate+zoom, 2D, after resize: <2 px), `A09b` (tap→uv→reprojection <2 px; nudge = exactly 1 source px; out-of-bounds rejected in unit/e2e `A10`) |
| A10 | Drag, pinch, tap pin, tap outside in placement mode | **Pass** | e2e `A10`, overlap chooser test. Behaviour: in Add-pin/Relocate mode every tap proposes a location (even over a pin; nothing saved until confirmed); in Navigate mode a tap selects; outside the plan is rejected with a message |
| A11 | Photos by camera and file; retake, reorder, caption, delete; camera stops | **Partial** | e2e `A11` with Chromium's *fake* video device: capture→retake→use, upload, caption, reorder, delete, all MediaStream tracks `ended` after capture/accept/cancel. Real camera hardware not tested |
| A12 | Camera denied / unsupported context | **Pass** | e2e `A12` (NotAllowedError message, device-camera picker offered, upload works, HEIC rejected). Insecure-context wording is implemented but only denial was simulated |
| A13 | Rename / archive / reassign categories | **Pass** | e2e `A13`; unit "categories" (duplicates, blanks, archive linkage, reassign-on-delete, reorder) |
| A14 | Reload after edits and attachments | **Pass** | e2e `A14` (fields, severity, multi-line text, coordinates, photo, plans) |
| A15 | Quota / write failure | **Pass** | unit "save status" + e2e `A15` (injected `QuotaExceededError`: "Save failed" shown, no false Saved, draft retained, retry succeeds). Real browser quota exhaustion not exercised |
| A16 | Back up then restore as a new project | **Pass** | e2e `A16` (zip layout, equivalent findings/photos/blobs, all-new IDs, original untouched, edit of copy isolated); unit round trip |
| A17 | Corrupt / missing-asset / future-version backups | **Pass** | e2e `A17` (6 malformed archives incl. `../` path, bad schema, dangling ref → rejected, project count unchanged); unit equivalents |
| A18 | Replace plan with retained pins | **Pass** | e2e `A18` (banner, editor warning, report warning until "Mark reviewed"; replace-and-remove path) |
| A19 | Full report while workspace filtered | **Pass** | e2e `A19` (filter = 2 rows, report = all 8 findings and 6 photos; summary counts from data; CSV 9 lines, exact header); unit report model |
| A20 | Print report: long text, mixed photos, many findings | **Pass (Chromium only)** | e2e `A20`: 48 findings / 86 photos → 51-page A4 PDF via Chromium print; `pdftotext` finds every finding/caption, no toolbar text; no photo page without its caption; no horizontal overflow; selected pages inspected visually. Other browsers' print engines not tested |
| A21 | Return to building, rapid floor switching | **Pass** | e2e `A21` (last click wins; 1 visible/1 interactive; overview restores 5/5) |
| A22 | Delete finding/project, duplicate | **Pass** | e2e `A22`; unit "deleting a finding…", "duplicate is independent" |
| A23 | Resize and device pixel ratio | **Pass (emulated)** | e2e `A23` (DPR 1, 2, 3 emulation + resize; pin tip hit-tested after resize); unit resize reprojection. Real zoom/DPR changes on devices not tested |
| A24 | Same project in two tabs | **Pass** | e2e `A24` (second tab read-only: banner, disabled actions; "Try again" works after the first tab closes) |

Additional automated coverage: data migration v1→v2 fixture, transactional blob/asset cleanup, CSV formula neutralisation, EXIF
orientation mapping/parsing, PNG header size sniffing, gesture thresholds, keyboard mapping, report aggregation, ID remapping.

## Commands run and outcomes (this build)

| Command | Outcome |
|---|---|
| `npm ci` (fresh clone of this repo) | installed, 0 vulnerabilities reported |
| `npm run typecheck` | no errors |
| `npm run lint` | no errors, no warnings |
| `npm run test -- --run` | 4 files, **48 tests passed** |
| `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome npm run test:e2e` | **34 passed** (≈2 min) |
| `npm run build` | succeeded (main chunk ≈470 kB, pdf chunk ≈334 kB + 1.4 MB worker) |

`npx playwright install chromium` was not needed in this container (pre-installed Chromium used via `PLAYWRIGHT_CHROMIUM_PATH`).

## Observed performance (headless, software-rendered Chromium in a container — not a tablet)

Scale fixture: sample project + 250 extra findings and 500 photo records (referencing 3 distinct photo assets), 5 plans.

* Workspace with 258 finding rows: isolate transition settled in ≈440 ms.
* 200 pointer-move frames of a rotate drag: median frame interval 16.7 ms, p95 18.2 ms, max 25 ms.
* Full report with 506 photos reached "Ready to print" in ≈3.9 s; JS heap ≈13 MB (distinct-photo memory not representative, see README).

## Deviations and decisions to review

1. Canvas 2D axonometric renderer instead of Three.js / R3F (README → Architecture). Same locked-elevation orthographic result, no WebGL dependency.
2. In placement mode a tap over an existing pin proposes a location rather than selecting that pin (so a pin can be placed next to / onto another one).
3. A new finding is saved first, then photos are added in its editor (avoids orphaned assets from a cancelled draft).
4. Default floor display width is 100 units; stack spacing is derived from the tallest plan.
5. Light theme only; no PWA.

## Material limitations

See README → *Known limitations*. Most important: **no physical-touch, Safari or real-camera verification**; use `docs/MANUAL-CHECKLIST.md`.
