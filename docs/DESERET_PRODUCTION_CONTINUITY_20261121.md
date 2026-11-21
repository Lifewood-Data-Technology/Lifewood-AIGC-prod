# Deseret 内部制作留档、发布绑定与接手核验（2026-11-21）

用户已确认实施。硬约束：工作日报整体保持原状，不强制填写、上传或关联，不改字段、开放时段、入口和旧数据。内部资料、内部文件名、路径、链接、日志和留档信息只保存在 AIGC，不进入 Deseret 仓库、出版社 API、文件传输任务、首次或重投事件，以及历史回放。

本文是**现行说明**。[设计稿](superpowers/specs/2026-11-21-deseret-production-continuity-design.md)和[实施计划](superpowers/plans/2026-11-21-deseret-production-continuity.md)是实施前的历史记录，其中的简写和接口签名已有部分过期，以本文为准。

本轮是本地候选：未提交、未推送、未部署，也未连接真实 Wasabi。

## 功能

### 内部留档

只用于 Deseret 任务，与日报无关。

- 每次登记生成一个不可变的编号，在任务内递增。
- 内容包括：
  - 一个必选的工程文件：本任务分类为“工程文件”的正式版本，必须实际位于 `03.project`；
  - 可选的预览视频、本任务的素材版本和下一步说明（最多 4000 字）。
- 登记入口有两个：
  - Deseret 制作面板的“内部留档”：选择本任务已保存的文件；
  - 原生工作区的“上传工程并留档”：沿用既有的暂存和正式确认上传，在同一事务中保存文件并登记留档。分镜或成片送审窗口中有快捷入口。
- 原生留档表单可混选新暂存的文件与本任务已有权限读取的正式版本。关闭并重开草稿后，可以继续使用原先选择的工程和预览版本。
- 谁可以登记：
  - 剪辑师可为自己的任务登记，只能选择按 `productionReadableVersionQuery` 自己本来就能读取的版本。登记本身不会带来新的读取权限，因此前任未进入日报、送审或留档的草稿不会出现在这个登记选项中。接手资料的只读入口见下方交接规则。
  - 项目负责人可为本项目的任何任务登记，沿用项目权限。
- 何时可以登记：质检中和出版社审阅期间都可以；已暂停、已交付、已归档、已终止、待分配、待补充资料的任务不可以。
- 工程文件按真实目录判断：
  - 已存版本以数据库中的真实目录为准，表单不能把其他文件改成工程文件。表单只列出符合条件的工程文件。
  - 新暂存的文件按实际写入的目录判断，并保留原有的类型校验。
  - 两个入口都会在写事务中复核：所选工程版本仍在 `03.project`，所有文件仍有效，剪辑师仍可读取。表单加载后文件被移走或失效的，不会登记成功。
- 不接受暂存中、已删除、其他任务或素材库的文件。
- 有效性在每次读取时重新计算：
  - 引用的版本失效后，留档标为失效，并列出缺失文件；
  - 历史上工程文件不在 `03.project` 的错误绑定，同样视为无效。

### 发布门禁

负责人发布整轮分镜或成片时：

- **每个镜头（即每个视频）都要明确确认一份留档**，系统不会自动套用最新的留档。可以用“应用到本任务全部镜头”一键复用同一份留档，也可以逐镜选择；同一任务的不同镜头可以使用不同的工程文件。
- 确认只在当前这一轮有效。范围包括：本项目、来源修订、阶段、该阶段已发布的包数、镜头、镜头版本和视频。以下情况都需要重新确认：
  - 镜头换了视频或版本；
  - 本轮发布完成；
  - 整轮被退回后进入新一轮，即使新一轮的视频与上一轮完全相同，也要明确确认复用。

  同一轮内未改动的镜头会保留已有的确认。
- 服务端只接受 `{ archiveId, sceneVersion, videoVersionId }` 形式的确认，并与当前镜头核对；不一致时返回 `DESERET_ARCHIVE_CONFIRMATION_STALE`。成片的 `sceneVersion` 与服务端的算法一致：该语言此前的成片包数（含已撤回的）加 1。
- 以下情况不能发布：
  - 缺少留档，或留档失效：错误提示会列出具体的语言任务；
  - 任务有待确认的交接；
  - 接手人已登记“缺项”，而所选留档早于该交接。
- 再次改派后，之前报告的缺项仍然有效。发布事务会核对该任务历次缺项交接的时间，拒绝早于其中任意一次的留档。
- 负责人可以在发布处直接为缺项任务登记留档。
- 发布时逐镜头写入绑定，与发布在同一事务中原子提交，事务内会复核留档文件仍然有效，且工程文件仍在 `03.project`。版本固定，之后再登记的留档不会改写旧包。历史包不补造绑定。

### 交接

只用于 Deseret 项目的剪辑师调动。

- **计划交接**：
  - 没有完整检查点时，可以用本任务的一份有效留档代替。日报仍然可选。
  - 只选择一次，按 ID 写入那一份留档；写事务中会复核这份留档仍然有效。不会出现检查的是 A、写入的却是 B 或为空的情况。
- **负责人批量换剪辑师**：
  - 只选取转出人本人在本任务的最新有效检查点，并在事务中复核。
  - 不会选中或冻结其他人的日报。
- **核验记录**：计划交接、应急交接、批量换人都会记录一条交接核验，状态为“待核验”，同样只选择一次留档（可以为空），并在事务中复核。
- **接手人核验**：接手人在面板中自行登记“可以续作”，或者“缺项”并填写说明。人员安排和接手核验是两个独立的结果。
- **应急缺件**：接手人可以继续在内部补做、送质检；在补登更新的留档之前，不能对外发布。
- 纯质检员调动、首次分配和普通项目都保持原状。

接手剪辑师可以在任务素材和交接页直接打开本语言任务已经正式保存的文件，包括任务的客户资料、前任的制作文件及其历史版本。系统根据当前剪辑师和最近一次剪辑师变更识别接手人，支持原有调动记录。交接准备完成并切换剪辑师后即可读取，以便接手人实际核对。取消交接或再改派后，撤销此次交接授予的读取权限。

项目通用的出版社素材沿用本任务已登记的副本。其他语言里的文件仅在本版本被明确设为本项目现行素材标准，或该任务已有这个版本的素材关联时，才会出现在交接资料中。项目受理附件和素材库继续通过原有入口读取。接手无需逐份重选附件；正式留档仍固定工程和素材的准确版本。新增权限仅限 AIGC 内部读取。

接手人可以从交接记录打开固定的留档，按文件版本下载工程、预览或素材。支持在线预览的格式另有预览入口。文件失效时显示缺失，存储直连不可用时会停止传输。

### 权限

- 任务的现任剪辑师可以读取本任务所有留档引用的版本，因此链式换人（甲→乙→丙）后，丙能拿到甲和乙的留档。
- 前任剪辑师失去读取权限，其他任务的剪辑师和质检员也不会因留档获得读取权限。
- 质检员的工作区不包含任何留档、交接或绑定信息。

### 审核期的上传恢复

- 未完成上传列表接受 `archive` 用途，按该用途授权，并且只列出该用途的上传。其他用途的白名单不变。
- 留档表单按 `archive` 用途列出未完成上传；全局列表的“返回原表单”会打开留档表单。
- 留档正式提交后如未收到响应，从同任务的日报或成片入口也会找回原请求，按原提交编号核对。
- 旧式上传的状态核对，按暂存文件本身的用途取权。

### 删除保护

留档引用的版本不能删除，与日报和送审材料的保护相同。

## 持久结构

新增迁移 `0010-deseret-production-archives.sql`，共四张内部表：

| 表 | 内容 |
|---|---|
| `deseret_production_archives` | 留档本身，任务内唯一的编号 |
| `deseret_archive_files` | 留档引用的文件版本及其角色 |
| `deseret_package_sources` | 包与镜头对应的留档，同一包内每个镜头唯一 |
| `deseret_task_handovers` | 交接核验记录 |

文件引用单独成表，不存成 JSON，所有读取规则和删除保护都用普通连接。

同步修改的位置：

- 迁移清单与当前版本：`scripts/mysql/migrations.mjs`
- 版本结构校验：`scripts/mysql/verify-schema.mjs`
- 结构契约：`db/mysql/schema-contract.json`
- 项目永久删除：`db/business-deletion.ts`
- 演示清理的保留表和空闲检查：`operations/demo-cleanup.ts`
- 删除保护：`db/file-deletion-guard.ts`，以及 `db/backend.ts` 中的正式文件检查
- 部署说明：`docs/PRODUCTION_OPERATIONS_20261118.md`

初始化脚本按迁移历史校验，不需要额外修改。已有安装执行 `scripts/mysql-migrate.mjs` 即可新增这四张表，不改写现有数据。

## 外发隔离

- 留档、绑定和核验只写入上述四张表，不写入 `state_json`。
- 对外事件由既有白名单逐字段构造，传输任务只包含发布视频的清单。
- 回归测试在留档的下一步和文件名中放入合成保密标记，并检查以下各处都不包含该标记、留档 ID 或相关字段名：
  - 发布后的物料传输任务；
  - 生成的 `review.published`；
  - 实际发出的正文；
  - 负责人重投后的再次发送；
  - `state_json`。

## 验证

### 本地离线回归（本仓）

只使用内存 SQLite、jsdom 和合成数据；最终结果为 137/137。

- `tests/deseret-archive-schema.test.ts`：迁移、契约、版本校验、删除与清理登记之间一致；留档版本的删除保护。
- `tests/deseret-production-archive.test.ts`：
  - 登记与拒绝的各种来源；读取权限（含写事务复核）；
  - 真实目录（含目录变化的负例和历史错误绑定）；
  - 失效显示；链式换人读取；
  - 服务端动作与开放时段；质检不可见；
  - 发布门禁：缺项任务、失效留档、待确认交接、缺项后须用新的留档，以及过期的逐镜确认；
  - 版本固定；
  - 外发与传输队列隔离，含重投；
  - 交接记录与核验；计划交接按 ID 选用留档及其复核；批量换人的检查点。
- `tests/deseret-archive-render.test.ts`：真实面板加真实服务。覆盖：
  - 剪辑师登记，质检不可见；
  - 逐镜确认与一键应用；
  - 换视频后须重新确认；
  - 跨轮时完全相同的视频仍须明确复用；
  - 接手人登记缺项。
- `tests/deseret-archive-upload-render.test.ts`：真实原生工作区。覆盖：
  - 快捷入口；
  - 待质检期间上传并留档；
  - 工程文件选项只列真实工程文件；
  - 未完成上传按 `archive` 用途列出。
- `tests/deseret-archive-recovery.test.ts`：未完成上传列表的用途过滤与授权；“返回原表单”的映射。
- 上一轮已有的发布测试改为先登记留档并逐镜确认，脚本相关的断言不变。

### 左屏独立验收（最终候选）

以下为左屏会话独立执行的结果，本文作者没有复跑。

- **离线回归**：137/137 通过。
- **隔离的本地 MySQL 8.0.28**（模拟对象存储，不是真实 Wasabi）：
  - 0010 迁移与结构校验；
  - 正式登记与复用；
  - 审核期的上传恢复；
  - 批量换人，以及并发变更时整笔回滚；
  - 计划交接的留档在提交前失效时整笔回滚；
  - 应急交接；
  - 零附件日报。
- **Chrome 浏览器**（英文桌面，以及中文窄屏）：逐镜绑定、跨轮重新选择、上传恢复。

### 仍未覆盖

- 未连接真实 Wasabi，所以：
  - 原生上传并留档、上传恢复，在真实对象存储上没有端到端执行；
  - 对象存储相关的结论只来自模拟存储。
- 未部署，没有在生产或 Test 站点上验证。
- 迁移 0010 只在隔离的本地 MySQL 8.0.28 上执行过，没有在任何既有安装上执行。

## 实施过程记录

交叉审核后，在首个候选的基础上做了以下修正。上面的“功能”各节已经是修正后的规则。

1. **读取权限**：剪辑师的候选和登记都复用 `productionReadableVersionQuery`，写事务内复核。
2. **真实目录**：已存版本按真实目录判断；两个入口都在写事务中复核工程版本仍在 `03.project`；历史上的错误绑定视为无效。
3. **逐镜确认**：取代首个候选中“按任务、默认选最新”的做法；确认只在当前一轮有效，跨轮须重新确认。
4. **审核期的上传恢复**：列表、用途过滤、返回原表单、旧式状态核对。
5. **批量换剪辑师**：只取转出人本人的有效检查点，并在事务中复核。
6. **计划交接**：按 ID 选用留档，并在写事务中复核。

## English summary

This document is the current description. The design and plan are historical records.

**Archives.**
- Each Deseret task gets immutable, numbered internal production archives: one engineering file version that must actually be in `03.project`, plus an optional preview, materials and next steps.
- They are independent of daily reports, which are unchanged.
- Editors archive only versions `productionReadableVersionQuery` lets them read; registering never grants access. The lead keeps project access.
- Saved versions are judged by their real folder. Both registration paths re-check the engineering version's folder, liveness and readability inside the write transaction.
- Registration stays open through internal QC and publisher review.

The native archive form accepts a mix of new uploads and authorized saved versions. Drafts retain the engineering and preview selections. Opening another form for the same task recovers an unconfirmed submission under its original request ID.

**Publishing.**
- Publishing a storyboard or final round requires the lead's explicit archive confirmation for every scene (video). Nothing is applied automatically; "apply to all scenes of this task" is an explicit action.
- A confirmation holds only for the current round, scene version and video. A new round asks again even for an identical video.
- The server checks `{ archiveId, sceneVersion, videoVersionId }`. For finals, `sceneVersion` is earlier final packages for the language, withdrawn ones included, plus one.
- Pinned sources are written atomically and are version-fixed.

**Handovers (Deseret editor changes only).**
- A planned handover may use an archive instead of a daily report. That archive is chosen once by ID and re-checked in the transaction.
- A batch editor change takes only the outgoing editor's own valid checkpoint, re-checked in the transaction.
- Every editor handover records a separate verification by the incoming editor.
- After an emergency handover with missing work, the editor can continue internally, but publication waits for a newer archive.
- Reviewer-only changes and ordinary projects are unchanged.

A later reassignment preserves the cutoff from earlier handovers marked missing. The incoming editor can open the pinned archive and access its exact versions through authorized direct downloads or supported previews.

**Isolation.** Archives, pinned sources and verifications live only in four AIGC tables (migration 0010). They never reach publisher events, transfer tasks, integration state or resends.

**Verification.**
- Offline here: 137/137.
- Independently by the left-screen session (not rerun by this author):
  - 137/137;
  - isolated local MySQL 8.0.28 with simulated object storage: migration 0010 and schema checks, registration and reuse, upload recovery during review, batch and concurrent-change rollback, planned-handover source-invalidation rollback, emergency handover, zero-attachment daily report;
  - Chrome, English desktop and Chinese narrow: per-scene binding, cross-round re-selection, upload recovery.
- Not done: real Wasabi, and any deployment.
