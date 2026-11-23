// Schema 0010 adds the internal Deseret production archive tables. Every entry that creates, verifies, deletes or
// cleans the schema must know them, and versions bound to an archive are protected like other formal records.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentSchemaVersion, migrationNames } from "../scripts/mysql/migrations.mjs";
import { schemaForVersion } from "../scripts/mysql/verify-schema.mjs";
import contract from "../db/mysql/schema-contract.json" with { type: "json" };
import { PRESERVED_TABLES } from "../operations/demo-cleanup";
import { fileVersionReferences, versionsUnreferenced } from "../db/file-deletion-guard";
import { sqliteDatabase } from "./support/sqlite-database";

const TABLES = ["deseret_production_archives", "deseret_archive_files", "deseret_package_sources", "deseret_task_handovers"];
const migration = readFileSync(new URL("../db/mysql/migrations/0010-deseret-production-archives.sql", import.meta.url), "utf8");
type Table = { columns: Record<string, { name: string }>; indexes: Record<string, { name: string; columns: string[]; isUnique: boolean }> };

describe("schema 0010", () => {
  it("is the current migration in the runner, the version checks and the contract", () => {
    assert.equal(migrationNames.at(-1), "0010-deseret-production-archives.sql");
    assert.equal(currentSchemaVersion, "0010");
    for (const table of TABLES) {
      assert.ok((schemaForVersion("0010").tables as Record<string, unknown>)[table], table);
      assert.ok(!(schemaForVersion("0009").tables as Record<string, unknown>)[table], `${table} is not part of 0009`);
    }
    assert.ok(schemaForVersion().tables.deseret_production_archives, "the default verification is the current version");
  });

  it("creates exactly the columns and indexes of the contract", () => {
    for (const name of TABLES) {
      const table = (contract.tables as Record<string, Table>)[name];
      const create = migration.match(new RegExp("CREATE TABLE `" + name + "` \\(([\\s\\S]*?)\\) ENGINE"))?.[1];
      assert.ok(create, `CREATE TABLE ${name}`);
      const columns = [...create.matchAll(/^\s*`([a-z_]+)` (?:VARCHAR|LONGTEXT|BIGINT|DOUBLE)/gm)].map(match => match[1]);
      assert.deepEqual(columns.sort(), Object.keys(table.columns).sort(), name);
      for (const index of Object.values(table.indexes)) {
        if (index.isUnique) assert.match(create, new RegExp("UNIQUE KEY `" + index.name + "` \\(`__uq_" + index.name + "`\\)"));
        else assert.match(create, new RegExp("KEY `" + index.name + "` \\(" + index.columns.map(column => "`" + column + "`").join(",") + "\\)"));
      }
    }
  });

  it("is known to project deletion and the demo cleaner", () => {
    const deletion = readFileSync(new URL("../db/business-deletion.ts", import.meta.url), "utf8");
    for (const table of TABLES) {
      assert.ok((PRESERVED_TABLES as readonly string[]).includes(table), `demo cleaner preserves ${table}`);
      assert.match(deletion.match(/const recordTables = new Set\(\[([^\]]*)\]/)![1], new RegExp(`"${table}"`), `deletion removes ${table}`);
    }
  });
});

describe("archived versions are formal records", () => {
  it("cannot be deleted while an archive references them", async () => {
    const db = sqliteDatabase();
    db.sqlite.exec(`CREATE TABLE project_files (id TEXT, project_id TEXT); CREATE TABLE deseret_project_links (id TEXT, state_json TEXT);
      CREATE TABLE aigc_file_versions (id TEXT PRIMARY KEY, file_id TEXT, version_number INTEGER);
      CREATE TABLE production_checkpoint_files (file_version_id TEXT, checkpoint_id TEXT); CREATE TABLE production_checkpoints (id TEXT, version_number INTEGER);
      CREATE TABLE production_final_submission_files (file_version_id TEXT); CREATE TABLE production_final_submissions (final_version_id TEXT);
      CREATE TABLE quality_rounds (file_id TEXT, report_file_id TEXT, round_number INTEGER); CREATE TABLE deliveries (file_id TEXT); CREATE TABLE share_links (file_id TEXT);
      CREATE TABLE material_standards (file_version_id TEXT, logical_file_id TEXT);
      CREATE TABLE deseret_production_archives (id TEXT, archive_number INTEGER); CREATE TABLE deseret_archive_files (archive_id TEXT, file_version_id TEXT, role TEXT);`);
    for (const id of ["v-project", "v-preview", "v-material", "v-free"]) db.sqlite.prepare("INSERT INTO aigc_file_versions VALUES (?,?,1)").run(id, `f-${id}`);
    db.sqlite.prepare("INSERT INTO deseret_production_archives VALUES ('a1',3)").run();
    for (const [id, role] of [["v-project", "project"], ["v-preview", "preview"], ["v-material", "material"]]) db.sqlite.prepare("INSERT INTO deseret_archive_files VALUES ('a1',?,?)").run(id, role);
    for (const id of ["v-project", "v-preview", "v-material"]) {
      assert.deepEqual((await fileVersionReferences(db, { versionId: id })).map(row => [row.kind, row.number]), [["archive", 3]], id);
      const guard = versionsUnreferenced({ versionId: id });
      assert.equal(db.sqlite.prepare(`SELECT ${guard.sql} AS ok`).get(...guard.values)?.ok, 0, id);
    }
    assert.deepEqual(await fileVersionReferences(db, { versionId: "v-free" }), []);
    const free = versionsUnreferenced({ logicalFileId: "f-v-free" });
    assert.equal(db.sqlite.prepare(`SELECT ${free.sql} AS ok`).get(...free.values)?.ok, 1);
    db.sqlite.prepare("INSERT INTO project_files VALUES ('v-free','p')").run();
    db.sqlite.prepare("INSERT INTO deseret_project_links VALUES ('p',?)").run(JSON.stringify({ storyboardDrafts: [{ fileVersionId: "v-free" }] }));
    assert.equal(db.sqlite.prepare(`SELECT ${free.sql} AS ok`).get(...free.values)?.ok, 0);
    assert.equal((await fileVersionReferences(db, { versionId: "v-free" }))[0]?.kind, "storyboard_draft");
    db.sqlite.prepare("UPDATE deseret_project_links SET state_json='{}'").run();
    assert.equal(db.sqlite.prepare(`SELECT ${free.sql} AS ok`).get(...free.values)?.ok, 1);
  });
});
