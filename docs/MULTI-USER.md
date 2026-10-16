# Multi-user and live sync: findings and proposed design

Status: **research only, nothing here is built.** Written 16 Oct 2026 after reading the current code.

## Where the app is today

* **Local-first, single device.** All data lives in the browser's IndexedDB through Dexie (`src/data/db.ts`). There is no
  server, no login and no network code. Supabase is **not** wired in yet; the 1 GB figure we discussed is a Supabase plan
  limit we would hit once photos are uploaded.
* **One editor per project, per browser.** `src/data/projectLock.ts` uses the Web Locks API so a second tab opens read-only.
  This protects one device only. It does nothing across people.
* **Good news for syncing:** every record already has a UUID (`src/lib/ids.ts`), most have `createdAt` / `updatedAt`, and edits
  are small patches (`FindingPatch`, `relocateFinding`, photo caption/order). Photo bytes live in a separate `blobs` table,
  keyed by id, and `Asset.sizeBytes` now records what each photo actually occupies.
* **Things that will bite a sync layer:**
  1. `Project.nextFindingNumber` is a local counter. Two people adding pins at once will both mint `D-007`.
  2. Deletes are hard deletes (`deleteFinding`, `deletePhoto`). A second device cannot learn something was removed.
  3. Photo `order` / `isCover` are rewritten across sibling rows, so two people reordering the same finding will collide.
  4. Replacing a floor plan flags findings `locationNeedsReview`; that has to propagate to everyone.
  5. `FindingEditor` adopts outside changes only when the user is not mid-edit. That is exactly the behaviour live updates
     need, so it can stay.

## Recommended approach: Supabase, with the local database kept as the working copy

Keep Dexie as the day-to-day store (site basements have no signal) and add a sync layer on top. This keeps the manual
editing flow exactly as it is.

| Concern | Proposal |
|---|---|
| Accounts | Supabase Auth (email magic link or Google). Table `project_members(project_id, user_id, role)` with roles owner / editor / viewer. |
| Access control | Postgres Row Level Security on every table: a row is visible only to members of its project. Storage bucket paths are `projectId/assetId/...` with matching policies. |
| Data model | Mirror the Dexie tables in Postgres. Add `rev` (bigint, server-incremented), `updated_by`, and `deleted_at` (soft delete) to each synced table. |
| Writing | An **outbox**: each local write also queues a small operation (table, id, changed fields). A background worker sends them when online and retries on failure. The UI keeps working offline. |
| Reading | On open and on reconnect, pull rows with `rev` greater than the last cursor. While online, subscribe to Supabase Realtime for the project so teammates' changes appear within seconds. |
| Conflicts | Last write wins **per field**, using the server's `rev`. Different fields of the same finding merge cleanly (you change severity while the office edits the description). Same field edited twice keeps the later write and records the earlier one in history. |
| Finding numbers | Assign `reference` on the server with a per-project counter inside one transaction. Offline pins show a provisional label (for example `D-new-3`) until they sync. Reports should warn if any provisional numbers remain. |
| Photos | Upload compressed images to Supabase Storage from a queue; store the path on the asset row. Thumbnails sync first and full images load on demand. Local copies remain as a cache. |
| Presence | Replace the Web Lock with Realtime presence: "Sam is viewing D-014". Optionally a soft warning when two people open the same finding. No hard locks. |
| Audit trail | A `finding_history` table (who, when, old value, new value). For a dilapidation record this is worth having regardless of conflicts. |

### Why not something heavier
CRDT libraries (Yjs, Automerge) and sync engines (PowerSync, ElectricSQL, Replicache/Zero) all work, but they add a lot of
moving parts. Our data is mostly "each inspector creates their own findings", so true simultaneous edits of the same
field are rare. Per-field last-write-wins on top of Supabase covers it. If we later need rich-text co-editing or very
large offline datasets, PowerSync (which sits on Postgres) is the most natural upgrade.

## Storage and cost, in light of the 1 GB limit
* With the new storage saver, a photo averages roughly 0.3 to 0.5 MB, so 1 GB holds about 2,000 to 3,000 photos.
* Supabase's free plan has limits on file storage, database size, monthly download (egress), and it may pause projects
  after a period of inactivity. **Check the current figures before committing**; they change. A paid plan is likely
  cheaper than the time spent managing space by hand.
* The storage bar in the app can switch from "this device" to "cloud project" by summing `sizeBytes` on the server.
* The office backup / free-up flow was deliberately **not** built. With cloud storage and shared access it is mostly
  unnecessary: the office person can export a project ZIP from the same data the inspector sees.

## Suggested build order
1. **Auth and membership** (sign in, create/join project, RLS). Nothing syncs yet.
2. **One-way push** of findings and categories (no photos) and a read-only "office view" in a second browser.
3. **Two-way sync** with outbox, pull cursor, soft deletes and server-assigned numbers.
4. **Photos** through the upload queue with thumbnails first.
5. **Realtime and presence**, then history/audit.
6. Offline hardening: reconnect storms, partial uploads, clock skew, large plan files.

Each step is shippable on its own and leaves the local-only mode working.

## Open questions for you
1. How many people per project, and may two people edit the **same** finding at once, or only add their own?
2. Should the office see changes **live** while you are on site, or is "sync when you have signal" enough?
3. Sign-in method (magic link, Google, company SSO)?
4. Data location and privacy (POPIA): which Supabase region, and who may see a client's photos?
5. Who owns a project when someone leaves the team?
