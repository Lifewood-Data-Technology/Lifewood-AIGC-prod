# Lifewood AIGC

AIGC production application and operations tools. The workbench uses MySQL and Wasabi and supports signed Deseret Book project handoffs.

生产构建使用 Node.js 24.22.1 和 pnpm 11.19.0。在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

部署入口为 `dist-mysql/launcher/server.mjs`。数据库恢复、Wasabi 迁移、私有配置、HTTPS、服务启动与回退步骤见[生产部署手册](docs/PRODUCTION_OPERATIONS_20261118.md)。

The [operations guide](docs/PRODUCTION_OPERATIONS_20261118.md) covers database restore, verified object migration, HTTPS configuration and service cutover. Store credentials, backups and object manifests outside the repository.
