# AIGC MySQL 预编译语句耗尽修复设计

2026-11-25，新加坡时间。状态为设计联审完成、待实施。基线为 `1df34a187748a31909477c45ba0392c3aa60036f`。本文中的预算和性能门槛是建议值，尚无修复后的线上数据。

## 故障依据

16:29 和 16:32 观察到 MySQL 已使用 16,382 / 16,382 个预编译语句名额。16:32 两次采样都看见 13 条业务 TCP 连接来自 AIGC 同一进程。16:35 会话检查和登录准备返回 503，应用同期记录错误 1461。运维账号无权限按线程清点全部语句。上述证据不能解释前一晚共享主机的 522 或重启。

对发布版转换器输入相同 SQL 与相同参数 1,000 次，隐式 json_each 别名路径产生 1,000 种文本，普通参数查询只产生 1 种。线上错误日志也出现连续的 json_rows_3075 至 json_rows_3078。mysql2 的 execute 按连接缓存语句；模块级编号让每一轮查询都可能产生新条目。素材和待发送队列默认每 15 秒扫描，空队列也要查询。用户数与已保留语句数没有一一对应关系。

## 修改面与边界

1. 在 `db/mysql/sql.ts` 每次 render 建立独立别名分配器，同一次递归 emit 共享分配器。保证相同 SQL 结构、相同翻译条件产生相同文本；参数值继续绑定。合法改变查询形状的条件、列数或占位符数仍可产生不同 SQL。
2. 区分“自动命名”和“实际消费了几个别名 token”。支持现有裸别名、AS 加标识符和项目词法器支持的引号标识符。把子句边界、JOIN 类关键字与别名区分开。预留原语句中的标识符（包括其引号形式，保守地忽略大小写比较），避让已有 json_rows_N 和新生成的名字，不能根据字符串前缀判断来源。仅在 json_each 转换处扩展识别，语法超出明确范围时报清晰错误。
3. 验证多个 JSON 表、嵌套子查询、前后声明的别名、限定列、空数组、JSON null、数字、字符串、排序规则、key 从 0 开始及 value 类型；多个参数和表达式复用时比较占位符和绑定顺序。内部 JSON_TABLE 的 jt、item、ordinality 按 SQL 作用域验证。关联外层列的 json_each(t.ids) 单列为兼容性测试；若旧版本不支持且业务无依赖，记录限制，单独设计支持。避免把这次修复扩成通用 SQL 解析器。
4. 在 `db/mysql/config.ts` 显式传入 mysql2 的 maxPreparedStatements，建议先用固定默认值 128 条/连接。若引入环境覆盖，建议名 MYSQL_MAX_PREPARED_STATEMENTS，仅接受正安全整数，拒绝 0、负数、小数、空字符串和非数字，未配置采用默认值。MYSQL_CONNECTION_LIMIT 在创建池前执行相同的有限正整数校验，未配置仍用 20。在隔离环境覆盖 0、负数、小数、非数字和合法旧值；旧部署若依赖特殊值，先确认并显式配置有限预算再切换。沿用 execute 和参数绑定，保留事务、回滚、权限过滤、TLS 和连接获取方式。
5. 现有 `runtime/node-environment.ts` 对每份已加载的模块复用数据库对象。按实际运行的池计数，核查独立进程、worker、重复加载的模块、滚动发布重叠期和后台程序。稳态缓存规划量为各池“最大连接数 × 每连接上限”之和，另加其他客户端用量、手工预编译及并发淘汰的暂时余量。默认 20 条连接时单池为 2,560，两套相同池重叠为 5,120；这个算例不能用于估计已饱和旧池的占用。部署检查应代入实配与 MySQL 全局上限。128 调往 256 前须有缓存抖动和延迟证据，并重算总预算。

## 受影响的操作

| 范围 | 可能的负面影响 | 验证 |
|---|---|---|
| 登录、会话及普通项目读取 | 冷缓存首次查询需要预编译。工作集超过 128 时会反复淘汰，增加 CPU、查询耗时和事务等待 | 分别测冷启动与预热后的登录、首页、项目列表，以及多用户并发 |
| 制作工作区、翻译、回收与归档 | 别名绑定出错可能导致漏行、误选记录、权限筛选失效或写入保护判断错误 | 同一份数据对照旧版的结果和事务效果，加入越权、已删除、版本过期和失败回滚用例 |
| AIGC 与 Deseret 双向交接 | 扫描查询回归会导致任务遗漏、重复或延迟；发布时进行中的任务可能中断 | 空队列、积压、租约过期、重试、同版本重复事件；覆盖收件、发布、反馈/返修、附件引用和终态 |
| 共享 MySQL 及发布 | 旧池保留句柄；旧版满额时，新版并行启动也可能申请失败。单实例替换会有短暂不可用 | 先取证，检查在途请求、事务和任务，验证优雅退出后旧连接释放，核对基线与新人流量 |
| 外部系统 | 本设计只修改 AIGC 的数据库访问。Deseret、官网、Wasabi 依赖交接可用性；共享 MySQL 上的其他应用也可能受额度和 CPU 波动影响 | 观察外部交接和共享实例指标。无需变更对端 API、桶/账号、业务表、数据或角色流程 |

## 验收与恢复

- 隔离环境使用与生产一致的 MySQL 8.4、mysql2 版本、SQL 模式与排序规则。对实际扫描/业务 SQL 做 1,000 次重复转换并交错其他查询，隐式别名路径只应得到一个文本。结果与绑定值单独断言。对不同命名、嵌套和 JOIN 的 SQL 做真实执行与读写结果对照。
- 固定连接数，预热后重复同一查询；每条实际参与的连接最多保留该模板的一份。再让每条连接依次执行超出上限的不同模板，等待命令完成，确认服务端计数有界并发生关闭。用隔离实例或按测试线程采样，避免误把其他服务的全局变化当成本次结果。关闭池后，计数回落到测试前基线。
- 连续运行真实 15 秒空轮询和有任务轮询；增加多池、多进程、短连接重建和冷启动组合。测试时长要足以让旧版重复产生增长，用相同输入比较两版，固定负载下新版预热后无持续线性增长、无 1461。登录页的会话检查、准备、真实测试账号登录、首页和业务操作全部成功。同样覆盖按设计返回的 401/409，不能把正常拒绝改成成功。
- 相同数据量与并发至少重复三轮，记录预热后业务延迟 p95、吞吐、数据库 CPU、prepare/close 速率、全局使用量与交接积压。建议以 p95 相对健康基线持续变慢超过 10% 作为复核线，同时检查绝对毫秒差和测量波动。饱和旧环境不能充当健康性能基线。
- 上线前留存时间、版本、进程、连接数、全局上限与在用数；有权限时按连接归属聚合，避免采集业务 SQL 的参数。当前已满时，在另行授权的维护窗口停止旧进程接收新工作、等待可完成的在途任务并关闭其池，旧池退出后重新读数，仅当“此时全局在用数 + 待启动的新池预算 + 给其他客户端增长与并发淘汰的余量 < 实际全局上限”时开放新版流量。余量依据实测峰值与部署拓扑在发布前确定；若条件不满足，维持维护状态并核对剩余占用归属。回退也执行同一容量检查。异常退出时核实未完成任务的租约和恢复行为。全局调大额度、重启整库、批量断开共享连接不作为本设计的发布步骤。
- 发布后覆盖真实低风险业务流程、至少一段典型使用高峰及前次耗尽所经历的数小时，再判断持续运行表现。1461 再现、权限/结果偏差、持续积压或性能明显恶化时停止扩大流量。若回退业务版本，旧版仍有耗尽风险；优先准备带预算保护且已验证的回退构建，仍需释放替换进程的池并跟踪增长。
- 单做限额能控制占用却会反复预编译；单做别名修复能消除已复现的增长源，但其他 SQL 形状仍可占满缓存。两项合并交付。MySQL 的全局上限不需要为本修复调整。

## 联审与核对入口

Codex 核对了固定版本、实际业务调用、驱动入口和进程退出路径。Claude 独立审阅所提供的发布版 SQL 转换器、连接池配置与故障证据，提出显式 AS、带前缀别名、关联查询、LRU 淘汰和旧连接释放等边界。以上为设计和验收条件，尚未运行修复后的测试。

- 代码入口为 `db/mysql/sql.ts`、`db/mysql/config.ts`、`db/mysql/driver.ts`、`db/deseret-integration-jobs.ts`、`runtime/node-environment.ts` 和 `runtime/server.ts`。
- 驱动行为见 [mysql2 Prepared Statements](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements)。全局额度定义见 [MySQL 8.4 系统变量](https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html#sysvar_max_prepared_stmt_count)。

## English decision summary

Scope the generated JSON table aliases to a single render, preserve explicit identifiers and bind order, and bound automatic prepared-statement caching per connection. Start with a proposed limit of 128 per connection. Size the budget across all live pools, including overlapping deployments and other clients. Validate equivalent business results, authorization boundaries, LRU eviction and steady-state counts on isolated MySQL 8.4. During a separately authorized release, drain existing AIGC connections and check server capacity before accepting traffic. No schema migration or cross-system API change is required. Status: design reviewed, implementation and release pending.
