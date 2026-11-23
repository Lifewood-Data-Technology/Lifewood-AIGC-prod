import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
export const RPC_PATH='/internal/deseret-transfer';
export const RESPONSE_SIGNATURE_HEADER='x-lw-response-signature';
const fail=(code,status=400)=>Object.assign(new Error(code),{code,status});
const identity=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(x);
const digest=body=>createHash('sha256').update(body).digest('hex');
export function signRpc(body, config, requestId, timestamp) {
  const canonical = ['LW-DESERET-RELAY-V1', config.keyId, timestamp, requestId, 'POST', RPC_PATH, digest(body)].join('\n');
  return createHmac('sha256', config.secret).update(canonical).digest('hex');
}
export function authenticate(headers, body, config, now = Date.now()) {
  const id = headers['x-lw-request-id'], timestamp = headers['x-lw-timestamp'], signature = headers['x-lw-signature'];
  if (headers['x-lw-key-id'] !== config.keyId || !identity(id) || !/^\d{1,12}$/.test(timestamp || '') ||
      Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(signature || '')) throw fail('UNAUTHORIZED', 401);
  const expected = signRpc(body, config, id, timestamp);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) throw fail('UNAUTHORIZED', 401);
  return id;
}
/**
 * Responses to an authenticated request are bound to that request ID, the HTTP status and the exact body,
 * so a misrouted proxy or another service cannot acknowledge storage work it did not perform.
 */
export function signRpcResponse(body, config, requestId, status) {
  const canonical = ['LW-DESERET-RELAY-RESPONSE-V1', config.keyId, requestId, String(status), digest(body)].join('\n');
  return createHmac('sha256', config.secret).update(canonical).digest('hex');
}
export function verifyRpcResponse(signature, body, config, requestId, status) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !identity(requestId)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signRpcResponse(body, config, requestId, status), 'hex'));
}
