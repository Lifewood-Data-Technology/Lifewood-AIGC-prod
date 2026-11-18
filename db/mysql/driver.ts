import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { Database, DatabaseStatement, DatabaseResult } from '../database.ts';
import { mysqlOptions } from './config.ts';
import { lex, word, identifier, quote, param, matching, findTop, split, bindTokens, render, substituted, type Token, type Value } from './sql.ts';
import snapshot from "./schema-contract.json" with { type: 'json' };
const primaryKeys = Object.fromEntries(Object.values(snapshot.tables).map(t => [t.name, Object.values(t.columns).find(c => c.primaryKey)?.name]));
const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('__uq_')));
const result = (rows: Record<string, unknown>[] = [], changes = 0, lastId = 0): DatabaseResult => ({ success: true, results: rows.map(strip), meta: { changes, last_row_id: lastId } });
type State = {
    changes: number;
};
export class MySqlDatabase implements Database {
    readonly pool: Pool;
    constructor(options = mysqlOptions()) { this.pool = mysql.createPool(options); }
    prepare(sql: string) { return new Statement(this, sql, []); }
    async acquireBatchLock(c: PoolConnection) {
        const [[row]] = await c.query<RowDataPacket[]>("SELECT GET_LOCK(CONCAT(DATABASE(), ':lifewood-batch'),30) AS acquired");
        if (row.acquired !== 1)
            throw Object.assign(Error('Database batch lock timed out'), { code: 'MYSQL_BATCH_BUSY' });
    }
    async releaseBatchLock(c: PoolConnection) { await c.query("DO RELEASE_LOCK(CONCAT(DATABASE(), ':lifewood-batch'))"); }
    async transaction<T>(work: (connection: PoolConnection, state: State) => Promise<T>) {
        const c = await this.pool.getConnection();
        let locked = false;
        try {
            // Preserve the application batch ordering across every Node pool/process.
            // This prevents range-lock/upsert lock upgrades from racing; no transaction is retried.
            await this.acquireBatchLock(c);
            locked = true;
            await c.query('SET NAMES utf8mb4 COLLATE utf8mb4_0900_bin');
            await c.query("SET SESSION sql_mode='STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES,PIPES_AS_CONCAT'");
            await c.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            await c.beginTransaction();
            const r = await work(c, { changes: 0 });
            await c.commit();
            return r;
        }
        catch (error) {
            await c.rollback();
            throw error;
        }
        finally {
            try {
                if (locked)
                    await this.releaseBatchLock(c);
            }
            finally {
                c.release();
            }
        }
    }
    async batch<T = Record<string, unknown>>(statements: DatabaseStatement[]): Promise<DatabaseResult<T>[]> {
        return this.transaction(async (c, state) => { const out = []; for (const s of statements) {
            if (!(s instanceof Statement) || s.owner !== this)
                throw Error('Foreign database statement');
            out.push(await this.execute(c, s, state));
        } return out as DatabaseResult<T>[]; });
    }
    async exec(sql: string) { await this.batch([this.prepare(sql)]); return { count: 1, duration: 0 }; }
    async close() { await this.pool.end(); }
    async query(c: PoolConnection, ts: Token[], state: State) {
        const lowered = render(ts, [], state.changes);
        const updateFields: Record<string, string[]> = { project_videos: ['project_id'], language_projects: ['project_id', 'video_id'], aigc_files: ['folder_id', 'language_project_id'], notifications: ['recipient_email'] };
        const table = word(ts[0], 'UPDATE') ? identifier(ts[1]) : '';
        const fields = updateFields[table];
        if (!fields)
            return c.execute<RowDataPacket[] & ResultSetHeader>(lowered.sql, lowered.values);
        const set = findTop(ts, 'SET'), where = findTop(ts, 'WHERE', set + 1);
        const assigned = split(ts.slice(set + 1, where < 0 ? undefined : where)).map(a => identifier(a[a.findIndex(t => t.text === '=') - 1]));
        // MySQL lacks UPDATE OF. This statement-scoped flag makes its additional
        // trigger check assignments even when NEW equals OLD, matching SQLite.
        const flag = '@lifewood_relation_' + table;
        await c.query(`SET ${flag} = ${Number(fields.some(f => assigned.includes(f)))}`);
        try {
            return await c.execute<RowDataPacket[] & ResultSetHeader>(lowered.sql, lowered.values);
        }
        finally {
            await c.query(`SET ${flag} = NULL`);
        }
    }
    async execute(c: PoolConnection, s: Statement, state: State): Promise<DatabaseResult> {
        const ts = bindTokens(lex(s.sql), s.values), ret = findTop(ts, 'RETURNING');
        const core = ret < 0 ? ts : ts.slice(0, ret), returning = ret < 0 ? null : ts.slice(ret + 1);
        if (word(core[0], 'INSERT') && (findTop(core, 'CONFLICT') >= 0 || word(core[1], 'OR')))
            return this.insert(c, core, returning, state);
        if (returning) {
            if (!word(core[0], 'UPDATE') && !word(core[0], 'DELETE'))
                throw Error('Unsupported returning statement');
            const table = identifier(core[word(core[0], 'DELETE') ? 2 : 1]);
            const pk = primaryKeys[table];
            if (!pk)
                throw Error('Unknown returning table');
            const where = findTop(core, 'WHERE');
            if (where < 0)
                throw Error('Unbounded returning mutation rejected');
            const condition = core.slice(where + 1);
            const [before] = await this.query(c, [...lex(`SELECT * FROM ${quote(table)} WHERE`), ...condition, ...lex('FOR UPDATE')], state);
            if (!before.length) {
                state.changes = 0;
                return result();
            }
            const [header] = await this.query(c, core, state);
            state.changes = header.affectedRows;
            if (word(core[0], 'DELETE'))
                return result(before.map(row => returning[0].text === '*' ? row : Object.fromEntries(split(returning).map(col => [identifier(col[0]), row[identifier(col[0])]]))), state.changes);
            const conditionKeys: Token[] = [];
            before.forEach((r, i) => { if (i)
                conditionKeys.push(...lex('OR')); conditionKeys.push(...lex(`${quote(pk)} <=>`), param(r[pk])); });
            const [after] = await this.query(c, [...lex('SELECT'), ...returning, ...lex(`FROM ${quote(table)} WHERE`), ...conditionKeys], state);
            return result(after, state.changes);
        }
        const [rows] = await this.query(c, core, state);
        if (Array.isArray(rows))
            return result(rows);
        const header = rows as ResultSetHeader;
        state.changes = header.affectedRows;
        return result([], header.affectedRows, header.insertId);
    }
    async insert(c: PoolConnection, ts: Token[], returning: Token[] | null, state: State) {
        const ignore = word(ts[1], 'OR') && word(ts[2], 'IGNORE');
        const into = findTop(ts, 'INTO'), table = identifier(ts[into + 1]);
        const start = into + 2, end = matching(ts, start), columns = split(ts.slice(start + 1, end)).map(x => identifier(x[0]));
        let on = findTop(ts, 'ON', end + 1);
        while (on >= 0 && !word(ts[on + 1], 'CONFLICT'))
            on = findTop(ts, 'ON', on + 1);
        const source = ts.slice(end + 1, on < 0 ? undefined : on);
        let conflict: string[] = [], assignments: Token[][] = [], condition: Token[] = [];
        if (on >= 0) {
            if (!word(ts[on + 1], 'CONFLICT'))
                throw Error('Unsupported INSERT clause');
            const ce = matching(ts, on + 2);
            conflict = split(ts.slice(on + 3, ce)).map(x => identifier(x[0]));
            const set = findTop(ts, 'SET', ce + 1), where = findTop(ts, 'WHERE', set + 1);
            if (set < 0)
                throw Error('Unsupported conflict action');
            assignments = split(ts.slice(set + 1, where < 0 ? undefined : where));
            condition = where < 0 ? [] : ts.slice(where + 1);
        }
        const values: Value[][] = [];
        if (word(source[0], 'VALUES')) {
            for (const row of split(source.slice(1))) {
                if (row[0]?.text !== '(' || row.at(-1)?.text !== ')')
                    throw Error('Unsupported values');
                const expressions = split(row.slice(1, -1));
                const selections = expressions.flatMap((e, i) => [...(i ? lex(',') : []), ...e, ...lex('AS ' + quote('c' + i))]);
                const [rows] = await this.query(c, [...lex('SELECT'), ...selections], state);
                values.push(expressions.map((_, i) => rows[0]['c' + i]));
            }
        }
        else if (word(source[0], 'SELECT')) {
            const from = findTop(source, 'FROM');
            const selectEnd = from < 0 ? source.length : from;
            const expressions = split(source.slice(1, selectEnd));
            const selections = expressions.flatMap((e, i) => [...(i ? lex(',') : []), ...e, ...lex('AS ' + quote('c' + i))]);
            const [rows] = await this.query(c, [...lex('SELECT'), ...selections, ...source.slice(selectEnd)], state);
            for (const row of rows)
                values.push(expressions.map((_, i) => row['c' + i]));
        }
        else
            throw Error('Unsupported insert source');
        let changed = 0, lastId = 0;
        const output: Record<string, unknown>[] = [];
        for (const row of values) {
            if (row.length !== columns.length)
                throw Error('Insert shape mismatch');
            const incoming = Object.fromEntries(columns.map((n, i) => [n, row[i]]));
            let inserted = true;
            try {
                const [header] = await c.execute<ResultSetHeader>(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')})`, row);
                lastId = header.insertId;
            }
            catch (error) {
                if ((error as {
                    code?: string;
                }).code !== 'ER_DUP_ENTRY')
                    throw error;
                inserted = false;
                if (ignore)
                    continue;
                if (!conflict.length)
                    throw error;
                const selector = conflict.flatMap((n, i) => [...(i ? lex('AND') : []), ...lex(quote(n) + ' <=>'), param(incoming[n])]);
                const [existing] = await this.query(c, [...lex(`SELECT * FROM ${quote(table)} WHERE`), ...selector, ...lex('FOR UPDATE')], state);
                if (existing.length !== 1)
                    throw error; // A different unique key must never overwrite this row.
                const names = assignments.map(a => identifier(a[0]));
                const expressions = assignments.flatMap((a, i) => [...(i ? lex(',') : []), ...substituted(a.slice(2), incoming), ...lex('AS ' + quote('u' + i))]);
                const [evaluated] = await this.query(c, [...lex('SELECT'), ...expressions, ...lex(`FROM ${quote(table)} WHERE`), ...selector, ...(condition.length ? [...lex('AND ('), ...substituted(condition, incoming), ...lex(')')] : [])], state);
                if (!evaluated.length)
                    continue;
                const update = names.flatMap((n, i) => [...(i ? lex(',') : []), ...lex(quote(n) + ' ='), param(evaluated[0]['u' + i])]);
                await this.query(c, [...lex(`UPDATE ${quote(table)} SET`), ...update, ...lex('WHERE'), ...selector], state);
            }
            changed++;
            if (returning) {
                const keys = conflict.length ? conflict : [primaryKeys[table]].filter((key): key is string => !!key);
                if (!keys[0])
                    throw Error('Missing insert identity');
                const selector = keys.flatMap((n, i) => [...(i ? lex('AND') : []), ...lex(quote(n) + ' <=>'), param(incoming[n] ?? (inserted ? lastId : null))]);
                const [rows] = await this.query(c, [...lex('SELECT'), ...returning, ...lex(`FROM ${quote(table)} WHERE`), ...selector], state);
                output.push(...rows);
            }
        }
        state.changes = changed;
        return result(output, changed, lastId);
    }
}
class Statement implements DatabaseStatement {
    readonly owner: MySqlDatabase;
    readonly sql: string;
    readonly values: Value[];
    constructor(owner: MySqlDatabase, sql: string, values: Value[]) { this.owner = owner; this.sql = sql; this.values = values; }
    bind(...values: unknown[]) { if (values.some(v => v !== null && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))))
        throw Error('Invalid SQL bind value'); return new Statement(this.owner, this.sql, values as Value[]); }
    async all<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> { return (await this.owner.batch<T>([this]))[0]; }
    async run<T = Record<string, unknown>>(): Promise<DatabaseResult<T>> { return this.all<T>(); }
    async first<T = Record<string, unknown>>(column?: string): Promise<T | null> { const r = (await this.all<Record<string, unknown>>()).results[0]; return r ? (column ? r[column] as T : r as T) : null; }
    async raw<T = unknown[]>(): Promise<T[]> { return (await this.all<Record<string, unknown>>()).results.map(r => Object.values(r) as T); }
}
