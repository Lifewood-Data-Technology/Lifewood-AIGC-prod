"use client";
import { useEffect, useId, useRef, useState } from "react";
import { progressEditableStatuses } from "../lib/task-file-access";
import { workspaceFetch } from "../lib/tab-session";
import { isStoryboardFileVersion, scopeDeseretReview, type DeseretScene, type DeseretStage, type DeseretWorkspace } from "../lib/deseret-workspace";
import DeseretProducerBrief from "./DeseretProducerBrief";
import SelectControl from "./SelectControl";
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
    script: "Scene script",
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
    script: "分镜脚本",
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
  const [commandError, setCommandError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState("");
  const [finalFileVersionId, setFinalFileVersionId] = useState("");
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
    setCommandError(false);
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
    } catch {
      if (generation.current === current) setCommandError(true);
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
  return (
    <section className="deseret-production-panel">
      <header>
        <h3>{c.title}</h3>
        <span>
          {status(data.stage)} · {zh ? `资料第 ${data.submissionVersion} 版` : `Brief version ${data.submissionVersion}`}
        </span>
      </header>
      {commandError && <p role="alert">{zh ? "操作尚未确认，请核对当前状态后重试。" : "The action was not confirmed. Check the current status and retry."}</p>}
      <dl className="deseret-production-facts">
        {(data.role === "lead" || data.intake !== "accepted") && <div><dt>{c.intake}</dt><dd>{status(data.intake)}</dd></div>}
        <div><dt>{c.materials}</dt><dd>{data.materialManifest.length ? status(data.materials) : zh ? "本版无附件" : "No attachments in this version"}</dd></div>
      </dl>
      {data.supplementNote && <blockquote>{data.supplementNote}</blockquote>}
      <DeseretProducerBrief brief={data.brief} files={data.materialManifest} locale={locale} />
      {data.role === "lead" && (
        <>
          {can("intake.requestSupplement") && (
            <details className="deseret-supplement">
              <summary>{c.supplement}</summary>
              <label>{c.note}
                <textarea rows={2} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} />
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
              <p className="deseret-production-script">{scene.script}</p>
              <small>{scene.duration}s</small>
            </article>
          ))}
        </section>
      )}
      {can("package.publish") && (
        <section className="pm-detail-card">
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
              reason={publishReason}
              onClick={() =>
                void command(
                  "package.publish",
                  phase === "final"
                    ? {
                        phase,
                        fileVersionId: finalFileVersionId,
                        duration: Number(finalDuration),
                      }
                    : { phase },
                ).catch(() => {})
              }
            />
          </div>
        </section>
      )}
      {[...history.feedback, ...history.authorFeedback].map((record) => (
        <blockquote key={record.id}>
          <strong>
            {record.type === "author.feedback" ? c.author : c.feedback}
          </strong>
          <FeedbackLocation record={record} packages={history.packages} locale={locale} />
          <p>{record.body}</p>
          {record.targets?.length ? (
            <p>
              {record.targets
                .map((target) =>
                  target === "script"
                    ? c.script
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
                  {kind === "pronunciation"
                    ? locale === "zh"
                      ? "发音修正"
                      : "Pronunciation correction"
                    : c.script}
                </strong>
                <br />
                {value}
              </p>
            ))}
          {record.files?.map((file) => (
            <p key={`${file.id}:${file.version}`}>{file.name}</p>
          ))}
          {record.seconds !== undefined && <small>{record.seconds}s</small>}
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
  const [script, setScript] = useState("");
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
  else if (!script.trim()) reason = zh ? "请填写分镜脚本。" : "Enter the scene script.";
  else if (!(Number(duration) > 0 && Number(duration) <= 3600)) reason = zh ? "请输入 0 至 3600 秒之间的有效时长。" : "Enter a duration greater than zero and up to 3600 seconds.";
  function selectScene(id: string) {
    setSceneId(id);
    const scene = data.scenes.find((item) => item.id === id);
    setScript(scene?.script || "");
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
      script,
      characterIds: existing?.characterIds ?? [],
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
        <label className="deseret-scene-script">
          {c.script}
          <textarea
            rows={4}
            maxLength={20000}
            required
            value={script}
            onChange={(event) => setScript(event.target.value)}
          />
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
