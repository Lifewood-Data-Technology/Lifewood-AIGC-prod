import {readVideoCacheBudget} from '../lib/video-cache-policy.ts';
import { readUploadSettings } from '../lib/upload-settings.ts';
import { auditResource } from './audit-environment.ts';
import { readWasabiHttpProxy } from './wasabi-proxy.ts';
/** Resource identities are explicit; a Git branch is never an authorization boundary. */
export function validateEnvironment(values: NodeJS.ProcessEnv = process.env) {
    const mode = values.LIFEWOOD_ENV;
    if(values.FILE_TRANSFER_MODE!==undefined&&!['proxy','direct'].includes(values.FILE_TRANSFER_MODE))throw Error('Invalid FILE_TRANSFER_MODE');
    readUploadSettings(values);
    readVideoCacheBudget(values);
    readWasabiHttpProxy(values.WASABI_HTTP_PROXY);
    if (mode !== 'local' && mode !== 'test' && mode !== 'production' && mode !== 'audit') throw Error('LIFEWOOD_ENV must be local, test, production or audit');
    const expected = mode==='audit' ? (({MYSQL_DATABASE,WASABI_BUCKET,WASABI_PREFIX})=>({MYSQL_DATABASE,WASABI_BUCKET,WASABI_PREFIX}))(auditResource(values)) : mode === 'test'
        ? { MYSQL_DATABASE: 'lifewood_aigc_test', WASABI_BUCKET: 'aigc-dev', WASABI_PREFIX: 'lifewood-test/app/' }
        : { MYSQL_DATABASE: 'lifewood_aigc', WASABI_BUCKET: mode === 'local' ? 'local-aigc' : 'aigc', WASABI_PREFIX: 'lifewood-local/' };
    for (const [key, value] of Object.entries(expected)) {
        if (values[key] !== value) throw Error(`Environment mismatch: ${key}`);
    }
    if (!['127.0.0.1', 'localhost'].includes(values.MYSQL_HOST || '')) throw Error('MYSQL_HOST must be loopback');
    const mysqlPort = values.MYSQL_PORT || '3306';
    const allowedPorts = mode === 'test' ? ['3306'] : ['3306', '3307'];
    const temporaryPortShape=/^\d{4,5}$/.test(mysqlPort)&&Number(mysqlPort)>=1024&&Number(mysqlPort)<=65535;
    const disposableAudit=mode==='audit'&&values.LIFEWOOD_AUDIT_DISPOSABLE_MYSQL!==undefined;
    const temporaryAuditPort=mode==='audit'&&(values.LIFEWOOD_AUDIT_SHARED_BUCKET==='local-aigc'||disposableAudit)&&temporaryPortShape;
    // A disposable container never takes the fixed local service ports.
    if (disposableAudit&&['3306','3307'].includes(mysqlPort)) throw Error('Unexpected MYSQL_PORT');
    if (!allowedPorts.includes(mysqlPort)&&!temporaryAuditPort) throw Error('Unexpected MYSQL_PORT');
    if (values.WASABI_REGION !== 'ap-southeast-1' || values.WASABI_ENDPOINT?.replace(/\/$/, '') !== 'https://s3.ap-southeast-1.wasabisys.com') throw Error('Unexpected Wasabi location');
    for (const key of ['MYSQL_USER', 'MYSQL_PASSWORD', 'WASABI_ACCESS_KEY_ID', 'WASABI_SECRET_ACCESS_KEY']) {
        if (!values[key]?.trim()) throw Error(`Missing configuration: ${key}`);
    }
    if (mode === 'test' && values.MYSQL_USER !== 'lifewood_test') throw Error('Test requires dedicated MYSQL_USER lifewood_test');
    if (mode==='audit' && values.MYSQL_USER!=='lifewood_audit')throw Error('Audit requires dedicated MYSQL_USER lifewood_audit');
    if (mode !== 'test' && mode!=='audit' && values.MYSQL_USER !== 'lifewood') throw Error(`Unexpected ${mode} MYSQL_USER`);
    return { mode, ...expected, region: values.WASABI_REGION, endpoint: values.WASABI_ENDPOINT! };
}
