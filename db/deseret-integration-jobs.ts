import { randomUUID } from "node:crypto";
import type { Database } from "./database";
import { guardedMutation } from "./mutation-guard";
import { visibleProjectSql } from "./business-visibility";
import { deseretOutboxStatement, readDeseretState } from "./deseret-integration";
import { integrationBodyHash, validateHandoffManifest, type HandoffMaterial, type ReceiptLookup } from "../lib/deseret-integration-contract";
import type { MaterialTransferInput, MaterialTransferPlan } from "../runtime/deseret-material-transfer";
import { materialTransferBudget } from "../runtime/deseret-material-transfer";

type Row = Record<string, unknown>;
type JobOperation = "read_source" | "plan_transfer" | "transfer_file" | "register_material" | "complete_material" | "deliver_event" | "complete_event";
export type JobDiagnostic = {
  event: "deseret.integration_job"; at: string; jobId?: string; projectId?: string;
  direction: string; operation: JobOperation; attempt: number; elapsedMs: number;
  outcome: "failed" | "ready" | "delivered"; code?: string; httpStatus?: number; providerRequestId?: string;
  /** Set when delivery was confirmed by Deseret's stored receipt for the original bytes, not by this send. */
  confirmation?: "prior_receipt";
};
export type DeseretJobDependencies = {
  db: Database;
  /** Concurrent material transfers, each in a different project. Database leases still serialize each task. */
  materialConcurrency?: 1 | 2;
  /** Aborts a persisted multipart handle of a stopped task through its own recorded plan. */
  abortTransfer?(input: MaterialTransferInput, plan: MaterialTransferPlan): Promise<void>;
  /** Lease and deadline for the configured transport (relay leases are short and renewed). */
  transferBudget?(size: number): ReturnType<typeof materialTransferBudget>;
  planTransfer(input: MaterialTransferInput): MaterialTransferPlan;
  transferFile(input: MaterialTransferInput, plan: MaterialTransferPlan): Promise<HandoffMaterial>;
  sourceReceipt(projectId: string, file: HandoffMaterial): Promise<MaterialTransferInput["sourceReceipt"]>;
  /** Registers the copied material in exactly `taskIds`, as computed by `incomingMaterialTaskIds`. */
  registerIncoming(projectId: string, jobId: string, file: HandoffMaterial, sourceRevision: string, leaseId: string, signal: AbortSignal, taskIds: string[]): Promise<void>;
  projectAuthority(projectId: string): Promise<{ sql: string; values: (string | number | null)[] }>;
  withProject<T>(projectId: string, work: () => Promise<T>): Promise<T>;
  deliver(body: string, eventId: string, signal: AbortSignal): Promise<void>;
  /**
   * Whether Deseret holds a successful receipt for this event with exactly these original bytes (signed receipt
   * lookup). Without it, an unconfirmed `request_reused` stays a failure.
   */
  confirmReceipt?(query: ReceiptLookup, signal: AbortSignal): Promise<boolean>;
  clock?: () => number;
  reportDiagnostic?(event: JobDiagnostic): void;
};
const errorCode = (error: unknown) => {
  if ((error as { status?: number })?.status === 403) return "ACCESS_DENIED";
  if ((error as { name?: string })?.name === "AbortError") return "OPERATION_ABORTED";
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "INTEGRATION_JOB_FAILED";
};
/** Material and cleanup lanes: provider throttling, timeouts and 5xx are transient; a failed precondition is a changed source. */
const materialErrorCode = (error: unknown) => {
  const details = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  if (details?.code === "TRANSFER_RETRY" || ["TimeoutError", "SlowDown"].includes(details?.name || "") || [408, 425, 429, 500, 502, 503, 504].includes(details?.$metadata?.httpStatusCode || 0)) return "TRANSFER_RETRY";
  if (details?.name === "PreconditionFailed") return "TRANSFER_SOURCE_CHANGED";
  return errorCode(error);
};
const jobError = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Scene keys that carried production script text. Production scripts stay inside AIGC; Deseret receives none. */
const SCRIPT_KEYS = ["narration", "script"] as const;
/**
 * The exact body to send for a stored outbox event. A `review.published` queued by an earlier version carried the
 * scene scripts. Deseret reads scenes from `payload.package.scenes` and from the older `payload.scenes`; in every
 * such array the `narration` and `script` keys are removed and nothing else is changed. The result is
 * deterministic, so every resend of one event has identical bytes. Events without these keys are returned
 * unchanged, byte for byte. The stored record itself is never rewritten.
 */
export function outgoingEventBody(stored: string): string {
  const envelope: unknown = JSON.parse(stored);
  if ((envelope as { type?: unknown })?.type !== "review.published") return stored;
  const payload = (envelope as { payload?: { package?: { scenes?: unknown }; scenes?: unknown } }).payload;
  let changed = false;
  for (const scenes of [payload?.package?.scenes, payload?.scenes]) {
    if (!Array.isArray(scenes)) continue;
    for (const scene of scenes) {
      if (!scene || typeof scene !== "object" || Array.isArray(scene)) continue;
      for (const key of SCRIPT_KEYS) if (Object.hasOwn(scene, key)) { delete (scene as Row)[key]; changed = true; }
    }
  }
  return changed ? JSON.stringify(envelope) : stored;
}

/**
 * Native tasks whose `02_客户素材` folder receives one incoming Deseret material.
 * - Handoff materials and ordinary review attachments keep the shared rule: every task of the project.
 * - A final QA revision frame goes only to the language task of each referencing issue's exact reviewed scene
 *   (`package.scenes[sceneId@sceneVersion].languageTaskId`); one image used by several issues gets the union.
 * A frame that cannot be bound to a current task of this project fails the job (retried automatically and by
 * `materials.retry`) instead of being spread to other tasks or dropped.
 */
export async function incomingMaterialTaskIds(db: Database, projectId: string, packageId: string | null, file: Pick<HandoffMaterial, "id" | "version">) {
  const projectTasks = (await db.prepare("SELECT id FROM language_projects WHERE project_id=? ORDER BY id").bind(projectId).all<{ id: string }>()).results.map(task => String(task.id));
  if (!packageId) return projectTasks;
  const link = await db.prepare("SELECT state_json FROM deseret_project_links WHERE id=?").bind(projectId).first<Row>();
  const state = link ? readDeseretState(link) : undefined;
  const pack = state?.packages.find(item => item.id === packageId);
  // Withdrawal cancels the job in the same transaction; a running lease then only has to stop.
  if (pack?.withdrawn) throw jobError("The review publication was withdrawn.", "STALE_RECORD");
  if (!state || !pack) throw jobError("The review publication of this material is unavailable.", "DESERET_FRAME_TASK_UNBOUND");
  const same = (item: Pick<HandoffMaterial, "id" | "version">) => item.id === file.id && item.version === file.version;
  const notes = [...state.feedback, ...state.authorFeedback].filter(note => note.packageId === packageId);
  if (notes.some(note => note.files?.some(same))) return projectTasks;
  const bound = notes.filter(note => note.frames?.some(frame => same(frame.file))).map(note => note.revisionId === undefined ? undefined
    : pack.scenes.find(scene => scene.id === note.sceneId && scene.version === note.sceneVersion)?.languageTaskId);
  if (!bound.length || bound.some(taskId => !taskId || !projectTasks.includes(taskId)))
    throw jobError("The revision frame is not bound to a current task of this project.", "DESERET_FRAME_TASK_UNBOUND");
  return [...new Set(bound as string[])].sort();
}

export function createDeseretIntegrationJobs(deps: DeseretJobDependencies) {
  const { db } = deps;
  const clock = deps.clock || Date.now;
  const iso = (value = clock()) => new Date(value).toISOString();
  const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  function diagnostic(row: Row, started: number, operation: JobOperation, outcome: JobDiagnostic["outcome"], error?: unknown, confirmation?: JobDiagnostic["confirmation"]) {
    const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const metadata = details.$metadata && typeof details.$metadata === "object" ? details.$metadata as Record<string, unknown> : {};
    const status = metadata.httpStatusCode ?? details.status ?? details.httpStatus;
    const knownNames: Record<string, string> = {
      TimeoutError: "OPERATION_TIMEOUT", AbortError: "OPERATION_ABORTED", SlowDown: "STORAGE_THROTTLED",
      AccessDenied: "ACCESS_DENIED", NoSuchKey: "STORAGE_OBJECT_MISSING", NoSuchUpload: "STORAGE_UPLOAD_MISSING",
      InvalidAccessKeyId: "STORAGE_AUTH_FAILED", SignatureDoesNotMatch: "STORAGE_AUTH_FAILED",
    };
    const knownCodes = new Set(["ACCESS_DENIED", "DESERET_OWNER_UNAVAILABLE", "OPERATION_ABORTED", "STALE_RECORD", "TRANSFER_NOT_CONFIGURED", "TRANSFER_REGION_UNSUPPORTED", "TRANSFER_INTEGRITY_UNAVAILABLE", "TRANSFER_PLAN_MISMATCH", "TRANSFER_SOURCE_CHANGED", "SOURCE_NOT_AUTHORIZED", "TRANSFER_RETRY", "TRANSFER_DESTINATION_CONFLICT", "DESERET_FRAME_TASK_UNBOUND", "DESERET_REPLAY_UNCONFIRMED", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
    const code = typeof details.name === "string" && Object.hasOwn(knownNames, details.name) ? knownNames[details.name]
      : typeof details.code === "string" && knownCodes.has(details.code) ? details.code : "INTEGRATION_JOB_FAILED";
    const event: JobDiagnostic = {
      event: "deseret.integration_job", at: iso(), jobId: safeId(row.id), projectId: safeId(row.project_id),
      direction: row.direction === "deseret_to_aigc" || row.direction === "aigc_to_deseret" ? row.direction : "callback",
      operation, attempt: Math.max(1, Number(row.attempts || 0) + 1), elapsedMs: Math.max(0, clock() - started), outcome,
      ...(outcome === "failed" ? { code, httpStatus: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined, providerRequestId: safeId(metadata.requestId) } : {}),
      ...(confirmation ? { confirmation } : {}),
    };
    // Keep an append-only diagnostic trail when successful retries clear last_error.
    // Never include exception messages, stacks, source objects or signed URLs.
    try { if (deps.reportDiagnostic) deps.reportDiagnostic(event); else console.warn(JSON.stringify(event)); } catch { /* Logging must not change a committed transfer or delivery. */ }
  }
  const failure = (stage: string, projectId: string | undefined, cause: unknown) => Object.assign(
    new Error("Deseret maintenance requires a retry.", { cause }),
    { stage, projectId, code: stage === "materials" || stage === "cleanup" ? materialErrorCode(cause) : errorCode(cause) },
  );
  async function runProject(stage: string, projectId: string, failures: Error[], work: () => Promise<void>) {
    try {
      await deps.withProject(projectId, work);
      return true;
    } catch (error) {
      failures.push(failure(stage, projectId, error));
      return false;
    }
  }
  async function runBatch(stage: string, limit: number, signal: AbortSignal, select: (blocked: string[]) => Promise<Row[]>, work: (row: Row) => Promise<void>, concurrency = 1) {
    const failures: Error[] = [];
    const blocked = new Set<string>();
    let attempted = 0;
    while (!signal.aborted && attempted < limit) {
      const rows = await select([...blocked]);
      if (!rows.length) break;
      const failuresBeforeBatch = failures.length;
      const queue = rows.filter(row => !blocked.has(String(row.project_id)));
      while (queue.length && !signal.aborted && attempted < limit) {
        // A concurrent group never holds two rows of one project, so registration and reconcile stay serial per project.
        const group: Row[] = [];
        for (let index = 0; index < queue.length && group.length < Math.min(concurrency, limit - attempted);) {
          if (group.some(row => row.project_id === queue[index].project_id)) index += 1;
          else group.push(...queue.splice(index, 1));
        }
        await Promise.all(group.map(async row => {
          if (signal.aborted) return;
          const projectId = String(row.project_id);
          if (blocked.has(projectId)) return;
          if (await runProject(stage, projectId, failures, () => work(row))) attempted += 1;
          else blocked.add(projectId);
        }));
      }
      if (failures.length === failuresBeforeBatch) break;
      for (const row of rows) blocked.add(String(row.project_id));
    }
    return failures;
  }
  async function materialTick(signal: AbortSignal) {
    return runBatch("materials", 4, signal, async blocked => {
      const rows = (await db.prepare(`SELECT task.* FROM deseret_material_tasks task
      JOIN deseret_project_links link ON link.id=task.project_id JOIN projects p ON p.id=task.project_id
      WHERE (${visibleProjectSql("p")}) AND link.source_revision=task.source_revision
        AND task.project_id NOT IN (SELECT value FROM json_each(?))
        AND ((task.state IN ('pending','failed','waiting_config') AND COALESCE(task.last_error,'')<>'TRANSFER_SOURCE_CHANGED' AND task.next_attempt_at<=?)
          OR (task.state='running' AND task.lease_expires_at<?))
      ORDER BY task.created_at,task.id LIMIT 4`).bind(JSON.stringify(blocked), iso(), iso()).all<Row>()).results;
      return rows;
    }, async task => {
        const lease = randomUUID();
        const budget = (deps.transferBudget ?? materialTransferBudget)(Number((JSON.parse(String(task.manifest_json)) as HandoffMaterial).size));
        // A changed source identity is never claimed again: a new approved revision creates a new task.
        const claim = await db.prepare("UPDATE deseret_material_tasks SET state='running',lease_id=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND ((state IN ('pending','failed','waiting_config') AND COALESCE(last_error,'')<>'TRANSFER_SOURCE_CHANGED' AND next_attempt_at<=?) OR (state='running' AND lease_expires_at<?))")
          .bind(lease, iso(clock() + budget.leaseMs), iso(), task.id, iso(), iso()).run();
        if (Number(claim.meta.changes) !== 1) return;
        const leaseController = new AbortController();
        const jobSignal = AbortSignal.any([signal, leaseController.signal]);
        let renewal: Promise<void> | undefined;
        const heartbeat = setInterval(() => {
          if (jobSignal.aborted || renewal) return;
          // A renewal that cannot finish in ten seconds stops the transfer before the short lease can lapse unnoticed.
          let renewalTimeout: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<never>((_, reject) => {
            renewalTimeout = setTimeout(() => reject(Object.assign(new Error("Lease renewal timed out."), { code: "TRANSFER_RETRY" })), 10000);
            renewalTimeout.unref?.();
          });
          renewal = Promise.race([db.prepare("UPDATE deseret_material_tasks SET lease_expires_at=? WHERE id=? AND state='running' AND lease_id=?")
            .bind(iso(clock() + budget.leaseMs), task.id, lease).run(), deadline]).then(result => {
              if (Number(result.meta.changes) !== 1) leaseController.abort();
            }).catch(() => leaseController.abort()).finally(() => { clearTimeout(renewalTimeout); renewal = undefined; });
        }, 30000);
        heartbeat.unref();
        const started = clock();
        let operation: JobOperation = "read_source";
        try {
          const linkQuery = task.direction === "aigc_to_deseret"
            ? "SELECT link.*,p.client_id AS publisher_client_id FROM deseret_project_links link JOIN projects p ON p.id=link.id WHERE link.id=? AND link.source_revision=?"
            : "SELECT * FROM deseret_project_links WHERE id=? AND source_revision=?";
          const link = await db.prepare(linkQuery).bind(task.project_id, task.source_revision).first<Row>();
          if (!link) return;
          const snapshot = JSON.parse(String(link.snapshot_json)) as Row;
          const source = JSON.parse(String(task.manifest_json)) as HandoffMaterial;
          const transferInput: MaterialTransferInput = {
            projectId: String(task.project_id), sourceRevision: String(task.source_revision), file: source,
            deseretProjectId: String(link.deseret_project_id),
            direction: task.direction as MaterialTransferInput["direction"],
            signal: AbortSignal.any([jobSignal, AbortSignal.timeout(budget.timeoutMs)]),
            ...(task.direction === "aigc_to_deseret" ? {
              publisherClientId: typeof link.publisher_client_id === "string" ? link.publisher_client_id : undefined,
              sourceReceipt: await deps.sourceReceipt(String(task.project_id), source),
              targetStorageProfileId: typeof snapshot.targetStorageProfileId === "string" ? snapshot.targetStorageProfileId : undefined,
              reviewObjectPrefix: typeof snapshot.reviewObjectPrefix === "string" ? snapshot.reviewObjectPrefix : undefined,
            } : {}),
          };
          const previousTarget = task.target_json ? JSON.parse(String(task.target_json)) : {};
          operation = "plan_transfer";
          const plan: MaterialTransferPlan = deps.planTransfer(transferInput);
          const handle = typeof previousTarget.peerUploadId === "string" ? previousTarget.peerUploadId : undefined;
          if (previousTarget.plan && JSON.stringify(previousTarget.plan) !== JSON.stringify(plan)) {
            // An upload handle belongs to the transport and destination of its recorded plan; it is never resumed
            // under another (for example a same-region server_copy upload after switching to deseret_relay).
            if (handle) throw jobError("The persisted storage plan requires reconciliation before retry.", "TRANSFER_PLAN_MISMATCH");
            // Nothing was started under the recorded plan, so the current configuration plans afresh.
            delete previousTarget.sourcePin;
          }
          const planned = await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running' AND EXISTS(SELECT 1 FROM deseret_project_links link WHERE link.id=deseret_material_tasks.project_id AND link.source_revision=deseret_material_tasks.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')")
            .bind(JSON.stringify({ ...previousTarget, ...plan.file, plan }), iso(), task.id, lease).run();
          if (Number(planned.meta.changes) !== 1) return;
          transferInput.multipartUploadId = handle;
          // The source identity (ETag/version) pinned when this upload was created; relay parts are reused only under it.
          transferInput.sourcePin = handle && previousTarget.sourcePin && typeof previousTarget.sourcePin === "object" ? previousTarget.sourcePin : undefined;
          const updateInventory = async (change: (inventory: Row) => Row) => {
            const current = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=? AND state='running'").bind(task.id, lease).first<{ target_json: string }>();
            if (!current) throw Object.assign(new Error("Transfer lease changed."), { code: "STALE_RECORD" });
            const inventory = JSON.parse(current.target_json) as Row;
            const saved = await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running' AND EXISTS(SELECT 1 FROM deseret_project_links link WHERE link.id=deseret_material_tasks.project_id AND link.source_revision=deseret_material_tasks.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')")
              .bind(JSON.stringify(change(inventory)), iso(), task.id, lease).run();
            if (Number(saved.meta.changes) !== 1) throw Object.assign(new Error("Transfer source changed."), { code: "STALE_RECORD" });
          };
          transferInput.onMultipartCreated = (peerUploadId, sourcePin) => updateInventory(inventory => ({ ...inventory, peerUploadId, sourcePin }));
          if (task.direction === "aigc_to_deseret") {
            transferInput.onPublisherSnapshot = ({ key, owner, uploadId }) => updateInventory(inventory => {
              const { bucket, endpoint, prefix, region } = plan.source;
              const entry = { key, owner, bucket, endpoint, prefix, region, ...(uploadId ? { uploadId } : {}) };
              const previous = inventory.publisherSnapshots ?? [];
              if (!Array.isArray(previous)) throw jobError("Invalid publisher snapshot inventory.", "TRANSFER_DESTINATION_CONFLICT");
              // A completion callback can follow an interrupted attempt with another upload ID.
              // Keep all known handles; aborting an already-completed ID is idempotent.
              const duplicate = previous.some(item => item.key === key && item.owner === owner &&
                item.bucket === bucket && item.endpoint === endpoint && item.prefix === prefix &&
                item.region === region && item.uploadId === uploadId);
              return duplicate ? inventory : { ...inventory, publisherSnapshots: [...previous, entry] };
            });
          }
          operation = "transfer_file";
          const copied = await deps.transferFile(transferInput, plan);
          const currentTarget = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=? AND state='running'").bind(task.id, lease).first<{ target_json: string }>();
          if (!currentTarget) return;
          await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running'").bind(JSON.stringify({ ...JSON.parse(currentTarget.target_json), ...copied, plan }), iso(), task.id, lease).run();
          const active = await db.prepare("SELECT task.id FROM deseret_material_tasks task JOIN deseret_project_links link ON link.id=task.project_id WHERE task.id=? AND task.lease_id=? AND task.state='running' AND link.source_revision=task.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement'").bind(task.id, lease).first();
          if (!active) return;
          operation = "register_material";
          if (task.direction === "deseret_to_aigc") {
            const taskIds = await incomingMaterialTaskIds(db, String(task.project_id), task.package_id ? String(task.package_id) : null, source);
            await deps.registerIncoming(String(task.project_id), String(task.id), copied, String(task.source_revision), lease, jobSignal, taskIds);
          }
          operation = "complete_material";
          const authority = await deps.projectAuthority(String(task.project_id));
          await guardedMutation(db, `${authority.sql} AND EXISTS(SELECT 1 FROM deseret_material_tasks task JOIN deseret_project_links link ON link.id=task.project_id WHERE task.id=? AND task.lease_id=? AND task.state='running' AND link.source_revision=task.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')`, [...authority.values, String(task.id), lease], [
            db.prepare("UPDATE deseret_material_tasks SET state='ready',last_error=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_id=?").bind(iso(), task.id, lease),
          ]);
          diagnostic(task, started, operation, "ready");
        } catch (error) {
          diagnostic(task, started, operation, "failed", error);
          const code = materialErrorCode(error);
          // Transient relay/provider errors stay pending (no materials.failed event); deployment and source-identity
          // states wait for an operator. TRANSFER_SOURCE_CHANGED is never claimed again.
          const recoverable = ["ACCESS_DENIED", "DESERET_OWNER_UNAVAILABLE", "OPERATION_ABORTED", "STALE_RECORD", "TRANSFER_RETRY"].includes(code);
          const state = recoverable ? "pending" : ["TRANSFER_NOT_CONFIGURED", "TRANSFER_REGION_UNSUPPORTED", "TRANSFER_INTEGRITY_UNAVAILABLE", "TRANSFER_PLAN_MISMATCH", "TRANSFER_SOURCE_CHANGED", "SOURCE_NOT_AUTHORIZED", "TRANSFER_DESTINATION_CONFLICT"].includes(code) ? "waiting_config" : "failed";
          const wait = Math.min(300000, 2000 * 2 ** Math.min(8, Number(task.attempts || 0)));
          await db.prepare("UPDATE deseret_material_tasks SET state=?,last_error=?,lease_id=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND state='running' AND lease_id=?")
            .bind(state, code, iso(clock() + wait), iso(), task.id, lease).run();
          if (recoverable) throw error;
        } finally {
          clearInterval(heartbeat);
          await renewal;
        }
        await reconcile(String(task.project_id));
    }, deps.materialConcurrency ?? 1);
  }
  async function reconcile(projectId: string) {
    const authority = await deps.projectAuthority(projectId);
    const row = await db.prepare(`SELECT link.* FROM deseret_project_links link JOIN projects p ON p.id=link.id WHERE link.id=? AND (${visibleProjectSql("p")})`).bind(projectId).first<Row>();
    if (!row) return;
    const state = readDeseretState(row);
    if (state.stage === "archived" || state.intake === "needsSupplement") return;
    const tasks = (await db.prepare("SELECT * FROM deseret_material_tasks WHERE project_id=? AND source_revision=?").bind(projectId, row.source_revision).all<Row>()).results;
    const incoming = tasks.filter(task => task.direction === "deseret_to_aigc" && !task.package_id);
    const statements = [];
    let changed = false;
    if (state.materials !== "ready" && incoming.every(task => task.state === "ready")) {
      state.materials = "ready";
      if (state.intake === "accepted" && state.stage === "intake") state.stage = "production";
      statements.push(deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "materials.ready", { direction: "deseret_to_aigc", aigcProjectId: projectId }, iso()));
      changed = true;
    }
    for (const pack of state.packages) {
      if (pack.withdrawn || pack.filesReady) continue;
      const publicationTasks = tasks.filter(task => task.package_id === pack.id && task.direction === "aigc_to_deseret");
      if (publicationTasks.length !== pack.files.length || !publicationTasks.every(task => task.state === "ready")) continue;
      pack.files = pack.files.map(file => ({ ...file, ...validateHandoffManifest([JSON.parse(String(publicationTasks.find(task => task.file_id === file.id)!.target_json))])[0] }));
      pack.filesReady = true;
      const scenes = pack.scenes.map(scene => ({
        // No narration: the scene script stays in AIGC's production state only.
        id: scene.id, number: scene.order, version: scene.version, duration: scene.duration, languageTaskId: scene.languageTaskId,
        characterIds: scene.characterIds,
        video: { id: scene.fileVersionId, version: pack.files.find(file => file.id === scene.fileVersionId)!.version, kind: "video" },
      }));
      const published = { id: pack.id, phase: pack.phase, version: pack.version, publicationId: pack.publicationId, publishedAt: pack.publishedAt, scenes, ...(pack.characters ? { characters: pack.characters } : {}) };
      statements.push(deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "review.published", { package: published, files: pack.files }, iso()));
      changed = true;
    }
    if (state.materials !== "ready" && state.materials !== "failed" && incoming.some(task => task.state === "failed")) {
      state.materials = "failed";
      statements.push(deseretOutboxStatement(db, projectId, String(row.deseret_project_id), String(row.source_revision), "materials.failed", { direction: "deseret_to_aigc", aigcProjectId: projectId }, iso()));
      changed = true;
    }
    if (!changed) return;
    state.revision += 1;
    await guardedMutation(db, `${authority.sql} AND EXISTS (SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?) AND EXISTS(SELECT 1 FROM projects p WHERE p.id=? AND (${visibleProjectSql("p")}))`, [...authority.values, projectId, Number(row.revision), projectId], [
      db.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(state), iso(), projectId), ...statements,
    ]);
  }
  async function outboxTick(signal: AbortSignal) {
    return runBatch("outbox", 10, signal, async blocked => {
      const rows = (await db.prepare(`SELECT outbox.* FROM deseret_outbox outbox JOIN projects p ON p.id=outbox.project_id
      WHERE (${visibleProjectSql("p")}) AND outbox.project_id NOT IN (SELECT value FROM json_each(?)) AND ((outbox.state IN ('pending','failed') AND outbox.next_attempt_at<=?)
       OR (outbox.state='sending' AND outbox.lease_expires_at<?))
       AND NOT EXISTS(SELECT 1 FROM deseret_outbox earlier WHERE earlier.project_id=outbox.project_id AND earlier.source_revision=outbox.source_revision AND earlier.sequence<outbox.sequence AND earlier.state NOT IN ('delivered','superseded'))
       ORDER BY outbox.sequence LIMIT 10`)
      .bind(JSON.stringify(blocked), iso(), iso()).all<Row>()).results;
      return rows;
    }, async row => {
        const lease = randomUUID();
        try {
          await guardedMutation(db, "EXISTS(SELECT 1 FROM deseret_outbox current_event WHERE current_event.id=? AND ((current_event.state IN ('pending','failed') AND current_event.next_attempt_at<=?) OR (current_event.state='sending' AND current_event.lease_expires_at<?))) AND NOT EXISTS(SELECT 1 FROM deseret_outbox earlier WHERE earlier.project_id=? AND earlier.source_revision=? AND earlier.sequence<? AND earlier.state NOT IN ('delivered','superseded'))", [String(row.id), iso(), iso(), String(row.project_id), String(row.source_revision), Number(row.sequence)], [
            db.prepare("UPDATE deseret_outbox SET state='sending',lease_id=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=?").bind(lease, iso(clock() + 60000), iso(), row.id),
          ]);
        } catch (error) {
          if ((error as { code?: string }).code === "STALE_RECORD") return;
          throw error;
        }
        const started = clock();
        let operation: JobOperation = "deliver_event";
        const stored = String(row.body_json);
        let altered = false;
        const complete = async (confirmation?: JobDiagnostic["confirmation"]) => {
          operation = "complete_event";
          const completed = await db.prepare("UPDATE deseret_outbox SET state='delivered',last_error=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_id=? AND state='sending'").bind(iso(), row.id, lease).run();
          if (Number(completed.meta.changes) === 1) diagnostic(row, started, operation, "delivered", undefined, confirmation);
        };
        try {
          const body = outgoingEventBody(stored);
          altered = body !== stored;
          try {
            await deps.deliver(body, String(row.id), AbortSignal.any([signal, AbortSignal.timeout(20000)]));
          } catch (error) {
            // Deseret binds an event id to the bytes it committed. A stripped resend of an event it already holds in
            // its original form is answered with HTTP 409 and exactly `request_reused`. Only then, and only for an
            // altered event, ask for Deseret's receipt of the original wire bytes; a matching receipt is the delivery.
            // Any other answer, including other conflicts, an unmatched receipt or a failed lookup, remains a failure.
            const rejection = error as { httpStatus?: unknown; remoteCode?: unknown } | undefined;
            if (!altered || rejection?.httpStatus !== 409 || rejection?.remoteCode !== "request_reused") throw error;
            const projectId = (JSON.parse(stored) as { projectId?: unknown }).projectId;
            const confirmed = deps.confirmReceipt && typeof projectId === "string"
              ? await deps.confirmReceipt({ eventId: String(row.id), projectId, bodySha256: integrationBodyHash(stored) }, AbortSignal.any([signal, AbortSignal.timeout(20000)]))
              : false;
            if (!confirmed) throw jobError("Deseret holds a different body for this event and no matching receipt was confirmed.", "DESERET_REPLAY_UNCONFIRMED");
            await complete("prior_receipt");
            return;
          }
          await complete();
        } catch (error) {
          diagnostic(row, started, operation, "failed", error);
          const wait = Math.min(300000, 2000 * 2 ** Math.min(8, Number(row.attempts)));
          await db.prepare("UPDATE deseret_outbox SET state='failed',last_error=?,next_attempt_at=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_id=? AND state='sending'").bind(errorCode(error), iso(clock() + wait), iso(), row.id, lease).run();
        }
    });
  }
  /**
   * Aborts the recorded multipart upload of a task that stopped (cancelled, superseded, paused for a supplement, or
   * a changed source) once its old lease has expired. Only the inventoried handle is aborted, through the task's own
   * recorded plan; completed objects are never deleted and the task's state and source-changed code are kept.
   */
  async function cleanupTick(signal: AbortSignal) {
    if (!deps.abortTransfer) return [];
    const failures: Error[] = [];
    // Deleted projects are cleaned by business deletion; hidden rows must not starve this lane.
    const rows = (await db.prepare(`SELECT task.* FROM deseret_material_tasks task JOIN projects p ON p.id=task.project_id
      WHERE (${visibleProjectSql("p")}) AND (task.state IN ('cancelled','superseded','paused') OR (task.state='waiting_config' AND task.last_error='TRANSFER_SOURCE_CHANGED'))
        AND json_extract(task.target_json,'$.peerUploadId') IS NOT NULL AND task.next_attempt_at<=? AND (task.lease_expires_at IS NULL OR task.lease_expires_at<?)
      ORDER BY task.updated_at,task.id LIMIT 8`).bind(iso(), iso()).all<Row>()).results;
    for (const task of rows) {
      if (signal.aborted) break;
      await runProject("cleanup", String(task.project_id), failures, async () => {
        const lease = randomUUID();
        const claim = await db.prepare("UPDATE deseret_material_tasks SET lease_id=?,lease_expires_at=? WHERE id=? AND state=? AND json_extract(target_json,'$.peerUploadId') IS NOT NULL AND (lease_expires_at IS NULL OR lease_expires_at<?)")
          .bind(lease, iso(clock() + 180000), task.id, task.state, iso()).run();
        if (Number(claim.meta.changes) !== 1) return;
        const keptError = task.state === "waiting_config" ? "TRANSFER_SOURCE_CHANGED" : null;
        try {
          // Re-read after the claim: a snapshot taken before it may hold an older upload handle.
          const claimed = await db.prepare("SELECT * FROM deseret_material_tasks WHERE id=? AND state=? AND lease_id=?").bind(task.id, task.state, lease).first<Row>();
          if (!claimed) return;
          const target = JSON.parse(String(claimed.target_json)) as Row & { plan?: MaterialTransferPlan & { target?: { storageProfileId?: string } }; peerUploadId?: unknown; sourcePin?: unknown };
          const link = await db.prepare("SELECT deseret_project_id,snapshot_json FROM deseret_project_links WHERE id=?").bind(task.project_id).first<Row>();
          if (!link || !target.plan || typeof target.peerUploadId !== "string") throw jobError("Cleanup inventory is unavailable.", "TRANSFER_PLAN_MISMATCH");
          const snapshot = JSON.parse(String(link.snapshot_json)) as Row;
          // The persisted plan is authoritative for the destination; caller-supplied paths are never used.
          const input: MaterialTransferInput = {
            projectId: String(task.project_id), deseretProjectId: String(link.deseret_project_id), sourceRevision: String(task.source_revision),
            direction: task.direction as MaterialTransferInput["direction"], file: JSON.parse(String(task.manifest_json)), multipartUploadId: target.peerUploadId,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
            ...(task.direction === "aigc_to_deseret" ? {
              targetStorageProfileId: target.plan.target?.storageProfileId,
              reviewObjectPrefix: typeof snapshot.reviewObjectPrefix === "string" ? snapshot.reviewObjectPrefix : undefined,
            } : {}),
          };
          await deps.abortTransfer!(input, target.plan);
          delete target.peerUploadId;
          delete target.sourcePin;
          await db.prepare("UPDATE deseret_material_tasks SET target_json=?,lease_id=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE id=? AND state=? AND lease_id=?")
            .bind(JSON.stringify(target), keptError, iso(), task.id, task.state, lease).run();
        } catch (error) {
          await db.prepare("UPDATE deseret_material_tasks SET lease_id=NULL,lease_expires_at=NULL,last_error=?,next_attempt_at=?,updated_at=? WHERE id=? AND state=? AND lease_id=?")
            .bind(keptError ?? materialErrorCode(error), iso(clock() + 60000), iso(), task.id, task.state, lease).run();
          throw error;
        }
      });
    }
    return failures;
  }
  async function reconciliationTick(signal: AbortSignal) {
    const failures: Error[] = [];
    const pending = (await db.prepare(`SELECT link.id FROM deseret_project_links link JOIN projects p ON p.id=link.id WHERE (${visibleProjectSql("p")}) AND json_extract(link.state_json,'$.stage')<>'archived' ORDER BY link.updated_at,link.id`).all<{ id: string }>()).results;
    for (const project of pending) {
      if (signal.aborted) break;
      await runProject("reconcile", project.id, failures, () => reconcile(project.id));
    }
    return failures;
  }
  async function tick(signal: AbortSignal) {
    const failures: Error[] = [];
    const stages = [{ name: "cleanup", run: cleanupTick }, { name: "materials", run: materialTick }, { name: "reconcile", run: reconciliationTick }, { name: "outbox", run: outboxTick }];
    for (const stage of stages) {
      if (signal.aborted) break;
      try { failures.push(...await stage.run(signal)); }
      catch (error) { failures.push(failure(stage.name, undefined, error)); }
    }
    if (failures.length) throw new AggregateError(failures, "Deseret maintenance has unfinished project operations.");
  }
  return { tick, reconcile, materialTick, reconciliationTick, outboxTick, cleanupTick };
}


/** Each lane has independent admission, while its existing database leases protect multiple processes. */
export function startDeseretIntegrationScheduler(jobs: Pick<ReturnType<typeof createDeseretIntegrationJobs>, "materialTick" | "reconciliationTick" | "outboxTick"> & { cleanupTick?: (signal: AbortSignal) => Promise<Error[]> }, options: {
  track(work: Promise<unknown>): void;
  report(error: unknown): void;
  stopping(): boolean;
  intervalMs?: number;
}) {
  const controller = new AbortController();
  const lanes = [
    ...(jobs.cleanupTick ? [{ run: jobs.cleanupTick, running: false }] : []),
    { run: jobs.materialTick, running: false },
    { run: jobs.reconciliationTick, running: false },
    { run: jobs.outboxTick, running: false },
  ];
  function tick() {
    if (controller.signal.aborted || options.stopping()) return;
    for (const lane of lanes) {
      if (lane.running) continue;
      lane.running = true;
      const work = Promise.resolve().then(async () => {
        if (controller.signal.aborted || options.stopping()) return;
        const failures = await lane.run(controller.signal);
        if (failures.length) throw new AggregateError(failures, "Deseret maintenance has unfinished project operations.");
      }).catch(options.report).finally(() => { lane.running = false; });
      options.track(work);
    }
  }
  const timer = setInterval(tick, options.intervalMs ?? 15000);
  timer.unref();
  tick();
  return { tick, stop() { clearInterval(timer); controller.abort(); } };
}
