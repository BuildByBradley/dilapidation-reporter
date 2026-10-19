/**
 * The user guide for Dilapidation Inspector. Shown in the app's Help panel and given to the help assistant as its
 * only source of truth — keep it in step with the app when features change.
 */
export const HELP_GUIDE = `# Dilapidation Inspector — user guide

## What the app is for
Dilapidation Inspector records building-condition ("dilapidation") inspections on floor plans: import the plans, drop pins where defects are, describe and photograph them, and produce a printable report. It records observations; it does not certify safety, diagnose structural causes or measure anything. Pin positions are positions on the supplied drawings, not surveyed measurements.

## Opening the app and installing it on a phone
- The app is a web page: https://buildbybradley.github.io/dilapidation-reporter/
- iPhone (Safari): open the link, tap Share, then "Add to Home Screen". Android (Chrome): menu ⋮ → "Add to Home screen" / "Install app".
- When a newer version is published, a dark bar says "A newer version of the app is available" — tap Reload now. If a device looks out of date, close and reopen the app (on a computer press Ctrl+F5).

## Projects
- Projects page: New inspection (name, site, address, client, inspector, date, reference, notes), Restore backup, Load sample project (invented demo data).
- Each project card: Open, Rename / details, Duplicate, Back up, Delete (or Leave for projects shared with you).
- Project details (inside a project: Project ▾ → Project details) also holds the Executive summary text for the report.

## Floors and plans
- A new project starts with five floors (Ground, Level 1–4). "+ Add floor" under the floor list adds Level 5, 6…; "Remove" appears on floors without findings.
- Import / Replace on a floor loads a plan: PDF, PNG or JPEG (up to 50 MB). For a PDF, pick the page. Several files can be imported at once.
- Replacing a plan that already has pins asks whether to keep the pins (they are flagged "location needs review" until moved or confirmed) or remove that floor's findings.
- Rename and ↑ ↓ (reorder) are on each floor. "Display width" only lines up the 3D stack visually.
- PDF plans stay sharp when zoomed: after you stop moving, the visible area is re-drawn from the original PDF. The label at the bottom right of the plan says "PDF sharp", or "⚠ not sharp" with the reason (for example the original PDF has not synced to this device yet). PNG/JPEG plans cannot be sharper than their own pixels.

## Moving around the plans
- The overview shows all floors stacked in 3D. Tap a floor (or pick it in Floors) to isolate it; "Return to building" goes back. "2D view" shows the floor flat from above.
- Phone/tablet: one finger sideways rotates (3D) or pans (2D); two fingers pan and pinch to zoom. The viewing angle is locked, so the plan never tips over.
- In a single-floor 3D view, rotating turns around the pin you are placing (or the selected pin), so that spot stays in view; otherwise it turns around the centre of the screen.
- Computer: drag rotates (3D) or pans (2D), Shift-drag pans, mouse wheel zooms; keys ←/→ rotate, +/− zoom, F fits.
- On a phone the plan fills the screen: Floors tab on the left, Findings on the right, the project menu at the top, tools at the bottom.

## Adding a finding (pin)
1. Isolate a floor, tap Add pin, then tap the plan where the defect is. The zoomed view in step 1 has Wider / Normal / Closer / Closest buttons.
2. On a phone a full-screen panel opens in three steps — the keyboard does not pop up first:
   - Step 1 Position: a zoomed view and an arrow pad move the pin one plan pixel at a time ("Bigger steps" moves 10). "Show plan to re-tap" hides the panel so you can tap a new spot.
   - Step 2 Details: title (required), category (required), severity, description, location notes.
   - Step 3 Photos (optional): Take photo or Upload photos; ✎ on a thumbnail draws on it, × removes it.
3. Save finding (the button shows how many photos will be attached). Findings get references D-001, D-002…
- Severity choices: Not assessed, Minor, Moderate, Major. They are record-keeping labels, not safety ratings.
- To edit later: select the pin (or the row in Findings). Relocate pin moves it; Delete finding removes it and its photos.

## Photos
- Take photo uses the camera inside the app: Capture → Retake / ✎ Draw on photo / Use photo. Drawing tools: pen, circle, arrow; red, yellow, white, black; thin or thick; Undo and Clear. The drawing is saved into the photo.
- If the camera is blocked, use "Take photo with device camera" or Upload photos.
- In a finding: captions, ← → to reorder, Make cover, Delete, tap a photo to see it full size.
- Photos are stored compactly (about 1920 pixels on the long side, roughly 0.25–0.4 MB each) to save storage and mobile data. Drawing on photos that are already saved in a finding is not available yet.

## Categories
- Project ▾ → Categories: add, rename, recolour, reorder, archive/restore, or delete (findings in a deleted category are moved to another one first).
- New projects start with: Cracks, Moisture / water damage, Finishes, Doors / windows, Floors, Ceilings, External works, Other. Changes affect only that project.

## The report
- Report (top bar) builds the full report from all findings, whatever filters are set in the workspace.
- Order: cover page; Executive summary (1–2 pages: the inspector's summary text, counts by severity, a floor × severity table, and key major/moderate findings); notes and scope; summary tables; a page per floor plan with numbered pins; then every finding with its plan extract and photos.
- Write the executive summary in Project ▾ → Project details. "Draft from findings" writes a neutral first draft to edit. If it is left empty, the report uses an automatic draft and says so.
- Print / Save as PDF opens the browser's print dialog — choose "Save as PDF". Wait for "Ready to print". Export findings CSV gives a spreadsheet of all findings.

## Sync between phone and computer (cloud)
- Projects page → "Sync phone and computer": create an account (email + password, at least 6 characters) or sign in. Use the same account on every device.
- Sync mode is set per device. Manual (default on phones): nothing is sent or received until you tap the "⟳ Sync now" button in the top bar, which shows how many changes are waiting — this saves mobile data. Automatic (default on computers): live, changes appear within seconds.
- The status button in the top bar shows Synced · live, Syncing…, Offline · N waiting, or Sync problem (hover or tap for the reason).
- Everything is saved on the device first, so the app works without signal; changes upload when you sync or come back online.
- Forgot password? on the sign-in box emails a reset link; opening it asks for a new password. Signed in, "Change password" is in the sync box.
- Sign out stops syncing on that device; its projects stay on it.

## Sharing a project with other people
- Inside the project: Project ▾ → Share project…  Choose Editor (can add and change findings) or Viewer (can look and print reports), then Create invite link and send it by WhatsApp, email or SMS.
- The person opens the link, signs in or creates an account, and the project appears in their list. Each link works once and expires after 14 days; unused links can be sent again or revoked.
- The owner can change someone's access or remove them in the same window. Viewers see a "viewer" banner and cannot change anything.
- People a project is shared with see "Shared · Editor/Viewer" on the project card. They can Leave it (it disappears from their devices, nothing is deleted for others). Only the owner can delete a shared project for everyone.

## Backups and storage
- Back up (project card or Project ▾) downloads a .zip with everything; Restore backup on the projects page loads it as a new project.
- Without cloud sync, projects live only in that browser: clearing site data or a private window can lose them — back up regularly.
- "Storage & backups" on the projects page shows how much space is used.

## Troubleshooting
- Phone and computer show different things: sign in with the same account on both, then tap Sync now (manual mode needs it).
- "Sync problem": tap it to see what did not upload and why (for example weak signal, a sign-in that expired, or a project that belongs to another account). Everything else is still uploaded; the rest waits safely on the device. Try again fixes signal drops; "Copy details" copies the report to send to the developer.
- Zoomed PDF looks blurry: check the label at the bottom right of the plan; reload the app if it is old; sync if the original PDF has not arrived yet.
- "This tab is read-only": the same project is open in another tab or window on that device — close the other one and press Try again.
- Camera does not start: allow camera access in the browser settings, or use Upload photos.
- "Browser storage is full": delete old projects or photos (back up first).

## Asking for help or improvements
- Help (the ? button) has this guide, the assistant you can ask questions, and "Suggest an improvement" to send a bug report or idea straight to the app's developer.
`;
