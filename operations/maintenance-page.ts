/** Temporary administrator-only review page. Remove the Worker hook after use. */
import { readCookie } from "../lib/request-security";
import { CLEANUP_PATH, DEMO_TABLES, cleanupDiagnostic, handleDemoCleanup, inventory, publicPlan, type CleanupEnv } from "./demo-cleanup";

export const REVIEW_PATH = "/__maintenance/data-review";
type Plan = ReturnType<typeof publicPlan>;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
const labels: Record<string, string> = {
  clients: "客户", client_profiles: "客户档案", projects: "项目", project_requests: "项目需求单",
  project_videos: "视频", language_projects: "语言任务", aigc_files: "文件记录", aigc_file_versions: "文件版本记录",
  aigc_storage_objects: "存储对象记录", production_checkpoints: "检查点", notifications: "通知", audit_logs: "操作日志",
  share_access_sessions: "分享访问会话", share_links: "分享链接", asset_collection_files: "素材集合文件关联", asset_lineage: "素材来源关联", asset_collections: "素材集合",
  production_checkpoint_files: "检查点文件关联", checkpoint_environment_snapshots: "检查点环境快照", task_material_links: "任务素材关联", handover_records: "任务交接记录",
  production_checkpoint_drafts: "检查点草稿", upload_sessions: "上传会话", aigc_file_operations: "文件操作记录", aigc_file_previews: "文件预览记录",
  project_request_analyses: "AI 需求解析记录", project_request_documents: "完整需求文档记录", project_request_revisions: "需求修订历史",
  quality_rounds: "质检轮次", reviews: "质检意见", feedback: "客户反馈", deliveries: "交付记录", publish_records: "作品发布记录", project_files: "项目文件关联",
  language_assignment_history: "任务分配历史", material_standards: "客户及项目需求标准", project_types: "旧项目类型记录", versions: "旧视频版本记录",
};
function page(body: string, status = 200) {
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据维护核对 · Lifewood</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f7f8f6;color:#153626;font:16px/1.65 system-ui,sans-serif}main{max-width:920px;margin:40px auto;padding:32px;background:white;border:1px solid #ccd9d1;border-radius:16px}h1{font-size:28px;margin:0 0 16px}h2{font-size:20px}p{margin:10px 0}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid #dce4de}td:last-child{text-align:right}code{font-size:13px;overflow-wrap:anywhere}button,input{font:inherit}input[type=text]{display:block;width:100%;padding:12px;margin:8px 0 16px;border:1px solid #9eafa5;border-radius:8px}button{padding:12px 20px;background:#00543b;color:white;border:0;border-radius:8px;cursor:pointer;margin-top:16px}label{display:block}.notice{padding:16px;background:#eef5f1;border-radius:8px}.warning{padding:16px;border:1px solid #d19f47;border-radius:8px}a{color:#00543b}@media(max-width:600px){main{margin:12px;padding:20px}}
    </style></head><body><main>${body}</main></body></html>`, { status, headers: {
      // A no-referrer policy makes native form POSTs send Origin: null.
      // Keep same-origin identity for strict CSRF checks, without sending
      // referrers to other origins. Do not allow null origins on submission.
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    } });
}
async function session(request: Request, env: CleanupEnv) {
  const token = readCookie(request.headers.get("cookie"), "lifewood_session");
  if (!token || token.length > 1024) return null;
  const tokenHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
  const now = new Date();
  const account = await env.DB.prepare(`SELECT a.email FROM account_sessions session JOIN accounts a ON a.email = session.account_email WHERE session.token_hash = ? AND session.expires_at > ? AND session.last_seen_at > ? AND a.status = 'active' AND a.access_group = 'system' AND a.must_change_password = 0`)
    .bind(tokenHash, now.toISOString(), new Date(now.getTime() - 30 * 60_000).toISOString()).first<{ email: string }>();
  return account ? tokenHash : null;
}
async function sign(env: CleanupEnv, sessionHash: string, planHash: string, preservedHash: string, operation: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.AIGC_DEMO_CLEANUP_TOKEN!), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify([REVIEW_PATH, env.AIGC_DEMO_CLEANUP_EXPIRES, sessionHash, planHash, preservedHash, operation]))));
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0; for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
async function review(plan: Plan, env: CleanupEnv, sessionHash: string, completed = false) {
  const execute = env.AIGC_DEMO_CLEANUP_MODE === "execute";
  const operation = plan.fileCount ? "files" : "database";
  const signature = await sign(env, sessionHash, plan.planHash, plan.preservedHash, operation);
  const hidden = Object.entries({ operation, planHash: plan.planHash, preservedHash: plan.preservedHash, signature }).map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`).join("");
  const rows = DEMO_TABLES.map(name => `<tr><td>${escape(labels[name] ?? name)}</td><td>${plan.tables[name]}</td></tr>`).join("");
  return page(`<h1>${completed ? "清理结果核对" : "数据维护核对"}</h1>
    <p class="notice">${completed ? "本次清理已完成。账号及受保护内容的校验值保持一致。" : execute ? "执行阶段：业务访问暂时暂停。查看此页不会删除任何数据。" : "当前仅核对数据，没有开启删除，其他业务页面保持可用。"}</p>
    <h2>保留内容</h2><p>全部 ${plan.tables.accounts} 个账号，以及密码、角色、权限、登录记录、个人工作区和系统设置。保留数据库表结构、平台维护记录与 ${plan.keptBaseFolders} 个基础文件夹。</p>
    <h2>${completed ? "剩余业务数据" : "待清理内容"}</h2><p>实际存储文件：<strong>${plan.fileCount}</strong> 个，共 <strong>${plan.fileBytes}</strong> 字节；业务文件夹：<strong>${plan.foldersToDelete}</strong> 个。</p>
    <table><thead><tr><th>数据类别</th><th>记录数</th></tr></thead><tbody>${rows}</tbody></table>
    <p>账号等受保护内容校验值：<code>${plan.preservedHash}</code></p><p>当前范围校验值：<code>${plan.planHash}</code></p>
    ${!completed && execute ? `<form method="post" action="${REVIEW_PATH}">${hidden}<div class="warning"><p>以下操作不可撤销，本次不创建备份。${operation === "files" ? `下一步删除本批 ${Math.min(plan.fileCount, 200)} 个实际文件，之后再核对数据库清理。` : "下一步清理上方列出的业务记录，保留账号和表结构。"}</p>
      <label>请输入：保留账号，清除业务数据<input type="text" name="confirmation" autocomplete="off" required></label><label><input type="checkbox" name="backupWaived" value="yes" required> 我确认这些都是测试数据，本次不需要备份</label>
      <button type="submit">${operation === "files" ? "永久删除本批实际文件" : "永久清理业务记录"}</button></div></form>` : ""}
    <p><a href="${REVIEW_PATH}">重新核对数据</a>${!execute ? ' · <a href="/?view=accounts">返回账号管理</a>' : ""}</p>
    <p>这是临时管理员入口，不加入系统菜单；操作结束后会撤下。页面不显示密码或密钥。</p>`);
}
export async function handleCleanupReview(request: Request, env: CleanupEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== REVIEW_PATH) return null;
  const expiry = Date.parse(env.AIGC_DEMO_CLEANUP_EXPIRES ?? "");
  if (!/^[a-f0-9]{64}$/.test(env.AIGC_DEMO_CLEANUP_TOKEN ?? "") || !["preview", "execute"].includes(env.AIGC_DEMO_CLEANUP_MODE ?? "") || !Number.isFinite(expiry) || Date.now() >= expiry) return page("<h1>临时入口未启用或已过期</h1>", 404);
  let stage = "administrator_session";
  try {
    const sessionHash = await session(request, env);
    if (!sessionHash) return page('<h1>需要有效的管理员登录</h1><p>此页不会重置密码或修改账号。请返回系统正常登录后重试。</p><a href="/">返回系统</a>', 401);
    if (request.method === "GET") { const plan = await inventory(env, value => { stage = value; }); stage = "render"; return await review(publicPlan(plan), env, sessionHash); }
    if (request.method !== "POST") return page("<h1>不支持此操作</h1>", 405);
    if (env.AIGC_DEMO_CLEANUP_MODE !== "execute") return page("<h1>当前仅允许核对，未开启删除</h1>", 403);
    if (request.headers.get("origin") !== url.origin) return page("<h1>请求来源不匹配</h1>", 403);
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return page("<h1>提交格式错误</h1>", 400);
    const raw = await request.text();
    if (raw.length > 2048) return page("<h1>提交内容过长</h1>", 400);
    const form = new URLSearchParams(raw);
    const operation = form.get("operation") ?? "", planHash = form.get("planHash") ?? "", preservedHash = form.get("preservedHash") ?? "";
    if (form.get("confirmation") !== "保留账号，清除业务数据" || form.get("backupWaived") !== "yes" || !["files", "database"].includes(operation) || !/^[a-f0-9]{64}$/.test(planHash) || !/^[a-f0-9]{64}$/.test(preservedHash)) return page("<h1>确认内容不完整，未执行删除</h1>", 400);
    if (!same(form.get("signature") ?? "", await sign(env, sessionHash, planHash, preservedHash, operation))) return page("<h1>确认已失效，未执行删除</h1>", 403);
    const response = await handleDemoCleanup(new Request(new URL(CLEANUP_PATH, url), { method: "POST", headers: { authorization: "Bearer " + env.AIGC_DEMO_CLEANUP_TOKEN, origin: url.origin, "content-type": "application/json" }, body: JSON.stringify({ operation, planHash, preservedHash, confirmation: "CLEAR_DEMO_KEEP_ACCOUNTS", backupWaived: true }) }), env);
    if (!response?.ok) return page(`<h1>操作未通过核对</h1><p>未报告清理完成。请停止重试并检查当前数据；已经完成的文件删除不会自动恢复。</p><a href="${REVIEW_PATH}">重新核对数据</a>`, response?.status ?? 503);
    const result = await response.json() as Plan & { completed?: boolean };
    return review(result, env, sessionHash, result.completed === true);
  } catch (error) {
    const diagnostic = cleanupDiagnostic(error);
    console.error(JSON.stringify({ event: "cleanup_review_failed", stage, ...diagnostic }));
    return page(`<h1>数据核对暂时失败</h1><p>没有确认清理完成。请检查实际状态，不要重复提交。</p><p>核对位置：${escape(stage)} · ${escape(diagnostic.code)}${diagnostic.item ? " · " + escape(diagnostic.item) : ""}</p><a href="${REVIEW_PATH}">重新核对数据</a>`, 503);
  }
}
