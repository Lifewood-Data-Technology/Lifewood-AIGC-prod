import type { HandoffMaterial } from "./deseret-integration-contract";

export type DeseretStage = "intake" | "production" | "storyboard_review" | "revision" | "final_production" | "final_review" | "delivery" | "archived";
export type DeseretScene = {
  id: string;
  order: number;
  version: number;
  duration: number;
  script: string;
  characterIds: string[];
  voiceId: string;
  fileVersionId: string;
  languageTaskId: string;
};
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
export type DeseretIntegrationState = {
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
export type DeseretWorkspace = DeseretIntegrationState & {
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
  actions: ("intake.accept" | "intake.requestSupplement" | "scene.save" | "package.publish" | "package.withdraw" | "revision.assign" | "materials.retry" | "outbox.retry")[];
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
