# Deseret Production Continuity Implementation Plan

> **Historical plan.** This is the plan as written before implementation. Several interfaces changed after cross-review; the
> current behaviour is described in [the current description](../../DESERET_PRODUCTION_CONTINUITY_20261121.md). Superseded below:
> - `payload.sources` is now `Record<sceneId, { archiveId, sceneVersion, videoVersionId }>`, confirmed per scene for the current round.
>   It was not a `Record<sceneId, archiveId>` defaulted per task.
> - `archiveSelection` / `archiveCandidates` take the editor's `productionReadableVersionQuery`.
> - `deseretHandoverStatements` returns `{ statements, guard }` and accepts a named `archiveId`.
> - `batchHandoverCheckpoint`, `nativeArchiveFiles`, `engineeringFolderGuard` and `validArchiveGuard` were added.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deseret tasks get an internal, versioned production archive (engineering file + optional preview, materials, next steps) that is independent of daily reports. Each external round publication pins one valid archive per scene. Editor changes inherit the archives with a separate verification by the incoming editor.

**Architecture:** Four internal MySQL tables (migration 0010; archive file references in their own table, not JSON) and one domain module, `db/deseret-production-archive.ts`. The module validates archive files, builds the atomic statements and computes validity.
- The integration service (`db/deseret-integration.ts`) projects archives, verifications and per-package sources to AIGC roles only. It also gates `package.publish`.
- Handover flows in `db/backend.ts` record Deseret verification rows.
- Production read authorization grants the task's current editor the archived versions.
- The native workspace gets an `archive` upload kind that reuses staging and formal commit.

**Tech Stack:** TypeScript, React, node:test with `--experimental-transform-types`, in-memory SQLite harness (`tests/support`), MySQL migrations.

**Spec:** `docs/superpowers/specs/2026-11-21-deseret-production-continuity-design.md` (section "实施决定" governs).

## Global Constraints

- Daily reports stay exactly as they are: no new required field, upload, link, stage, open period, entry point or data change.
- Ordinary (non-Deseret) projects, first assignment, reviewer-only changes and single-scene QC submission keep their current rules.
- Archives, package sources and verifications are never serialized into `review.published`, other outbox bodies, material transfer tasks, `state_json` or resends.
- Archive rows are immutable. A package source never changes after publication; old packages get no invented source.
- Write scope: only `E:/Deseret-AIGC-UAT/repair-20261120-aigc`. No commit, push, deploy or real service. Keep the 13 earlier uncommitted items and the design file.

## Review Focus

1. A version referenced by an archive is deleted or recycled later. The archive must show as invalid and publishing must be blocked; deleting a referenced version must be refused. (Task 1 and Task 3 tests.)
2. A chain of editor changes A→B→C. C must read A's and B's archived versions, and A and B must lose access. (Task 2 test.)
3. A concurrent second publish, or an archive registered between preview and publish. Binding is checked inside the publish transaction; a stale revision is rejected. (Task 3 test.)
4. A package spanning two language tasks with different editors where one task lacks an archive. The error names that task, and nothing is published. (Task 3 test.)
5. A synthetic secret in an archive's next steps or file names. It must not appear in any outbox body or material task after publication or resend. (Task 3 test.)

---

### Task 1: Schema, migration sync and deletion protection

**Files:**
- Create: `db/mysql/migrations/0010-deseret-production-archives.sql`
- Modify:
  - `scripts/mysql/migrations.mjs`
  - `scripts/mysql/verify-schema.mjs`
  - `db/mysql/schema-contract.json`
  - `db/business-deletion.ts:92,161`
  - `operations/demo-cleanup.ts:11,30,37`
  - `db/file-deletion-guard.ts`
  - `db/backend.ts:4148`
  - `docs/PRODUCTION_OPERATIONS_20261118.md`
- Test: `tests/deseret-archive-schema.test.ts`

**Interfaces — Produces these tables:**
- `deseret_production_archives`: `id` PK, `project_id`, `language_project_id`, `archive_number` INT, `created_by_email`, `next_steps`, `created_at`. Unique index `idx_deseret_archive_number` on (`language_project_id`, `archive_number`).
- `deseret_archive_files`: `id` PK, `archive_id`, `language_project_id`, `file_version_id`, `role` (`project` | `preview` | `material`), `created_at`. Unique index on (`archive_id`, `file_version_id`). Plain joins only: the MySQL translation of `json_each(column)` is a correlated JSON_TABLE, avoided here.
- `deseret_package_sources`: `id` PK, `project_id`, `package_id`, `scene_id`, `scene_version` INT, `language_project_id`, `video_version_id`, `archive_id`, `confirmed_by_email`, `created_at`. Unique index `idx_deseret_package_scene` on (`package_id`, `scene_id`).
- `deseret_task_handovers`: `handover_id` PK, `project_id`, `language_project_id`, `handover_kind`, `from_editor_email`, `to_editor_email`, `archive_id` NULL, `verification`, `verification_notes`, `verified_by_email` NULL, `verified_at` NULL, `created_at`.

- [ ] Test `schema version 0010 is wired everywhere`:
  - `migrationNames.at(-1) === '0010-deseret-production-archives.sql'` and `currentSchemaVersion === '0010'`.
  - `schemaForVersion('0010')` has the three tables; `schemaForVersion('0009')` has none of them.
  - The contract's columns and unique indexes match the SQL file (parse the CREATE statements).
  - `recordTables` and the demo cleanup list contain all three.
- [ ] Test `archived versions cannot be deleted`: insert an archive referencing a project, preview and material version. `fileVersionReferences` returns kind `archive` for each, and `versionsUnreferenced` is false in SQLite.
- [ ] Run; expect FAIL. Implement; run; expect PASS.

### Task 2: Archive domain module and read authorization

**Files:**
- Create: `db/deseret-production-archive.ts`
- Modify: `db/production-file-access.ts`, `lib/deseret-workspace.ts`
- Test: `tests/deseret-production-archive.test.ts`

**Interfaces — Produces:**
- `type DeseretArchive = { id; number; taskId; createdBy; createdAt; projectVersion: ArchiveFile; preview?: ArchiveFile; materials: ArchiveFile[]; nextSteps: string; valid: boolean; missing: string[] }`
- `type ArchiveFile = { id; name; version; kind; live: boolean }`
- `archiveSelection(db, projectId, taskId, input: { projectVersionId: string; previewVersionId?: string; materialVersionIds?: string[]; nextSteps?: string }): Promise<{ statements, guard: { sql, values }, id }>`
  - Rejects with `DESERET_ARCHIVE_INVALID` (422) when the project version is not a live `03.project` version of this task, the preview is not a live video of this task, a material is not a live version of this task, there are more than 50 materials, or the next steps exceed 4000 characters.
  - The guard rechecks liveness and task membership in the write transaction. `archive_number` is `COALESCE(MAX)+1` inside the INSERT.
- `taskArchives(db, projectId, taskIds: string[]): Promise<DeseretArchive[]>` returns newest first; validity is recomputed at read time.
- `archiveReadableClause`: SQL fragment added to `productionReadableVersionQuery` — a version referenced by any archive of the task `lp` (whose `editor_email` is the reader) is readable.

- [ ] Tests:
  - Register from existing versions, both kinds.
  - Rejected for: staged, deleted, another task, a library file, a non-project category as the engineering file, a non-video preview.
  - Numbers increase per task.
  - Validity turns false when the referenced version is deleted, and the deleted version is named in `missing`.
  - Read clause: the current editor of the task can read the archived versions; the previous editor, another task's editor and QC cannot. A chain A→B→C reads all archives.
- [ ] Run; FAIL; implement; PASS.

### Task 3: Integration service — projection, actions, publish gate

**Files:** Modify `db/deseret-integration.ts`, `lib/deseret-workspace.ts`. Test: `tests/deseret-production-archive.test.ts` (service section).

**Interfaces — Produces:**
- Workspace fields:
  - `archives: DeseretArchive[]` — lead: all tasks; producer: own tasks; qc: none.
  - `archiveCandidates: { id; name; taskId; kind: "project" | "video" | "material"; version }[]` — the same scope.
  - `handovers: { id; taskId; kind; from; to; archiveId?; verification: "pending" | "verified" | "missing"; notes; verifiedAt? }[]` — lead: all; producer: own tasks.
  - `packageSources: { packageId; sceneId; sceneVersion; taskId; archiveId; archiveNumber }[]` — lead only.
- Actions:
  - `archive.register` — payload `{ taskId, projectVersionId, previewVersionId?, materialVersionIds?, nextSteps? }`. Allowed for a producer on their own task, or the lead; task not paused or closed; any Deseret stage except `archived`.
  - `handover.verify` — payload `{ handoverId, result: "verified" | "missing", notes }`. Only the `to_editor_email`, who must still be the task's editor; `notes` is required for `missing`.
- `package.publish` gains `payload.sources: Record<sceneId, archiveId>` *(historical; now `{ archiveId, sceneVersion, videoVersionId }` per scene)*:
  - Each package scene needs a valid archive of the same task. Otherwise reject `DESERET_ARCHIVE_REQUIRED` (409) with a message naming the language task IDs.
  - A pending native handover on any task in the package → `DESERET_HANDOVER_PENDING` (409).
  - A latest verification of `missing` with the chosen archive created before that handover → `DESERET_ARCHIVE_REQUIRED`.
  - Inserts `deseret_package_sources` rows in the publish transaction, plus each archive's liveness guard.

- [ ] Tests:
  - Producer registers an archive on their own task while the task is `待质检` and the stage is `storyboard_review`. It is rejected on another task, for QC, and on a `已交付` task.
  - Lead registers for any task.
  - QC workspace has no archives.
  - Publish without sources → 409 naming the task; nothing is written.
  - Publish with sources for a two-task package → the source rows match; a later archive does not change them.
  - Stale archive (version deleted after selection) → 409.
  - Pending handover → 409.
  - A secret in next steps never appears in the outbox body, material tasks or `state_json`, including after a resend via `outbox.retry`.
  - Verify: only the incoming editor; `missing` requires notes; a second verify is rejected or idempotent with the same result.
  - Missing-then-publish blocked until a newer archive is registered.
- [ ] Run; FAIL; implement; PASS.

### Task 4: Native handover flows (Deseret only)

**Files:** Modify `db/backend.ts` (`project.handover.prepare` ~9986, `project.schedule` ~9919) and `db/deseret-production-archive.ts`. Test: `tests/deseret-production-archive.test.ts`.

**Interfaces — Produces:**
- `deseretHandoverStatements(db, { handoverId, projectId, taskId, kind: "planned" | "emergency" | "batch", fromEmail, toEmail, now }): Promise<DatabaseStatement[]>`. It returns `[]` for non-Deseret projects. It records the latest valid archive, or null, with `verification='pending'`.
- `plannedHandoverArchive(db, projectId, taskId): Promise<string | null>` — a valid archive allowed in place of a complete checkpoint, only for Deseret projects.

- [ ] Tests:
  - The statements create a row with the latest valid archive.
  - An ordinary project creates nothing.
  - An emergency with no archive records null.
  - `plannedHandoverArchive` returns null for invalid archives.
- [ ] Wiring in `backend.ts`:
  - Prepare: accept an archive instead of a checkpoint for Deseret planned handovers, and append the statements.
  - Schedule: when the role is editor and there is a previous editor, append the `batch` statements.
  - This wiring is not testable in the SQLite harness; it is listed as untested in the report.

### Task 5: Archive upload kind in the native workspace

**Files:** Modify `db/production-workspace.ts`, `db/backend.ts` (`productionWorkspaceContext`), `app/ProductionWorkspace.tsx`.

**Interfaces:**
- `productionWorkspaceContext(email, taskId, write, pendingFinal, archive = false)`. With `archive`, the project must be Deseret-linked and intake accepted, the task status not paused or closed, and the editor must be the actor. It skips the open-stage gate.
- Staging purpose `"archive"`.
- `submitProductionWorkspace` kind `"archive"`:
  - Commits staged and existing selected files like materials.
  - Inserts the archive using `archiveSelection` in the same guarded transaction, using `payload.archiveProjectVersionId`, `archivePreviewVersionId` and `nextSteps`.
  - Returns `{ archiveId }`.
- UI: `openProductionWorkspace(taskId, "materials", …, { archive: true })` opens the materials dialog in archive mode, with a next-steps field and a project-file choice. The storyboard/final dialog gets a shortcut link.
- Not testable in the harness (MySQL/Wasabi). Listed as untested.

### Task 6: Panel UI (archive list and register, publish gate, verification, shortcuts)

**Files:** Modify `app/DeseretProductionPanel.tsx`. Test: `tests/deseret-archive-render.test.ts`.

- [ ] Render tests against the real service, using the jsdom approach of the earlier render tests (boolean DOM assertions only):
  - The producer sees their own task's archives and registers one from existing files.
  - The lead's publish form lists each task in the round with an archive selector; publish is disabled while a task is missing one and names it.
  - The lead registers an archive at the gate, and publish becomes enabled; the POST carries `sources` per scene.
  - The incoming editor sees "verify" and can record "missing" with notes.
  - QC sees no archive section.
  - Chinese and English labels.

### Task 7: Docs and full verification

- Update `docs/DESERET_PRODUCTION_CONTINUITY_20261121.md` (new, Chinese and English) and the deployment docs (migration 0010).
- Run the full suite, tsc, eslint, `git -c core.whitespace=cr-at-eol diff --check`, and a doc link check.
