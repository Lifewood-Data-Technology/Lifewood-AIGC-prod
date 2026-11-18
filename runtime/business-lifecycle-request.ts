import type { Database } from "../db/database";
import { assertBusinessAvailable, businessScopes, withBusinessOperation } from "../db/business-deletion";
import { PublicError } from "../lib/security-controls";
import { boundedUploadRequest } from "../lib/upload-security";
import { withUploadAdmission } from "./upload-admission";

const businessRoutes = new Set(["/api/workflow", "/api/files", "/api/folders", "/api/production-workspace", "/api/request-documents", "/api/request-analysis", "/api/business-recycle", "/api/shares", "/api/shares/unlock", "/api/public-file", "/api/name-translations", "/api/content-translations"]);
const inputKeys = /(?:^id$|^ids$|Id$|Ids$|^task$|^file$|^folder$|^project$|^customer$|^client$|^token$|^targets$|^children$)/;
type Input = { key: string; value: string };
function collect(value: unknown, found: Input[], key = "") {
  if (found.length > 2000) throw new PublicError("Too many business references.", 400);
  if (Array.isArray(value)) { for (const item of value) collect(item, found, key); return; }
  if (value && typeof value === "object") { for (const [name, item] of Object.entries(value)) collect(item, found, name); return; }
  if (typeof value !== "string" || !inputKeys.test(key)) return;
  if (value.startsWith("[") || value.startsWith("{")) { try { collect(JSON.parse(value), found, key); } catch (error) { if (error instanceof PublicError) throw error; } return; }
  if (value && value.length <= 255) found.push({ key, value });
}
async function resolveInputs(db: Database, inputs: Input[]) {
  const out = new Set<string>();
  for (const id of [...new Set(inputs.map(input => input.value))]) {
    // IDs are looked up in fixed, bounded tables. Persisted parentage determines scope.
    const common = await businessScopes(db, { customerId: undefined, projectId: undefined, taskId: id, fileId: id, folderId: id, requestId: id });
    common.forEach(value => out.add(value));
    const client = await db.prepare("SELECT id FROM clients WHERE id=?").bind(id).first<{id:string}>();
    if (client) out.add(`customer:${client.id}`);
    const project = await db.prepare("SELECT id,client_id FROM projects WHERE id=?").bind(id).first<{id:string;client_id:string}>();
    if (project) { out.add(`project:${project.id}`); out.add(`customer:${project.client_id}`); }
    const derived = (await db.prepare("SELECT language_project_id FROM production_staged_files WHERE id=? UNION SELECT language_project_id FROM production_checkpoints WHERE id=? UNION SELECT language_project_id FROM handover_records WHERE id=? UNION SELECT language_project_id FROM material_standards WHERE id=? UNION SELECT language_project_id FROM quality_rounds WHERE id=?").bind(id,id,id,id,id).all<{language_project_id:string}>()).results;
    for (const row of derived) (await businessScopes(db, { taskId: row.language_project_id })).forEach(value => out.add(value));
    const child = (await db.prepare("SELECT project_id FROM project_videos WHERE id=? UNION SELECT project_id FROM share_links WHERE id=? OR token=? UNION SELECT project_id FROM deliveries WHERE id=? UNION SELECT project_id FROM publish_records WHERE id=?").bind(id,id,id,id,id).all<{project_id:string}>()).results;
    for (const row of child) (await businessScopes(db, { projectId: row.project_id })).forEach(value => out.add(value));
    const document = await db.prepare("SELECT request_id FROM project_request_documents WHERE id=?").bind(id).first<{request_id:string}>();
    if (document) (await businessScopes(db, { requestId: document.request_id })).forEach(value => out.add(value));
    // Deleted roots retain tombstones even when no business row remains.
    out.add(`customer:${id}`); out.add(`project:${id}`);
  }
  return [...out];
}

/** Runs inside authenticatedResponse, after identity and source checks; no caller headers are trusted. */
export async function businessLifecycleResponse(request: Request, db: Database, handle: (request: Request) => Promise<Response>) {
  return withUploadAdmission(request, requestId => admittedBusinessLifecycleResponse(request, db, handle, requestId));
}

async function admittedBusinessLifecycleResponse(request: Request, db: Database, handle: (request: Request) => Promise<Response>, requestId?: string) {
  const url = new URL(request.url), direct = /^\/api\/direct-uploads(?:\/([^/]+))?$/.exec(new URL(request.url).pathname);
  // /projects/<id> is a client shell without business data; its APIs are gated here. Answering the page
  // itself with BUSINESS_DELETED JSON showed raw JSON and told visitors which IDs once existed (D4).
  if (!businessRoutes.has(url.pathname) && !direct) return handle(request);
  const inputs: Input[] = [];
  for (const [key, value] of url.searchParams) collect(value, inputs, key);
  if(direct?.[1]){
    const session=await db.prepare("SELECT payload_json FROM direct_upload_sessions WHERE id=? AND actor_email=?").bind(decodeURIComponent(direct[1]),request.headers.get("x-lifewood-actor-email") || "").first<{payload_json:string}>();
    if(session)collect(JSON.parse(session.payload_json),inputs);
  }
  const writes = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  try {
    if (writes && request.body) {
      const copy = request.clone(), contentType = copy.headers.get("content-type") ?? "";
      if (contentType.startsWith("multipart/form-data")) {
        const started=Date.now();
        const form = await boundedUploadRequest(copy, url.pathname === "/api/request-documents" ? 26 * 1024 * 1024 : 104 * 1024 * 1024).formData();
        const id=String(form.get("id")||"");
        console.info({event:"upload.lifecycle.parsed",requestId,durationMs:Date.now()-started,...(/^[a-f0-9-]{36}$/.test(id)?{fileId:id}:{})});
        for (const [key, value] of form) if (typeof value === "string") collect(value, inputs, key);
      } else if (contentType.includes("application/json")) {
        const text=await boundedUploadRequest(copy, 2 * 1024 * 1024).text();
        // The direct DELETE contract uses its path, not a JSON payload. Node can
        // expose an empty readable body even when no bytes were sent.
        if(!(direct?.[1]&&request.method==='DELETE'&&!text.trim())){
          let value:unknown;
          try{value=JSON.parse(text);}catch(error){if(error instanceof SyntaxError)throw new PublicError('Invalid JSON request body.',400,'INVALID_JSON');throw error;}
          collect(value,inputs);
        }
      }
    }
    const scopes = await resolveInputs(db, inputs);
    await assertBusinessAvailable(db, scopes);
    // Media may generate a thumbnail; workspace reads may repair system folders.
    // Both must finish before a deletion is allowed to freeze its inventory.
    const mayWriteOnRead = ["/api/files", "/api/public-file", "/api/production-workspace"].includes(url.pathname);
    return writes || mayWriteOnRead ? await withBusinessOperation(db, scopes, request.headers.get("x-lifewood-actor-email") ?? "", () => handle(request)) : await handle(request);
  } catch (error) {
    if (!(error instanceof PublicError)) throw error;
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "cache-control": "no-store" } });
  }
}
