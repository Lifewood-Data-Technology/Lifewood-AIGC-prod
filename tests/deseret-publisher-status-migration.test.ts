// Schema 0011 repairs Deseret task statuses written before the publisher-review status fix. It is data only:
// tasks whose latest publication still awaits the publisher become 待客户预览, tasks still revising a returned
// publication become 客户要求修改, and their projects are recalculated with the application's summary rules.
//
// The MySQL scenarios need a disposable server (never a shared or deployed one):
//   LIFEWOOD_MIGRATION_TEST_MYSQL_URL=mysql://root@127.0.0.1:33911/ pnpm test
// Each run creates and drops its own database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { currentSchemaVersion, migrationNames, readMigrations } from "../scripts/mysql/migrations.mjs";
import { schemaForVersion } from "../scripts/mysql/verify-schema.mjs";
import contract from "../db/mysql/schema-contract.json" with { type: "json" };
import { lex, word } from "../db/mysql/sql.ts";

const NAME = "0011-deseret-publisher-review-task-status.sql";
const source = readFileSync(new URL(`../db/mysql/migrations/${NAME}`, import.meta.url), "utf8");
const statements = source.split("--> statement-breakpoint").map(statement => statement.trim()).filter(Boolean);
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("schema 0011 registration", () => {
  it("is appended after 0010 without changing earlier migrations", () => {
    assert.equal(migrationNames.at(-1), NAME);
    assert.equal(migrationNames.at(-2), "0010-deseret-production-archives.sql");
    assert.equal(migrationNames.length, 11);
    assert.equal(currentSchemaVersion, "0011");
  });

  it("is read by the migration runner as its own checksummed version", async () => {
    const migration = (await readMigrations()).at(-1)!;
    assert.equal(migration.version, "0011");
    assert.match(migration.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(migration.statements, statements);
  });

  it("does not change the verified schema shape", () => {
    // Data-only migration: the 0011 schema must be exactly the 0010 schema. This fails until
    // scripts/mysql/verify-schema.mjs accepts version 0011, which the migration runner verifies after applying it.
    assert.deepEqual(schemaForVersion("0011"), schemaForVersion("0010"));
  });
});

describe("schema 0011 statements", () => {
  it("is a single transaction that only updates task and project rows", () => {
    assert.match(statements[0], /^(?:--[^\n]*\n)*SET @lifewood_m0011_at = /);
    assert.equal(statements[1], "START TRANSACTION");
    assert.equal(statements.at(-1), "COMMIT");
    const body = statements.slice(2, -1);
    assert.equal(body.length, 3);
    assert.match(body[2], /WHERE updated_at = @lifewood_m0011_marker/);
    assert.match(body[0], /^UPDATE `language_projects` lp\n/);
    assert.match(body[1], /^UPDATE `projects` SET\n/);
    for (const statement of statements) {
      const tokens = lex(statement);
      for (const forbidden of ["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "DELETE", "INSERT", "REPLACE", "TRIGGER", "TEMPORARY", "GRANT"])
        assert.ok(!tokens.some(token => word(token, forbidden)), `${forbidden} in: ${statement.slice(0, 60)}`);
      assert.ok(!tokens.some(token => token.kind === "param"), "no bind parameters");
    }
  });

  it("writes only the two publisher-review statuses, and only over 制作中", () => {
    const repair = statements[2];
    assert.deepEqual([...repair.matchAll(/THEN '([^']+)'/g)].map(match => match[1]), ["待客户预览", "客户要求修改"]);
    assert.match(repair, /SET lp\.status = repair\.next_status,/);
    assert.match(repair, /AND lp\.status = '制作中'\n/);
    assert.match(repair, /AND p\.deleted_at IS NULL\n {2}AND p\.status NOT IN \('已暂停', '已交付', '已归档', '已终止'\)/);
    assert.match(repair, /business_deletion_locks/);
    assert.match(repair, /`quality_rounds` q WHERE q\.language_project_id = latest\.task_id AND q\.created_at > latest\.published_at/);
    assert.match(repair, /`production_final_submissions` s WHERE s\.language_project_id = latest\.task_id AND s\.submitted_at > latest\.published_at/);
  });

  it("recalculates projects with the application's project summary rules", () => {
    const backend = readFileSync(new URL("../db/backend.ts", import.meta.url), "utf8");
    const body = backend.match(/function projectSummaryUpdateSql\([^)]*\) \{([\s\S]*?)\n\}/)?.[1];
    assert.ok(body, "projectSummaryUpdateSql");
    const caseSql = body.match(/const status = `(CASE[\s\S]*?END)`;/)?.[1];
    const assignments = body.match(/editor_email = ([\s\S]*?),\n\s*updated_at/)?.[1];
    assert.ok(caseSql && assignments);
    const scoped = (sql: string) => normalize(sql.replaceAll("${scope}", "language_projects.project_id = projects.id"));
    const summary = normalize(statements[3]);
    assert.ok(summary.includes(`status = ${scoped(caseSql)},`), "status rules");
    assert.ok(summary.includes(`editor_email = ${scoped(assignments)},`), "editor and reviewer rules");
    assert.match(summary, /revision = revision \+ 1 WHERE projects\.id IN \(/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Real MySQL scenarios.

type Row = Record<string, unknown>;
type Table = { columns: Record<string, { name: string; type: string; notNull?: boolean; default?: unknown }> };
const mysqlUrl = process.env.LIFEWOOD_MIGRATION_TEST_MYSQL_URL;
const T0 = "2026-11-01T00:00:00.000Z";
const PUBLISHED = "2026-11-10T08:00:00.000Z";
const BEFORE = "2026-11-09T08:00:00.000Z";
const AFTER = "2026-11-12T08:00:00.000Z";

const file = (taskId: string, n = 1) => ({ id: `v-${taskId}-${n}`, fileVersionId: `v-${taskId}-${n}`, languageTaskId: taskId });
const scene = (id: string, taskId: string) => ({ id, languageTaskId: taskId, fileVersionId: `v-${taskId}-1`, version: 1, order: 1 });
const pack = (input: { phase?: "storyboard" | "final"; tasks: string[]; scenes?: [string, string][]; conclusion?: "approved" | "revision"; withdrawn?: boolean; publishedAt?: string }) => ({
  id: randomUUID(), phase: input.phase ?? "storyboard", version: 1, publicationId: randomUUID(), publishedAt: input.publishedAt ?? PUBLISHED, filesReady: true,
  files: input.tasks.map(task => file(task)), scenes: (input.scenes ?? input.tasks.map(task => [`s-${task}`, task] as [string, string])).map(([id, task]) => scene(id, task)),
  ...(input.conclusion ? { conclusion: input.conclusion } : {}), ...(input.withdrawn ? { withdrawn: true } : {}),
});
const state = (stage: string, packages: unknown[], revisionSceneIds: string[] = [], extra: Row = {}) =>
  ({ stage, intake: "accepted", revision: 3, materials: "ready", scenes: [], packages, feedback: [], authorFeedback: [], revisionSceneIds, ...extra });

describe("schema 0011 on MySQL", { skip: mysqlUrl ? false : "set LIFEWOOD_MIGRATION_TEST_MYSQL_URL to a disposable MySQL 8 server" }, () => {
  it("repairs only unambiguous published and returned Deseret tasks and recalculates their projects", async () => {
    const mysql = (await import("mysql2/promise")).default;
    const database = `lifewood_m0011_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = await mysql.createConnection({ uri: mysqlUrl!, charset: "utf8mb4_bin", timezone: "Z" });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    const c = await mysql.createConnection({ uri: mysqlUrl!, database, charset: "utf8mb4_bin", timezone: "Z", multipleStatements: false });
    try {
      const migrations = await readMigrations();
      for (const migration of migrations.slice(0, -1)) for (const statement of migration.statements) await c.query(statement);

      const tables = (contract as unknown as { tables: Record<string, Table> }).tables;
      const insert = async (table: string, values: Row) => {
        const row: Row = {};
        for (const column of Object.values(tables[table].columns))
          if (column.notNull) row[column.name] = column.default !== undefined ? column.default : column.type === "integer" || column.type === "real" ? 0 : "";
        Object.assign(row, values);
        const names = Object.keys(row);
        await c.query(`INSERT INTO \`${table}\` (${names.map(name => `\`${name}\``).join(",")}) VALUES (${names.map(() => "?").join(",")})`, names.map(name => row[name]));
      };
      const project = async (id: string, tasks: [string, string, Row?][], link?: unknown, projectRow: Row = {}) => {
        await insert("projects", { id, client_id: "client-1", name: id, status: "制作中", updated_at: T0, revision: 5, ...projectRow });
        await insert("project_videos", { id: `video-${id}`, project_id: id, video_code: "VID-001", name: "Video", updated_at: T0 });
        for (const [taskId, status, extra] of tasks)
          await insert("language_projects", { id: taskId, project_id: id, video_id: `video-${id}`, language: taskId, language_code: taskId, status, editor_email: `editor-${taskId}@example.com`, reviewer_email: "qc@example.com", updated_at: T0, revision: 7, ...extra });
        if (link !== undefined)
          await insert("deseret_project_links", { id, deseret_project_id: `deseret-${id}`, source_revision: "r1", submission_version: 1, snapshot_json: "{}", state_json: typeof link === "string" ? link : JSON.stringify(link), native_video_ids: "[]", native_task_ids: JSON.stringify(tasks.map(task => task[0])), revision: 11, created_by: "lead@example.com", created_at: T0, updated_at: T0 });
      };

      // Pending publisher review.
      await project("p-review", [["a1", "制作中"], ["b1", "已暂停", { paused_from_status: "制作中" }], ["c1", "已终止"]],
        state("storyboard_review", [pack({ tasks: ["a1", "b1"] })]));
      await project("p-final-review", [["a2", "制作中"], ["b2", "制作中"]],
        state("final_review", [pack({ tasks: ["a2", "b2"], conclusion: "approved" }), pack({ phase: "final", tasks: ["a2"], scenes: [["final-a2", "a2"]] })]));
      // Returned publications: awaiting assignment, assigned, re-reviewed, resubmitted, author revision.
      await project("p-returned", [["a3", "制作中"], ["b3", "制作中"]],
        state("revision", [pack({ tasks: ["a3", "b3"], conclusion: "revision" })], ["s-a3"]));
      await project("p-assigned", [["a4", "制作中"], ["b4", "制作中"], ["c4", "待质检"], ["d4", "制作中"], ["e4", "质检驳回"]],
        state("production", [pack({ tasks: ["a4", "b4", "c4", "d4", "e4"], conclusion: "revision" })], ["s-a4", "s-b4", "s-c4", "s-d4", "s-e4"]));
      await insert("quality_rounds", { id: "q-b4", project_id: "p-assigned", language_project_id: "b4", file_id: "v-b4-2", round_number: 2, reviewer_email: "qc@example.com", result: "approved", comments: "", created_at: AFTER });
      await insert("quality_rounds", { id: "q-a4-old", project_id: "p-assigned", language_project_id: "a4", file_id: "v-a4-1", round_number: 1, reviewer_email: "qc@example.com", result: "approved", comments: "", created_at: BEFORE });
      await insert("production_final_submissions", { id: "f-d4", language_project_id: "d4", final_version_id: "v-d4-2", submitted_by: "editor-d4@example.com", submitted_at: AFTER });
      await project("p-author", [["a5", "制作中"]],
        state("final_production", [pack({ tasks: ["a5"], conclusion: "approved" }), pack({ phase: "final", tasks: ["a5"], scenes: [["final-a5", "a5"]], conclusion: "approved" })], ["final-a5"]));
      await project("p-republished", [["a6", "制作中"]],
        state("storyboard_review", [pack({ tasks: ["a6"], conclusion: "revision" }), pack({ tasks: ["a6"] })], []));
      // Left unchanged.
      await project("p-ordinary", [["a7", "制作中"]]);
      await project("p-withdrawn", [["a8", "制作中"]],
        state("production", [pack({ tasks: ["a8"], conclusion: "approved" }), pack({ tasks: ["a8"], withdrawn: true })]));
      await project("p-archived", [["a9", "制作中"]], state("storyboard_review", [pack({ tasks: ["a9"] })]), { status: "已归档" });
      await project("p-deleted", [["a10", "制作中"]], state("storyboard_review", [pack({ tasks: ["a10"] })]), { deleted_at: T0 });
      await project("p-locked", [["a11", "制作中"]], state("final_review", [pack({ phase: "final", tasks: ["a11"] })], [], { deliveryLocked: true }));
      await project("p-invalid", [["a12", "制作中"]], "{not json");
      await project("p-stage", [["a13", "制作中"]], state("production", [pack({ tasks: ["a13"] })]));
      await project("p-stale-ids", [["a14", "制作中"]], state("final_production", [pack({ tasks: ["a14"], conclusion: "revision" })], []));
      await project("p-bad-time", [["a15", "制作中"]], state("storyboard_review", [pack({ tasks: ["a15"], publishedAt: "yesterday" })]));
      await project("p-deleting", [["a16", "制作中"]], state("storyboard_review", [pack({ tasks: ["a16"] })]));
      await insert("business_deletion_locks", { scope_id: "project:p-deleting", job_id: "job-1", created_at: T0 });

      const snapshot = async () => {
        const [tasks] = await c.query("SELECT id,project_id,status,paused_from_status,updated_at,revision FROM language_projects ORDER BY id");
        const [projects] = await c.query("SELECT id,status,editor_email,reviewer_email,updated_at,revision FROM projects ORDER BY id");
        const [links] = await c.query("SELECT id,state_json,revision,updated_at FROM deseret_project_links ORDER BY id");
        return { tasks: tasks as Row[], projects: projects as Row[], links: links as Row[] };
      };
      const before = await snapshot();
      for (const statement of migrations.at(-1)!.statements) await c.query(statement);
      const after = await snapshot();

      const expected: Record<string, string> = { a1: "待客户预览", a2: "待客户预览", a3: "客户要求修改", a4: "客户要求修改", a5: "客户要求修改", a6: "待客户预览" };
      const [[{ marker }]] = await c.query("SELECT @lifewood_m0011_at AS marker") as unknown as [[{ marker: string }]];
      assert.match(marker, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      for (const task of after.tasks) {
        const old = before.tasks.find(row => row.id === task.id)!;
        if (expected[String(task.id)]) {
          assert.deepEqual([task.status, task.updated_at, task.revision], [expected[String(task.id)], marker, Number(old.revision) + 1], String(task.id));
          assert.equal(task.paused_from_status, old.paused_from_status);
        } else assert.deepEqual(task, old, `${task.id} is unchanged`);
      }
      const projectStatus: Record<string, string> = { "p-review": "待客户预览", "p-final-review": "制作中", "p-returned": "客户要求修改", "p-assigned": "质检驳回", "p-author": "客户要求修改", "p-republished": "待客户预览" };
      for (const row of after.projects) {
        const old = before.projects.find(item => item.id === row.id)!;
        if (projectStatus[String(row.id)]) {
          assert.deepEqual([row.status, row.updated_at, row.revision], [projectStatus[String(row.id)], marker, Number(old.revision) + 1], String(row.id));
          assert.ok(String(row.editor_email).split(",").includes(`editor-${String(row.id) === "p-review" ? "a1" : after.tasks.find(task => task.project_id === row.id)!.id}@example.com`));
          assert.equal(row.reviewer_email, "qc@example.com");
        } else assert.deepEqual(row, old, `${row.id} is unchanged`);
      }
      assert.deepEqual(after.links, before.links, "integration state is not rewritten");

      // Applying the same statements again changes nothing further.
      for (const statement of migrations.at(-1)!.statements) await c.query(statement);
      const again = await snapshot();
      assert.deepEqual(again.tasks, after.tasks);
      assert.deepEqual(again.projects, after.projects);
    } finally {
      await c.end();
      await admin.query(`DROP DATABASE \`${database}\``);
      await admin.end();
    }
  });

  it("rolls the whole repair back when a later statement fails", async () => {
    const mysql = (await import("mysql2/promise")).default;
    const database = `lifewood_m0011_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const admin = await mysql.createConnection({ uri: mysqlUrl!, charset: "utf8mb4_bin", timezone: "Z" });
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
    const c = await mysql.createConnection({ uri: mysqlUrl!, database, charset: "utf8mb4_bin", timezone: "Z" });
    try {
      const migrations = await readMigrations();
      for (const migration of migrations.slice(0, -1)) for (const statement of migration.statements) await c.query(statement);
      await c.query("INSERT INTO projects (id,client_id,name,sales_email,project_owner_email,status,priority,specification,due_date,updated_at,revision) VALUES ('p','c','p','','','制作中','standard','','',?,1)", [T0]);
      await c.query("INSERT INTO project_videos (id,project_id,video_code,name,brief,aspect_ratio,priority,due_date,sort_order,updated_at,revision) VALUES ('v','p','VID-001','v','','16:9','standard','',0,?,1)", [T0]);
      await c.query("INSERT INTO language_projects (id,project_id,video_id,project_type_id,language,language_code,production_progress_note,status,requirements,material_standard_version,due_date,updated_at,revision) VALUES ('t','p','v','','en','en','','制作中','',1,'',?,1)", [T0]);
      await c.query("INSERT INTO deseret_project_links (id,deseret_project_id,source_revision,submission_version,snapshot_json,state_json,native_video_ids,native_task_ids,revision,created_by,created_at,updated_at) VALUES ('p','d','r',1,'{}',?,'[]','[\"t\"]',1,'',?,?)", [JSON.stringify(state("storyboard_review", [pack({ tasks: ["t"] })])), T0, T0]);
      const [setAt, start, repair] = migrations.at(-1)!.statements;
      await c.query(setAt);
      await c.query(start);
      await c.query(repair);
      const [[inside]] = await c.query("SELECT status FROM language_projects WHERE id='t'") as unknown as [[Row]];
      assert.equal(inside.status, "待客户预览");
      await c.end();
      const fresh = await mysql.createConnection({ uri: mysqlUrl!, database, charset: "utf8mb4_bin", timezone: "Z" });
      const [[outside]] = await fresh.query("SELECT status,revision FROM language_projects WHERE id='t'") as unknown as [[Row]];
      await fresh.end();
      assert.deepEqual(outside, { status: "制作中", revision: 1 }, "an interrupted run leaves no partial repair");
    } finally {
      await c.end().catch(() => {});
      await admin.query(`DROP DATABASE \`${database}\``);
      await admin.end();
    }
  });
});
