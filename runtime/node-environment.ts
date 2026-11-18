import { MySqlDatabase } from '../db/mysql/driver';
import { WasabiBucket } from './wasabi';
let database: MySqlDatabase | undefined;
let files: WasabiBucket | undefined;
const pending = new Set<Promise<unknown>>();
export const env = {
    get DB() { return database ??= new MySqlDatabase(); },
    get FILES() { return files ??= new WasabiBucket(); },
    LIFEWOOD_STORAGE: 'wasabi',
    get WASABI_BUCKET() { return process.env.WASABI_BUCKET; },
    get WASABI_REGION() { return process.env.WASABI_REGION; },
    get WASABI_ENDPOINT() { return process.env.WASABI_ENDPOINT; },
    get BACKUP_SERVICE_URL() { return process.env.BACKUP_SERVICE_URL; },
    get BACKUP_SERVICE_TOKEN() { return process.env.BACKUP_SERVICE_TOKEN; },
    get MFA_ENCRYPTION_KEY() { return process.env.MFA_ENCRYPTION_KEY; },
    get ZHIPU_API_KEY() { return process.env.ZHIPU_API_KEY; },
    get ZHIPU_MODEL() { return process.env.ZHIPU_MODEL; },
    get ZHIPU_FALLBACK_MODEL() { return process.env.ZHIPU_FALLBACK_MODEL; },
};
let closing = false;
/** True once shutdown has begun: background producers must stop starting new work. */
export function shuttingDown() { return closing; }
export function waitUntil(promise: Promise<unknown>) { pending.add(promise); void promise.catch(() => console.error('Background operation failed')).finally(() => pending.delete(promise)); }
// Wait until nothing tracked remains, not only for the snapshot taken when shutdown began: a running job may still
// register follow-up work before it ends. Producers check shuttingDown(), so this drain terminates.
export async function shutdown() { closing = true; while (pending.size) await Promise.allSettled([...pending]); await database?.close(); }
