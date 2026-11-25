import assert from "node:assert/strict";
import test from "node:test";
import { mysqlOptions } from "../db/mysql/config.ts";
import { lex, render } from "../db/mysql/sql.ts";

test("rendering repeated parameterized JSON scans reuses the same SQL text", () => {
  const template = lex("SELECT id FROM projects WHERE id IN (SELECT value FROM json_each(?))");
  const variants = new Set<string>();
  for (let index = 0; index < 1000; index++) {
    const input = JSON.stringify([index]);
    const compiled = render(template, [input]);
    variants.add(compiled.sql);
    assert.deepEqual(compiled.values, [input]);
    render(lex("SELECT value FROM json_each(?)"), ["[]"]);
  }
  assert.equal(variants.size, 1);
});

test("nested JSON iterators reserve later identifiers and preserve bind order", () => {
  const template = lex('SELECT ? FROM json_each(?) WHERE EXISTS (SELECT 1 FROM json_each(?) CROSS JOIN json_each(?) AS "JSON_ROWS_1" WHERE "JSON_ROWS_1".value = ?)');
  const values = ["prefix", "[]", "[1]", "[null]", 42];
  const compiled = render(template, values);
  const aliases = Array.from(compiled.sql.matchAll(/AS jt\) AS `([^`]+)`/g), match => match[1]);
  assert.equal(aliases.length, 3);
  assert.equal(aliases[2], "JSON_ROWS_1");
  assert.equal(new Set(aliases.map(name => name.toLowerCase())).size, 3);
  assert.match(compiled.sql, /CROSS JOIN/);
  assert.deepEqual(compiled.values, values);
  assert.equal(compiled.sql.match(/\?/g)?.length, values.length);
});

test("explicit aliases consume exactly their own tokens and retain qualified column references", () => {
  for (const spelling of ["json_rows_1", "AS json_rows_1", "`json_rows_1`", 'AS "json_rows_1"']) {
    const compiled = render(lex(`SELECT json_rows_1.value FROM json_each(?) ${spelling} WHERE json_rows_1.key = ?`), ["[]", 0]);
    assert.match(compiled.sql, /AS jt\) AS `json_rows_1` WHERE json_rows_1 \. `key` = \?/);
  }
  for (const join of ["LEFT JOIN", "INNER JOIN", "CROSS JOIN", "NATURAL JOIN"]) {
    const compiled = render(lex(`SELECT 1 FROM json_each(?) ${join} projects`), ["[]"]);
    assert.ok(compiled.sql.includes("` " + join + " projects"));
  }
  for (const invalid of ["AS", "AS WHERE", "AS 'literal'"]) {
    assert.throws(() => render(lex(`SELECT 1 FROM json_each(?) ${invalid}`), ["[]"]), /alias/i);
  }
});

const testEnv: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  LIFEWOOD_ENV: "test", MYSQL_HOST: "localhost", MYSQL_DATABASE: "lifewood_aigc_test",
  MYSQL_USER: "lifewood_test", MYSQL_PASSWORD: "test", WASABI_BUCKET: "aigc-dev",
  WASABI_PREFIX: "lifewood-test/app/", WASABI_REGION: "ap-southeast-1",
  WASABI_ENDPOINT: "https://s3.ap-southeast-1.wasabisys.com",
  WASABI_ACCESS_KEY_ID: "test", WASABI_SECRET_ACCESS_KEY: "test",
};

test("MySQL pool and per-connection statement budgets default to finite limits", () => {
  const defaults = mysqlOptions(testEnv);
  assert.equal(defaults.connectionLimit, 20);
  assert.equal(defaults.maxPreparedStatements, 128);
  const configured = mysqlOptions({ ...testEnv, MYSQL_CONNECTION_LIMIT: "2", MYSQL_MAX_PREPARED_STATEMENTS: "8" });
  assert.equal(configured.connectionLimit, 2);
  assert.equal(configured.maxPreparedStatements, 8);
});

test("explicit invalid limits fail before opening any MySQL connections", () => {
  for (const name of ["MYSQL_CONNECTION_LIMIT", "MYSQL_MAX_PREPARED_STATEMENTS"]) {
    for (const value of ["", " ", "0", "-1", "1.5", "abc", "Infinity", "9007199254740992"]) {
      assert.throws(() => mysqlOptions({ ...testEnv, [name]: value }), new RegExp(name));
    }
  }
});
