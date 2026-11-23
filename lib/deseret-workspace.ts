import type { HandoffMaterial } from "./deseret-integration-contract";

export type DeseretStage = "intake" | "production" | "storyboard_review" | "revision" | "final_production" | "final_review" | "delivery" | "archived";
export type DeseretScene = {
  id: string;
  order: number;
  version: number;
  duration: number;
  /**
   * Internal production script, optional. Scenes are submitted with a video and a duration only, so new scenes
   * carry none. A historical script stays in AIGC's state and is never sent to Deseret.
   */
  script?: string;
  characterIds: string[];
  voiceId: string;
  fileVersionId: string;
  languageTaskId: string;
};
export const SCENE_SCRIPT_MAX_LENGTH = 20000;

/**
 * Reads the optional script an older client or a replayed request may still send. Absent or blank means none;
 * anything else must be a string of at most 20000 characters and is returned byte for byte (callers that
 * historically trimmed keep doing so). Returns `false` for a malformed value.
 */
export function optionalSceneScript(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > SCENE_SCRIPT_MAX_LENGTH) return false;
  return value.trim() ? value : undefined;
}

/**
 * The stored scene for a submission. An omitted or blank script keeps the previous version's script (or none).
 * A script an older client sends explicitly is kept as before: if it differs from the stored text the scene gets
 * a new version, exactly as any other change; an identical resend keeps the version. Without any script the
 * scene has no script key.
 */
export function nextSceneVersion(scene: Omit<DeseretScene, "script" | "version">, previous: DeseretScene | undefined, script: string | undefined): DeseretScene {
  const kept = script ?? previous?.script;
  const content = (item: Omit<DeseretScene, "version">) =>
    JSON.stringify([item.id, item.order, item.duration, item.script ?? null, item.characterIds, item.voiceId, item.fileVersionId, item.languageTaskId]);
  const next = { ...scene, ...(kept === undefined ? {} : { script: kept }) };
  const version = !previous ? 1 : content(previous) === content(next) ? previous.version : previous.version + 1;
  return { ...next, version };
}

/** The internal script of an assembled final: the stored, non-blank scene scripts joined as stored, or none. */
export function joinedSceneScript(scenes: DeseretScene[]) {
  const scripts = scenes.map(scene => scene.script).filter((script): script is string => typeof script === "string" && Boolean(script.trim()));
  return scripts.length ? { script: scripts.join("\n\n") } : {};
}
export type DeseretPublishedFile = HandoffMaterial & { fileVersionId: string; languageTaskId: string };
export type DeseretReviewPackage = {
  id: string;
  phase: "storyboard" | "final";
  version: number;
  publicationId: string;
  characters?: { id: string; name: string }[];
  publishedAt: string;
  filesReady?: boolean;
  scenes: DeseretScene[];
  files: DeseretPublishedFile[];
  conclusion?: "approved" | "revision";
  withdrawn?: boolean;
};
export type DeseretFeedback = {
  id: string;
  type: "review.feedback" | "author.feedback";
  packageId: string;
  body: string;
  actorId: string;
  createdAt: string;
  sceneId?: string;
  seconds?: number;
  mode?: "comment" | "time" | "revision" | "flag";
  targets?: string[];
  corrections?: Record<string, string>;
  files?: (HandoffMaterial & { state?: string; nativeVersionId?: string })[];
  processing?: { decision: "noted" | "revision_requested"; note: string; processedBy: string; processedAt: string };
  /** Final QA revision issue: the reviewer role that raised it. */
  role?: DeseretIssueRole;
  /** Final QA revision issue: the exact reviewed scene version. */
  sceneVersion?: number;
  /** End of a reviewed interval; `seconds` is its start. */
  endSeconds?: number;
  /** Final QA revision issue: frame images with their own times. */
  frames?: DeseretRevisionFrame[];
  /** On an issue: the QA summary feedback id (the signed conclusion event id) it was returned with. */
  revisionId?: string;
  /** On a QA summary: the issue ids returned with it, in the publisher's order. */
  issueIds?: string[];
};
export type DeseretIssueRole = "marketing" | "creative" | "publisher_qa";
/**
 * A frame image. Stored state keeps the canonical Deseret guidance manifest. The workspace projection keeps
 * only its display identity, transfer state and, when this account may read it, the native copy registered
 * in the issue's own task (`nativeVersionId`); storage profiles and object keys are not projected.
 */
export type DeseretFrameFile = Pick<HandoffMaterial, "id" | "version" | "name" | "mimeType" | "size"> &
  Partial<Omit<HandoffMaterial, "id" | "version" | "name" | "mimeType" | "size">> & { state?: string; nativeVersionId?: string };
export type DeseretRevisionFrame = { seconds: number; caption?: string; file: DeseretFrameFile };
export type DeseretStoryboardDraft = {
  languageTaskId: string;
  sceneId: string;
  fileVersionId: string;
  sceneVersion: number;
  duration: number;
};
export type DeseretIntegrationState = {
  storyboardDrafts?: DeseretStoryboardDraft[];
  stage: DeseretStage;
  intake: "pending" | "accepted" | "needsSupplement";
  revision: number;
  materials: "waiting_transfer" | "ready" | "failed";
  scenes: DeseretScene[];
  packages: DeseretReviewPackage[];
  feedback: DeseretFeedback[];
  authorFeedback: DeseretFeedback[];
  revisionSceneIds: string[];
  supplementNote?: string;
  deliveryLocked?: boolean;
};
/** Internal QC may replace only the scenes requested in the current publisher revision. */
export function storyboardRevisionScopeChanged(state: Pick<DeseretIntegrationState, "packages" | "revisionSceneIds" | "scenes">) {
  if (!state.revisionSceneIds.length) return false;
  const reviewed = state.packages.filter(pack => pack.phase === "storyboard" && !pack.withdrawn).at(-1);
  if (!reviewed || reviewed.scenes.length !== state.scenes.length) return true;
  const requested = new Set(state.revisionSceneIds);
  const current = new Map(state.scenes.map(scene => [scene.id, scene]));
  return reviewed.scenes.some(previous => {
    const scene = current.get(previous.id);
    return !scene || (!requested.has(scene.id) &&
      (previous.fileVersionId !== scene.fileVersionId || previous.version !== scene.version));
  });
}
export type DeseretFileCandidate = {
  id: string;
  name: string;
  languageTaskId: string;
  size: number;
  mimeType: string;
  sha256: string;
  qualityPassed: boolean;
  finalSubmission: boolean;
  storageReady: boolean;
};
export type DeseretWorkspace = Omit<DeseretIntegrationState, "storyboardDrafts"> & {
  storyboardDraftCount?: number;
  storyboardBatchEditing?: boolean;
  projectId: string;
  projectTitle: string;
  deseretProjectId: string;
  sourceRevision: string;
  submissionVersion: number;
  role: "lead" | "producer" | "qc";
  brief: Record<string, unknown>;
  materialManifest: (HandoffMaterial & { state: string; nativeVersionId?: string })[];
  tasks: { id: string; videoId: string; language: string; languageCode: string; status: string; editorEmail?: string; reviewerEmail?: string }[];
  fileCandidates: DeseretFileCandidate[];
  actions: ("intake.accept" | "intake.requestSupplement" | "scene.save" | "package.publish" | "package.withdraw" | "revision.assign" | "materials.retry" | "outbox.retry" | "archive.register" | "handover.verify")[];
  /** Internal only (never sent to Deseret): production archives of the tasks this account may continue. QC: none. */
  archives?: DeseretArchive[];
  handoverFiles?: DeseretHandoverFile[];
  /** Internal only: live formal versions this account may archive, by task. */
  archiveCandidates?: DeseretArchiveCandidate[];
  /** Internal only: Deseret editor handovers with the incoming editor's verification. */
  handovers?: DeseretTaskHandover[];
  /** Internal only, lead: the archive pinned to each published scene. */
  packageSources?: DeseretPackageSource[];
  transfers: { id: string; direction: string; packageId?: string; name: string; state: string; attempts: number; lastError?: string }[];
  outbox: { id: string; type: string; state: string; attempts: number; lastError?: string }[];
};

type ReviewHistory = Pick<DeseretIntegrationState, "scenes" | "packages" | "feedback" | "authorFeedback" | "revisionSceneIds">;

export function scopeDeseretReview(history: ReviewHistory, canRead: (taskId: string, fileVersionId: string) => boolean): ReviewHistory {
  const visibleScene = (scene: DeseretScene) => canRead(scene.languageTaskId, scene.fileVersionId);
  const scenes = history.scenes.filter(visibleScene);
  const packages = history.packages.flatMap(pack => {
    const scenes = pack.scenes.filter(visibleScene);
    const files = pack.files.filter(file => canRead(file.languageTaskId, file.fileVersionId));
    // Historical final packages can identify the reviewed cut by its file alone.
    const ids = new Set(scenes.flatMap(scene => scene.characterIds ?? []));
    return scenes.length || (pack.phase === "final" && files.length)
      ? [{ ...pack, scenes, files, ...(pack.characters ? {characters: pack.characters.filter(character => ids.has(character.id))} : {}) }] : [];
  });
  const packageScenes = new Map(packages.map(pack => [pack.id, new Set(pack.scenes.map(scene => scene.id))]));
  const visibleNote = (note: DeseretFeedback) => {
    const sceneIds = packageScenes.get(note.packageId);
    return sceneIds !== undefined && (!note.sceneId || sceneIds.has(note.sceneId));
  };
  const visibleIds = new Set([...scenes, ...packages.flatMap(pack => pack.scenes)].map(scene => scene.id));
  return {
    scenes, packages,
    feedback: history.feedback.filter(visibleNote),
    authorFeedback: history.authorFeedback.filter(visibleNote),
    revisionSceneIds: (history.revisionSceneIds ?? []).filter(id => visibleIds.has(id)),
  };
}

export function isStoryboardFileVersion(state: Pick<DeseretIntegrationState, "scenes" | "packages">, id: string) {
  return state.scenes.some(scene => scene.fileVersionId === id) ||
    state.packages.some(pack => pack.phase === "storyboard" && pack.files.some(file => file.fileVersionId === id));
}

/** One file version referenced by an internal production archive; `live` is recomputed whenever it is read. */
export type DeseretHandoverFile = DeseretArchiveFile & { taskId: string; size: number; kind: string; category: string; currentVersionId: string };
export type DeseretArchiveFile = { id: string; name: string; version: number; mimeType: string; live: boolean };
/**
 * Internal production archive of one language task: the engineering file version to continue from, an optional
 * preview, materials and next steps. Immutable and numbered per task. Stored only in AIGC; never sent to Deseret.
 */
export type DeseretArchive = {
  id: string; number: number; taskId: string; createdBy: string; createdAt: string;
  projectVersion: DeseretArchiveFile; preview?: DeseretArchiveFile; materials: DeseretArchiveFile[];
  nextSteps: string; valid: boolean; missing: string[];
};
/** Language task statuses in which internal archives cannot be registered. */
export const archiveClosedStatuses = ["待分配", "待补充资料", "已暂停", "已交付", "已归档", "已终止"];

export type DeseretArchiveCandidate = { id: string; name: string; version: number; taskId: string; kind: "project" | "video" | "material" };
export type DeseretTaskHandover = {
  id: string; taskId: string; kind: "planned" | "emergency" | "batch"; from: string; to: string; archiveId?: string;
  verification: "pending" | "verified" | "missing"; notes: string; verifiedAt?: string; createdAt: string;
};
export type DeseretPackageSource = { packageId: string; sceneId: string; sceneVersion: number; taskId: string; videoVersionId: string; archiveId: string; archiveNumber: number };
