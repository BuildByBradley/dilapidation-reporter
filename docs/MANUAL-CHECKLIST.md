# Manual checklist (physical device and print)

Record device, OS, browser and date next to each result. **Nothing here has been run yet** — these checks need hardware
that was unavailable when the prototype was built.

## Touch device (tablet Safari / Android Chrome)
Setup: serve over trusted HTTPS (README → *Camera access*), open the sample project.

- [ ] Overview: tap a floor — all other floors fade out completely; nothing left to tap behind it.
- [ ] One-finger horizontal drag rotates smoothly through 360°; the far side of the plan is revealed (no fixed-view switch).
- [ ] One-finger vertical / diagonal drag never tilts or flips the view.
- [ ] Two-finger drag pans; pinch zooms; twisting two fingers does **not** rotate; page never scrolls or zooms while on the canvas.
- [ ] Lifting one finger mid-pinch does not make the view jump.
- [ ] Add pin → tap: crosshair + magnifier appear, finger does not hide the target; nudge buttons are comfortable (≥ 44 px).
- [ ] A drag, pinch or palm touch in Add-pin mode never drops a pin.
- [ ] Pins stay on their drawing position after rotating/zooming/switching 2D ↔ 3D and rotating the tablet.
- [ ] Take photo: permission prompt appears only when tapping *Take photo*; rear camera used; capture → retake → use; camera light goes off.
- [ ] Deny camera permission: message appears and Upload / device-camera picker still work.
- [ ] Bottom sheet / side panel never hides the whole plan; text fields scroll normally.
- [ ] Performance with the 250-finding fixture feels smooth (note device, observed behaviour — do not invent numbers).

## Print / PDF
- [ ] Open a long report → Print / Save as PDF in Safari, Chrome and Firefox: A4, margins consistent, no workspace controls.
- [ ] No photo separated from its caption; no clipped text; plan pins and legend legible.
- [ ] Floors without a plan say "not imported"; flagged pins show the location-review warning.

## Backup
- [ ] Back up, clear site data, restore: project, pins, photos, categories identical; original (if kept) unchanged.
