# Deseret 分镜不再填写脚本（2026-11-21）

用户已确认：Deseret 项目的分镜去掉脚本填写。新分镜只需要视频和时长即可送审。制作脚本本来就只留在 AIGC 内部，见[发布不外发制作脚本](DESERET_SCRIPT_CONFIDENTIALITY_20261121.md)。

本轮为本地修改，未提交、未推送、未部署。

## 改了什么

**两个入口都不再要求脚本，也不再显示脚本框：**

- **原生送审窗口**（制作人员“上传分镜送审”）：去掉“分镜脚本”文本框。只校验分镜视频、时长（大于 0、不超过 3600 秒）和资料核对勾选。
- **Deseret 制作面板的“编辑分镜资料”**（也嵌在原生质检窗口里）：去掉脚本框，以及“请填写分镜脚本”的提示和示例文字。只校验视频版本和时长。

**提交说明：**

- 分镜制作阶段的 Deseret 分镜送审（新建、编辑、返修）不再要求“本次提交说明”。界面显示为“本次提交说明（选填）”。
- 替换待审视频仍须填写“替换原因 \*”。
- 成片送审、工作日报、检查点以及普通（非 Deseret）任务，备注要求都不变。
- 服务端以本次送审事务中的分镜登记结果判断能否省略备注，前端不能决定。该结果来自 `deseretSceneSubmission().storyboard`，它的项目修订号守卫和整个送审一同提交。如果送审期间阶段变了，写入会失败，因此成片不可能带着空备注通过。

**提示文字：**

- 服务端错误改为“Check the scene duration.” / “Register the scene video and duration before submitting for review.”。
- 中文提示改为“请选择分镜视频并填写有效时长（0–3600 秒，不含 0），再提交质检。”。旧版本的英文报错也映射到这条新提示。

**规则不变：**

- 分镜身份、视频必须是本人任务中已登记的视频版本、语言任务范围、版本冲突检查、200 个分镜上限、角色校验。
- 返修分镜必须换新视频版本，包括旧客户端只改了脚本的情况。
- 替换待审视频必须选原分镜，并填写原因。
- 质检、发布门禁、交付锁定。

## 历史脚本与兼容

**已存脚本不删除，仍是 AIGC 内部资料：**

- 历史分镜、已发布审阅包和成片包里的脚本都保留。
- 制作面板的分镜卡片仍会显示已有的历史脚本，没有脚本的分镜不显示空块。

**编辑或返修已有分镜时：**

- 不带脚本，或脚本为空白：沿用原脚本的原始字节。
- 只重新保存未改动的分镜：版本不变。
- 换视频或改时长：照常产生新版本。

**旧客户端仍可能显式发送 `script`，保持原有语义：**

- 改了真实脚本文字：照常产生新版本，不会在同一版本里静默改写。
- 完全相同的重投：版本不变。
- 带前后空白的旧文本，两个入口各自沿用原来的处理：
  - **Deseret 制作面板 `scene.save`**：旧版本原样保存，现在也按原始字节保存和比较。与已存文字完全相同（含空白）的重投不升版。
  - **原生送审入口**：旧版本去掉首尾空白后保存，现在仍先 trim 再保存和比较。
  - 两个入口都只用 trim 判断是否为空白。
- 格式错误（不是字符串，或超过 20000 字符）：仍然拒绝。

**成片拼接：**

- 发布成片时，只拼接已存的非空白分镜脚本，用空行分隔，并保留各自原文字节，结果存为成片包的内部记录。
- 所有分镜都没有脚本时，成片镜头没有 `script` 键，不会生成空串或 `undefined`。

**不外发：** 无论脚本来自历史数据还是旧客户端，都不会发给 Deseret，`review.published` 仍然不含 `narration`/`script`。

**本地草稿（浏览器）：**

- 旧版本保存的草稿里可能有 `sceneDraft.script`。打开表单时只恢复分镜 ID、版本和时长，脚本不进入表单，也不随新提交发送。
- 这段文字按原字节保留在原本地草稿中：打开表单、修改时长都不会覆盖它。只有脚本的旧草稿也不会因为“空草稿”而被自动删除。
- 直到送审成功，或用户点“清空本次草稿”，这段文字才随草稿一起移除。
- 切换到其他任务或表单时会重置这段文字，不会带进别的草稿。
- 未确认的旧请求（`pending`）仍按原始字节重新核对提交，以保证幂等。

**普通任务不受影响：** 普通任务的“脚本制作”流程阶段、日报中的“脚本与策划”阶段、`03.script` 文件夹，以及质检清单里的通用条目都保持不变。Deseret 反馈中出版社标注的“脚本”返修目标仍按原样显示。

## 测试

只用内存 SQLite、jsdom、合成数据，不接真实服务。

- `tests/deseret-scene-without-script.test.ts`：
  - 面板 `scene.save` 和原生 `deseretSceneSubmission`：新建、编辑、返修；历史脚本沿用；旧客户端空白、改文和相同重投；面板带空白旧文本按原字节、原生入口按原有 trim；格式错误、时长、身份、版本、任务范围、替换等负例；返修未换视频仍被拒绝（含只改脚本）。
  - 送审备注规则及服务端的分镜阶段来源。
  - 分镜包和成片包的脚本：成片只拼接已存脚本，并按原字节拼接。
  - 中文错误提示。
- `tests/deseret-scene-without-script-render.test.ts`：
  - 真实 `DeseretProductionPanel`（中、英），命令经由真实集成服务执行。
  - 真实 `ProductionWorkspace`：无脚本框；无备注即可送审；时长仍然必填；替换仍须填写原因；旧草稿脚本只在本地保留到提交或清空，不串到其他任务；旧的未确认请求按原字节重发。

**仍需人工验收：** 原生送审入口的服务端整体流程 `submitProductionWorkspace` 依赖 MySQL 和 Wasabi，本轮测试没有端到端执行它。它的备注判断复用了上面两项已测部件（`deseretSceneSubmission` 和 `submissionNoteRequired`），但仍需要在隔离环境中做一次真实送审验收。

## English summary

Deseret scenes are now submitted with a video and a duration only. Neither the native submission dialog nor the Deseret production panel's scene editor (also shown in the native QC window) asks for, clears or validates a script, and the "enter the scene script" prompts are gone.

A storyboard-round scene submission needs no submission note. Replacing a pending video still requires its reason. Finals, daily reports, checkpoints and ordinary tasks keep their note. The server decides this from the in-transaction, revision-guarded scene registration.

Stored scripts remain internal AIGC data:

- Editing a scene without a script keeps the stored bytes.
- An older client's explicit script keeps the original semantics: changed text means a new version and an identical resend does not. The panel's `scene.save` stores and compares the text byte for byte, as it always has. The native entry still trims it first, as it always has. Blankness is judged with trim on both.
- Malformed scripts are still rejected.
- A requested revision still needs a new video version.
- The final package joins only the stored, non-blank scripts, byte for byte, and has no `script` key when no scene has one.
- Nothing script-related is sent to Deseret.

An older browser draft's `sceneDraft.script` stays in that local draft until it is submitted or cleared. It is never shown or sent, and it is not carried into another task's draft. Unconfirmed earlier requests are still re-sent byte for byte.

Not covered end to end here: the full native `submitProductionWorkspace` path, which needs MySQL and Wasabi. Its note decision reuses the tested parts and still needs an isolated live check.
