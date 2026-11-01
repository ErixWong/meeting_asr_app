# 数据库方言可移植性（SQLite / MariaDB / SQL Server）

> 状态：PR-B 阶段①（issue #53）产出。**本文件记录的是实测事实与待办边界，不是「已支持多库」的声明。**
> 生产目前仅 SQLite 经过真机验证；`DB_TYPE=mysql|mssql` 是进行中能力（见文末「待办边界」）。

## 1. 现状：两套数据库访问路径并存

| 路径 | 入口 | 驱动 | 谁在用 |
| --- | --- | --- | --- |
| legacy（生产） | `server/db-shared.mjs` 的 `getDb()` → `server/database-schema.mjs` 的 `initializeDatabase()` | `node:sqlite`（同步） | 全部运行时业务代码（Next 服务端 + `server/*.mjs`） |
| knex 新基建 | `server/db/index.mjs` 的 `getKnex()` → `server/db/async-db.mjs` 的 `AsyncDb` | `better-sqlite3` / `mysql2` / `tedious` | 仅 `scripts/db-smoke.mjs`、`scripts/db-schema-test.mjs`、`scripts/db-semantic-test.mjs` |

**关键事实：运行时根本不读 `DB_TYPE`。** `server/db-shared.mjs` 里 `new DatabaseSync(...)` 写死 SQLite；knex 那套只被脚本调用。把 `DB_TYPE` 接到运行时是 #54 的事，本阶段（#53）**零运行时行为变更**。

## 2. 已实证的可移植性（这些是资产，别推翻）

- **ID 全应用侧生成**：主键一律 `string(64)` 存应用侧生成的字符串 ID，**没有一处自增**（`t.string("id", 64).primary()` / `t.primary([...])` 复合主键），跨库无 `IDENTITY`/`AUTO_INCREMENT` 差异。
- **时间戳统一 `TEXT` 存 ISO8601 字符串**（`string(32)`），不依赖数据库时间类型/时区转换；knex 工厂对 mysql 显式 `dateStrings: true` + `timezone: "Z"` 保持同一语义。
- **SQL 里 0 处** `strftime` / `julianday` / `datetime()` / `GROUP_CONCAT` / `json_extract`（全仓 grep 实测，含 legacy DDL 与业务 SQL）。
- **`server/db/insert-ignore.mjs`** 已实现 mssql 分支：`INSERT INTO t SELECT ... WHERE NOT EXISTS(...)`（knex 的 `onConflict().ignore()` 不支持 mssql 客户端）；sqlite/mysql 走 `onConflict(keys).ignore()`。
- **`AsyncDb.prepare(sql)`** 提供与 `node:sqlite` 同形的 `.all/.get/.run`（异步版），占位符 `?` 由 knex 翻译成各库绑定语法（mssql → `@p0`）；`extractRows()` / `extractRunInfo()` 已消化三库返回结构差异。
- **迁移 SQL 已用三库通用写法**：`ROW_NUMBER() OVER (PARTITION BY ...)`（三库都支持）、`COALESCE`、`DELETE` + `INSERT` 记账（不依赖 `ON CONFLICT`/唯一键，见 #52）。

## 3. 实测坐标（2026-11，本机容器）

| 目标 | 版本 | 默认排序规则 | 驱动 / 版本 |
| --- | --- | --- | --- |
| SQLite（`node:sqlite`） | 3.53.4 | `BINARY`（大小写敏感） | Node 内置（node:24-slim / v24.21.0） |
| SQLite（`better-sqlite3`） | 3.53.4 | `BINARY` | `better-sqlite3@13.0.3` |
| MariaDB（容器 `mariadb`） | 11.7.2-MariaDB-ubu2404 | `utf8mb4_uca1400_ai_ci`（**不敏感**） | `mysql2@3.23.3` |
| SQL Server（容器 `mssql`） | 2025 RTM-CU8 17.0.4075.5 | `SQL_Latin1_General_CP1_CI_AS`（**不敏感**） | `tedious@20.0.0`（knex 3.3.0） |

> 两个外部实例是**共享实例**（别的项目在用）：测试只准建 `meeting_asr_ci_*` 一次性库，跑完 `DROP`。

## 4. 方言坑登记表（#54/#55 直接继承这张表）

### 4.1 `ON DELETE RESTRICT` —— MSSQL 不支持，改 `NO ACTION`

| 项 | 内容 |
| --- | --- |
| 现象原文 | `CREATE TABLE [meetings] (...) - Incorrect syntax near the keyword 'RESTRICT'.`（`Msg 156, Level 15`） |
| 触发条件 | knex `createTable(...).foreign(...).onDelete("RESTRICT")`，knex 对 mssql **原样透传**该关键字 |
| 正确写法 | `onDelete("NO ACTION")`（三库合法、语义等价：都是「有引用则拒绝删除」） |
| 本单是否已修 | ✅ 已修：`server/db/schema.mjs:64` / `:86` / `:186`（3 处）。legacy `server/database-schema.mjs:94,148,171,336,361`（5 处）**只在 node:sqlite 上执行，本单不动** |

### 4.2 `CREATE INDEX IF NOT EXISTS` —— MSSQL 不支持

| 项 | 内容 |
| --- | --- |
| 现象原文 | `CREATE INDEX IF NOT EXISTS idx_... ON ... - Incorrect syntax near the keyword 'IF'.`（`Msg 156`） |
| 触发条件 | `server/db/schema.mjs` 的 `createIndexes()` 批量下发带 `IF NOT EXISTS` 的建索引语句（幂等需要） |
| 正确写法 | 先查目录表再建：`SELECT name FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id WHERE ...`，命中即跳过，未命中再 `CREATE INDEX` |
| 本单是否已修 | ✅ 已修：索引清单改为结构化 `INDEXES`（`server/db/schema.mjs:250-263`）+ `createIndexIfAbsent()`（`:272-292`）。sqlite/mysql 下发的 SQL 文本与改动前**逐字一致** |
| 附带坑 | `sys.indexes` 里混有 `sys` schema 内部表的索引（`idx_groupid` / `idx_lcid` / `idx_phraseid` / `idx_term`）——**不 JOIN `sys.tables` 会多出 4 条**（实测）。测试脚手架已按 JOIN 写法实现 |

### 4.3 `BEGIN` 经 `sp_executesql` 触发 `Msg 266`

| 项 | 内容 |
| --- | --- |
| 现象原文 | `BEGIN - Incorrect syntax near 'BEGIN'.`；改成 `BEGIN TRANSACTION` 后变成 `Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements. Previous count = 0, current count = 1.`（`Msg 266`） |
| 触发条件 | knex 的 mssql 方言把 `knex.raw(sql)` 交给 `sp_executesql` 执行；语句内开启事务会让 SQL Server 在过程返回时发现 `@@TRANCOUNT` 前后不一致 |
| 正确写法 | 走**驱动级事务 API**：`knex.transaction(async (trx) => ...)`（→ tedious `beginTransaction` / `commitTransaction` / `rollbackTransaction`），并让事务期间的语句都走 `trx` 连接 |
| 本单是否已修 | ✅ 已修：`server/db/async-db.mjs` 的 `withTransaction()` 增加 mssql 分支（`async-db.mjs:92-116`），事务期间把 `this.knex` 换成 `trx`，使 `exec/prepare` 与调用方 `db.knex.xxx` 落在同一连接。sqlite/mysql 分支与它们下发的 SQL 文本**逐字节不变** |

### 4.4 大小写语义：`=` 与主键唯一性

| 项 | SQLite | MariaDB 11.7 | SQL Server 2025 |
| --- | --- | --- | --- |
| 默认排序规则 | `BINARY`（**敏感**） | `utf8mb4_uca1400_ai_ci`（**不敏感**） | `SQL_Latin1_General_CP1_CI_AS`（**不敏感**） |
| `account_name = 'admin'` 命中 `admin` + `Admin` 两行？ | 否（只命中 1 行） | 是（若两行共存） | 是 |
| 唯一键上 `admin` / `Admin` 能否共存 | 能 | **不能**（撞唯一键） | **不能** |
| 主键上 `u-1` / `U-1` 能否共存 | 能 | **不能**（`Duplicate entry`） | **不能** |

- 现网依赖的等值查询：`src/lib/admin-store.ts` 的 `SELECT id FROM users WHERE account_name = ?`（登录）与 `SELECT id, password_hash ... WHERE account_name = ?`。SQLite 上是**二进制比较**，换到 mysql/mssql 默认排序规则会变成**不敏感**（`Admin` 也能登进 `admin` 的账号）。
- 本单选定的目标方案（语义锁测试已断言生效）：**敏感语义列显式声明二进制排序规则**
  - mysql：`VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
  - mssql：`NVARCHAR(255) COLLATE Latin1_General_100_BIN2`
  - sqlite：默认 `BINARY`，无需声明
  - **主键/唯一键列同样要声明**（否则 `u-1` 与 `U-1` 撞键，实测 mysql 报 `Duplicate entry 'u-Admin' for key 'PRIMARY'`）。
- 本单**不改业务 SQL**，只把差异钉死；真正的列排序规则落地归 #55。

### 4.5 `LIKE` 检索语义

| 目标 | `account_name LIKE 'admin'`（列上有 `admin` / `Admin`） | 说明 |
| --- | --- | --- |
| SQLite | 命中 **2 行** | `LIKE` 对 ASCII 一律不敏感，**与列的排序规则无关** |
| mysql `utf8mb4_bin` / mssql `..._BIN2` | 命中 **1 行**（`admin`） | `LIKE` 跟随列的二进制排序规则 → 敏感 |

- 可移植写法建议（本单已在三库断言验证）：**显式 `LOWER()` 两侧折叠**——`WHERE LOWER(col) LIKE LOWER(?)`，三库行为一致（命中 2 行）。
- ⚠ SQLite 的 `lower()` **只折叠 ASCII**：`LOWER('Ä')` → `'Ä'`（不变），而 mysql/mssql 会折叠成 `'ä'`。**中文不受影响**（`LOWER('管理员')` 三库都返回 `'管理员'`），所以 `LOWER()` 方案对中文检索安全，对非 ASCII 拉丁字母（德语/北欧姓名）仍不一致——需要精确检索时应改用 `COLLATE` 方案或应用侧规范化。
- 本单**不改业务 SQL**（SQLite 现网行为必须逐条不变），只记录差异 + 留断言。

### 4.6 已知缺口：嵌套事务在 sqlite/mysql 的 savepoint 分支

- 现象（独立缺陷，**本单不修**，归 #55）：嵌套 `withTransaction` 在 sqlite/mysql 上走 `SAVEPOINT sp_N` / `ROLLBACK TO SAVEPOINT sp_N` 分支，已知会报 `ROLLBACK TO SAVEPOINT sp_1 - no such savepoint`；根因方向是 `AsyncDb._txDepth` 为**实例级**状态、savepoint 名只由深度决定。
- 本单的取证边界：在 sqlite 上试了两种形态——① 内层抛错被外层吞掉（结果 `rows=[1,3]`，符合预期）；② 内层抛错穿透（整体回滚，符合预期）——**两种都正常**，缺陷的精确复现条件尚未收敛，需要 #55 重新定位。
- 因此：**嵌套事务的断言只在 mssql 上跑**（mssql 分支已改走 `knex.transaction()`，提交/回滚语义必须真测，见 §6）。sqlite/mysql 的嵌套语义**未覆盖**，不要当成已验证。

## 5. 裸 SQL 分布与方言点逐条

统计口径（可复现）：`grep -c '\.prepare(' <file>`（`.prepare(...)` 即一条裸 SQL 语句）。

| 文件 | 裸 SQL 条数 |
| --- | --- |
| `src/lib/admin-store.ts` | 78 |
| `server/runtime-store.mjs` | 26 |
| `server/database-schema.mjs` | 6 |
| `server/db-shared.mjs` | 2 |
| `server/tts-gateway.mjs` | 1 |
| `server/app-server.mjs` | 1 |
| **合计** | **114** |

### 5.1 `ON CONFLICT`（业务 SQL 实际 7 处；工单快照记 8，差额是 `server/db/schema.mjs:452` 的注释）

| 文件:行号 | 语句 |
| --- | --- |
| `src/lib/admin-store.ts:963` | `ON CONFLICT(item_section, item_mark) DO UPDATE SET` |
| `src/lib/admin-store.ts:989` | `ON CONFLICT(id) DO UPDATE SET` |
| `src/lib/admin-store.ts:1023` | `ON CONFLICT(id) DO UPDATE SET` |
| `src/lib/admin-store.ts:1891` | `ON CONFLICT(role_key) DO UPDATE SET role_name = excluded.role_name` |
| `server/runtime-store.mjs:37` | `ON CONFLICT(item_section, item_mark) DO NOTHING` |
| `server/runtime-store.mjs:220` | `ON CONFLICT(capture_session_id) DO UPDATE SET` |
| `server/runtime-store.mjs:612` | `ON CONFLICT(capture_session_id) DO UPDATE SET` |

（另有测试夹具 `scripts/audio-test.mjs:385,394` 两处，不计入业务 SQL。）

### 5.2 `INSERT OR IGNORE`（3 处，全在 `src/lib/admin-store.ts`）

`src/lib/admin-store.ts:944`（app_settings）、`:1644`、`:1975`（user_roles）。

### 5.3 `INSERT OR REPLACE`（**业务代码 0 处**）

工单快照记 1 处；实测全仓仅 3 处**注释**提到它（`server/db/schema.mjs:452`、`server/database-schema.mjs:253`、`:434`），真正的 REPLACE 用法已在 #52 的记账改造中删除。**结论：无待改代码点。**

### 5.4 `PRAGMA`（业务/运行时 8 处）

| 文件:行号 | 用途 |
| --- | --- |
| `src/lib/admin-store.ts:627` | `PRAGMA table_info(...)` 列探测 |
| `server/db-shared.mjs:21` | `PRAGMA journal_mode = WAL` |
| `server/database-schema.mjs:301` | `PRAGMA table_info(asr_capture_sessions)` |
| `server/database-schema.mjs:310` | `PRAGMA table_info(meeting_llm_results)` |
| `server/database-schema.mjs:471` | `PRAGMA table_info(meeting_llm_results)` |
| `server/database-schema.mjs:503` | `PRAGMA foreign_keys = OFF`（迁移期） |
| `server/database-schema.mjs:516` | `PRAGMA foreign_keys = ON` |
| `server/db/schema.mjs:507` / `:522` | `PRAGMA foreign_keys = OFF/ON`（knex 迁移期，仅 `dbType==="sqlite"` 分支） |

> 上表按「运行时业务 + 迁移路径」口径计 8 处（不含 `server/db/index.mjs:109-116` 的 3 条 SQLite 连接级优化 PRAGMA——那 3 条本来就只在 `dbType === "sqlite"` 分支里下发，天然安全）。knex 侧已有跨库替代：`server/db/async-db.mjs` 的 `listTableColumns()`（sqlite `PRAGMA table_info` / mysql `information_schema.COLUMNS` / mssql `INFORMATION_SCHEMA.COLUMNS`）。

## 6. 三库测试脚手架（本单新增）

```bash
# 全矩阵：sqlite（node:sqlite legacy + better-sqlite3 两驱动）+ mariadb + mssql
npm run db:test-parity

# 单方言
npm run db:test-semantic                     # 语义锁（默认 sqlite）
DB_TYPE=mssql DB_HOST=... DB_USER=sa DB_PASSWORD=... npm run db:test-schema -- --dialect
```

- 宿主机 node 是 v22，跑不了 `node:sqlite` → 一律在 `node:24-slim` 容器里跑（完整命令见 `docs/tasks/active/feat-261101-03-db-dialect-parity-phase1/report.md`）。
- **容器到宿主的可达性**：mssql 发布在 `0.0.0.0:1433`，容器用 `--add-host=host.docker.internal:host-gateway` + `host.docker.internal:1433`；**mariadb 只发布在 `127.0.0.1:3306`（loopback-only），`host.docker.internal` 打不通**，容器必须挂到 `prod` 网络并用容器名 `mariadb:3306`。
- 覆盖矩阵：

| 目标 | schema/迁移套件 | 语义锁 |
| --- | --- | --- |
| sqlite / `node:sqlite`（legacy 生产入口） | 8 个场景（含并发、旧库 v0 迁移） | — |
| sqlite / `better-sqlite3`（knex） | 同上（同一脚本内两条路径） | A/B/C 共 11 项 |
| mariadb 11.7 | 基线建表 → 建索引 → 迁移 → 记账单行 → 二次幂等 → v3/v4 迁移循环 | A/B/C 共 11 项 |
| SQL Server 2025 | 同上 + 嵌套事务提交/回滚 | A/B/C 共 11 项 |

- **SKIP 语义**：目标库不可达（连接被拒/认证失败）时，子进程打印 `SKIP: <原因>` 并以退出码 3 结束，矩阵汇总里显示 `⏭` 与原因，**不会静默算通过**。SKIP 不改变矩阵退出码（0），但会打印「存在 SKIP 项…未覆盖的方言不算通过」。
- **安全边界**：mysql/mssql 目标只允许建/删 `meeting_asr_ci_*` 一次性库（`assertSafeDbName()` 强制前缀，越界直接抛错），跑完 `DROP DATABASE`。

## 7. 待办边界（#54 / #55）

### #54：把运行时接到 `getKnex()`（本单不碰）

1. `server/db-shared.mjs` 的 `getDb()` 改为按 `DB_TYPE` 返回 `AsyncDb`，`new DatabaseSync()` 路径退役。
2. 114 处裸 SQL 的同步→异步改造（`.all/.get/.run` 加 `await`），`src/lib/admin-store.ts` 占 78 处是主战场。
3. `getKnex()` 成为唯一入口；`DB_TYPE` 真正生效（含启动期迁移与健康检查）。
4. 迁移期 `PRAGMA foreign_keys = OFF` 的语义在 mysql/mssql 上需要等价物（或不必要：MySQL/MSSQL 的 RENAME/DROP COLUMN 不受外键阻碍，knex 侧已按 `dbType` 分支处理）。

### #55：方言语法清零 + 三库 CI（本单只登记）

1. `ON CONFLICT` 7 处 → `insertIgnore()` / upsert 分支（`server/db/insert-ignore.mjs` 已有 mssql 分支）。
2. `INSERT OR IGNORE` 3 处 → 同上。
3. `PRAGMA table_info` 5 处 → `listTableColumns()`。
4. 大小写语义落地：按 §4.4 给 `account_name` 等敏感列声明二进制排序规则（或在应用侧规范化账号名），并把 `LIKE` 检索改 `LOWER()` 方案（§4.5）。
5. **嵌套 savepoint 缺陷**（§4.6）定位与修复。
6. 三库 CI：把 `npm run db:test-parity` 接进流水线（需要能起 mariadb/mssql 的 runner）。
