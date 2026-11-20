# AIGC 正式环境交接 / Production handoff

2026-11-18。应用基线来自已通过验收的 Ubuntu Test 发布。保留业务数据的唯一来源是 Ubuntu Test。运维使用新的正式仓库保存源码，数据库、业务文件和密钥通过私有渠道交接。测试站通过的 42 组回归不代替生产恢复演练。

## 1. 准备与盘点 / Prepare and inventory

正式应用当前强制 MySQL 数据库 `lifewood_aigc`、Wasabi 桶 `aigc`、前缀 `lifewood-local/`。后者是历史命名。测试来源为 `lifewood_aigc_test` 和 `aigc-dev/lifewood-test/app/`。若团队改用另一个正式桶或前缀，先更改应用环境校验、迁移工具和对应配置测试，并重新构建。此包按新加坡同区域准备。

先在 Ubuntu Test 查 `systemctl --user show lifewood-test -p WorkingDirectory`，在该目录用 Node 24 执行下列只读盘点。输出目录须新建，父目录应为运维私有目录。Test 的 Wasabi 连接曾依赖本机代理；若盘点走直连超时，先验证盘点客户端的线路。切换当日重新生成清单。

```bash
node scripts/deployment/inventory-test-source.mjs --env "$TEST_ENV" --out "$NEW_INVENTORY_DIR"
```

负责人确认保留范围。全量保留时使用下列恢复步骤；部分项目保留时，先完成依赖导出与隔离恢复核对，包括跨项目共享文件、客户、账号、语言任务、历史版本、质检和出版社记录。工具包内的数据库导出是全库导出。清理旧正式桶属于独立变更，需先核对桶版本、删除标记、保留策略、旧引用及备份。

## 2. MySQL 迁移 / Database migration

1. 在隔离实例准备空的 `lifewood_aigc`，MySQL 版本、字符集、排序规则匹配 Test。演练期间阻止对外回调、邮件和后台消费；数据库事件调度保持关闭。确认旧正式库已有可恢复快照及独立回退入口。
2. 最终导出前暂停源站写入及后台任务，等待上传和交接出队，记录同一截止点的库与对象清单。若暂停写入不可接受，需要另行设计增量追平。迁移期间控制新的写入来源。
3. 在 Ubuntu Test 执行 `bash scripts/deployment/export-test-db.sh "$NEW_PRIVATE_EXPORT_DIR"`。将生成的 `database.sql.gz` 和校验文件经受控加密渠道传给运维。此导出不带源库 CREATE DATABASE 或 USE 指令。归档库里仍可能包含配置、个人资料及会话数据，按私有备份管理。
4. 运维复核导出中的 DEFINER、视图、触发器、事件及显式源库引用。检查 MySQL login-path 指向隔离的目标实例，确保恢复账号的权限限定在目标范围。在空目标执行 `bash scripts/deployment/restore-production-db.sh "$PRIVATE_EXPORT_DIR" aigc-prod-restore --restore-reviewed-empty-target`。若中断，保留日志，换空目标重新恢复。
5. 从发布目录执行 `LIFEWOOD_ENV_FILE=/etc/lifewood/aigc.env node scripts/mysql-migrate.mjs`。随包有 0001–0009，包含 Deseret 字段。对比迁移指纹、逐表行数、关键外键关系、项目及文件版本。正式启用前处置测试登录会话、测试账号、未完成上传、待发回调和环境专属配置。需保留的加密数据应核实密钥兼容性或完成重加密。

## 3. Wasabi 对象迁移 / Object migration

根据保留的数据库记录生成私有 JSONL 对象清单，一行对应一个固定来源版本和唯一目标 key，包括仍有引用的旧版本、质检 PDF、封面、分镜及成片。以下仅演示格式。etag 取源 HEAD 的原值；启用版本控制时填入真实 sourceVersion。多个历史版本引用同一 key 时，为每个保留版本分配独立目标 key 并登记映射。

```json
{"source":"lifewood-test/app/example.mp4","target":"lifewood-local/example.mp4","etag":"\"source-etag\"","size":1234,"sourceVersion":"source-version-id"}
```

在运维机使用支持 S3 PutObject.IfNoneMatch 的 boto3/botocore，配置两个私有 AWS profile：`aigc-test-read` 仅可读源，`aigc-prod-copy` 可读写目标。运维机提供加密临时盘，预留至少最大单文件的空间。程序逐文件下载到临时盘、校验、条件写入并读回，支持单对象至 5 GiB。更大的对象、特殊 ACL、标签、对象锁和保留期限须另行迁移核验。

```bash
umask 077
python3 scripts/deployment/copy-approved-wasabi.py approved.jsonl
python3 scripts/deployment/copy-approved-wasabi.py approved.jsonl --apply > mapping.jsonl
```

遇到目标已有对象时只接受大小、内容 SHA-256 和所复制的元数据均匹配。失败时保留已生成映射，以同一清单重跑并写入新的结果文件。若目标 Wasabi 对条件写入支持不符，应在隔离演练中停止并核对。显式清理旧桶须单独审批，复制工具无删除动作。

复制完成后，根据映射在隔离目标库事务中更新**实际保存的**存储位置、绝对 key、VersionId、ETag 和跨平台包快照；相对 key 若路径一致可保留。不要对整个 SQL 文本全局替换。该回填依赖最终保留范围与现场清单，本包未含针对客户数据的一次性 UPDATE。逐条核对已保留文件映射覆盖率、缺失/冲突为零，再抽验历史附件、预览和下载。核对完成后锁定迁移结果。

## 4. 上传资源包并启动 / Deploy the application

资源包 `aigc-production-source.tar.gz` 提供完整受核验源码、public、锁文件、SQL、运维工具及配置模板。它需要在 Linux 构建。若从本仓库生成交付包，可从审核过的提交运行 `git archive --format=tar.gz -o aigc-production-source.tar.gz HEAD` 并执行 `sha256sum aigc-production-source.tar.gz > aigc-production-source.tar.gz.sha256`。把压缩包与同名 .sha256 上传至运维暂存目录，在该目录运行：

```bash
sha256sum -c aigc-production-source.tar.gz.sha256
release=/opt/lifewood/aigc/releases/20261118-01
mkdir "$release" && tar -xzf aigc-production-source.tar.gz -C "$release"
cd "$release"
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build
test -s dist-mysql/launcher/server.mjs
```

使用 Node 24.22.1 及 pnpm 11.19.0（与已验收 Ubuntu 主机一致）。正式基础配置由运维在服务器私有目录准备，参见 [基础配置模板](config/production.env.example) 及 [服务模板](config/aigc-public.service.example)。从生产基础配置生成应用配置和反代令牌：

```bash
node scripts/deployment/prepare-public-config.mjs --env "$PROD_BASE_ENV" --origin https://www.aigc.lifewood.com --out "$NEW_PRIVATE_CONFIG_DIR"
```

依模板安装私有配置、证书和服务文件；核对服务账号对应用、配置、证书的权限。运行目录 `/opt/lifewood/aigc/current` 指向本次 release。systemd 的 Node 路径应指向实际 Node 24，Nginx 转发至本机 3002。模板生成器默认关闭 Deseret 对接；待正式双方地址、签名、桶授权及待发任务核对完成后再启用。Deseret 的带图成片退回（`FilmEvidenceEnabled`）须在 AIGC 部署并验证返修接收后才能开启，见[成片 QA 返修接收修复](DESERET_QA_REVISION_REPAIR_20261121.md)。测试代理 7897 仅在正式主机有同一受控代理且实测通过时配置。

```bash
sudo systemd-analyze verify /etc/systemd/system/aigc-public.service
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable aigc-public.service
sudo systemctl restart aigc-public.service
sudo systemctl reload nginx
```

开放业务写入前，从公网按域名校验证书、首页、登录、无签名接口拒绝、浏览器直传 CORS/ETag、质检 PDF、分镜审核与成片交付。真实出版社通过双方生产配置进行签名联调。切换失败时，在仍停写的窗口恢复上一版 release、配置和配套的数据库/存储映射。若正式已有新写入，先冻结并核对增量再决定恢复点，以免丢失新订单。

**Release status.** This kit uses the verified Ubuntu Test source. Operations must rehearse database restore, copy and read back retained Wasabi objects, reconcile references and verify the public deployment before admitting production traffic. Keep private dumps, object lists and credentials outside the source repository.

