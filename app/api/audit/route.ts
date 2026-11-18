import { getAccount, requireCapability } from '../../../db/backend';
import { parseAuditQuery, readAuditDetail, readAuditPage, readAuditSelection } from '../../../db/audit-query';
import { auditLogCsv } from '../../../lib/audit-display';
import { PublicError } from '../../../lib/security-controls';
import { env } from '../../../runtime/node-environment';
import { apiError, authenticatedEmail } from '../_auth';
export async function GET(request: Request) {
  try {
    const actor = await getAccount(authenticatedEmail(request));
    if (!actor || actor.access !== 'system') throw new PublicError('Administrator access required.', 403);
    await requireCapability(actor, 'system.manage');
    const params = new URL(request.url).searchParams, query = parseAuditQuery(params);
    if (query.csv) return new Response(auditLogCsv(await readAuditSelection(env.DB, params)), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="operation-logs.csv"', 'cache-control': 'no-store' } });
    if (query.detailId) return Response.json({ row: await readAuditDetail(env.DB, params) }, { headers: { 'cache-control': 'no-store' } });
    return Response.json(await readAuditPage(env.DB, params), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return apiError(error, 'Audit records could not be loaded.'); }
}
