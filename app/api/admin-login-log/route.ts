import { getAccount, requireCapability } from '../../../db/backend';
import { readLoginLog, readLoginLogDetail, readLoginLogSelection } from '../../../db/admin-login-log';
import { parseLoginLogQuery, loginLogCsv } from '../../../lib/admin-login-log';
import { PublicError } from '../../../lib/security-controls';
import { env } from '../../../runtime/node-environment';
import { authenticatedEmail, apiError } from '../_auth';
export async function GET(request: Request) {
  try {
    const actor = await getAccount(authenticatedEmail(request));
    if (!actor || actor.access !== 'system') throw new PublicError('Administrator access required.', 403);
    await requireCapability(actor, 'accounts.manage');
    const params = new URL(request.url).searchParams;
    let query;
    try { query = parseLoginLogQuery(params); } catch { throw new PublicError('Invalid login-log filters.', 400); }
    if (query.csv) return new Response(loginLogCsv(await readLoginLogSelection(env.DB, params)), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="login-history.csv"', 'cache-control': 'no-store' } });
    if (query.detailId) return Response.json({ row: await readLoginLogDetail(env.DB, params) }, { headers: { 'cache-control': 'no-store' } });
    return Response.json(await readLoginLog(env.DB, query), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return apiError(error, 'Could not read login history.'); }
}
