# AIGC MySQL prepared statement implementation plan
Use Superpowers subagent-driven-development. Base 1df34a1. See ../specs/2026-11-25-mysql-prepared-statement-budget-design.md.
Goal: deterministic MySQL SQL and a finite per-connection prepared statement cache.
Architecture: scope implicit aliases to one render and configure mysql2 per pool. TypeScript, Node, MySQL 8.4.
- [x] Red/green regression tests for repeated SQL, alias collisions, joins, bound values, finite pool and statement options.
- [x] Implement db/mysql/sql.ts and db/mysql/config.ts. Preserve existing write and access semantics.
- [x] Run real MySQL repeated queries, pooling, eviction, shutdown, login and business/integration tests; build, typecheck and run repository suite.
- [ ] Have Claude review the exact diff, address issues, verify artifact. Local commit only; no push.
- [ ] Stage separate release. Check host capacity, active work, recovery path, close old pool, verify release and public/DB health.

Release evidence (2026-11-25, Singapore). Claude static review PASS. Full Linux suite 278/278, TypeScript and targeted eslint passed. On isolated MySQL 8.4.13 the same template 1,000 times used 1,000 handles before and 1 after. Four empty maintenance lanes held at four after warmup. Two pools with two connections each held 512 after eviction and returned to baseline on close. Materials and outbox completed with simulated storage/peer, including retry and expired lease. The exact Linux bundle passed 17 HTTP checks with a synthetic account on isolated MySQL 8.4.11. The tested bundle has two copies of the backend, so budget for two pools (20 x 128 x 2 = 5,120) in one instance. Use the measured global headroom before admitting the replacement.