# 永久删除单个视频或语言版本

项目负责人可以在项目详情中，永久删除单个视频或单个语言版本。实现复用项目永久删除模型（`db/business-deletion.ts`），原有的“终止语言版本”功能保留。

## 规则

- **入口。** 视频和语言版本各有单独入口：视频标题栏的“永久删除视频…”，语言行的“永久删除…”。只有项目负责人可见。
- **默认范围。** 只删除所选范围独占的内容。共享内容列出来，可以筛选；原件只要仍被其他对象引用，就绝不销毁。
- **不向上删除。** 删除最后一个语言版本后，视频保留；删除最后一个视频后，项目保留。创建时要求至少一个语言版本，只是创建规则，删除时不会强制删除父级。
- 不做跨范围的真实销毁。

## 复用的项目删除机制

以下机制与项目删除完全一致：

- 服务端授权：按所属项目的负责人与 `projects.manage` 权限判断；
- 影响预检与计划哈希；
- 名称二次确认：语言版本为“视频名 · 语言”，视频为视频名；
- 修订号；
- 同一提交编号可幂等重放，共享项的选择也是提交凭据的一部分；
- 加锁、失败可续删、中断可恢复；
- 存储对象先逐个清理，最后统一删除记录；
- 审计日志。

## 删除与保留

**独占内容**随所选范围一起删除。语言版本的独占内容包括：

- 任务本身及其目录；
- 正式文件的各版本及独占的存储对象；
- 日报、送审、质检记录；
- 制作流程、暂存文件、交接、分配记录；
- 本范围的分享链接、通知、名称翻译。

视频还包括视频行、视频目录，以及其下的全部语言版本。

**父项目不删除，也不标记为已删除。** 删除完成后会重算项目汇总。如果项目已没有任何语言版本：

- 项目上不再显示已删除任务的剪辑师和质检员；
- 状态回到“待分配”（已归档的项目除外），可以继续添加视频和语言版本。

新增视频的编号取现有最大 `VID-n` 加一，并跳过已占用的编号，`VID-999` 之后为 `VID-1000`。删除中间的视频后，新视频不会撞号。

**共享内容**的原件都不删除：

| 类型 | 处理 | 是否可选 |
|---|---|---|
| 本范围对其他范围原件的关联（如本语言日报引用了兄弟语言的文件） | 勾选：清理这条关联；不勾选：在原件的文件历史中留下可追溯记录（`business.deleted_scope_reference_retained`）。原件和其他引用都保留。不选、部分选、全选都可以提交。 | 可选 |
| 本范围的文件，且只被同项目的另一个语言使用 | 文件连同全部版本、封面、存储对象和其他引用一起保留，移交给使用它的语言（放入对应目录），并写入文件历史（`business.moved_from_deleted_scope`）。被删语言对该文件的旧分享链接及访问会话，会在移交的同一事务中撤销，其他文件的分享不受影响。 | 必要，不提供复选框 |
| 与其他文件共用的存储对象 | 保留，列在“保留的共享存储对象”中 | 仅说明 |

**只对确实无法安全解除关联的项单独阻止**，并在界面逐项说明原因，不会建议删除整个项目：

- 文件被多个范围、其他项目、素材集合或项目级标准使用（`SHARED_FILE_UNASSIGNABLE`）；
- 移交目标自身正在被删除；
- 共享项超过 200 项（`SHARED_ITEMS_TOO_MANY`）。

## 保护

以下情况会阻止删除：

- **已交付或已归档的历史**，包括：
  - 所属项目已交付或已归档；
  - 该语言已交付或已归档；
  - 存在交付记录、已交付的文件，或发布记录。
- **Deseret 对接项目中被对接引用的视频或语言**，包括：
  - 在 `native_video_ids` 或 `native_task_ids` 中；
  - 出现在对接状态（场景、包、文件等）中；
  - 有内部留档、包来源或交接核验；
  - 有登记进来的出版社素材。

  对接记录结构无法解析时，一律拒绝。AIGC 后来自建、从未与对接关联的视频和语言版本，可以单独删除。
- **未结束的上传**，按以下任一方式判定属于本范围：
  - 任务、目录；
  - 已保存的 `language:` 或 `video:` 范围；
  - 自动封面上传所指向的具体版本或暂存上传。
- **共享目录**：目录与其他客户、项目、视频或语言共享，或属于素材库。语言目录自带所属视频的 ID，这是正常结构，不算共享。

## 并发与锁

删除期间锁定的范围：

- **视频或语言删除**只锁自己的 `video:`、`language:`、版本、文件，以及全部候选存储对象（含保留的）。
- 开始删除时，会在同一事务中复核，但不锁定：
  - 父项目和客户没有正在进行的删除；
  - 移交目标的语言或视频没有正在删除，其目录仍然存在。
- 移交文件的临时锁，在移交的同一事务中释放；删除完成时，还会再释放残留的锁。
- **项目或客户删除**会同时锁定其下所有视频和语言。因此，同一棵树上的删除不会同时进行，即使下级没有任何文件也是如此。
- **共用存储对象的两个删除**会被串行处理。后一个删除重新核对时，会发现自己是最后一个引用，由它清理该对象，且只清理一次。

请求入口 `runtime/business-lifecycle-request.ts`：

- 按视频 ID、分享令牌、交付、发布、文件、目录、任务找到所属的语言和视频范围。
- 写请求如果指向视频或项目，还会带上其下的语言和视频范围。因此，在下级删除待完成或待重试期间，按视频新增语言、修改项目截止日期这类批量改写都会被拒绝。
- 读请求不受影响，兄弟语言的日常制作照常进行。
- 删除完成后，原 ID 留有墓碑记录，之后的请求一律拒绝。

## 界面

- 删除对话框中的文字随目标而定：“随此视频删除”“随此语言版本删除”。预检时会醒目说明保留的内容：所属视频、项目及其他视频或语言版本。
- “共享内容”一节：
  - 可按“全部 / 可选关联 / 必要移交”筛选；
  - 可选关联逐项勾选；
  - 必要移交只作说明。
- 项目列表和项目详情的“视频与语言版本”工具栏中，有“核对视频删除”“核对语言版本删除”两个入口。它们根据浏览器保存的提交凭据工作，即使对应行已经消失，刷新后仍能核对结果；完成后只刷新数据，不跳转页面。

## 测试

只使用合成数据。项目删除用的是按 `db/mysql/schema-contract.json` 生成的完整内存 SQLite 表结构（`tests/support/contract-database.ts`）。

- **`tests/business-subitem-deletion.test.ts`**，覆盖：
  - 项目删除特征回归；
  - 语言和视频的删除与保留，以及不向上删除；
  - 幂等与过期预检；
  - 各项保护；
  - 共享关联的不选、部分选、全选；
  - 必要移交，包括封面、分享撤销、锁的释放；
  - 请求入口的拦截；
  - 父子删除与共用存储对象的串行化；
  - 移交目标正在删除的两种先后顺序；
  - Deseret 中被对接引用与未引用的子项；
  - 空项目汇总与视频编号。
- **`tests/business-subitem-delete-dialog.test.ts`**：真实对话框的共享内容筛选、复选，以及提交的选择。

## 验收证据

2026-11-21 在独立副本上验收，全部使用合成账号、文件和项目。 最终组合版本通过 175 项自动化测试、TypeScript、ESLint 和生产构建。构建保留动态导入与代码包大小提示。

- 使用本机临时 MySQL 8.0.28 执行迁移 0001 至 0010，并核对数据库结构。通过项目负责人的实际业务入口删除已终止的语言、整条视频和最后一条视频，核对父项目及其他语言，并验证普通剪辑师不能发起删除。
- 在两条共享关联中分别选择零条、一条和两条。三种情况下两份原文件均保留，对应历史关联数为二、一和零。模拟对象存储记录实际请求的键，核对并发删除最后一份引用时恰好清理一次。
- 通过故障注入验证清理失败后重试、过期预检、父子删除互斥。通过原生添加视频接口验证删除中间视频后仍可添加替代视频，原有视频编号保留。
- 在 Chrome 的中文桌面和英文窄屏中，从项目详情打开两个删除入口。实测取消、输入名称、选择部分共享项与刷新后核对丢失响应的回执。
- 正式账号、出版社服务及真实 Wasabi 均未用于验收。存储清理使用测试替身，本机 MySQL 验证结束后已关闭。

## English summary

Project owners can permanently delete one video or one language version. This reuses the project permanent-deletion model.

**What goes and what stays.**
- Only the selected scope's exclusive content is deleted.
- The parent stays even when its last child is deleted. An empty project shows no removed people and reopens as awaiting assignment.
- New video codes never collide after a deletion.
- Shared originals are never destroyed:
  - Optional links to originals owned elsewhere can be ticked (cleaned up) or left (kept as history on the original).
  - A file used by exactly one other language is handed over to it, with its cover. The deleted language's old shares of it are revoked.
  - Only items that cannot be unlinked safely block, each with its reason. The whole project is never suggested instead.

**Protections.**
- Protected history.
- Deseret items the integration references; unlinked AIGC-added items can be deleted.
- Unfinished uploads, including automatic covers.
- Shared folders.

**Concurrency.** Deletions in one tree, deletions sharing a stored object, and hand-overs to a language under deletion are serialized or refused. The request gate refuses writes into a pending or deleted video or language through any reference.

**Interface.** Wording follows the target. Recovery entries for saved video and language receipts work even after the rows are gone.
