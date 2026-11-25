import { validateEnvironment } from '../../runtime/environment.ts';
import type { PoolOptions } from 'mysql2/promise';
function poolLimit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const text = env[key];
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1)
        throw Error(`Invalid ${key}: expected a positive integer`);
    return value;
}

export function mysqlOptions(env: NodeJS.ProcessEnv = process.env): PoolOptions {
    validateEnvironment(env);
    const required = (key: string) => { const value = env[key]; if (!value)
        throw Error(`${key} is required`); return value; };
    const port = Number(env.MYSQL_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw Error('Invalid MYSQL_PORT');
    return { host: required('MYSQL_HOST'), port, database: required('MYSQL_DATABASE'), user: required('MYSQL_USER'), password: required('MYSQL_PASSWORD'),
        ssl: { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2', ...(env.MYSQL_TLS_CA ? { ca: env.MYSQL_TLS_CA } : {}) },
        charset: 'utf8mb4_bin', timezone: 'Z', decimalNumbers: true, supportBigNumbers: true, bigNumberStrings: false,
        connectionLimit: poolLimit(env, 'MYSQL_CONNECTION_LIMIT', 20),
        maxPreparedStatements: poolLimit(env, 'MYSQL_MAX_PREPARED_STATEMENTS', 128),
        multipleStatements: false, enableKeepAlive: true };
}
