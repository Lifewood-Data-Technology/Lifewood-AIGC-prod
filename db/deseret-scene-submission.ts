import type { Database, DatabaseStatement } from "./database";
import { nextSceneVersion, optionalSceneScript, type DeseretIntegrationState } from "../lib/deseret-workspace";
import { PublicError } from "../lib/security-controls";

/**
 * Join scene registration to the native submission transaction, after the final version ID is known. A scene
 * is submitted with its video and duration only; see `nextSceneVersion` for how a stored script is kept.
 */
export async function deseretSceneSubmission(db: Database, projectId: string, taskId: string, fileVersionId: string, input?: string, replacesVersionId?: string) {
  const row = await db.prepare("SELECT state_json,revision FROM deseret_project_links WHERE id=?").bind(projectId).first<{ state_json: string; revision: number }>();
  const empty = { storyboard: false, sql: "1=1", values: [] as (string | number | null)[], statements: [] as DatabaseStatement[] };
  if (!row) return { ...empty, sql: "NOT EXISTS(SELECT 1 FROM deseret_project_links WHERE id=?)", values: [projectId] };
  const state = JSON.parse(row.state_json) as DeseretIntegrationState;
  if (state.intake !== "accepted" || state.materials !== "ready" || !["production", "final_production"].includes(state.stage))
    throw new PublicError("Deseret production is not open for submission.", 409, "DESERET_PRODUCTION_BLOCKED");
  const result = { ...empty, storyboard: state.stage === "production", sql: "EXISTS(SELECT 1 FROM deseret_project_links WHERE id=? AND revision=?)", values: [projectId, Number(row.revision)] as (string | number | null)[] };
  if (state.stage !== "production") {
    if (input) throw new PublicError("The storyboard round changed. Refresh before submitting.", 409, "DESERET_CONFLICT");
    return result;
  }
  if (!input) {
    if (!state.scenes.some(scene => scene.languageTaskId === taskId && scene.fileVersionId === fileVersionId && Number.isFinite(scene.duration) && scene.duration > 0 && scene.duration <= 3600))
      throw new PublicError("Register the scene video and duration before submitting for review.", 409, "DESERET_SCENE_REQUIRED");
    return result;
  }
  let value: { id?: unknown; version?: unknown; script?: unknown; duration?: unknown };
  try { value = JSON.parse(input); } catch { throw new PublicError("Check the scene duration.", 400, "DESERET_SCENE_INVALID"); }
  const script = value && typeof value === "object" && !Array.isArray(value) ? optionalSceneScript(value.script) : false;
  if (script === false || typeof value.duration !== "number" || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 3600 || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id))
    throw new PublicError("Check the scene duration.", 400, "DESERET_SCENE_INVALID");
  const previous = state.scenes.find(scene => scene.id === value.id);
  const replacedScenes = replacesVersionId ? state.scenes.filter(scene => scene.fileVersionId === replacesVersionId && scene.languageTaskId === taskId) : [];
  if (replacedScenes.length && (replacedScenes.length !== 1 || replacedScenes[0].id !== value.id))
    throw new PublicError("Select the scene associated with the pending video before replacing it.", 409, "DESERET_SCENE_REPLACEMENT");
  if (previous && previous.languageTaskId !== taskId)
    throw new PublicError("The scene belongs to another language task.", 403, "DESERET_SCENE_SCOPE");
  if (value.version !== (previous?.version ?? 0))
    throw new PublicError("The scene changed. Refresh before submitting.", 409, "DESERET_CONFLICT");
  if (!previous && state.scenes.length >= 200) throw new PublicError("A review package supports up to 200 scenes.");
  const scene = nextSceneVersion({
    id: value.id, order: previous?.order ?? Math.max(0, ...state.scenes.map(scene => scene.order)) + 1, duration: value.duration,
    characterIds: previous?.characterIds ?? [], voiceId: previous?.voiceId ?? "", fileVersionId, languageTaskId: taskId,
  }, previous, script?.trim()); // The native entry has always stored the script trimmed.
  if (previous && state.revisionSceneIds.includes(scene.id) && previous.fileVersionId === fileVersionId)
    throw new PublicError("Requested scene revisions require a newly registered video version.", 409, "DESERET_NEW_VERSION_REQUIRED");
  if (previous) state.scenes.splice(state.scenes.indexOf(previous), 1, scene);
  else state.scenes.push(scene);
  state.revision = Number(row.revision) + 1;
  result.statements.push(db.prepare("UPDATE deseret_project_links SET state_json=?,revision=revision+1,updated_at=? WHERE id=?").bind(JSON.stringify(state), new Date().toISOString(), projectId));
  return result;
}
