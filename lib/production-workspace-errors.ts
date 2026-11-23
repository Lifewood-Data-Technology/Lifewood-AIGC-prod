import {legacyUploadMaxBytes,uploadSizeLabel} from "./upload-policy";

const uploadErrors: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/wasabi upload setup or status check timed out/i, "核对上传状态超时，请稍后查看原上传记录，或选择原文件续传。", "Checking the upload status timed out. Check the original upload later or select the original file to resume."],
  [/storage promotion timed out/i, "确认文件保存结果超时，请核对本次上传后再继续。", "Confirmation that the file was saved timed out. Check this upload before continuing."],
  [/storage connection interrupted|storage part not confirmed/i, "上传中断，请核对本次上传并续传。", "The upload was interrupted. Check and resume this upload."],
  [/storage checksum confirmation is unavailable|copy receipt missing with pending multipart/i, "文件保存结果待确认，请先核对本次上传。", "The file could not be confirmed as saved. Check this upload before continuing."],
  [/wasabi storage is not available/i, "文件暂不可用，请稍后重试。", "The file is temporarily unavailable. Try again later."],
  [/stored checksum mismatch|invalid upload part or checksum/i, "文件校验未通过，请核对原文件后重新上传。", "File verification failed. Check the original file before uploading it again."],
  [/refresh this page to use direct|direct transfers are not enabled/i, "请刷新页面后重试上传。", "Refresh the page and try the upload again."],
  [/direct transfer requires a bucket without native|invalid storage (?:header|transfer destination)/i, "暂时无法上传文件，请联系管理员。", "File uploads are temporarily unavailable. Contact an administrator."],
  [/legacy storage operation needs administrator reconciliation|stored upload ownership or size mismatch/i, "请联系管理员核对这次上传。", "Contact an administrator to check this upload."],
  [/storage operation is unconfirmed/i, "上传结果待确认，请先核对本次上传，再决定是否取消。", "Check the result of this upload before cancelling."],
  [/upload parts are missing|upload parts do not match/i, "文件未传完整，请选择原文件续传。", "The upload is incomplete. Select the original file to resume."],
];

export function uploadErrorForStaff(message: string, locale: "zh" | "en") {
  const match = uploadErrors.find(([pattern]) => pattern.test(message));
  return match?.[locale === "zh" ? 1 : 2];
}

/** Localise known failures without exposing raw database or storage errors. */
export function productionWorkspaceError(message: string, locale: "zh" | "en", maxBytes = legacyUploadMaxBytes) {
  const uploadError = uploadErrorForStaff(message, locale);
  if (uploadError) return uploadError;
  if (locale === "en") return message || "The operation could not be confirmed. Refresh to check.";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  const mappings: [RegExp,string][] = [
    [/a draft video is (?:no longer available|unavailable)/i,"这个分镜视频已不可用，请在草稿中重新选择任务视频。"],
    [/refresh the task before saving storyboard/i,"分镜草稿已更新，请刷新后核对待送列表。"],
    [/select a returned scene|only a returned scene/i,"请选择需要修改的分镜。"],
    [/choose the new video for this revision|upload the revised video/i,"请为这个分镜选择修改后的视频。"],
    [/choose a storyboard scene/i,"请选择要保存的分镜。"],
    [/select a video and enter its duration/i,"请选择分镜视频，并填写大于 0 且不超过 3600 秒的时长。"],
    [/video is already in the draft/i,"这个视频已经在待送列表中。"],
    [/confirm the storyboard drafts|save storyboard drafts and confirm|submit storyboard drafts together/i,"请先保存分镜草稿，再确认提交质检。"],
    [/use the storyboard workflow/i,"请从当前出版项目的分镜制作入口继续。"],
    [/accept the publisher brief/i,"请先受理出版社的制作资料，再分配人员。"],
    [/select the scene associated/i,"替换待审视频时，请选择该视频对应的原分镜。"],
    [/scene belongs to another/i,"请选择当前语言任务的分镜。"],
    [/register the scene|check the scene (?:script and )?duration/i,"请选择分镜视频并填写有效时长（0–3600 秒，不含 0），再提交质检。"],
    [/requested scene revisions require/i,"返修分镜须上传并关联新的文件版本。"],
    [/up to 200 scenes/i,"每个审阅包最多包含 200 个分镜。"],
    [/pending final changed/i,"待审成片或审核状态已变化，请刷新核对后重新提交。"],
    [/choose a new video to replace/i,"请选择新的成片文件，确认当前待审版本后再替换。"],
    [/reason for replacing/i,"请填写替换待审成片的原因。"],
    [/upload changed or is processing|upload processing changed/i,"上传状态已变化或仍在处理，请重新核对。"],
    [/no longer available to discard/i,"该暂存文件已无法丢弃（可能已正式提交、已过期或不属于你），请刷新核对文件状态。"],
    [/choose the original file/i,"请选择与原上传名称、大小和内容一致的文件，续传会沿用原上传记录。"],
    [/upload paused/i,"上传已暂停。未完成的上传仍保留，可在重新登录后核对或选择原文件续传。"],
    [/unfinished uploads could not be loaded/i,"未完成上传列表读取失败，请重新核对；原上传记录未被删除。"],
    [/file verification is busy/i,"文件核对名额正在使用中，请稍后核对同一上传，不要重新上传文件。"],
    [/this upload is (?:still )?processing/i,"原上传正在处理，请稍后核对同一记录，不要重复上传。"],
    [/your upload slots are occupied/i,"当前账号的上传名额被占用。请核对未完成上传，或等待正在进行的传输结束。"],
    [/site upload slots are occupied/i,"站点上传名额正在使用中，请等待其他传输结束后再试。"],
    [/temporary upload quota is full|too many retained uploads/i,"暂存配额或保留的上传记录已满，请核对或取消不再需要的上传，并等待清理。"],
    [/upload capacity changed/i,"上传名额状态已变化，请先核对未完成上传，再尝试原操作。"],
    [/upload capacity or account quota/i,"当前上传并发或暂存配额已满，请完成或核对原上传后重试。"],
    [/upload interrupted/i,"上传中断，请核对本次上传并续传。"],
    [/previous stages|reopen a completed stage/i,"请先完成前面的阶段；已完成阶段需重新打开后才能更新。"],
    [/current task production files/i,"请选择当前任务中可用的最新版制作文件，不可关联其他任务或素材库文件。"],
    [/temporary files to save as materials/i,"请先上传并选择要保存的暂存素材，再点击“确认保存素材”。"],
    [/work date|production stage/i,"请选择今天或过去的有效工作日期，并选择制作阶段。"],
    [/file must be 1 B|1 GB|1073741824|100 MB|104857600|too large/i,`单个文件不能超过 ${uploadSizeLabel(maxBytes)}，请选择符合大小限制的文件。`],
    [/category|categories/i,"请为每个文件确认分类；音频需选择配音或背景音乐。"],
    [/only one.*final/i,"一次只能指定一个成片视频，其他视频请选择“视频”分类。"],
    [/locked.*correction/i,"此检查点已锁定，请创建更正版本。"],
    [/checkpoint.*unavailable/i,"此检查点已不可用，请刷新后重新选择。"],
    [/changed|stale|identity mismatch/i,"记录已变化，请刷新核对后重新提交，原有文件不会被覆盖。"],
    [/reviewer|handover/i,"请先确认交接，并由项目负责人分配有效的质检员。"],
    [/work notes|progress percentage/i,"请填写工作说明和 0–100 的整数进度；日报不会自动提交质检。"],
    [/current production final|current production video|final video/i,"请选择当前任务中可用的最新版制作视频或成片；不支持旧版本、素材库或其他任务文件作为主成片。"],
    [/confirm.*materials/i,"请核对并勾选确认本版成片及关联资料。"],
    [/unavailable|not open|permission|access/i,"当前任务或文件不可用，可能已改派、撤销权限或进入下一阶段。请刷新核对。"],
    [/incomplete/i,"文件尚未完整上传，请核对上传结果。"],
    [/maximum 50/i,"一次最多选择 50 个文件，请减少本次选择。"],
    [/timeout|unconfirmed|aborted|fetch|network|result/i,"结果尚未确认。请保留当前表单，点击“刷新核对”或“核对本次提交结果”，不要重复新建提交。"],
  ];
  return mappings.find(([pattern])=>pattern.test(message))?.[1] || "操作未完成，请刷新核对任务状态和文件选择后重试。";
}
