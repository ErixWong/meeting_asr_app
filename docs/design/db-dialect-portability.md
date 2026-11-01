# 数据库方言可移植性（SQLite / MariaDB / SQL Server）

> 状态：PR-B 阶段①（issue #53）产出，阶段②（issue #54）更新。**本文件记录的是实测事实与待办边界，不是「已支持多库」的声明。**
> 生产目前仅 SQLite 经过真机验证；`DB_TYPE=mysql|mssql` 已能「初始化 + 冒烟」（三库 CI 绿），
> 但业务 SQL 的方言语法清零归 #55（见文末「待办边界」）。

## 1. 现状：#54 之后只剩**一条**数据库访问路径

| 路径 | 入口 | 驱动 | 谁在用 |
| --- | --- | --- | --- |
| **唯一路径（#54 起）** | `server/db-shared.mjs` 的 `getDb()` → `getKnex()` → `server/db/async-db.mjs` 的 `AsyncDb` → `server/db/schema.mjs` 的 `initializeSchema()` | `better-sqlite3` / `mysql2` / `tedious`（`DB_TYPE` 决定） | 全部运行时业务代码（Next 服务端 + `server/*.mjs`）与全部脚本 |
| ~~legacy~~ | ~~`server/database-schema.mjs` 的 `initializeDatabase()`~~ | ~~`node:sqlite`（同步）~~ | **#54 已退役并删除该文件** |

**`DB_TYPE` 现在真的生效**（默认 `sqlite`）。运行时形态：`const db = await getDb(); await db.prepare(sql).all(...)`。
初始化（建表 + 迁移 + 索引）由 `server/db/schema.mjs` 单一实现承担，single-flight 挂在 `globalThis` 上
（生产是**一个进程两个模块图**：`server/app-server.mjs` 与 Next 打包的服务端代码各 import 一份，
模块作用域互不可见，挂 globalThis 才能让两边共享同一个初始化 promise，否则并发建表会撞
`table ... already exists`）。

### 1.1 同一 DB 文件禁止混用两种 SQLite 驱动（#54 实测的新约束）

`node:sqlite`（`DatabaseSync`）与 `better-sqlite3` **交替写同一个库文件**时，WAL 会变得对彼此不可读：

| 步骤 | 结果 |
| --- | --- |
| A：`DatabaseSync` 写一行 → 关连接 | ✅ |
| B：knex(`better-sqlite3`) 事务里再写一行 → COMMIT | ✅ knex 自己读得到 |
| C：新的 `DatabaseSync` 连接读 | ❌ **看不到 B 写的行** |
| C'：新的 `better-sqlite3` 连接读 | ❌ `SqliteError: disk I/O error (SQLITE_IOERR_SHORT_READ)` |

结论：**生产与所有脚本/备份工具必须单驱动**（生产 = `better-sqlite3`）。`scripts/ai-title-test.mjs`
原先用 `node:sqlite` 直连断言，已在本单改成 `better-sqlite3`。这条直接影响 #56 的备份脚本
（`VACUUM INTO` 之类必须用 `better-sqlite3` 调）。

## 2. 已实证的可移植性（这些是资产，别推翻）

- **ID 全应用侧生成**：主键一律 `string(64)` 存应用侧生成的字符串 ID，**没有一处自增**（`t.string("id", 64).primary()` / `t.primary([...])` 复合主键），跨库无 `IDENTITY`/`AUTO_INCREMENT` 差异。
- **时间戳统一 `TEXT` 存 ISO8601 字符串**（`string(32)`），不依赖数据库时间类型/时区转换；knex 工厂对 mysql 显式 `dateStrings: true` + `timezone: "Z"` 保持同一语义。
- **SQL 里 0 处** `strftime` / `julianday` / `datetime()` / `GROUP_CONCAT` / `json_extract`（全仓 grep 实测，含 legacy DDL 与业务 SQL）。
- **`server/db/insert-ignore.mjs`** 已实现 mssql 分支：`INSERT INTO t SELECT ... WHERE NOT EXISTS(...)`（knex 的 `onConflict().ignore()` 不支持 mssql 客户端）；sqlite/mysql 走 `onConflict(keys).ignore()`。
- **`AsyncDb.prepare(sql)`** 提供与 `node:sqlite` 同形的 `.all/.get/.run`（异步版），占位符 `?` 由 knex 翻译成各库绑定语法（mssql → `@p0`，**实测可用**，见 §4.7）；`extractRows()` 已消化三库返回结构差异，`extractRunInfo()` 在 mssql 上有已知缺口（见 §4.8）。
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

### 4.6 实例级事务状态：#54 已用「串行化」止血，#55 仍需「显式传递 trx」终解

`AsyncDb` 的事务状态原本是**实例级可变状态**（`this.knex = trx`、`_txDepth`）。同步驱动时代所有事务天然串行，缺陷看不出来；异步化后同一实例上的并发事务会互踩（后进入者把 `this.knex` 改写成自己的 `trx`，先退出者又指回自己的 `outerKnex` ⇒ 语句落在事务之外却仍返回「成功」，或 savepoint 名撞车）。

#### 4.6.1 现状（#54 已修的部分）

- **同一实例上的顶层事务串行化**：`AsyncDb.withTransaction()` 的顶层事务走 `_serialize()` 排队（后进者等前一个 settle 再进入），等价于同步时代的串行语义。嵌套层**不排队**（它本来就在外层事务的异步上下文里，排队会自锁），只按深度开 savepoint。
- **事务深度从实例字段改为 AsyncLocalStorage**（`_txContext`）：深度按**异步上下文**隔离，savepoint 名 `sp_<depth>` 不再被并发事务撞车。这是 §4.6.1 原缺陷（`no such savepoint: sp_1`）的根因修复。
- **SQLite 单连接语义保持**：SQLite 的 `pool.max = 1`，事务未提交时其他请求的普通语句会落进这个事务（同一个连接）。为保持「同步驱动时代语句不会插进别人事务」的语义，sqlite 下**语句执行也走同一把锁**（事务内直接放行，靠 `_txContext` 判重入）。
- **断言**：`scripts/db-schema-test.mjs` 的「事务并发回归」套件真跑四条（sqlite + mariadb + mssql 三库都跑）：
  ① 两个并发顶层事务都提交且互不丢失；② 并发下嵌套事务内层抛错只回滚内层；③ 并发下不出现 savepoint 报错；④（sqlite）事务回滚不吞掉并发的非事务写入。
  **反向证据**：把串行化关掉后，同一用例立刻 FAIL（`BEGIN - cannot start a transaction within a transaction`）；把改动前的实现（实例级 `_txDepth` + 无串行化）拿来跑同一用例，报的正是 `ROLLBACK TO SAVEPOINT sp_1 - no such savepoint: sp_1`。

#### 4.6.2 仍然存在的缺口（归 #55，本单不修）

- **串行化是权宜，显式传递 `trx` 才是终解**：`this.knex = trx` 仍是实例级可变状态。串行化只保证「同一时刻只有一个顶层事务」，但**非事务语句**在 mssql 下仍会被 `this.knex = trx` 带进事务（并发请求的普通写可能随别人的事务一起回滚）。sqlite 由语句级锁兜住了；**mysql / mssql 没有**（连接池 > 1，语句可能落在别人的事务连接之外/之内，取决于方言实现）。
- 正解：把事务句柄（`trx`）作为参数/上下文显式传递，不再存在实例字段上；届时 §4.6 整节可以删除。这也是 #55 的输入。
- 并发事务的**吞吐**：sqlite 下所有语句串行（等价于同步时代），mssql/mysql 只串行事务本身。

### 4.7 mssql 的位置参数 `?`：**实测可用**（与 #53 工单假设相反）

#53 的待办里写「knex 的 mssql 方言走 `sp_executesql` + 命名绑定，`?` 不会被自动翻译」。**#54 实测证伪**：knex 会把 `?` 顺序翻译成 `@p0`、`@p1`…，位置绑定与顺序都正确。

| 探针（`DB_TYPE=mssql`，一次性库 `meeting_asr_ci_qprobe*`） | 结果 |
| --- | --- |
| `INSERT ... VALUES (?,?,?,?,?,?)` 6 参数 | ✅ 成功 |
| 读回校验绑定顺序 | ✅ `{item_section:"p", item_mark:"k", item_title:"标题", item_value:"值"}` |
| `UPDATE ... SET a = ? WHERE b = ?` | ✅ 成功 |
| `WHERE col IN (?, ?)` | ✅ 成功（命中 1 行） |
| `WHERE int_col = ?` 传数字 | ❌ `Conversion failed when converting the nvarchar value 'k' to data type int.`（**这是 SQL Server 的类型严格性，不是 `?` 的问题**：把字符串绑到 int 列会报错；SQLite 会隐式转换） |
| `WHERE col = ?` 传 `null` / `true` | ✅ 不报错（`= NULL` 语义照旧不命中） |
| SQL 里带**字面量** `?`（如 `SELECT '?' AS q ... ?`） | ❌ `Expected 1 bindings, saw 2`（knex 把字面量里的 `?` 也数成占位符） |
| 多语句 `db.exec("SELECT 1; SELECT 2")`（无参数） | ✅ 不报错 |

结论与影响面：
- **`?` 本身不是 mssql 的阻塞项**，不需要在 `AsyncDb` 层统一翻译，也不需要把 114 处调用点改 builder。**本单不修任何 `?`**。
- 真实需要盯的两条（**归 #55**）：
  1. **SQL 文本里不能出现字面量 `?`**（字符串/注释里也不行）。全仓 grep 目前 **0 处**（`grep -rn "'?'\|\"?\"" src/lib server scripts` 为空），属于**潜在**约束，写新 SQL 时要注意。
  2. **类型严格性**：mssql 不做 SQLite 那种隐式类型转换（数字列传字符串会报 `Conversion failed`）。生产代码目前一律按列类型传值（`Number(...)` / 字符串），但没有方言级断言，属 #55 的三库业务回归范畴。

### 4.8 mssql 的 `extractRunInfo()` 拿不到受影响行数（#55 的阻塞项）

- 现象：`AsyncDb.prepare(sql).run(...)` 在 mssql 上**恒返回 `changes: 0`**。实测 `knex.raw("INSERT ...")` / `UPDATE` / `DELETE` 在 mssql 下返回的是**空数组 `[]`**（knex 的 mssql 方言不把 tedious 的 `rowsAffected` 透传出来），`extractRunInfo()` 因此取到 `{}` → `Number(undefined ?? 0) === 0`。
- 影响（mssql 上会**静默判错**，不报错）：
  - `src/lib/admin-store.ts` 的 `deleteHotword()` → `Number(result.changes ?? 0) > 0` 恒为 false；
  - `updateMeetingStatus()` → `if (Number(result.changes ?? 0) === 0) throw ...` 恒抛「状态已被改动」；
  - `cleanupExpiredAuditLogs()` 返回值恒 0（日志里永远显示清理 0 条）。
- 建议解法（#55，本单不修）：mssql 分支把语句改写成同一 batch 里追加 `; SELECT @@ROWCOUNT AS changes`，从 `recordsets` 里取；或对 DML 改用 knex builder（`.update()/.delete()` 返回 rowCount）。
- 本单的取证边界：只证明「`?` 能跑通 + 受影响行数拿不到」，**mssql 业务路径没有端到端跑过**（#54 对 mysql/mssql 的要求只有「初始化 + 冒烟」）。

## 5. 裸 SQL 分布与方言点逐条

统计口径（可复现）：`grep -c '\.prepare(' <file>`（`.prepare(...)` 即一条裸 SQL 语句）。
注意这个口径含一处**误计**：`server/app-server.mjs` 的 1 处是 Next 的 `app.prepare()`，不是 SQL。

| 文件 | #54 之前 | #54 之后 | 说明 |
| --- | --- | --- | --- |
| `src/lib/admin-store.ts` | 78 | 79 | +1 是 `getDb()` 的 `AsyncDatabase` 类型注释里那行示例；SQL 语句数不变，全部补 `await` |
| `server/runtime-store.mjs` | 26 | 27 | +1 是 `statementsFor(database)` 里拆出的 `updateSession` 注释行；语句数不变 |
| `server/database-schema.mjs` | 6 | **0** | **文件已退役删除**（DDL/迁移并入 `server/db/schema.mjs`） |
| `server/db-shared.mjs` | 2 | 6 | 2 条业务（审计清理）+ 3 条 SQLite PRAGMA + 1 条 WAL 复核 |
| `server/tts-gateway.mjs` | 1 | 1 | 只补 `await` |
| `server/app-server.mjs` | 1 | 1 | 误计（Next `app.prepare()`） |
| **合计（含误计）** | **114** | **114** | 运行时 SQL 语句**一条没改语义**，只是换成 `await`；legacy 的 6 条 DDL 随文件退役 |

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

## 6. 三库测试脚手架（#53 新增，#54 扩展）

```bash
# 全矩阵：sqlite（node:sqlite legacy + better-sqlite3 两驱动）+ mariadb + mssql
npm run db:test-parity

# 单方言
npm run db:test-semantic                     # 语义锁（默认 sqlite）
DB_TYPE=mssql DB_HOST=... DB_USER=sa DB_PASSWORD=... npm run db:test-schema -- --dialect

# 确认要放行 SKIP（例如本机暂时没有 mssql 靶子）
npm run db:test-parity -- --allow-skip
```

**参数只有三个**：`--matrix` / `--dialect` / `--allow-skip`。**未知参数不会被静默忽略**——直接报错退出（退出码 2）并打印可用参数列表（此前传 `--strict` 会什么都不发生，属于「沉默成功」类缺陷，已修）。

- 宿主机 node 是 v22，跑不了 `node:sqlite` → 一律在 `node:24-slim` 容器里跑（完整命令见 `docs/tasks/active/feat-261101-03-db-dialect-parity-phase1/report.md`）。
- **容器到宿主的可达性**：mssql 发布在 `0.0.0.0:1433`，容器用 `--add-host=host.docker.internal:host-gateway` + `host.docker.internal:1433`；**mariadb 只发布在 `127.0.0.1:3306`（loopback-only），`host.docker.internal` 打不通**，容器必须挂到 `prod` 网络并用容器名 `mariadb:3306`。
- 覆盖矩阵（#54 之后只剩一条实现路径，所有目标都打**生产入口**）：

| 目标 | schema/迁移套件 | 语义锁 |
| --- | --- | --- |
| sqlite（生产入口 `getDb()` → `better-sqlite3`） | 场景 1/2/4/4b/5（幂等、污染库收敛、并发）+ **5b 事务并发回归** + 3（v0 旧库迁移）+ **3b 去重/孤儿丢弃** + 6/7/8（生产入口：单例、WAL/busy_timeout/外键、污染库收敛、两模块图并发） | A/B/C 共 11 项 |
| mariadb 11.7 | 基线建表 → 建索引 → 迁移 → 记账单行 → 二次幂等 → v3/v4 迁移循环 + 事务并发回归 + **生产入口 getDb() 初始化** | A/B/C 共 11 项 |
| SQL Server 2025 | 同上 + 嵌套事务提交/回滚 | A/B/C 共 11 项 |

- **#54 的关键变化：`db:test-schema` 打的就是运行时那条**。`getDb()`（`server/db-shared.mjs`）是唯一入口，脚本不再直连 `node:sqlite`；`--dialect`/`--matrix` 额外跑一步「生产入口 `getDb()` 在本方言上初始化」，这就是 #54 对 mysql/mssql 的「初始化 + 冒烟可跑通」。
- **事务并发回归**（#54 新增，三库都跑）：见 §4.6.1 的四条断言。
- **场景 3b**（#54 新增）：从已删除的 `tests/verify-migration.mjs` 折叠进来的「重复版本去重保留最新 / 孤儿 `llm_result` 丢弃 / 孤儿 `send_record` 丢弃 / 无空 `meeting_id` / 二次幂等 / 全新库直接新结构 + 索引」。
- **脚本入口必须自己关池**（#54 交付项）：`db-smoke` / `db-schema-test` / `db-semantic-test` / `audio-test` / `ai-title-test` 都必须在收尾释放 knex 连接池（`db.destroy()` / `closeDb()`），否则进程挂着句柄不退出（cron/CI 里就是「永远跑不完」）。断言方式：`timeout 60 node scripts/db-smoke.mjs` 自行退出且退出码 0。

- **SKIP 语义（默认严格）**：目标库不可达（连接被拒/认证失败）时，子进程打印 `SKIP: <原因>` 并以退出码 3 结束；矩阵汇总里显示 `⏭` 与原因，**并且退出码非 0**（`[matrix] ❌ 存在 SKIP 项，未覆盖的方言不算通过`，同时列出被跳过的具体项）。
  - 为什么必须这样：外部靶子偶发不可达时，矩阵会打出 `PASS 2 / SKIP 4 / FAIL 0` —— 若退出码为 0，CI 会「绿着过关」但**实际只测了 sqlite**，是最难发现的沉默成功。默认严格就是为了掐死这一形态。
  - 确需放行（本机暂时没有 mssql/mariadb 靶子）：显式追加 `--allow-skip`，此时退出码 0，汇总行改为 `⏭ 存在 SKIP 项，已由 --allow-skip 显式放行`。
  - 矩阵**不向子进程透传 `--allow-skip`**：子进程的 SKIP 永远以退出码 3 上报，避免被误判成 PASS。
- **安全边界**：mysql/mssql 目标只允许建/删 `meeting_asr_ci_*` 一次性库（`assertSafeDbName()` 强制前缀，越界直接抛错），跑完 `DROP DATABASE`。

## 7. 待办边界（#54 / #55）

### #54：把运行时接到 `getKnex()`（**已完成**）

1. ✅ `server/db-shared.mjs` 的 `getDb()` 改为 `getKnex()` → `AsyncDb`，`new DatabaseSync()` 路径退役，`server/database-schema.mjs` 删除。
2. ✅ 114 处裸 SQL 同步→异步（补 `await` + 沿调用链传导到 `src/app/api/**`）。
3. ✅ `getKnex()` 成为唯一入口；`DB_TYPE` 真正生效（建表 + 迁移 + 索引 + SQLite PRAGMA 条件化）。
4. ✅ 迁移期 `PRAGMA foreign_keys = OFF/ON` 只在 `dbType === "sqlite"` 时下发（mysql/mssql 的 RENAME/DROP COLUMN 不受外键阻碍）。
5. ✅ `next.config.mjs` 加 `serverExternalPackages: ["knex","better-sqlite3","mysql2","tedious"]`（否则 webpack 静态解析 knex dialects 会撞未安装的可选驱动，build 失败）。

### #55：方言语法清零 + 三库 CI（本单只登记）

1. `ON CONFLICT` 7 处 → `insertIgnore()` / upsert 分支（`server/db/insert-ignore.mjs` 已有 mssql 分支）。
2. `INSERT OR IGNORE` 3 处 → 同上。
3. `PRAGMA table_info` 5 处 → `listTableColumns()`。
4. 大小写语义落地：按 §4.4 给 `account_name` 等敏感列声明二进制排序规则（或在应用侧规范化账号名），并把 `LIKE` 检索改 `LOWER()` 方案（§4.5）。
5. **实例级事务状态**（§4.6，两条同根因，必须一并解决）：① sqlite/mysql 的嵌套 savepoint 缺陷；② mssql 分支的 `this.knex = trx` / `_txDepth` 在并发事务下互踩（语句可能落在事务之外且不报错）。正解是把 `trx` 显式传递而不是存实例字段。
6. 三库 CI：把 `npm run db:test-parity` 接进流水线（需要能起 mariadb/mssql 的 runner）。
7. **mssql 的受影响行数**（§4.8）：`extractRunInfo()` 在 mssql 恒 0，`deleteHotword` / `updateMeetingStatus` / 审计清理会静默判错。
8. **`?` 的字面量约束 + 类型严格性**（§4.7）：SQL 文本里不能出现字面量 `?`；mssql 不做隐式类型转换。
9. **mysql/mssql 的非事务语句可能落进别人的事务**（§4.6.2 剩余缺口）：`this.knex = trx` 的实例级状态在连接池 > 1 的方言上没有语句级锁兜底。
