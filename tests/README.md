# tests/ 目录说明（手工验收脚本，**不在 CI 里**）

这里的 `verify-*.mjs` 是历次工单留下的**手工验收脚本**（`package.json` 里对 `tests/` 的引用数是 0，
CI 与 `npm run *` 都不会跑它们）。

## ⚠ #54（feat-261101-05）之后：这些脚本**没有适配异步运行时**

运行时数据库入口在 #54 从 `node:sqlite` 的同步 API 换成了 `server/db-shared.mjs` 的
`getDb()`（返回 `AsyncDb`，`prepare().all/get/run` 全部变成 Promise）。因此：

- 这些脚本里凡是直接调用 `admin-store` / `runtime-store` / `db-shared` 的地方，
  **未适配前直接运行会得到语义错误的结果**——典型症状是在 Promise 上取属性（拿到
  `undefined`）或把 Promise 当布尔值判断（恒真），**不会报错**，只会给出假的 PASS。
- `verify-migration.mjs` 已在 #54 删除：它 import 的 `server/database-schema.mjs`（legacy
  手写 DDL）已退役，其覆盖面（旧库去重保留最新、孤儿 `send_records` 丢弃、二次幂等、
  全新库直接新结构）已折叠进 CI 唯一路径 `scripts/db-schema-test.mjs` 的**场景 3b**。
- 其余脚本保留原样（#54 的红线是不做无关重写），需要复用时**先按异步 API 适配**：
  给调用点补 `await`、把回调改成 `async`、并在收尾 `await closeDb()`（否则连接池挂着
  句柄，进程不会自己退出）。

需要真回归的场景，请优先加进 `scripts/db-schema-test.mjs`（schema/迁移）、
`scripts/db-semantic-test.mjs`（方言语义锁）或对应的 `scripts/*-test.mjs`（node --test），
这些才是进 CI 的路径。
