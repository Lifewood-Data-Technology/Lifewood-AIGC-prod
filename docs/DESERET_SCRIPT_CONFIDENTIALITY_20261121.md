# Deseret 发布不外发制作脚本（2026-11-21）

用户已确认：制作脚本只留在 AIGC 内部。分镜和成片发布都不得把脚本正文发给 Deseret。AIGC 与 Deseret 已就此对齐最终契约。

## 根因与范围

- 脚本只有一条外发途径：负责人发布审阅包后，`reconcile()` 在文件就绪时生成 `review.published` 事件，把每个镜头的 `scene.script` 写进 `narration.en`。成片镜头带的是该语言任务各分镜脚本的合并文本。
- 事件整体写入 `deseret_outbox.body_json`，之后由 `outboxTick()` → `deliver()` 原样发出。以下几种重投都发送同一份已存正文：
  - 首次发送；
  - 失败退避后的重试；
  - 发送中租约超时后的重新领取；
  - 负责人点"重试发送"（`outbox.retry`）。

  所以只改新发布不够：升级前已排队、失败或超时的事件仍会带着脚本发出。
- 其余外发事件不含脚本：
  - 项目受理；
  - 资料就绪或失败；
  - 补充资料说明；
  - 撤回；
  - 交付；
  - 归档。
- 资料传输只复制已发布的视频文件。
- Deseret 调用 AIGC 的两个接口只接收数据，响应中不含脚本。部署清点脚本只统计行数。

## 修复后的行为

- **新发布**：镜头不再带 `narration` 或 `script` 键。其他字段照常发送，包括 ID、序号、版本、时长、语言任务、角色和视频。
  - 旧版 Deseret（`9d12ca8`、`e7d7fd4`）也能接收：镜头先经 `NormalizeScene` 规范化，缺失的 narration 会变成空的 `{en:"", zh:""}`，校验只针对规范化后的对象，因此不会返回 400。
  - 新版 Deseret 直接不保存 narration。
- **已有队列与各种重投**：发送前用 `outgoingEventBody()` 处理已存的 `review.published`。
  - Deseret 读取的两种镜头数组都会处理：`payload.package.scenes`，以及旧格式的 `payload.scenes`。两者同时存在时都处理。
  - 每个镜头删除 `narration` 和 `script` 两个键，其余内容不变。
  - 结果是确定的，同一事件每次重投的字节完全相同。
  - 本来不含这两个键的事件原样发送。
  - 库中已存的记录不改写。
- **内部资料**：AIGC 的分镜、审阅包脚本、发件历史和收件记录都照常保留，不清理任何历史。
- **后续调整**：分镜已不再填写脚本，只需视频和时长即可送审；历史脚本仍保留在 AIGC 内部，见[Deseret 分镜不再填写脚本](DESERET_SCENE_WITHOUT_SCRIPT_20261121.md)。

## 重投的幂等，以及 Deseret 已收到旧事件但确认丢失的情况

Deseret 按"事件 ID + 原始正文的 SHA-256"保存回执。

- **同一份去脚本正文重复投递**：命中同一回执，正常幂等。
- **升级前旧正文已被 Deseret 提交、但响应丢失**：去脚本后的重投与回执哈希不符，Deseret 返回 409 `request_reused`。AIGC 此时：
  1. 只有同时满足以下三个条件才查询回执：本条正文确实被去过脚本；HTTP 状态为 409；错误码完全等于 `request_reused`。查询方式是带同一服务鉴权的 `POST /api/integrations/aigc/events/receipt`，内容为 `{eventId, projectId, bodySha256}`，`x-lw-request-id` 等于事件 ID：
     - `projectId` 取原事件中的 Deseret 项目 ID，两端已确认；
     - `bodySha256` 是库中原始正文（即当初实际发出的字节）的 SHA-256。
  2. 只有 Deseret 返回 200 `{accepted:true, eventId, status:"received"}`，且事件 ID 一致时，才记为已送达。诊断日志会标记 `confirmation: "prior_receipt"`。
  3. 回执不匹配（404）或回答不符，记为失败，错误码 `DESERET_REPLAY_UNCONFIRMED`，按原退避重试。查询本身出错时（例如 401、503 或网络错误），记录相应错误并重试。同项目后续事件继续排在它后面，不会越过。
- **以下情况一律按失败处理，不查询回执**：
  - 其他冲突，例如 `publication_reused`、`stale_publication`、`closed`，以及没有错误码的 409；
  - 状态码不是 409 的 `request_reused`；
  - 未被改写的事件收到 `request_reused`。

## 部署顺序与 Deseret 侧

1. **推荐先部署 Deseret 本轮版本，再部署本修复。** 这不是因为接收兼容：旧版 Deseret 也能接收不带 narration 的发布。实际原因有两个：
   - **屏蔽历史脚本**：旧版本已收到的审阅包里存有脚本正文，新版在所有投影中去掉历史包的 `narration` 和 `script`。
   - **旧事件的精确回执**：对已收到旧正文、但 AIGC 未收到确认的事件，只有新版提供回执查询接口，AIGC 才能确认送达。

   另外，新版判断能否沿用旧批准时会先忽略旧镜头中的这两个键。旧版会把带脚本的旧镜头与不带脚本的新镜头视为不同，已批准的未改动镜头在重新发布后会回到待审。
2. **AIGC 先上线时的影响**：
   - 新发布可以正常送达。
   - "旧正文已提交、响应丢失"的事件会因查询接口不存在而返回 404，记为 `DESERET_REPLAY_UNCONFIRMED`，并挡住同项目后续事件。Deseret 新版上线后，下一次重试查询到匹配回执，即可确认送达。
3. **404 不保证会恢复。** AIGC 无法区分两种 404：
   - 接口尚未部署；
   - 确实没有匹配的回执，即项目、事件或正文摘要不一致。

   后一种情况不会自动恢复：事件保持失败并继续挡住后续事件，需要两端人工核对。两种情况都不会被当作成功。
4. Deseret 已收到的旧事件中，脚本正文仍保存在其项目状态和回执记录里，只是不再对外展示。是否清理，由 Deseret 决定。

## 测试

只用内存 SQLite、合成数据和模拟的 Deseret，不接真实服务。

- `tests/deseret-outgoing-script.test.ts` 驱动真实的发件进程：
  - 新发布，以及排队中的分镜和成片旧事件；
  - 旧格式的 `payload.scenes`、`script` 别名，以及两种数组同时存在的情况；
  - 失败重投、租约超时、负责人重试；
  - 去脚本后发送的确认丢失后，按相同字节幂等重投；
  - 旧正文已被提交：回执匹配才视为送达，并放行后续事件；
  - 以下情况都不会被当成成功：回执不匹配、属于其他项目、查询失败、其他冲突、非 409 的 `request_reused`，以及未改写的事件。
- `tests/deseret-outgoing-contract.test.ts`：
  - 保留 Deseret 返回的确切状态和错误码；
  - 回执查询的签名、路径和请求 ID；
  - 只认可完全匹配的回执，其他回答按失败处理。

## English summary

Production scripts stay inside AIGC, and scenes are now submitted without one (see [Deseret scenes without scripts](DESERET_SCENE_WITHOUT_SCRIPT_20261121.md)). No `review.published` sent to Deseret carries a `narration` or `script` key. This applies to new publications and to events queued by earlier versions, in both `payload.package.scenes` and the older `payload.scenes`. Every resend is covered: after failure or lease expiry, and the lead's outbox retry. All other fields are sent unchanged. Stored outbox rows and AIGC's production state keep their content.

A resend of a stripped legacy event can be answered with HTTP 409 and exactly `request_reused`. Only then does AIGC query Deseret's signed receipt endpoint. The query carries the Deseret project ID from the original event, as both sides have confirmed, and the SHA-256 of the original wire body. AIGC marks the event delivered only on a matching receipt. Any other answer remains a failure.

Older Deseret versions (`9d12ca8`, `e7d7fd4`) also accept publications without narration: `NormalizeScene` turns a missing narration into an empty `{en, zh}` object before validation. Deploying Deseret first is still recommended, for two reasons:

- It hides the scripts stored in previously received packages.
- Its receipt endpoint lets AIGC confirm legacy events that Deseret received but never acknowledged.

The new Deseret also ignores these keys when deciding whether an old approval still applies, so unchanged approved scenes keep their approval.

A 404 from the receipt lookup is not guaranteed to clear. If the endpoint is merely not deployed yet, the next retry after deployment can confirm the event. If the project, event or body digest really does not match, the event stays failed, keeps later events waiting, and needs manual reconciliation on both sides.
