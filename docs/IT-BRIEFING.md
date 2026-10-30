# Dilapidation Inspector: build breakdown for IT sign-off

Prepared 30 Oct 2026 from the repository, the build sessions that produced it, and a re-run of the automated checks.
Items marked **[confirm]** are settings held in Supabase, GitHub or the hosting account that could not be seen from the code.

## 1. Summary

**What it is.** A web app for recording building-condition ("dilapidation") inspections on phones and computers. An inspector
imports floor plans, views them as a 3D stack or flat 2D, drops numbered pins where defects are, attaches photos, and produces a
printable "Conditioning Report" and a CSV. Work is kept on the device first (so it works with no signal) and synchronises to a
cloud database, so the site team and the office see the same project. Projects can be shared with colleagues.

**Status.** A working, automatically tested prototype with a real backend and row-level access rules. It runs on personal
accounts and has had no independent review, so it is ready for a **controlled pilot**, not yet for company-wide use. Section 8
lists what closes that gap, including two-factor authentication.

It records observations only. It does not certify building safety, diagnose causes or measure anything; pin positions are
positions on the supplied drawing.

## 2. What it does

* Projects with site, client, inspector, reference and report summary.
* Floors: import PNG, JPEG or a chosen PDF page; add, rename, reorder and remove floors; replace a plan without losing pins (pins are flagged for review). PDF plans stay sharp when zoomed.
* 3D stack and 2D views; locked viewing angle; mouse, keyboard and touch gestures; phone layout with edge drawers and a bottom sheet.
* Findings: numbered per floor (G-001, L1-001), category, severity, description, location notes; precise pin placement with crosshair, magnifier and nudge buttons; copy a finding to other floors; renumber.
* Photos: camera or upload; rotate, crop and draw on photos; captions, order and cover photo. Photos are stored compressed (1920 px).
* Storage meter: shows how much the device is holding against an adjustable budget (default 1 GB), with an estimate of remaining photos and warnings at 70% and 90%.
* Report: summary, tables by floor and category, floor plans with pins, each finding with photos, key plan and close-up plan. Print or save as PDF; CSV export.
* Backup to a .zip file and restore as a new project; duplicate project.
* Cloud: sign-in, sync between a user's devices, project sharing by invite link (owner, editor, viewer roles).
* Help: searchable user guide, an AI "Ask" box, and a "Suggest an improvement" form.

## 3. How it was built

Built between 15 and 26 Oct 2026 by **Claude Code (Anthropic's AI coding assistant)**, directed by the project owner (an architect)
who tested the running app on real screens and steered the requirements in plain language. The first stage worked from a written
specification (*Dilapidation Inspector, Prototype Implementation Specification*, 15 Oct). Later stages were requested one feature at a time.
Every stage ended with the automated checks passing before it was published.

| Stage | Date | What was done |
|---|---|---|
| 1. Foundation | 15 Oct | Local storage layer, coordinate maths, gesture logic, backup format and report model, written test-first |
| 2. Workspace | 15 Oct | Screens, canvas 3D/2D viewer, plan import, pins, photos, categories, report, browser tests |
| 3. Hardening | 15 Oct | Bugs found by running in development mode, PDF and long-report print tests, edit-lock fallbacks; written acceptance checklist (24 scenarios) |
| 4. Phone layout | 15 Oct | Full-screen plan with edge drawers and bottom sheet, after the owner asked that the plan be the main working space |
| 5. Cloud sync (Rev 02) | 15 Oct | Sign-in and phone-to-computer sync on Supabase; three-step pin placement sheet on phones |
| 6. Rev 03 | 16 Oct | Manual sync option, password reset, photo markup, compressed photos, sharper plans, executive summary, add floor |
| 7. Sharing and help (Rev 04) | 17 Oct | Project sharing by invite link with roles; help guide, AI assistant and suggestion box |
| 8. Refinements | 17 to 26 Oct | Per-floor numbering, copy finding to floors, report redesign, sync robustness, report retitled "Conditioning Report" |
| 9. Storage meter | 30 Oct | Storage usage bar and warnings |

All code was written by the AI tool. The history contains no human code review and no pull requests until this release PR.

## 4. Architecture

```
 Phone / computer browser                     Supabase project (cloud)                 Anthropic API
┌─────────────────────────────┐   HTTPS   ┌──────────────────────────────────┐  HTTPS ┌──────────────┐
│ Static web app (React)      │──────────▶│ Auth (email + password)          │        │ Claude model │
│ Working copy in IndexedDB   │           │ Postgres: records, members,      │        │ (help answers│
│ (works offline)             │◀──────────│   invites, feedback  (RLS on)    │        │  only)       │
│ Sync engine                 │  Realtime │ Private storage bucket "blobs"   │        └──────▲───────┘
└─────────────▲───────────────┘           │ Edge Function "assistant" ───────┼───────────────┘
              │ static files              └──────────────────────────────────┘
     GitHub Pages (public)                        optional: Resend (feedback e-mail)
```

* **Front end:** TypeScript, React 19, Vite; static files only. About 7,000 lines of app code, 2,800 lines of tests, 450 lines of SQL and server function.
* **Local data:** IndexedDB (Dexie). Every record has an ID; the server stamps update times; deletes are kept as markers so other devices learn of them. Phones default to manual "Sync now" to save mobile data.
* **Viewer:** hand-written Canvas 2D engine (no WebGL). PDF.js for plans, fflate for zip backups, zod for backup validation, supabase-js for the backend.
* **Runtime dependencies (7):** react, react-dom, dexie, pdfjs-dist, fflate, zod, @supabase/supabase-js. Licences read from the installed packages: MIT or Apache-2.0 (IT should run its own scanner).

## 5. Data, access control and security

### What is stored where
| Data | Where |
|---|---|
| Project details (site, address, client, inspector), findings, categories | Supabase Postgres, table `records`, and the user's browser |
| Plans and photos | Supabase Storage, private bucket `blobs`, path `<projectId>/<fileId>`, and the user's browser |
| Members and invites | Tables `project_members`, `project_invites` |
| Help suggestions | Table `feedback` (users can add; nobody can read it through the app) |
| Sign-in session, sync mode, device ID, storage budget | Browser localStorage |

### Access control (from `supabase/setup.sql`, `sharing.sql`)
* Row-level security is on for every table: users see only projects they are members of.
* Roles: **owner**, **editor** (can change), **viewer** (read only). Only the owner can delete a project, invite or remove people.
* Storage policies match: members read, owners and editors write.
* People join by **single-use invite link**: random 36-character token, 14-day expiry, revocable. The token is in the URL fragment (`#/join/...`), which browsers do not send to servers. Invites are by link, not e-mail address, because e-mail addresses are not verified on this project (noted in `sharing.sql`).
* The Supabase "publishable" key in the front end is public by design and grants only what the rules allow. A search of the code and git history found no secret keys.

### AI help assistant
* A server function requires a signed-in user, then sends their typed question plus the user guide to Anthropic's Claude API and returns the answer (limits: 20 turns, 4,000 characters each).
* **The code sends no inspection data**, only what the user types in the Ask box.
* The Anthropic key is a Supabase server secret, not in the repository.
* "Suggest an improvement" stores the message, the user's e-mail and the screen name in `feedback`, and **optionally** e-mails it through Resend (third party) if configured **[confirm]**.

### Other properties
* Photos are re-encoded in the browser, which drops GPS metadata. Original camera files are not kept by the live app.
* Backup .zip files are not encrypted.
* Imports: file types sniffed rather than trusted, size limits (plans 50 MB, photos 20 MB); backups validated before anything is written (bad paths, future versions, oversized archives rejected). CSV export neutralises spreadsheet formula injection.
* Permissions requested: camera only. No microphone, no location.

## 6. Test evidence (re-run 30 Oct)

| Check | Result |
|---|---|
| TypeScript type check | clean |
| Lint | clean |
| Unit tests (Vitest) | 74 passed, 2 skipped (the skipped ones need a live Supabase connection) |
| Browser tests (Playwright, Chromium) | 60 of 60 passed (about 3 minutes, headless Chromium on Linux) |
| `npm audit` (production) | 1 high advisory in `zod` (memory exhaustion on huge collections). zod is only used to validate backup files a user imports; fix is an upgrade to zod 4.x (breaking change, not yet done) |

**Never tested:** real phones and tablets, Safari, Firefox, real camera hardware, printing outside Chromium, assistive technology, or the Supabase rules against the live database (they were read and tested with mocks, not attacked). No penetration test; no independent code review.

### Real-world use so far

The owner has used the app on one complete live project (a multi-storey commercial building, anonymised here), 19 to 22 Oct 2026:

| Measure | Figure (from the project's CSV export and report) |
|---|---|
| Floors with plans | 9 |
| Findings (pins) recorded | 247 |
| Photos attached | 513 |
| Capture period | about 3 days (19 to 22 Oct) |
| Output | Conditioning Report, edited by the owner to suit the client's needs, plus CSV |

The owner reports that it ran on phone, tablet and computer; that several people captured on the same project at the same time; that
the project was shared with colleagues who signed in to view it; and that work captured on a phone appeared on the computer after
signing in. These are the owner's observations of normal use, not results of a formal test, and no one has independently verified
them. This is the strongest evidence that the app works in the field, and it also means **real client data is already in the cloud
project on the owner's account**, which is why gaps 1, 2 and 5 below are the priority.

## 7. Gaps IT will likely raise, with proposed responses

| # | Gap | Proposed response |
|---|---|---|
| 1 | Code and site are on the owner's personal GitHub account; repository and site are **public** | Move to a private repository in a company organisation; host on company infrastructure |
| 2 | Backend is a Supabase project on the owner's account; plan, region and admin access undocumented **[confirm]** | Company-owned project in an approved region; documented admins; POPIA / data-residency decision |
| 3 | Sign-up appears open to anyone with the URL; e-mail confirmation unknown **[confirm]**; 6-character minimum password | Restrict sign-up to company e-mail domain or SSO; stronger password policy |
| 4 | **No two-factor authentication** (raised by IT) | Add authenticator-app 2FA; see section 8 |
| 5 | Client data (addresses, names, property photos) in the cloud with no app-level encryption; platform admins can read it | Classify the data; confirm encryption at rest and admin-access policy |
| 6 | No audit trail of who changed what | Add change history before records are relied on as evidence |
| 7 | AI help box uses a third-party API and has no per-user rate limit in the code | Approve or remove; add rate limit and a spend cap on the key |
| 8 | No Content-Security-Policy or security headers (GitHub Pages cannot set them) | Set on company hosting |
| 9 | No automated dependency or secret scanning; zod advisory | Enable scanning and CI; upgrade zod |
| 10 | Unencrypted backups; client data on personal phones | Backup policy; device management |
| 11 | Not tested on target devices and browsers | Run `docs/MANUAL-CHECKLIST.md` on the real company devices |
| 12 | AI-written code with no independent review or penetration test | Disclosed here; commission both before company-wide release |
| 13 | No error monitoring or logging visible to IT | Log to a company-approved service |
| 14 | Storage meter measures the device, not the cloud quota | Add cloud usage once the company plan is chosen |

## 8. Two-factor authentication: proposed approach

Supabase Auth supports time-based one-time codes (authenticator apps such as Microsoft Authenticator) **[confirm availability on the chosen plan]**.

1. Enable MFA in the Supabase Auth settings.
2. Add to the app: a "Turn on two-factor" step that shows a QR code, then asks for the 6-digit code; and a code prompt at sign-in.
3. Enforce on the server, not only in the screen: database rules that require an MFA-verified session (`aal2`) before records or files can be read or written, so a stolen password alone gets nothing.
4. Recovery: a documented process for a lost phone (admin removes the factor), and an option to enrol a second device.
5. Tests: unit tests for the rule, browser tests for enrol and sign-in with a test authenticator, and a manual run on real phones.

Not built yet. Longer term, single sign-on through the company identity provider would replace password plus 2FA.

## 9. What is needed before company-wide release

**Design and hand-off:** a short visual design pass on phone and tablet (spacing, tap sizes, contrast, colour use); accessibility review against WCAG 2.1 AA; a hand-off pack (design tokens, component list, screen states, empty and error states); and an agreed brand/name and report template.

**Checks:** run the physical-device checklist (`docs/MANUAL-CHECKLIST.md`) on company phones and tablets in Safari and Chrome; a pilot with named users on real inspections; independent code review and penetration test; backup-and-restore drill; load test with a realistic project (many floors and hundreds of photos); privacy review (POPIA) of what is stored and where.

**Operations:** company-owned hosting and backend; sign-up restriction and 2FA; monitoring; a support contact; a release process (protected main branch, reviewed changes, automated checks on every change); a data-retention and deletion policy.

## 10. Decisions needed from IT

1. Approved hosting and domain; must sign-in use company SSO?
2. Approved backend platform, region and administrator; classification of client addresses and photos.
3. Allow or block the AI help assistant and its provider.
4. Two-factor: authenticator app now, SSO later?
5. Required controls before go-live (review, penetration test, backup policy, logging, device management).
6. Pilot scope: how many users and projects, for how long.

## 11. Where to look in the code

| Path | Contents |
|---|---|
| `supabase/setup.sql`, `sharing.sql`, `sharing-fix-1.sql`, `feedback.sql` | Tables, row-level security, invite logic |
| `supabase/functions/assistant/` | Help assistant server function and user guide |
| `src/sync/` | Sync engine, backend connection, sign-in and sharing |
| `src/data/`, `src/lib/` | Local database, storage measurement, backup, report model, imaging, coordinates |
| `src/features/`, `src/components/` | Screens: projects, viewer, findings, photos, imports, reports, storage bar |
| `tests/unit`, `tests/e2e` | Automated tests |
| `ACCEPTANCE.md`, `docs/MANUAL-CHECKLIST.md` | Acceptance scenarios and physical-device checklist |
