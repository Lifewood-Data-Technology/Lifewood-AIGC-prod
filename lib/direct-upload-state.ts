type Claim = {claim_id?: string | null; lease_expires_at?: string | null};

/** An invalid lease is unknown, not proof that a worker has stopped. */
export function uploadClaimActive(row: Claim, now = Date.now()) {
  if (!row.claim_id) return false;
  const expires = Date.parse(row.lease_expires_at || '');
  return !Number.isFinite(expires) || expires > now;
}

export function uploadClaimInterrupted(row: Claim, now = Date.now()) {
  return Boolean(row.claim_id) && !uploadClaimActive(row, now);
}
