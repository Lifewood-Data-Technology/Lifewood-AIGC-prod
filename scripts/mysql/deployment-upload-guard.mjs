/** Read-only cutover predicate: protect live claims and unexpired foreground activity, not expired cleanup cooldowns. */
export function deploymentUploadBusySql(now) {
 if(typeof now!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now)||new Date(now).toISOString()!==now)throw Error('Canonical deployment timestamp required');
 return "cleaned_at IS NULL AND lease_expires_at>'"+now+"' AND (claim_id IS NOT NULL OR (expires_at>'"+now+"' AND state NOT IN ('ready','cancelled','expired')))";
}
