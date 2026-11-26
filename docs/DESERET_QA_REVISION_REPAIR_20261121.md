# Deseret 成片 QA 返修接收修复（2026-11-21）

本修复针对出版社成片 QA 退回（`review.concluded` 带 `qaRevision`）在 AIGC 侧未被消费，以及已分配质检员无法读取 `02_客户素材` 中已登记附件的问题。它不改变角色权限、文件目录层级或 Deseret 侧行为。

## 行为

- **返修记录持久化**：成片 QA 退回时，AIGC 在同一事务内保存一条汇总记录（文字原因、时间点）和逐条问题记录。问题记录包含角色、镜头、镜头版本、起止时间及截图。每张截图登记一个从 Deseret 到 AIGC 的资料传输任务。汇总记录的 ID 等于事件 ID。未带 `qaRevision` 的旧事件按原逻辑处理。
- **校验与上限**：每次最多 100 条问题；每条问题最多 12 张截图；全部最多 256 张图；单张不超过 10 MiB；说明不超过 500 字。截图须为规范的指导图片清单。不合规返回 400 `DESERET_QA_REVISION_INVALID` 或 422 `DESERET_QA_REVISION_LIMIT`，且不写入任何内容。同一图片的身份发生变化时，返回 409 `DESERET_MEDIA_IDENTITY_CHANGED`。
- **重复投递幂等**：同一事件 ID、同一正文的重复投递返回已提交的同一回执。并发投递时晚到的那次也一样：处理失败时会按已存回执复核。同一事件 ID 但正文不同，返回 409 `DESERET_REPLAY_CONFLICT`。
- **失败可重试**：
  - 截图传输按其问题所属镜头的语言任务登记到该任务的 `02_客户素材`，不再登记到全部任务。
  - 暂时性失败按原退避自动重试。
  - 镜头未绑定任务时，标记为失败 `DESERET_FRAME_TASK_UNBOUND`；绑定后由负责人用原有“重试资料”恢复。
  - 传输未配置（`waiting_config`）时，返修记录照常保留。
- **可见范围**：项目负责人、该任务的剪辑师和质检员只能看到自己任务内的问题和截图。整页预览可显示截图时间及说明。
- **来源角色**：经过上述权限过滤后，每条退回问题标明提出它的 Deseret 角色。中文显示为“营销意见”“创意意见”“出版社 QA 意见”，英文显示为 Marketing issue、Creative issue、Publisher QA issue。以下记录保留原标签：
  - 退回汇总和普通出版社反馈，标签为“出版社意见”（Publisher feedback）；
  - 作者反馈，标签为“作者意见”（Author feedback）。截图只在传输就绪且可读后显示，不暴露对象 key 或存储配置。
- **质检读取 02 附件**：读取 Deseret 资料的原生副本时，质检员的可读判断改用与 `/api/files` 相同的 `qualityFileVisible` 规则，依据状态、来源和目录三项。因此，已分配任务 `02_客户素材` 中的附件对质检员可读。以下情况仍拒绝：
  - 未分配的任务；
  - 其他项目；
  - `03_项目制作` 中未送审的草稿。
- **资料复用**：资料登记只复用同一项目、同一任务的 `02_客户素材` 目录中同名、同 SHA-256、同大小的有效版本。文件或该目录已删除的不复用，已移出 02 的版本也不复用。`03` 中内容相同的草稿不会被复用，资料仍登记到 02。

## 启用顺序

1. 先部署本修复到 AIGC 并完成测试环境验证。
2. 在测试环境实测 Deseret 带图退回能被 AIGC 接收、可重复投递、截图对相应角色可见。
3. 之后才在 Deseret 启用 `Lifewood:AigcIntegration:FilmEvidenceEnabled`（默认 false），参见 Deseret `docs/aigc-service-contract.md`。

旧版 AIGC 已经接受过的带 `qaRevision` 的事件，其回执已完整记录在收件箱中。重新投递只会拿到原回执，不会补写返修记录。这类历史轮次需要单独核对处理。

## 测试

`pnpm test` 只使用内存 SQLite 和合成数据，不连接 MySQL、Wasabi 或 Deseret。覆盖范围：

- `tests/deseret-qa-revision-persistence.test.ts`：持久化、重放、原子拒绝、暂时失败后重试、旧事件、身份与范围冲突、按角色可见，以及并发重复投递的确定性交错。
- `tests/deseret-qa-revision-transfer.test.ts`：真实传输工作进程搭配伪存储。覆盖按任务登记、自动重试、未绑定失败后由负责人重试，以及传输未配置时保留记录。
- `tests/deseret-qc-material-read.test.ts`：质检员读取 02 附件，以及未分配任务、其他项目和 03 草稿的拒绝。
- `tests/deseret-material-reuse.test.ts`：资料复用限于同任务的 02。
- `tests/deseret-revision-source-render.test.ts`：在 jsdom 中渲染真实的制作面板。数据为真实服务按负责人、任务 1 剪辑师和另一任务质检员分别投影的工作区。中英文下逐条核对问题的来源标签，并确认普通反馈和作者反馈保留原标签。测试通过 `tests/support/tsx-load.mjs` 用项目自带的 TypeScript 转译 `.tsx`。

`registerIncoming` 的对象复制依赖真实存储，未做端到端测试。它使用的复用查询已直接测试。界面改动（截图时间、说明及来源标签）只有 jsdom 渲染测试，没有在本仓库做浏览器验收。

## 2026-11-24 成片审阅参考文件 / Final-film review references

本地联审版本。每条意见可包含 PNG、JPEG、MP4 或 MOV 参考文件，单个附件上限为 10 MiB。成片位置使用所审影片的时间。QA 退回时，AIGC 按原有 `issues[].frames[].file` 清单接收、校验和传输到对应语言任务。接收人员可预览图片、播放支持的视频或下载原文件。 既有截图按 PNG/JPEG MIME 类型识别，兼容没有扩展名或后缀不同的历史文件名。视频参考文件同时校验 MIME 类型和扩展名。

Locally verified. Final-film feedback supports PNG, JPEG, MP4 and MOV references up to 10 MiB per file. Each timestamp locates the issue in the reviewed film. When QA returns selected issues, the existing manifest and transfer path deliver attachments to their language tasks. Recipients can preview images, play supported video or download the original. Legacy PNG and JPEG screenshots retain their original file names, including missing or different extensions. Video references require matching MIME types and extensions.

## 出版社审阅与制作任务（2026-11-26，本地验证）

1. 项目负责人发布审阅包后，包内语言任务进入「待出版社审核」。当前 Deseret 交接指定一种制作语言。成片待质检或质检驳回时，负责人须等待当前版本质检通过后再发布。
2. 出版社退回后，相关任务进入「客户要求修改」，负责人在「出版社资料与审核」分派返修。
3. 分派后，原剪辑师打开自己的语言任务，查看出版社意见及已传输的截图，使用「提交返修成片送审」提交新版本。原质检员审核通过后，负责人可再次发布。成片获出版社批准后进入交付。

## Publisher review and production tasks (2026-11-26, verified locally)

1. When the project lead publishes a review package, its language tasks enter publisher review. Each Deseret handoff specifies one production language. If the current final is awaiting QC or has been rejected by QC, the lead must wait for QC approval before publishing.
2. A publisher return marks the affected tasks as requiring changes. The project lead assigns the revision in the publisher review panel.
3. The assigned editor opens the existing language task, reads the publisher feedback and transferred frames, and selects **Submit revised final for QC**. After internal QC passes, the lead can publish the new version. Publisher approval moves the final to delivery.
