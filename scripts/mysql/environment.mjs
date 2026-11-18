import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { validateEnvironment } from '../../runtime/environment.ts';
import {regressionTarget} from './regression-target.mjs';

// Resource-binding variables of audit/isolated runs. They must come from the selected file, never only from a parent.
export const fileOnlyBindings = ['LIFEWOOD_AUDIT_RESOURCE', 'LIFEWOOD_AUDIT_RUN', 'LIFEWOOD_AUDIT_SHARED_BUCKET', 'LIFEWOOD_AUDIT_MYSQL_ACCOUNT_HOST', 'LIFEWOOD_AUDIT_DISPOSABLE_MYSQL', 'LIFEWOOD_ISOLATED_STORAGE'];
const lanBindings = ['LIFEWOOD_LAN_HOST', 'LIFEWOOD_LAN_CIDRS', 'LIFEWOOD_LAN_ALIASES', 'LIFEWOOD_LAN_TLS_CERT', 'LIFEWOOD_LAN_TLS_KEY', 'LIFEWOOD_PROXY_ORIGINS', 'LIFEWOOD_PROXY_CIDRS', 'LIFEWOOD_PROXY_TOKEN', 'LIFEWOOD_PUBLIC_ORIGIN', 'LIFEWOOD_PUBLIC_PROXY_TOKEN'];
export function loadEnvironment() {
    if (!process.env.LIFEWOOD_ENV_FILE) throw Error('LIFEWOOD_ENV_FILE is required; no implicit configuration fallback');
    const path = resolve(process.env.LIFEWOOD_ENV_FILE);
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    for (const key of new Set([...Object.keys(parsed), ...Object.keys(process.env)])) {
        if (!key.startsWith('LIFEWOOD_DESERET_INTEGRATION_')) continue;
        if (process.env[key] !== undefined && process.env[key] !== parsed[key]) throw Error(`Conflicting configuration: ${key} must match the selected environment file`);
    }
    for (const key of ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'WASABI_BUCKET', 'WASABI_PREFIX', 'WASABI_REGION', 'WASABI_ENDPOINT', 'WASABI_ACCESS_KEY_ID', 'WASABI_SECRET_ACCESS_KEY']) {
        if (!parsed[key]?.trim()) throw Error(`Missing configuration in selected file: ${key}`);
    }
    // NODE_ENV is a framework setting, not a resource identity.
    for (const [key, value] of Object.entries(parsed)) {
        if ((/^(LIFEWOOD_ENV$|LIFEWOOD_VIDEO_CACHE_MIB$|FILE_TRANSFER_MODE$|MYSQL_|WASABI_|UPLOAD_)/.test(key) || fileOnlyBindings.includes(key) || lanBindings.includes(key)) && process.env[key] !== undefined && process.env[key] !== value) throw Error(`Conflicting configuration: ${key}`);
    }
    for (const key of fileOnlyBindings) if (process.env[key] !== undefined && parsed[key] === undefined) throw Error(`Conflicting configuration: ${key} must be selected in the environment file`);
    for (const key of lanBindings) if (process.env[key] !== undefined && parsed[key] === undefined) throw Error(`Conflicting configuration: ${key} must be selected in the environment file`);
    if(process.env.LIFEWOOD_VIDEO_CACHE_MIB!==undefined&&parsed.LIFEWOOD_VIDEO_CACHE_MIB===undefined)throw Error('LIFEWOOD_VIDEO_CACHE_MIB must be selected in the environment file');
    const merged = { ...parsed, ...process.env };
    if(process.env.FILE_TRANSFER_MODE!==undefined&&parsed.FILE_TRANSFER_MODE===undefined)throw Error('FILE_TRANSFER_MODE must be selected in the environment file');
    if(process.env.WASABI_HTTP_PROXY!==undefined&&parsed.WASABI_HTTP_PROXY===undefined)throw Error('WASABI_HTTP_PROXY must be selected in the environment file');
    if (process.env.LIFEWOOD_EXPECT_ENV && merged.LIFEWOOD_ENV !== process.env.LIFEWOOD_EXPECT_ENV) throw Error('Unexpected LIFEWOOD_ENV for launch target');
    validateEnvironment(merged);
    for (const [key, value] of Object.entries(parsed)) if (process.env[key] === undefined) process.env[key] = value;
    return path;
}

export const regressionIdentity = 'lifewood_aigc_test:aigc-dev:lifewood-test/app/';
// The shared manual Test resources are destroyed by a regression run (fixture DELETEs every business table,
// cleanup deletes every object version under the prefix). Each run must name them explicitly.
export const sharedTestAcknowledgement = regressionIdentity;
export function loadRegressionEnvironment() {
    if (!process.env.LIFEWOOD_ENV_FILE || /(?:^|[/\\])(?:app|production)\.env$/.test(process.env.LIFEWOOD_ENV_FILE))
        throw Error('Regression requires an explicit Test configuration file');
    if (process.env.LIFEWOOD_ENV && !['test','audit'].includes(process.env.LIFEWOOD_ENV)) throw Error('Regression must use test or audit');
    // Resolve the selected file before choosing any resource/marker. No connection is made here.
    const selected=parseEnv(readFileSync(resolve(process.env.LIFEWOOD_ENV_FILE),'utf8'));
    const target=regressionTarget(selected);
    if (process.env.LIFEWOOD_REGRESSION_TARGET !== target.resource)
        throw Error('REGRESSION_RESOURCE_NOT_ISOLATED: explicit resource binding required');
    if (selected.LIFEWOOD_ENV === 'test' && process.env.LIFEWOOD_SHARED_TEST_DESTRUCTIVE !== sharedTestAcknowledgement)
        throw Error('SHARED_TEST_DESTRUCTIVE_ACK_REQUIRED: this target is the shared manual Test (database rows and every object under the prefix are deleted). Set LIFEWOOD_SHARED_TEST_DESTRUCTIVE='+sharedTestAcknowledgement+' only with current authorization, or use an isolated audit run.');
    const path = loadEnvironment();
    if (!['test','audit'].includes(process.env.LIFEWOOD_ENV) || process.env.MYSQL_DATABASE !== target.database ||
        process.env.MYSQL_USER !== target.user || process.env.MYSQL_HOST !== '127.0.0.1' ||
        process.env.WASABI_BUCKET !== target.bucket || process.env.WASABI_PREFIX !== target.prefix)
        throw Error('Regression resource binding mismatch');
    return path;
}
