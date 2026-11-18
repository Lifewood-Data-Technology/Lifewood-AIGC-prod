import { AsyncLocalStorage } from "node:async_hooks";

/** Server-only context. The runtime shell and the built route bundle share one store. */
export type AuditRequestContext = { requestId: string; actorEmail: string; ipAddress: string | null; active: boolean };
const storeKey = Symbol.for("lifewood.audit-request-context.v1");
const stores = globalThis as typeof globalThis & { [key: symbol]: AsyncLocalStorage<AuditRequestContext> | undefined };
export const auditRequestContext = stores[storeKey] ??= new AsyncLocalStorage<AuditRequestContext>();
export function currentAuditRequestId(): string | null {
  const context = auditRequestContext.getStore();
  return context?.active ? context.requestId : null;
}
