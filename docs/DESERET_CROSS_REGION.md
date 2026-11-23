# Deseret 跨区域附件 / Cross-region attachments

适用于美区 Deseret 和新加坡 AIGC，以及双方使用独立 Wasabi 账户的部署。AIGC 的接单签名与文件复制独立配置。上线前保留现有接单配置。

Applies to US Deseret and Singapore AIGC buckets, including separate Wasabi accounts. Keep the existing business handoff configuration when enabling file transfer.

| 主机 / Host | 凭据与访问 / Credentials and access |
| --- | --- |
| AIGC | WASABI_* 仅访问 AIGC 自有桶。AIGC signs short-lived requests for specific multipart uploads or reads in its own bucket. |
| Deseret 中继 / worker | DESERET_RELAY_ACCESS_KEY_ID and DESERET_RELAY_SECRET_ACCESS_KEY belong to the Deseret account. Grant access for approved input reads and review-output writes, including multipart operations. Worker 使用项目授权和限定前缀。 |
| 服务认证 / Service authentication | AIGC 与 worker 配对独立的 RELAY_KEY_ID/SECRET。Worker 与 Deseret API 配对 RELAY_AUTH_KEY_ID/SECRET。Keep these separate from the business incoming/outgoing keys. |

## 部署与验收 / Deployment and acceptance

1. 在 Deseret 主机部署完整的 `services/deseret-transfer-worker`，使用 Node 24，在该目录运行 `npm ci --omit=dev`。按 `config/deseret-transfer-worker.env.example` 配置本地私有环境文件，按 service 示例运行 `node cli.mjs`。Deploy the full directory, including its lockfile and authorization module, from the same release as AIGC. This version verifies signed worker acknowledgements.
2. 将 HTTPS 路径 `/internal/deseret-transfer` 转发至 worker，将 `/api/integrations/aigc/relay-authorize` 转发至 Deseret 应用。Verify the real authorizer accepts a current approved file and rejects a withdrawn or superseded source.
3. 根据本次交接的存储标识和实际桶配置填写两端 profile、endpoint、region 和受限前缀。按真实 AIGC WASABI_PREFIX 填写 worker 的读写前缀。A bucket change does not migrate historical versions; keep access to old objects for existing references.
4. 在隔离项目中使用 `LIFEWOOD_DESERET_TRANSFER_STRATEGY=deseret_relay`，分别验证封面入站及审阅文件回传，核对完整性、权限和中断续传。Use separate account credentials on the two hosts. Record the resulting object versions and verify the files open under their intended roles.
5. 正式启用前核对已排队的附件和已保存的复制计划。Changing the strategy may start existing pending transfers. Investigate a plan mismatch before retrying. Keep the approved brief and project identifiers.
6. 在现有 Space Bros 项目重试符合条件的素材任务。用制作账号打开封面与封底，再检查原版本的返修截图。Verify both material state and the readable registered file version. A successful business handoff alone does not verify file transfer.

## Deseret 更换 Wasabi 账户 / Moving Deseret to its own account

如果只轮换访问密钥并保留同一个桶，更新实际访问该桶的 Deseret 应用与 worker，按各自权限验证读写。AIGC 继续使用自己的密钥。For a credential rotation on the same bucket, update each Deseret-side consumer that uses the rotated credential and verify the existing object references.

如果同时更换桶，先用新桶验证一笔新交接，再处理历史项目。已批准清单引用原存储配置、对象键及文件版本，换账户不会自动迁移 Space Bros 的封面。跨桶迁移需单独安排，在旧项目验收前保留原对象和读取它们所需的配置。For a new bucket, update the Deseret uploader, relay, and AIGC peer storage profile together. Validate the old project against its original profile before retiring the old bucket or keys.
