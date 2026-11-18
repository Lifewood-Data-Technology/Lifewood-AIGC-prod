import { randomUUID } from "node:crypto";
import type { Database } from "./database";
import { guardedMutation } from "./mutation-guard";
import { visibleProjectSql } from "./business-visibility";
import { deseretOutboxStatement, readDeseretState } from "./deseret-integration";
import { validateHandoffManifest, type HandoffMaterial } from "../lib/deseret-integration-contract";
import type { MaterialTransferInput, MaterialTransferPlan } from "../runtime/deseret-material-transfer";
import { materialTransferBudget } from "../runtime/deseret-material-transfer";

type Row = Record<string, unknown>;
type JobOperation = "read_source" | "plan_transfer" | "transfer_file" | "register_material" | "complete_material" | "deliver_event" | "complete_event";
type JobDiagnostic = {
  event: "deseret.integration_job"; at: string; jobId?: string; projectId?: string;
  direction: string; operation: JobOperation; attempt: number; elapsedMs: number;
  outcome: "failed" | "ready" | "delivered"; code?: string; httpStatus?: number; providerRequestId?: string;
};
export type DeseretJobDependencies = {
  db: Database;
  planTransfer(input: MaterialTransferInput): MaterialTransferPlan;
  transferFile(input: MaterialTransferInput, plan: MaterialTransferPlan): Promise<HandoffMaterial>;
  sourceReceipt(projectId: string, file: HandoffMaterial): Promise<MaterialTransferInput["sourceReceipt"]>;
  registerIncoming(projectId: string, jobId: string, file: HandoffMaterial, sourceRevision: string, leaseId: string, signal: AbortSignal): Promise<void>;
  projectAuthority(projectId: string): Promise<{ sql: string; values: (string | number | null)[] }>;
  withProject<T>(projectId: string, work: () => Promise<T>): Promise<T>;
  deliver(body: string, eventId: string, signal: AbortSignal): Promise<void>;
  clock?: () => number;
  reportDiagnostic?(event: JobDiagnostic): void;
};
const errorCode = (error: unknown) => {
  if ((error as { status?: number })?.status === 403) return "ACCESS_DENIED";
  if ((error as { name?: string })?.name === "AbortError") return "OPERATION_ABORTED";
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "INTEGRATION_JOB_FAILED";
};

export function createDeseretIntegrationJobs(deps: DeseretJobDependencies) {
  const { db } = deps;
  const clock = deps.clock || Date.now;
  const iso = (value = clock()) => new Date(value).toISOString();
  const safeId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
  function diagnostic(row: Row, started: number, operation: JobOperation, outcome: JobDiagnostic["outcome"], error?: unknown) {
    const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const metadata = details.$metadata && typeof details.$metadata === "object" ? details.$metadata as Record<string, unknown> : {};
    const status = metadata.httpStatusCode ?? details.status;
    const knownNames: Record<string, string> = {
      TimeoutError: "OPERATION_TIMEOUT", AbortError: "OPERATION_ABORTED", SlowDown: "STORAGE_THROTTLED",
      AccessDenied: "ACCESS_DENIED", NoSuchKey: "STORAGE_OBJECT_MISSING", NoSuchUpload: "STORAGE_UPLOAD_MISSING",
      InvalidAccessKeyId: "STORAGE_AUTH_FAILED", SignatureDoesNotMatch: "STORAGE_AUTH_FAILED",
    };
    const knownCodes = new Set(["ACCESS_DENIED", "DESERET_OWNER_UNAVAILABLE", "OPERATION_ABORTED", "STALE_RECORD", "TRANSFER_NOT_CONFIGURED", "TRANSFER_REGION_UNSUPPORTED", "TRANSFER_INTEGRITY_UNAVAILABLE", "TRANSFER_PLAN_MISMATCH", "TRANSFER_SOURCE_CHANGED", "TRANSFER_DESTINATION_CONFLICT", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
    const code = typeof details.name === "string" && Object.hasOwn(knownNames, details.name) ? knownNames[details.name]
      : typeof details.code === "string" && knownCodes.has(details.code) ? details.code : "INTEGRATION_JOB_FAILED";
    const event: JobDiagnostic = {
      event: "deseret.integration_job", at: iso(), jobId: safeId(row.id), projectId: safeId(row.project_id),
      direction: row.direction === "deseret_to_aigc" || row.direction === "aigc_to_deseret" ? row.direction : "callback",
      operation, attempt: Math.max(1, Number(row.attempts || 0) + 1), elapsedMs: Math.max(0, clock() - started), outcome,
      ...(outcome === "failed" ? { code, httpStatus: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined, providerRequestId: safeId(metadata.requestId) } : {}),
    };
    // Keep an append-only diagnostic trail when successful retries clear last_error.
    // Never include exception messages, stacks, source objects or signed URLs.
    try { if (deps.reportDiagnostic) deps.reportDiagnostic(event); else console.warn(JSON.stringify(event)); } catch { /* Logging must not change a committed transfer or delivery. */ }
  }
  const failure = (stage: string, projectId: string | undefined, cause: unknown) => Object.assign(
    new Error("Deseret maintenance requires a retry.", { cause }),
    { stage, projectId, code: errorCode(cause) },
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
  async function runBatch(stage: string, limit: number, signal: AbortSignal, select: (blocked: string[]) => Promise<Row[]>, work: (row: Row) => Promise<void>) {
    const failures: Error[] = [];
    const blocked = new Set<string>();
    let attempted = 0;
    while (!signal.aborted && attempted < limit) {
      const rows = await select([...blocked]);
      if (!rows.length) break;
      const failuresBeforeBatch = failures.length;
      for (const row of rows) {
        if (signal.aborted || attempted >= limit) break;
        const projectId = String(row.project_id);
        if (blocked.has(projectId)) continue;
        if (await runProject(stage, projectId, failures, () => work(row))) attempted += 1;
        else blocked.add(projectId);
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
        AND ((task.state IN ('pending','failed','waiting_config') AND task.next_attempt_at<=?)
          OR (task.state='running' AND task.lease_expires_at<?))
      ORDER BY task.created_at,task.id LIMIT 4`).bind(JSON.stringify(blocked), iso(), iso()).all<Row>()).results;
      return rows;
    }, async task => {
        const lease = randomUUID();
        const budget = materialTransferBudget(Number((JSON.parse(String(task.manifest_json)) as HandoffMaterial).size));
        const claim = await db.prepare("UPDATE deseret_material_tasks SET state='running',lease_id=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND ((state IN ('pending','failed','waiting_config') AND next_attempt_at<=?) OR (state='running' AND lease_expires_at<?))")
          .bind(lease, iso(clock() + budget.leaseMs), iso(), task.id, iso(), iso()).run();
        if (Number(claim.meta.changes) !== 1) return;
        const leaseController = new AbortController();
        const jobSignal = AbortSignal.any([signal, leaseController.signal]);
        let renewal: Promise<void> | undefined;
        const heartbeat = setInterval(() => {
          if (jobSignal.aborted || renewal) return;
          renewal = db.prepare("UPDATE deseret_material_tasks SET lease_expires_at=? WHERE id=? AND state='running' AND lease_id=?")
            .bind(iso(clock() + budget.leaseMs), task.id, lease).run().then(result => {
              if (Number(result.meta.changes) !== 1) leaseController.abort();
            }).catch(() => leaseController.abort()).finally(() => { renewal = undefined; });
        }, 30000);
        heartbeat.unref();
        const started = clock();
        let operation: JobOperation = "read_source";
        try {
          const link = await db.prepare("SELECT * FROM deseret_project_links WHERE id=? AND source_revision=?").bind(task.project_id, task.source_revision).first<Row>();
          if (!link) return;
          const snapshot = JSON.parse(String(link.snapshot_json)) as Row;
          const source = JSON.parse(String(task.manifest_json)) as HandoffMaterial;
          const transferInput: MaterialTransferInput = {
            projectId: String(task.project_id), sourceRevision: String(task.source_revision), file: source,
            deseretProjectId: String(link.deseret_project_id),
            direction: task.direction as MaterialTransferInput["direction"],
            signal: AbortSignal.any([jobSignal, AbortSignal.timeout(budget.timeoutMs)]),
            ...(task.direction === "aigc_to_deseret" ? {
              sourceReceipt: await deps.sourceReceipt(String(task.project_id), source),
              targetStorageProfileId: typeof snapshot.targetStorageProfileId === "string" ? snapshot.targetStorageProfileId : undefined,
              reviewObjectPrefix: typeof snapshot.reviewObjectPrefix === "string" ? snapshot.reviewObjectPrefix : undefined,
            } : {}),
          };
          const previousTarget = task.target_json ? JSON.parse(String(task.target_json)) : {};
          operation = "plan_transfer";
          const plan: MaterialTransferPlan = previousTarget.plan || deps.planTransfer(transferInput);
          const planned = await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running' AND EXISTS(SELECT 1 FROM deseret_project_links link WHERE link.id=deseret_material_tasks.project_id AND link.source_revision=deseret_material_tasks.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')")
            .bind(JSON.stringify({ ...previousTarget, ...plan.file, plan }), iso(), task.id, lease).run();
          if (Number(planned.meta.changes) !== 1) return;
          transferInput.multipartUploadId = typeof previousTarget.peerUploadId === "string" ? previousTarget.peerUploadId : undefined;
          transferInput.onMultipartCreated = async uploadId => {
            const current = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=? AND state='running'").bind(task.id, lease).first<{ target_json: string }>();
            if (!current) throw Object.assign(new Error("Transfer lease changed."), { code: "STALE_RECORD" });
            const inventory = JSON.parse(current.target_json) as Row;
            const saved = await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running' AND EXISTS(SELECT 1 FROM deseret_project_links link WHERE link.id=deseret_material_tasks.project_id AND link.source_revision=deseret_material_tasks.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')")
              .bind(JSON.stringify({ ...inventory, peerUploadId: uploadId }), iso(), task.id, lease).run();
            if (Number(saved.meta.changes) !== 1) throw Object.assign(new Error("Transfer source changed."), { code: "STALE_RECORD" });
          };
          operation = "transfer_file";
          const copied = await deps.transferFile(transferInput, plan);
          const currentTarget = await db.prepare("SELECT target_json FROM deseret_material_tasks WHERE id=? AND lease_id=? AND state='running'").bind(task.id, lease).first<{ target_json: string }>();
          if (!currentTarget) return;
          await db.prepare("UPDATE deseret_material_tasks SET target_json=?,updated_at=? WHERE id=? AND lease_id=? AND state='running'").bind(JSON.stringify({ ...JSON.parse(currentTarget.target_json), ...copied, plan }), iso(), task.id, lease).run();
          const active = await db.prepare("SELECT task.id FROM deseret_material_tasks task JOIN deseret_project_links link ON link.id=task.project_id WHERE task.id=? AND task.lease_id=? AND task.state='running' AND link.source_revision=task.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement'").bind(task.id, lease).first();
          if (!active) return;
          operation = "register_material";
          if (task.direction === "deseret_to_aigc") await deps.registerIncoming(String(task.project_id), String(task.id), copied, String(task.source_revision), lease, jobSignal);
          operation = "complete_material";
          const authority = await deps.projectAuthority(String(task.project_id));
          await guardedMutation(db, `${authority.sql} AND EXISTS(SELECT 1 FROM deseret_material_tasks task JOIN deseret_project_links link ON link.id=task.project_id WHERE task.id=? AND task.lease_id=? AND task.state='running' AND link.source_revision=task.source_revision AND json_extract(link.state_json,'$.intake')<>'needsSupplement')`, [...authority.values, String(task.id), lease], [
            db.prepare("UPDATE deseret_material_tasks SET state='ready',last_error=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND state='running' AND lease_id=?").bind(iso(), task.id, lease),
          ]);
          diagnostic(task, started, operation, "ready");
        } catch (error) {
          diagnostic(task, started, operation, "failed", error);
          const code = errorCode(error);
          const recoverable = ["ACCESS_DENIED", "DESERET_OWNER_UNAVAILABLE", "OPERATION_ABORTED", "STALE_RECORD"].includes(code);
          const state = recoverable ? "pending" : ["TRANSFER_NOT_CONFIGURED", "TRANSFER_REGION_UNSUPPORTED", "TRANSFER_INTEGRITY_UNAVAILABLE", "TRANSFER_PLAN_MISMATCH"].includes(code) ? "waiting_config" : "failed";
          await db.prepare("UPDATE deseret_material_tasks SET state=?,last_error=?,lease_id=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=? AND state='running' AND lease_id=?")
            .bind(state, code, iso(clock() + 60000), iso(), task.id, lease).run();
          if (recoverable) throw error;
        } finally {
          clearInterval(heartbeat);
          await renewal;
        }
        await reconcile(String(task.project_id));
    });
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
        id: scene.id, number: scene.order, version: scene.version, duration: scene.duration,
        narration: { en: scene.script, zh: "" }, characterIds: scene.characterIds,
        video: { id: scene.fileVersionId, version: pack.files.find(file => file.id === scene.fileVersionId)!.version, kind: "video" },
      }));
      const published = { id: pack.id, phase: pack.phase, version: pack.version, publicationId: pack.publicationId, publishedAt: pack.publishedAt, scenes };
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
        try {
          await deps.deliver(String(row.body_json), String(row.id), AbortSignal.any([signal, AbortSignal.timeout(20000)]));
          operation = "complete_event";
          const completed = await db.prepare("UPDATE deseret_outbox SET state='delivered',last_error=NULL,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_id=? AND state='sending'").bind(iso(), row.id, lease).run();
          if (Number(completed.meta.changes) === 1) diagnostic(row, started, operation, "delivered");
        } catch (error) {
          diagnostic(row, started, operation, "failed", error);
          const wait = Math.min(300000, 2000 * 2 ** Math.min(8, Number(row.attempts)));
          await db.prepare("UPDATE deseret_outbox SET state='failed',last_error=?,next_attempt_at=?,lease_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_id=? AND state='sending'").bind(errorCode(error), iso(clock() + wait), iso(), row.id, lease).run();
        }
    });
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
    const stages = [{ name: "materials", run: materialTick }, { name: "reconcile", run: reconciliationTick }, { name: "outbox", run: outboxTick }];
    for (const stage of stages) {
      if (signal.aborted) break;
      try { failures.push(...await stage.run(signal)); }
      catch (error) { failures.push(failure(stage.name, undefined, error)); }
    }
    if (failures.length) throw new AggregateError(failures, "Deseret maintenance has unfinished project operations.");
  }
  return { tick, reconcile, materialTick, reconciliationTick, outboxTick };
}


/** Each lane has independent admission, while its existing database leases protect multiple processes. */
export function startDeseretIntegrationScheduler(jobs: Pick<ReturnType<typeof createDeseretIntegrationJobs>, "materialTick" | "reconciliationTick" | "outboxTick">, options: {
  track(work: Promise<unknown>): void;
  report(error: unknown): void;
  stopping(): boolean;
  intervalMs?: number;
}) {
  const controller = new AbortController();
  const lanes = [
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
