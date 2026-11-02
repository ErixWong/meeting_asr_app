# 数据库方言可移植性（SQLite / MariaDB / SQL Server）

> 状态：PR-B 阶段①（issue #53）产出，阶段②（issue #54）、阶段③（issue #55 / #55a / #55b）更新。
> **#55b 之后，业务 SQL 里的 SQLite 方言语法已清零**（逐条改前/改后见 §5），三库矩阵 12 项全绿，
> `DB_TYPE=mssql` 的真机链路（登录→建会议→转写落库→录音绑定→AI 标题→删除级联）已跑通。
> 但生产仍只用 SQLite：`DB_TYPE=mysql|mssql` 的验证级别是「一次性库 + 真机 e2e」，不是「已在生产跑过」。
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
- **`AsyncDb.prepare(sql)`** 提供与 `node:sqlite` 同形的 `.all/.get/.run`（异步版），占位符 `?` 由 knex 翻译成各库绑定语法（mssql → `@p0`，**实测可用**，见 §4.7）；`extractRows()` 已消化三库返回结构差异；`extractRunInfo()` 在 mssql 上原本拿不到受影响行数（#55 已修：同 batch 追加 `SELECT @@ROWCOUNT`，见 §4.8）。
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
| 本单是否已修 | ✅ 已修：走**驱动级事务 API**（`knex.transaction` → tedious `beginTransaction` / `commitTransaction` / `rollbackTransaction`）。#54 时是「事务期间把 `this.knex` 换成 `trx`」；**#55 起改成把 `trx` 作为回调参数显式传给调用方**（`withTransaction(async (tx) => …)`），实例级可变状态已删除，见 §4.6 |

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

### 4.6 实例级事务状态：**#55 已删除**（事务句柄显式传递 + 运行期防线）

#### 4.6.1 旧缺陷（#54 前的形态，已不再存在）

`AsyncDb` 的事务状态原本是**实例级可变状态**（`this.knex = trx`、`_txDepth`）。同步驱动时代所有事务天然串行，缺陷看不出来；异步化后同一实例上的并发事务会互踩：后进入者把 `this.knex` 改写成自己的 `trx`，先退出者又指回自己的 `outerKnex` ⇒ 语句落在事务之外却仍返回「成功」，或 savepoint 名撞车报 `no such savepoint: sp_1`。

#54 用「顶层事务串行化 + 深度改 `AsyncLocalStorage`」止血，但「用哪条连接」仍是实例级字段。

#### 4.6.2 现状（#55 D1/D2/D3）：句柄显式传递，实例级状态清零

| 项 | 现状 |
| --- | --- |
| 事务句柄 | `withTransaction(async (tx) => …)`，`tx` 是**绑定事务连接**的 AsyncDb 视图（`.prepare().all/get/run` / `.exec` / `.knex` / `.dbType`），可直接交给 `listTableColumns(tx, …)` 这类工具函数 |
| 实例级可变状态 | **已删除**：不再有 `this.knex = trx`。`AsyncDb` 实例的 `knex` 在生命周期内不变 |
| 运行期防线（D2） | 事务上下文（`transactionDepth > 0`）中在**普通 db** 上调用 `prepare` / `exec` / `withTransaction`（以及 `listTableColumns(db, …)`）**直接抛错**：`[DB] prepare() 在事务上下文里被调用，但用的是普通 db 句柄：事务内请使用回调传入的 tx，否则语句会落在事务连接之外…`。这是「漏改一处就静默写错库」的唯一硬闸 |
| 嵌套事务 | `tx.withTransaction(async (tx2) => …)`；三库统一走 knex 嵌套事务（sqlite/mysql `SAVEPOINT`、mssql `SAVE TRANSACTION`），**savepoint 一定发在事务连接上** ⇒ `no such savepoint: sp_1` 已修 |
| 串行锁职责 | 收窄为**跨事务互斥**（同一实例上的顶层事务排队，等价于同步驱动时代的串行语义）；sqlite 的语句级锁保留（单连接下语句否则会落进别人的事务）。锁不再负责连接路由 |
| 非事务语句落进别人事务 | **已关闭**：mssql 不再有 `this.knex = trx`，非事务语句一定走池连接；sqlite 仍由语句级锁兜住 |

**断言**（`scripts/db-tx-test.mjs`，`npm run db:test-tx`，已挂进 `db:test-parity` 矩阵）：
顶层提交 / 顶层回滚 / 嵌套内层回滚不影响外层 / **D2 防线（4 个入口全部抛错且文案含提示）** / 并发两个顶层事务不丢写 / 顶层事务串行化不交错 / 三库 affected-rows / 回调签名兼容。
反向证据（变异验证，见 `docs/tasks/active/feat-261101-06-db-tx-explicit/report.md` §变异）：
事务体内改用 `db.prepare` ⇒ 立即被 D2 抛错（`test:title` 4 条用例红）；关掉串行锁 ⇒ mariadb/mssql 的「不交错」断言立刻 FAIL。

> sqlite 的 `pool.max = 1` 本身就把并发事务排到同一条连接上，所以「串行化」这条在 sqlite 上关掉锁也观测不到差别——观测点是连接池 > 1 的 mariadb / mssql。

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

### 4.8 mssql 的 `extractRunInfo()`：**#55 已修**（同 batch 追加 `SELECT @@ROWCOUNT`）

- 原现象：`AsyncDb.prepare(sql).run(...)` 在 mssql 上**恒返回 `changes: 0`**，`deleteHotword()` / `updateMeetingStatus()` / 审计清理静默判错。
- **探针实测**（`DB_TYPE=mssql`，一次性库 `meeting_asr_ci_txprobe*`，原始输出见 `docs/tasks/active/feat-261101-06-db-tx-explicit/report.md`）：
  - `knex.raw("INSERT/UPDATE/DELETE …")` → **空数组 `[]`**（knex 的 mssql 方言不透传 tedious 的 `rowsAffected`）；事务内 `trx.raw(...)` 同样是 `[]`；
  - builder 形态：`.insert()` 返回 `[]`，`.update()` / `.del()` 返回 number；
  - 同一 batch 末尾追加 `\n; SELECT @@ROWCOUNT AS changes` → `[{ changes: 1 }]` / `[{ changes: 0 }]`；
  - 追加**必须换行**：SQL 末尾有 `-- 行注释` 时，同行的 SELECT 会被注释吞掉（不换行 → `[]`，换行 → `[{changes:1}]`）；语句本身以 `;` 结尾没问题。
- 实现：`server/db/async-db.mjs` 的 `appendRowCountSelect(sql)`，只作用于 `prepare(sql).run()` 的 mssql 分支（`.all/.get` 与 `exec` 的 SQL 文本不变）。
- 断言：`scripts/db-tx-test.mjs` 的 G1–G10（三库都跑）：INSERT=1、UPDATE 命中=1 / 不命中=0、DELETE 命中=1 / 不命中=0，事务内同样成立。

### 4.9 `LIMIT` —— MSSQL 不支持（#55b 新登记）

| 项 | 内容 |
| --- | --- |
| 现象原文 | `LIMIT 1` → `Incorrect syntax near 'LIMIT'`（`Msg 102`） |
| 触发条件 | 业务 SQL 里的 `LIMIT ?`（列表分页）与子查询 `ORDER BY ... LIMIT 1`（取最新一条） |
| 正确写法 | 子查询取单行 → `SELECT TOP 1 ...`；列表分页 → `ORDER BY ... OFFSET 0 ROWS FETCH NEXT n ROWS ONLY`（要求带 `ORDER BY`） |
| 本单是否已修 | ✅ 已修：`server/db/async-db.mjs` 的 `singleRowFragment()` / `limitFragment()`，调用点 3 处（`listAuditLogs` / `listMeetings` / `queryMeetingRowById`） |
| 附带约束 | 行数一律经 `normalizeRowLimit()` 白名单化成正整数后再拼进 SQL 文本（原来是 `?` 绑定参数，改后不再绑定，避免注入面） |

### 4.10 `ALTER TABLE ... ADD COLUMN` 与列类型 —— MSSQL 两处不兼容（#55b 新登记）

| 项 | 内容 |
| --- | --- |
| 现象原文 | `ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0` → MSSQL 报 `Incorrect syntax near the keyword 'COLUMN'`；去掉 `COLUMN` 后 `INTEGER` 又报类型不存在 |
| 触发条件 | `src/lib/admin-store.ts` 的 `ensureColumn()`（`migrateAuthSchema` 每次启动都跑），列探测原本是 SQLite 专属的 `PRAGMA table_info` |
| 正确写法 | 列探测走 `listTableColumns()`（三库）；`ADD` 后不带 `COLUMN`；类型 `INTEGER→INT` / `TEXT→NVARCHAR(MAX)` / `REAL→FLOAT` / `BLOB→VARBINARY(MAX)` |
| 本单是否已修 | ✅ 已修：`server/db/async-db.mjs` 的 `addColumnIfAbsent()` + `dialectColumnDefinition()`（sqlite/mysql 的 DDL 文本逐字不变） |

### 4.11 `UPDATE OR IGNORE` —— MSSQL / MySQL 都没有（#55b 新登记，工单未列）

| 项 | 内容 |
| --- | --- |
| 触发条件 | `src/lib/admin-store.ts` 的 legacy 角色迁移：`UPDATE OR IGNORE user_roles SET role_id = 新 WHERE role_id = 旧` |
| 语义 | 更新时若撞 `unique(user_id, role_id)` 就跳过该行（SQLite 的 `OR IGNORE` 冲突消解子句） |
| 跨库等价写法 | 逐行 `insertIgnore()` 插入新角色行 + 普通 `DELETE FROM user_roles WHERE role_id = 旧` + `DELETE FROM roles WHERE id = 旧` |
| 行为差异 | legacy 在「用户已有新角色」时把旧行留在表里，随后 `DELETE FROM roles` 会撞外键报错；新写法把重复旧行一并删掉（用户最终一定持有新角色，且旧角色删得掉） |
| 备注 | 该路径只在**老库同时存在 `minutes_admin` 与 `system_admin` 两个角色**时触发，全新库不可达；等价写法由 `db:test-dialect` 的 E1 用例在三库上验证 |

## 5. 裸 SQL 分布与方言点逐条

统计口径（可复现）：`grep -c '\.prepare(' <file>`（`.prepare(...)` 即一条裸 SQL 语句）。
注意这个口径含一处**误计**：`server/app-server.mjs` 的 1 处是 Next 的 `app.prepare()`，不是 SQL。

| 文件 | #54 之前 | #54 之后 | 说明 |
| --- | --- | --- | --- |
| `src/lib/admin-store.ts` | 78 | 79 | +1 是 `getDb()` 的 `AsyncDatabase` 类型注释里那行示例；SQL 语句数不变，全部补 `await`。**#55 后仍 79**（`(await getDb()).prepare` 换成 `tx.prepare`，计数不变） |
| `server/runtime-store.mjs` | 26 | 27 | +1 是 `statementsFor(database)` 里拆出的 `updateSession` 注释行；语句数不变。**#55 后仍 27** |
| `server/database-schema.mjs` | 6 | **0** | **文件已退役删除**（DDL/迁移并入 `server/db/schema.mjs`） |
| `server/db-shared.mjs` | 2 | 6 | 2 条业务（审计清理）+ 3 条 SQLite PRAGMA + 1 条 WAL 复核 |
| `server/tts-gateway.mjs` | 1 | 1 | 只补 `await` |
| `server/app-server.mjs` | 1 | 1 | 误计（Next `app.prepare()`） |
| **合计（含误计）** | **114** | **114** | 运行时 SQL 语句**一条没改语义**，只是换成 `await`；legacy 的 6 条 DDL 随文件退役 |

### 5.1 方言敏感语法清零台账（#55b，逐条）

改造后**业务 SQL 里已没有** `ON CONFLICT` / `INSERT OR IGNORE` / `INSERT OR REPLACE` /
`UPDATE OR IGNORE` / `PRAGMA table_info` / `LIMIT`（`grep` 实测为空，注释除外）。
实现集中在两个工具模块，调用点只传「表 + 行 + 冲突键 + 覆盖列」：

| 工具 | 位置 | 三方方言 |
| --- | --- | --- |
| `insertIgnore()` | `server/db/insert-ignore.mjs` | sqlite `INSERT OR IGNORE` / mysql `INSERT IGNORE` / mssql `INSERT ... SELECT ... WHERE NOT EXISTS`（受影响行数三库一致，mssql 走 `@@ROWCOUNT`） |
| `upsert()` | `server/db/insert-ignore.mjs` | sqlite `ON CONFLICT(keys) DO UPDATE` / mysql `ON DUPLICATE KEY UPDATE`（**不用**已弃用的 `VALUES()`）/ mssql `UPDATE ...; IF @@ROWCOUNT = 0 INSERT ...` |
| `addColumnIfAbsent()` | `server/db/async-db.mjs` | 列探测三库；`ADD COLUMN` 关键字与列类型（`INTEGER→INT` / `TEXT→NVARCHAR(MAX)`）按方言翻译 |
| `singleRowFragment()` / `limitFragment()` | `server/db/async-db.mjs` | sqlite/mysql `LIMIT n`；mssql 子查询 `TOP n`、列表 `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` |

逐条（文件:行号是**改造前**的位置）：

| # | 文件:行号 | 改前 SQL | 改后 | 三库实测 |
| --- | --- | --- | --- | --- |
| 1 | `src/lib/admin-store.ts:963` | `INSERT ... ON CONFLICT(item_section, item_mark) DO UPDATE SET item_title = excluded.item_title, ...` | `upsert(db,"app_settings",row,["item_section","item_mark"],[...])` | ✅ |
| 2 | `src/lib/admin-store.ts:989` | `ON CONFLICT(id) DO UPDATE SET template_* = excluded.*` | `upsert(db,"llm_prompt_templates",row,["id"],[...])`（`created_at` 不进覆盖列） | ✅ |
| 3 | `src/lib/admin-store.ts:1023` | `ON CONFLICT(id) DO UPDATE SET term/weight/status/note = excluded.*` | `upsert(db,"asr_hotwords",row,["id"],[...])` | ✅ |
| 4 | `src/lib/admin-store.ts:1891` | `ON CONFLICT(role_key) DO UPDATE SET role_name = excluded.role_name` | `upsert(db,"roles",row,["role_key"],["role_name"])` | ✅ |
| 5 | `server/runtime-store.mjs:37` | `ON CONFLICT(item_section, item_mark) DO NOTHING` | `insertIgnore(db,"app_settings",row,[...])` | ✅ |
| 6 | `server/runtime-store.mjs:220` | `ON CONFLICT(capture_session_id) DO UPDATE SET task_id/asr_provider/... = excluded.*` | `upsert(db,"asr_capture_sessions",row,["capture_session_id"],[...])` | ✅ |
| 7 | `server/runtime-store.mjs:612` | `ON CONFLICT(capture_session_id) DO UPDATE SET raw_file_path/sample_rate, status='recording', error_message=NULL, ...` | `upsert(...,[...,{column:"status",literal:"'recording'"},{column:"error_message",literal:"NULL"},...])` | ✅ |
| 8 | `src/lib/admin-store.ts:944` | `INSERT OR IGNORE INTO app_settings (...)` | `insertIgnore(db,"app_settings",row,["item_section","item_mark"])` | ✅ |
| 9 | `src/lib/admin-store.ts:1644` | `INSERT OR IGNORE INTO user_roles (...)`（`setUserRoleKeys`） | `insertIgnore(db,"user_roles",row,["user_id","role_id"])` | ✅ |
| 10 | `src/lib/admin-store.ts:1975` | `INSERT OR IGNORE INTO user_roles (...)`（`seedIdentityDefaults`） | 同上 | ✅ |
| 11 | `src/lib/admin-store.ts:1969` | `UPDATE OR IGNORE user_roles SET role_id = ? WHERE role_id = ?`（legacy `minutes_admin` 迁移；**工单未列**） | 逐行 `insertIgnore` 到新角色 + 普通 `DELETE` 旧行 | ✅ |
| 12 | `src/lib/admin-store.ts:627` | `PRAGMA table_info(<table>)`（`ensureColumn`，**每次启动**都跑） | `addColumnIfAbsent(db, table, column, definition)` | ✅ |
| 13 | `src/lib/admin-store.ts:1759` | `ORDER BY created_at DESC LIMIT ?`（`listAuditLogs`） | `... ${limitFragment(db.dbType, limit)}` | ✅ |
| 14 | `src/lib/admin-store.ts:2829` / `:2865` | 子查询 `ORDER BY ... LIMIT 1`（`listMeetings` / `queryMeetingRowById`；**工单未列**） | `(SELECT ${top}... ORDER BY ... ${limit})` | ✅ |

`INSERT OR REPLACE`：**业务代码 0 处**（工单快照记 1 处；实测只有 3 处注释提到它，真正的 REPLACE
已在 #52 的记账改造中删除）。**结论：无待改代码点。**

保留的 `PRAGMA`（都是 SQLite 专属分支，不构成方言泄漏）：`server/db-shared.mjs` 的 3 条连接级
PRAGMA（`dbType !== "sqlite"` 直接 return）、`server/db/index.mjs` 的 3 条连接优化 PRAGMA
（只建 sqlite 实例时下发）、`server/db/schema.mjs` 迁移期 `PRAGMA foreign_keys = OFF/ON`
（`dbType === "sqlite"` 分支）。测试夹具 `scripts/audio-test.mjs` 的 `PRAGMA` 只在 sqlite 上跑。

## 6. 三库测试脚手架（#53 新增，#54 扩展，#55 加事务套件，#55b 加方言语法套件）

```bash
# 全矩阵：sqlite（better-sqlite3 生产入口）+ mariadb + mssql，每个目标跑 4 个 job（共 12 项）
npm run db:test-parity

# 单方言
npm run db:test-semantic                     # 语义锁（默认 sqlite）
npm run db:test-tx                           # 事务句柄/affected-rows（默认 sqlite；--dialect 单方言）
DB_TYPE=mssql DB_HOST=... DB_USER=sa DB_PASSWORD=... npm run db:test-schema -- --dialect

# 确认要放行 SKIP（例如本机暂时没有 mssql 靶子）
npm run db:test-parity -- --allow-skip
```

**参数只有三个**：`--matrix` / `--dialect` / `--allow-skip`。**未知参数不会被静默忽略**——直接报错退出（退出码 2）并打印可用参数列表（此前传 `--strict` 会什么都不发生，属于「沉默成功」类缺陷，已修）。

- 宿主机 node 是 v22，跑不了 `node:sqlite` → 一律在 `node:24-slim` 容器里跑（完整命令见 `docs/tasks/active/feat-261101-03-db-dialect-parity-phase1/report.md`）。
- **容器到宿主的可达性**：mssql 发布在 `0.0.0.0:1433`，容器用 `--add-host=host.docker.internal:host-gateway` + `host.docker.internal:1433`；**mariadb 只发布在 `127.0.0.1:3306`（loopback-only），`host.docker.internal` 打不通**，容器必须挂到 `prod` 网络并用容器名 `mariadb:3306`。
- 覆盖矩阵（#54 之后只剩一条实现路径，所有目标都打**生产入口**）：

| 目标 | schema/迁移套件 | 语义锁 | 事务句柄/affected-rows | 方言语法（#55b） |
| --- | --- | --- | --- | --- |
| sqlite（生产入口 `getDb()` → `better-sqlite3`） | 场景 1/2/4/4b/5（幂等、污染库收敛、并发）+ **5b 事务并发回归** + 3（v0 旧库迁移）+ **3b 去重/孤儿丢弃** + 6/7/8（生产入口：单例、WAL/busy_timeout/外键、污染库收敛、两模块图并发） | A/B/C 共 11 项 | A–H 共 20 项 | A–E 共 14 项 |
| mariadb 11.7 | 基线建表 → 建索引 → 迁移 → 记账单行 → 二次幂等 → v3/v4 迁移循环 + 事务并发回归 + **生产入口 getDb() 初始化** | A/B/C 共 11 项 | A–H 共 20 项 | A–E 共 14 项 |
| SQL Server 2025 | 同上 + 嵌套事务提交/回滚 | A/B/C 共 11 项 | A–H 共 20 项 | A–E 共 14 项 |

> #55a 起矩阵从 6 项变 **9 项**（每个目标多一个「事务句柄/affected-rows」job）；
> #55b 起再变 **12 项**（每个目标多一个「方言语法」job，`scripts/db-dialect-test.mjs`）。

- **#54 的关键变化：`db:test-schema` 打的就是运行时那条**。`getDb()`（`server/db-shared.mjs`）是唯一入口，脚本不再直连 `node:sqlite`；`--dialect`/`--matrix` 额外跑一步「生产入口 `getDb()` 在本方言上初始化」，这就是 #54 对 mysql/mssql 的「初始化 + 冒烟可跑通」。
- **事务并发回归**（#54 新增，三库都跑）：见 §4.6.1 的四条断言（#55 起嵌套断言也从「只在 mssql」放开到三库）。
- **事务句柄/affected-rows 套件**（#55 新增，`scripts/db-tx-test.mjs`，三库都跑）：顶层提交/回滚、嵌套 savepoint、**D2 防线**、并发不丢写、串行化不交错、affected-rows（含事务内）、回调签名兼容。
- **方言语法套件**（#55b 新增，`scripts/db-dialect-test.mjs`，`npm run db:test-dialect`，三库都跑）：
  直接 import 生产用的 `insertIgnore()` / `upsert()` / `addColumnIfAbsent()`（**不复制 SQL 文本**），
  A 插入忽略（首次生效 / 重复忽略 / 批量部分重复）、B upsert（不存在则插入 / 只覆盖指定列 /
  `{column, literal}` 字面量覆盖）、C 列探测 + 幂等补列（含 `INTEGER NOT NULL DEFAULT 0` 的方言翻译）、
  D 分页与单行片段（`LIMIT n` vs `TOP n`）、E 角色迁移等价写法，共 14 条断言。
- **CI workflow**（#55b 新增，`.github/workflows/db-parity.yml`）：`services: mariadb:11.7 + mssql 2025`，
  先跑 `scripts/probe-db-targets.mjs` 探活（带重试，把「service 没起来」和「代码坏了」分开），
  再跑 `npm run db:test-parity`，最后 `scripts/check-db-leftovers.mjs` 复核共享实例无残留。
  ⚠ **本机没有 GitHub runner，这份 workflow 未被执行过**；本机主门禁仍是本地矩阵。
  两个辅助脚本本身在本机可跑，且已用真实例验证（探活 2/2、残留 0）。
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

### #55：方言语法清零 + 三库 CI

**#55a（本单，已完成）**：第 5 项（事务句柄显式传递 + 运行期防线 + 嵌套 savepoint）与第 7 项（mssql 受影响行数）、第 9 项（非事务语句落进别人事务）。

1. ✅ `ON CONFLICT` 7 处 → `insertIgnore()` / `upsert()`（#55b 完成，逐条见 §5.1）。
2. ✅ `INSERT OR IGNORE` 3 处 → `insertIgnore()`（#55b 完成）。顺带清掉工单未列的 `UPDATE OR IGNORE` 1 处（§4.11）。
3. ✅ `PRAGMA table_info` → `addColumnIfAbsent()`（#55b 完成；legacy 文件删除后业务侧只剩 `ensureColumn` 1 处）。
4. ⏳ 大小写语义落地：按 §4.4 给 `account_name` 等敏感列声明二进制排序规则（或在应用侧规范化账号名），并把 `LIKE` 检索改 `LOWER()` 方案（§4.5）。**#55b 未做**（仍只有语义锁断言钉住差异，没有落地到 DDL）。
5. ✅ **实例级事务状态**（§4.6）：① sqlite/mysql 的嵌套 savepoint 缺陷；② mssql 的 `this.knex = trx` 在并发事务下互踩。已改为「事务句柄显式传递 + D2 运行期防线」，实例字段清零。
6. ✅ 三库 CI：`.github/workflows/db-parity.yml`（#55b 写好，**未在 runner 上跑过**；本机主门禁仍是本地矩阵）。
7. ✅ **mssql 的受影响行数**（§4.8）：同 batch 追加 `SELECT @@ROWCOUNT AS changes`，三库断言在 `db:test-tx` 的 G1–G10。
8. ⏳ **`?` 的字面量约束 + 类型严格性**（§4.7）：SQL 文本里不能出现字面量 `?`；mssql 不做隐式类型转换。
   **#55b 未做**（仍无方言级断言；`?` 字面量当前全仓 0 处，属潜在约束）。
9. ✅ **mysql/mssql 的非事务语句可能落进别人的事务**：`this.knex = trx` 已删除，非事务语句不再被带进事务。

## 8. #55b 的两个结论（留给后续，别重犯）

### 8.1 `AsyncDb.transactionDepth` 是**双承重**：既是 D2 防线判据，又是语句级串行锁的重入放行条件

| 承重 | 位置 | 拿掉会怎样 |
| --- | --- | --- |
| D2 运行期防线 | `server/db/async-db.mjs` 的 `_assertTransactionHandle()`：`transactionDepth > 0 && !isTransactionHandle` ⇒ 抛错 | 事务内误用普通 `db` 不再抛错，语句静默落在事务连接之外（#55a 的硬闸失效） |
| 语句级串行锁放行 | 同文件的 `_serializeStatement()`：`dbType === "sqlite" && transactionDepth > 0` ⇒ **跳过加锁**直接执行 | sqlite 是单连接：事务内的语句若再抢同一把实例锁，会**自锁**（#55b 前的实测：把深度恒置 0 → `db:test-tx` 挂死、`timeout` 打出 exit 124） |

**结论（#55b 未动串行化策略，原样保留）**：想改「事务内语句跳过串行锁」这条，必须同时保住
D2 防线（否则漏改一处就静默写错库），或者给锁换成可重入实现；只把 `transactionDepth` 当鉴权位
去「顺手清零」会直接自锁。改动时的最小验证集：`npm run db:test-tx`（D2 四入口 + 串行化不交错 +
affected-rows）必须三库全绿。

### 8.2 `DB_TYPE=mssql` 真机链路已验证到哪一步

一次性库 `meeting_asr_ci_e2e_*` + 真 HTTP 服务（`node server/app-server.mjs`，端口 `:3197`）跑通：
登录 → 建会议（`withTransaction`）→ 转写落库 → 录音行绑定（`meeting_id` 写入、`expires_at` 置 NULL）
→ AI 标题（LLM 用本地 OpenAI 兼容 stub 顶替，见下）→ 删除级联（子表 0 行、磁盘文件删除）。
`meeting_asr_ci_*` 库与文件收尾已清空。

⚠ **AI 标题这一步的 LLM 是 stub**：本机可用的真实端点全部不可达（生产 `app_settings` 指向的
`http://host.docker.internal:8008/v1` 已停；`api.ai.erix.vip` 与 `api.deepseek.com` 用现有 key 均 401）。
所以真机链路证明的是「HTTP → admin-store → LLM 客户端 → `meeting_llm_results` 落库 → 会议改名」这条
路径在三库方言上成立，**不是**「真实模型的输出质量」。
