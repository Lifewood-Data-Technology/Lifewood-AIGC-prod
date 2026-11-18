// Page identity for cover media. Logout, an account change or a 401 ends the
// epoch: cover caches and in-flight cover requests from the old identity are
// dropped, and results that arrive later are discarded.
let epoch = 0;
export type CoverSessionResetReason = "reset" | "unauthorized";
const listeners = new Set<(reason: CoverSessionResetReason) => void>();
export function coverSessionEpoch() { return epoch; }
export function onCoverSessionReset(listener: (reason: CoverSessionResetReason) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function releaseMediaCovers(reason: CoverSessionResetReason = "reset") {
  epoch++;
  for (const listener of [...listeners]) listener(reason);
}
