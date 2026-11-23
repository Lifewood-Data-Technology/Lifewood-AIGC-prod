import type { DeseretStage } from "./deseret-workspace";

const stages: Record<DeseretStage, [string, string]> = {
  intake: ["制作准备", "Production preparation"],
  production: ["分镜制作", "Scene production"],
  storyboard_review: ["出版社审核分镜", "Publisher scene review"],
  revision: ["等待项目负责人分派返修。", "Waiting for the project lead to assign revisions."],
  final_production: ["成片制作", "Final production"],
  final_review: ["出版社审核成片", "Publisher final review"],
  delivery: ["交付", "Delivery"],
  archived: ["已归档", "Archived"],
};

export function editorStageLabel(stage: string | undefined, locale: "zh" | "en") {
  const labels = stage && Object.hasOwn(stages, stage) ? stages[stage as DeseretStage] : undefined;
  return labels?.[locale === "zh" ? 0 : 1] ?? (locale === "zh" ? "阶段待核对" : "Stage unavailable");
}

export type EditorProductionPhase = {stage: string; intake?: string; materials?: string};

export function isDeseretSubmissionOpen(phase?: EditorProductionPhase) {
  if (!phase || (phase.intake !== undefined && phase.intake !== "accepted") ||
      (phase.materials !== undefined && phase.materials !== "ready")) return false;
  return phase.stage === "production" || phase.stage === "final_production";
}

export function editorUploadLabel(stage: string | undefined, locale: "zh" | "en", replacing = false) {
  if (stage === "production") return locale === "zh" ? "分镜工作区" : "Storyboard workspace";
  if (stage === "final_production") return locale === "zh" ? (replacing ? "替换待审成片" : "上传成片送审") : (replacing ? "Replace pending final" : "Submit final for QC");
  return locale === "zh" ? "提交制作视频" : "Submit production video";
}

/**
 * Whether a production submission needs its note. A Deseret scene submitted for internal QC in the storyboard
 * round needs only its video and duration; replacing a pending video still needs its reason, and assembled
 * finals, daily reports and ordinary tasks keep their note. The server decides `storyboard` from the scene
 * registration that joins the submission transaction; the client mirrors it for the button state.
 */
export function submissionNoteRequired(input: { mode: string; storyboard: boolean; replacing: boolean }) {
  if (input.mode === "materials") return false;
  return !(input.mode === "final" && input.storyboard && !input.replacing);
}
