"use client";
import { useEffect, useId, useRef, useState } from "react";
import { progressEditableStatuses } from "../lib/task-file-access";
import { workspaceFetch } from "../lib/tab-session";
import { isStoryboardFileVersion, scopeDeseretReview, type DeseretScene, type DeseretStage, type DeseretWorkspace } from "../lib/deseret-workspace";
import { approvedSceneCharacters } from "../lib/deseret-producer-brief";
import DeseretProducerBrief, { DeseretBriefFiles } from "./DeseretProducerBrief";
import SelectControl from "./SelectControl";
import DeseretArchivePanel, { usableArchives } from "./DeseretArchivePanel";
import { openProductionWorkspace } from "./ProductionWorkspace";
import { MenuIcon } from "./MenuIcon";
import { LogIcon } from "./AdminLogControls";

const copy = {
  en: {
    title: "Deseret Book",
    loading: "Loading production handoff…",
    error:
      "The production handoff could not be loaded. Check access and retry.",
    retry: "Retry",
    intake: "Intake",
    materials: "Publisher attachments",
    accept: "Accept project",
    supplement: "Request additional information",
    note: "Review note",
    assign: "Assign revisions",
    scenes: "Scenes",
    add: "Save scene",
    duration: "Duration in seconds",
    file: "Production file version",
    choose: "Select a file version",
    language: "Language task",
    scene: "Scene",
    qc: "Quality passed",
    pendingQc: "Awaiting quality approval",
    publish: "Publish for publisher review",
    withdraw: "Withdraw package",
    storyboard: "Storyboard",
    final: "Final video",
    feedback: "Publisher feedback",
    author: "Author feedback",
    issueSource: { marketing: "Marketing issue", creative: "Creative issue", publisher_qa: "Publisher QA issue" } as Record<string, string>,
    history: "Published packages",
    delivery: "Delivery",
    empty: "No production files are registered yet.",
    intakeStage: "Production preparation",
    production: "Scene production",
    storyboard_review: "Publisher storyboard review",
    revision: "Revision",
    final_production: "Final production",
    final_review: "Publisher final review",
    archived: "Archived",
    pending: "Pending",
    accepted: "Accepted",
    needsSupplement: "Additional information required",
    waiting_transfer: "Awaiting attachments",
    ready: "Received",
    failed: "Some attachments are unavailable",
    reviewed: "Reviewed",
    revision_requested: "Final revision requested",
    approved: "Approved",
  },
  zh: {
    title: "Deseret Book",
    loading: "正在读取制作交接…",
    error: "暂时无法读取制作交接，请检查权限后重试。",
    retry: "重试",
    intake: "项目受理",
    materials: "出版社附件",
    accept: "接受项目",
    supplement: "要求补充资料",
    note: "审核说明",
    assign: "分派返修",
    scenes: "分镜",
    add: "保存分镜",
    duration: "时长（秒）",
    file: "制作文件版本",
    choose: "选择文件版本",
    language: "语言任务",
    scene: "分镜",
    qc: "质检通过",
    pendingQc: "待质检确认",
    publish: "发布给出版社审核",
    withdraw: "撤回审阅包",
    storyboard: "分镜",
    final: "完整影片",
    feedback: "出版社意见",
    author: "作者意见",
    issueSource: { marketing: "营销意见", creative: "创意意见", publisher_qa: "出版社 QA 意见" } as Record<string, string>,
    history: "已发布审阅包",
    delivery: "交付",
    empty: "尚未登记制作文件。",
    intakeStage: "制作准备",
    production: "分镜制作",
    storyboard_review: "出版社分镜审核",
    revision: "返修",
    final_production: "成片制作",
    final_review: "出版社成片审核",
    archived: "已归档",
    pending: "待处理",
    accepted: "已接受",
    needsSupplement: "待补充资料",
    waiting_transfer: "等待附件到齐",
    ready: "已收到",
    failed: "有附件暂不可用",
    reviewed: "已阅",
    revision_requested: "已要求成片返修",
    approved: "已批准",
  },
};
type Action = DeseretWorkspace["actions"][number];
type Command = (
  action: Action,
  payload: Record<string, unknown>,
) => Promise<void>;

function ActionButton({
  label,
  icon = "parameters",
  busy,
  reason,
  onClick,
}: {
  label: string;
  icon?: string;
  busy: boolean;
  reason?: string;
  onClick: () => void;
}) {
  const reasonId = useId();
  return (
    <div className="deseret-action">
    <button
      type="button"
      className="primary-button"
      disabled={busy || Boolean(reason)}
      aria-busy={busy || undefined}
      aria-describedby={reason ? reasonId : undefined}
      onClick={onClick}
    >
      <MenuIcon name={icon} />
      {label}
    </button>
    {reason && <small id={reasonId}>{reason}</small>}
    </div>
  );
}

type ProductionPanelProps = {
  projectId: string;
  locale: "en" | "zh";
  taskId?: string;
  onIntakeChange?: (intake: DeseretWorkspace["intake"]) => void;
  onStageChange?: (stage: DeseretStage | undefined) => void;
};

export default function DeseretProductionPanel(props: ProductionPanelProps) {
  return (
    <DeseretProductionState
      key={`${props.projectId}:${props.taskId || ""}:${props.locale}`}
      {...props}
    />
  );
}

function DeseretProductionState({
  projectId,
  locale,
  taskId,
  onIntakeChange,
  onStageChange,
}: ProductionPanelProps) {
  const c = copy[locale];
  const [data, setData] = useState<DeseretWorkspace>();
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState(false);
  const [commandError, setCommandError] = useState<"unknown" | "character" | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState("");
  const [finalFileVersionId, setFinalFileVersionId] = useState("");
  // The lead's explicit per-scene archive confirmations (keyed by round, scene, version and video), and the
  // per-task archive offered by "apply to all scenes of this task".
  const [archiveChoice, setArchiveChoice] = useState<Record<string, string>>({});
  const [taskApply, setTaskApply] = useState<Record<string, string>>({});
  const [finalDuration, setFinalDuration] = useState("");
  const intake = data?.intake;
  const stage = data?.stage;
  useEffect(() => {
    if (intake) onIntakeChange?.(intake);
  }, [intake, onIntakeChange]);
  useEffect(() => {
    onStageChange?.(stage);
  }, [stage, onStageChange]);
  const generation = useRef(0);
  const pendingRequest = useRef<
    | {
        signature: string;
        input: {
          requestId: string;
          expectedRevision: number;
          action: Action;
          payload: Record<string, unknown>;
        };
      }
    | undefined
  >(undefined);
  const endpoint = `/api/deseret-book?${new URLSearchParams({ project: projectId })}`;
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let reading = false;
    let notIntegrated = false;
    async function read() {
      if (reading || notIntegrated) return;
      reading = true;
      try {
        const response = await workspaceFetch(endpoint, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (generation.current !== current) return;
        if (response.status === 404) {
          notIntegrated = true;
          setUnavailable(true);
          setData(undefined);
          return;
        }
        if (!response.ok) throw new Error("Unavailable");
        const result: DeseretWorkspace = await response.json();
        if (generation.current === current) {
          setData((previous) =>
            previous && previous.revision > result.revision ? previous : result,
          );
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted && generation.current === current) {
          setError(true);
          setData(undefined);
        }
      } finally {
        reading = false;
      }
    }
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      generation.current += 1;
      controller.abort();
      clearInterval(timer);
    };
  }, [endpoint, reload]);
  async function command(action: Action, payload: Record<string, unknown>) {
    if (!data || busy) return;
    const current = generation.current;
    const signature = JSON.stringify({ projectId, action, payload });
    if (pendingRequest.current?.signature !== signature)
      pendingRequest.current = {
        signature,
        input: {
          requestId: crypto.randomUUID(),
          expectedRevision: data.revision,
          action,
          payload: structuredClone(payload),
        },
      };
    setBusy(true);
    setCommandError(null);
    try {
      const response = await workspaceFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pendingRequest.current.input),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setData(undefined);
          setError(true);
        }
        if (response.status === 422) {
          const failure = await response.json().catch(() => ({}));
          if (failure.code === "DESERET_SCENE_CHARACTER_INVALID") throw new Error("Invalid scene character");
        }
        if (response.status === 409) {
          const failure: { code?: string } = await response
            .json()
            .catch(() => ({}));
          if (failure.code === "DESERET_CONFLICT") {
            pendingRequest.current = undefined;
            setReload((value) => value + 1);
          }
        }
        throw new Error("Unconfirmed");
      }
      const result: DeseretWorkspace = await response.json();
      if (generation.current === current) {
        setData((previous) =>
          previous && previous.revision > result.revision ? previous : result,
        );
        pendingRequest.current = undefined;
        setNote("");
      }
    } catch (error) {
      if (generation.current === current) setCommandError(error instanceof Error && error.message === "Invalid scene character" ? "character" : "unknown");
      throw new Error("Unconfirmed");
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }
  if (unavailable || !projectId) return null;
  if (!data && !error) return <p className="deseret-loading" aria-live="polite">{c.loading}</p>;
  if (!data)
    return (
      <section className="deseret-production-panel" role="alert">
        <p>{c.error}</p>
        <button
          type="button"
          className="secondary-button"
          onClick={() => setReload((value) => value + 1)}
        >
          <LogIcon name="refresh" />
          {c.retry}
        </button>
      </section>
    );
  const can = (action: Action) => data.actions.includes(action);
  const zh = locale === "zh";
  const phase =
    data.stage === "final_production" ||
    (data.stage === "revision" && data.packages.at(-1)?.phase === "final")
      ? "final"
      : "storyboard";
  const status = (value: DeseretStage | DeseretWorkspace["intake"] | DeseretWorkspace["materials"]) =>
    value === "intake" ? c.intakeStage : c[value];
  const finalFiles = data.fileCandidates.filter(file =>
    file.finalSubmission === true && file.mimeType.startsWith("video/") &&
    file.qualityPassed && file.storageReady && !isStoryboardFileVersion(data, file.id),
  );
  const latestFinal = finalFiles.find(file => file.id === finalFileVersionId);
  const history = taskId ? scopeDeseretReview(data, id => id === taskId) : data;
  const visibleScenes = history.scenes;
  const editableSceneSource = data.fileCandidates.some(file =>
    file.storageReady && file.mimeType.startsWith("video/") && (!taskId || file.languageTaskId === taskId),
  );
  const validDuration = Number(finalDuration) > 0 && Number(finalDuration) <= 14400;
  const unapprovedScenes = data.scenes.filter(scene => !data.fileCandidates.some(file => file.id === scene.fileVersionId && file.qualityPassed && file.storageReady));
  const publishReason = phase === "final"
    ? (!latestFinal || !validDuration ? (zh ? "请选择质检通过的成片并填写时长。" : "Select a quality-approved final video and enter its duration.") : "")
    : !data.scenes.length
      ? (zh ? "等待剪辑师登记分镜，并由质检员审核分镜视频。" : "Awaiting a registered scene and internal approval of its video.")
      : unapprovedScenes.length
        ? (zh ? `尚有 ${unapprovedScenes.length} 个分镜缺少就绪且通过质检的视频版本。` : `${unapprovedScenes.length} scene(s) still need a ready, quality-approved video version.`)
        : "";
  // Publication gate: the lead explicitly confirms an internal archive for every scene (video) of the round. A
  // confirmation is keyed by round, scene, version and video, so a new round, video or version needs a new one;
  // nothing is applied without the lead's action. One archive may be applied to all scenes of a task at once.
  const taskLabel = (task: string) => data.tasks.find(item => item.id === task)?.language ?? task;
  const finalVersion = (task: string) => 1 + data.packages.filter(pack => pack.phase === "final" && pack.files.some(file => file.languageTaskId === task)).length;
  const roundScenes = phase === "final"
    ? (latestFinal ? [{ id: `final-${latestFinal.languageTaskId}`, languageTaskId: latestFinal.languageTaskId, version: finalVersion(latestFinal.languageTaskId), fileVersionId: latestFinal.id, label: c.final }] : [])
    : data.scenes.map(scene => ({ id: scene.id, languageTaskId: scene.languageTaskId, version: scene.version, fileVersionId: scene.fileVersionId, label: `${c.scene} ${scene.order}` }));
  type RoundScene = (typeof roundScenes)[number];
  const roundTasks = [...new Set(roundScenes.map(scene => scene.languageTaskId))];
  // The round: this project and source revision, the phase, and how many packages of that phase were already
  // published. A published round ends its confirmations, so a returned round asks again even for unchanged videos.
  const round = `${projectId}|${data.sourceRevision}|${phase}|${data.packages.filter(pack => pack.phase === phase).length}`;
  const confirmKey = (scene: RoundScene) => `${round}|${scene.id}|${scene.version}|${scene.fileVersionId}`;
  const confirmedArchive = (scene: RoundScene) => usableArchives(data, scene.languageTaskId).find(archive => archive.id === archiveChoice[confirmKey(scene)]);
  const archiveGaps = roundTasks.filter(task => !usableArchives(data, task).length).map(taskLabel);
  const unconfirmed = roundScenes.filter(scene => usableArchives(data, scene.languageTaskId).length && !confirmedArchive(scene));
  const gateReason = publishReason || (archiveGaps.length ? `${zh ? "缺少有效内部留档：" : "Internal archive missing: "}${archiveGaps.join(", ")}`
    : unconfirmed.length ? `${zh ? "请确认以下镜头的内部留档：" : "Confirm the internal archive for: "}${unconfirmed.map(scene => scene.label).join(", ")}` : "");
  const sources = Object.fromEntries(roundScenes.map(scene => [scene.id, { archiveId: confirmedArchive(scene)?.id ?? "", sceneVersion: scene.version, videoVersionId: scene.fileVersionId }]));
  const videoName = (scene: RoundScene) => data.fileCandidates.find(file => file.id === scene.fileVersionId)?.name ?? scene.fileVersionId;
  const archiveOptions = (task: string) => usableArchives(data, task).map(archive =>
    <option key={archive.id} value={archive.id}>#{archive.number} · {archive.projectVersion.name} v{archive.projectVersion.version}</option>);
  return (
    <section className="deseret-production-panel" data-role={data.role}>
      <header className="deseret-project-heading">
        <h3><MenuIcon name="projects" />{c.title}</h3>
        <span>
          {status(data.stage)} · {zh ? `资料第 ${data.submissionVersion} 版` : `Brief version ${data.submissionVersion}`}
        </span>
      </header>
      {commandError && <p role="alert">{commandError === "character"
        ? (zh ? "镜头中的人物与已批准资料不一致。请重新选择出场人物并保存镜头。" : "The scene cast differs from the approved brief. Select the characters again and save the scene.")
        : (zh ? "操作尚未确认，请核对当前状态后重试。" : "The action was not confirmed. Check the current status and retry.")}</p>}
      <dl className="deseret-production-facts">
        {(data.role === "lead" || data.intake !== "accepted") && <div data-status={data.intake}><dt>{c.intake}</dt><dd>{status(data.intake)}</dd></div>}
        <div data-status={data.materials}><dt>{c.materials}</dt><dd>{data.materialManifest.length ? status(data.materials) : zh ? "本版无附件" : "No attachments in this version"}</dd></div>
      </dl>
      {data.supplementNote && <blockquote>{data.supplementNote}</blockquote>}
      <div className="deseret-brief-layout">
      <DeseretProducerBrief brief={data.brief} files={data.materialManifest} locale={locale} leadView={data.role === "lead"} />
      <div className="deseret-work-items">
      {data.role === "lead" && (
        <>
          {can("intake.requestSupplement") && (
            <details className="deseret-supplement">
              <summary>{c.supplement}</summary>
              <label>{c.note}
                <textarea rows={2} maxLength={2000} placeholder={zh ? "例如，请补充封底原图，保留完整的书脊和边缘。" : "For example, please send the original back cover with the spine and edges visible."} value={note} onChange={event => setNote(event.target.value)} />
              </label>
              <ActionButton label={c.supplement} busy={busy} reason={!note.trim() ? (zh ? "请填写需要出版社补充的资料。" : "Specify what the publisher needs to provide.") : undefined}
                onClick={() => void command("intake.requestSupplement", { note }).catch(() => {})} />
            </details>
          )}
          {(can("intake.accept") || can("revision.assign")) && <div className="deseret-production-actions">
            {can("intake.accept") && (
              <ActionButton
                label={c.accept}
                busy={busy}
                onClick={() =>
                  void command("intake.accept", {}).catch(() => {})
                }
              />
            )}
            {can("revision.assign") && (
              <ActionButton
                label={c.assign}
                busy={busy}
                onClick={() =>
                  void command("revision.assign", {}).catch(() => {})
                }
              />
            )}
          </div>}
        </>
      )}
      {can("scene.save") && (visibleScenes.length > 0 || editableSceneSource) && (!taskId || data.tasks.some(task => task.id === taskId && progressEditableStatuses.includes(task.status))) &&
        !(
          data.stage === "revision" && data.packages.at(-1)?.phase === "final"
        ) && (
          <SceneEditor
            key={`${projectId}:${phase}:${taskId || ""}`}
            data={data}
            taskId={taskId}
            locale={locale}
            busy={busy}
            command={command}
          />
        )}
      {visibleScenes.length > 0 && (
        <section>
          <h4>{c.scenes}</h4>
          {visibleScenes.map((scene) => (
            <article className="deseret-production-scene" key={scene.id}>
              <strong>
                {c.scene} {scene.order} · v{scene.version}
              </strong>
              {/* A historical script stays visible inside AIGC; new scenes have none. */}
              {scene.script ? <p className="deseret-production-script">{scene.script}</p> : null}
              <small>{scene.duration}s</small>
            </article>
          ))}
        </section>
      )}
      {data.role !== "qc" && data.archives && (
        <DeseretArchivePanel data={data} taskId={taskId} locale={locale} busy={busy} command={command}
          onUpload={task => openProductionWorkspace(task, "materials", undefined, undefined, undefined, { archive: true })} />
      )}
      {can("package.publish") && (
        <section className="pm-detail-card">
          {roundTasks.map(task => (
            <fieldset key={task} className="deseret-archive-gate">
              <legend>{zh ? "内部留档" : "Internal archive"} · {taskLabel(task)}</legend>
              <div data-task-apply={task}>
                <SelectControl locale={locale} name={`apply-archive-${task}`} value={taskApply[task] ?? ""} onChange={event => setTaskApply({ ...taskApply, [task]: event.target.value })}>
                  <option value="">{zh ? "选择留档" : "Choose an archive"}</option>
                  {archiveOptions(task)}
                </SelectControl>
                <button type="button" disabled={busy || !usableArchives(data, task).some(archive => archive.id === taskApply[task])}
                  onClick={() => setArchiveChoice({ ...archiveChoice, ...Object.fromEntries(roundScenes.filter(scene => scene.languageTaskId === task).map(scene => [confirmKey(scene), taskApply[task]])) })}>
                  {zh ? "应用到本任务全部镜头" : "Apply to all scenes of this task"}
                </button>
              </div>
              {roundScenes.filter(scene => scene.languageTaskId === task).map(scene => (
                <label key={scene.id} data-scene-confirm={scene.id}>{scene.label} · v{scene.version} · {videoName(scene)}
                  <SelectControl locale={locale} name={`confirm-archive-${scene.id}`} value={confirmedArchive(scene)?.id ?? ""} onChange={event => setArchiveChoice({ ...archiveChoice, [confirmKey(scene)]: event.target.value })}>
                    <option value="">{zh ? "请确认留档" : "Confirm an archive"}</option>
                    {archiveOptions(task)}
                  </SelectControl>
                </label>
              ))}
            </fieldset>
          ))}
          {phase === "final" && (
            <>
              <label>
                {c.file}
                <SelectControl
                  locale={locale}
                  value={finalFileVersionId}
                  onChange={(event) =>
                    setFinalFileVersionId(event.target.value)
                  }
                >
                  <option value="">{c.choose}</option>
                  {finalFiles.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.name}
                      </option>
                    ))}
                </SelectControl>
              </label>
              <label>
                {c.duration}
                <input
                  type="number"
                  min="0.01"
                  max="14400"
                  step="0.01"
                  value={finalDuration}
                  onChange={(event) => setFinalDuration(event.target.value)}
                />
              </label>
            </>
          )}
          <div className="deseret-production-actions">
            <ActionButton
              label={`${c.publish} · ${phase === "final" ? c.final : c.storyboard}`}
              icon="previews"
              busy={busy}
              reason={gateReason}
              onClick={() =>
                void command(
                  "package.publish",
                  phase === "final"
                    ? {
                        phase,
                        fileVersionId: finalFileVersionId,
                        duration: Number(finalDuration),
                        sources,
                      }
                    : { phase, sources },
                ).catch(() => {})
              }
            />
          </div>
        </section>
      )}
      {[...history.feedback, ...history.authorFeedback].map((record) => (
        <blockquote key={record.id}>
          {/* Final QA return issues name the reviewer role that raised them; other records keep their labels. */}
          {record.type !== "author.feedback" && record.role && c.issueSource[record.role] ? (
            <strong data-source-role={record.role}>{c.issueSource[record.role]}</strong>
          ) : (
            <strong>
              {record.type === "author.feedback" ? c.author : c.feedback}
            </strong>
          )}
          <FeedbackLocation record={record} packages={history.packages} locale={locale} />
          <p>{record.body}</p>
          {record.processing && (
            <div className="deseret-production-script">
              <strong>{zh ? "出版社 QA 处理说明" : "Publisher QA note"}</strong>
              <p>{record.processing.decision === "revision_requested" ? (zh ? "要求返修" : "Revision requested") : c.reviewed}
                {" · "}<time dateTime={record.processing.processedAt}>{new Date(record.processing.processedAt).toLocaleString(zh ? "zh-CN" : "en-US")}</time>
              </p>
              {record.processing.note !== record.body && <p>{record.processing.note}</p>}
            </div>
          )}
          {record.targets?.length ? (
            <p>
              {record.targets
                .map((target) =>
                  target === "script"
                    ? (zh ? "脚本" : "Script")
                    : target === "voice"
                      ? locale === "zh"
                        ? "声音"
                        : "Voice"
                      : target === "visuals"
                        ? locale === "zh"
                          ? "画面"
                          : "Visuals"
                        : target === "timing"
                          ? locale === "zh"
                            ? "节奏"
                            : "Timing"
                          : target,
                )
                .join(" · ")}
            </p>
          ) : null}
          {Object.entries(record.corrections || {})
            .filter(([, value]) => value.trim())
            .map(([kind, value]) => (
              <p className="deseret-production-script" key={kind}>
                <strong>
                  {({
                    text: zh ? "替换后的台词" : "Requested wording",
                    pronunciation: zh ? "发音修正" : "Pronunciation correction",
                    en: zh ? "英文修正" : "English wording",
                    zh: zh ? "中文修正" : "Chinese wording",
                    extra: zh ? "补充说明" : "Additional instructions",
                  } as Record<string, string>)[kind] ?? kind}
                </strong>
                <br />
                {value}
              </p>
            ))}
          {!!record.files?.length && <DeseretBriefFiles files={record.files} visible locale={locale} />}
          {record.seconds !== undefined && <small>{record.endSeconds !== undefined ? `${record.seconds}s–${record.endSeconds}s` : `${record.seconds}s`}</small>}
          {record.frames?.map((frame, index) => (
            <div key={`${frame.file.id}:${index}`} className="deseret-revision-frame">
              <small>{zh ? "截图时间" : "Frame at"} {frame.seconds}s{frame.caption ? ` · ${frame.caption}` : ""}</small>
              <DeseretBriefFiles files={[frame.file]} visible locale={locale} />
            </div>
          ))}
        </blockquote>
      ))}
      {history.packages.length > 0 && (
        <details>
          <summary>{c.history}</summary>
          {history.packages.map((pack) => (
            <article key={pack.id} className="deseret-production-scene">
              <strong>
                {pack.phase === "final" ? c.final : c.storyboard} · v
                {pack.version}
              </strong>
              <span>
                {pack.conclusion === "approved"
                  ? c.approved
                  : pack.conclusion === "revision"
                    ? c.revision
                    : ""}
              </span>
              {can("package.withdraw") && !pack.withdrawn && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() =>
                    void command("package.withdraw", {
                      packageId: pack.id,
                    }).catch(() => {})
                  }
                >
                  {c.withdraw}
                </button>
              )}
            </article>
          ))}
        </details>
      )}
      </div>
      </div>
    </section>
  );
}

function FeedbackLocation({ record, packages, locale }: {
  record: DeseretWorkspace["feedback"][number];
  packages: DeseretWorkspace["packages"];
  locale: "en" | "zh";
}) {
  const pack = packages.find(item => item.id === record.packageId);
  if (!pack) return null;
  const scene = pack.scenes.find(item => item.id === record.sceneId);
  const phase = pack.phase === "final" ? copy[locale].final : copy[locale].storyboard;
  return <p>
    {`${phase} · v${pack.version}`}
    {scene && ` · ${copy[locale].scene} ${scene.order} · ${locale === "zh" ? "镜头版本" : "Scene version"} v${scene.version}`}
  </p>;
}

function SceneEditor({
  data,
  taskId,
  locale,
  busy,
  command,
}: {
  data: DeseretWorkspace;
  taskId?: string;
  locale: "en" | "zh";
  busy: boolean;
  command: Command;
}) {
  const c = copy[locale];
  const [sceneId, setSceneId] = useState("");
  const [characterIds, setCharacterIds] = useState<string[]>([]);
  const characters = approvedSceneCharacters(data.brief);
  const [duration, setDuration] = useState("");
  const [fileVersionId, setFileVersionId] = useState("");
  const editableTaskIds = new Set(data.tasks.filter(task => progressEditableStatuses.includes(task.status)).map(task => task.id));
  const files = data.fileCandidates.filter(
    (file) => file.storageReady && file.mimeType.startsWith("video/") && editableTaskIds.has(file.languageTaskId) && (!taskId || file.languageTaskId === taskId),
  );
  const selectedFileAvailable = files.some(file => file.id === fileVersionId);
  const reasonId = useId();
  const zh = locale === "zh";
  let reason = "";
  if (!fileVersionId && !files.length) reason = zh ? "提交分镜视频后，可在这里修改已登记的分镜。" : "Submit a scene video to edit its registered scene here.";
  else if (!selectedFileAvailable) reason = zh ? "请选择可用的视频版本。" : "Choose an available video version.";
  else if (!(Number(duration) > 0 && Number(duration) <= 3600)) reason = zh ? "请输入 0 至 3600 秒之间的有效时长。" : "Enter a duration greater than zero and up to 3600 seconds.";
  function selectScene(id: string) {
    setSceneId(id);
    const scene = data.scenes.find((item) => item.id === id);
    setCharacterIds((scene?.characterIds ?? []).filter(id => characters.some(character => character.id === id)));
    setDuration(scene ? String(scene.duration) : "");
    setFileVersionId(scene?.fileVersionId || "");
  }
  async function submit() {
    const file = files.find((item) => item.id === fileVersionId);
    if (!file || reason || busy) return;
    const existing = data.scenes.find((item) => item.id === sceneId);
    const scene: DeseretScene = {
      id: existing?.id || crypto.randomUUID(),
      order: existing?.order ?? Math.max(0, ...data.scenes.map(scene => scene.order)) + 1,
      version: existing?.version ?? 1,
      duration: Number(duration),
      characterIds,
      voiceId: existing?.voiceId ?? "",
      fileVersionId,
      languageTaskId: file.languageTaskId,
    };
    await command("scene.save", { scene });
    setSceneId(scene.id);
  }
  return (
    <details className="deseret-scene-details">
      <summary>{zh ? "编辑分镜资料" : "Edit scene details"}</summary>
    <form
      className="deseret-scene-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit().catch(() => {});
      }}
    >
      <fieldset disabled={busy}>
        <label>
          {c.scene}
          <SelectControl
            locale={locale}
            value={sceneId}
            onChange={(event) => selectScene(event.target.value)}
          >
            <option value="">{locale === "zh" ? "新增分镜" : "New scene"}</option>
            {data.scenes
              .filter((scene) => !taskId || scene.languageTaskId === taskId)
              .map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {c.scene} {scene.order}
                </option>
              ))}
          </SelectControl>
        </label>
        <label>
          {c.duration}
          <input
            type="number"
            min="0.01"
            max="3600"
            step="0.01"
            required
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
          />
        </label>
        {characters.length > 0 && <fieldset className="deseret-scene-cast">
          <legend>{zh ? "出场人物" : "Characters in this scene"}</legend>
          {characters.map(character => <label key={character.id}>
            <input type="checkbox" checked={characterIds.includes(character.id)}
              onChange={event => setCharacterIds(event.target.checked ? [...characterIds, character.id] : characterIds.filter(id => id !== character.id))} />
            {character.name}
          </label>)}
        </fieldset>}
        <label>
          {c.file}
          <SelectControl
            locale={locale}
            value={fileVersionId}
            onChange={(event) => setFileVersionId(event.target.value)}
          >
            <option value="">{c.choose}</option>
            {files.map((file) => (
              <option key={file.id} value={file.id}>
                {file.name} · {file.qualityPassed ? c.qc : c.pendingQc}
              </option>
            ))}
          </SelectControl>
        </label>

        <button
          type="submit"
          className="primary-button"
          disabled={busy || Boolean(reason)}
          aria-busy={busy || undefined}
          aria-describedby={reason ? reasonId : undefined}
        >
          {c.add}
        </button>
        {reason && <p id={reasonId} role="status">{reason}</p>}
      </fieldset>
    </form>
    </details>
  );
}
