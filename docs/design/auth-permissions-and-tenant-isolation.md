# 权限模型与会议数据隔离设计

> 沉淀自 `docs-260804-01-code-audit`。描述角色模型、会议数据按用户隔离、数据访问分层与密码生命周期策略，以及后续改动必须遵守的约束。

## 角色模型

### 1. 二元角色：`user` / `system_admin`

- 删除了历史 `minutes_admin` 角色；启动时将遗留 `minutes_admin` 关联用户迁移为 `system_admin`，然后删除旧角色。
- **约束**：
  - 新增角色需同时评估 API 守卫常量（`src/lib/api-auth.ts` 的 `ADMIN_ROLES` / `BUSINESS_ROLES`）与前端守卫（`roles.includes(...)`）。
  - 普通业务端点（会议/配置/模板读取）守卫用 `BUSINESS_ROLES = ["user", "system_admin"]`；管理端点一律 `ADMIN_ROLES = ["system_admin"]`。
  - 后端为唯一权限裁决点，前端角色判断仅用于隐藏入口与减少无效请求。

### 2. bootstrap admin 保护

- `user-admin` 不可被停用、不可失去 `system_admin`（`ensureUserChangeAllowed`，前后端双保险）。
- 用户列表接口必须走 `listUsers` 的授权路径，禁止直接暴露全量用户给非管理员。

## 会议数据隔离

### 3. 所有者边界：`created_by_user_id`

- 会议在创建时写入创建者 `created_by_user_id`；所有会议相关读取/变更/删除均以"当前 actor 是否所有者"为唯一判定，**非所有者一律返回 404（不区分"存在但无权"）**，避免资源枚举。
- **约束**：新增任何按会议 id 查询/写库的函数，都必须先过所有者检查或显式选择无检查的内部变体（见第 4 节）；管理员同样受隔离（无全局会议视图）。

### 4. 数据访问分层：`getMeetingById` vs `getMeetingRowById`

| 函数 | 行为 | 使用场景 |
|------|------|----------|
| `getMeetingById(id)` | 先所有者检查（无 actor 上下文则抛错），再读行 | 所有 API 入口读取 |
| `getMeetingRowById(id)` | 无 actor 依赖，直接读行 | 内部状态流转（`updateMeetingStatus` 等），未来后台任务可安全调用 |

- **约束**：`getMeetingById` 不持有数据库连接句柄透传，保持分层简洁；内部状态更新函数不得隐式依赖请求上下文（AsyncLocalStorage actor），否则后台任务/cron 会直接崩溃。

### 5. 会议列表/详情 SQL 约定

- 列表与详情共用 `MEETING_ROW_SELECT` 常量：用关联子查询取**最新一条** ASR 结果与最新成功纪要（`meeting_llm_results` 经 `meeting_asr_results` 关联到会议），禁止外层 `LEFT JOIN meeting_asr_results`（会产生按 ASR 行数展开的重复行）。
- `rawPayload` 经 `parseJsonOr` 解析，取 `segments ?? transcriptSegments` 作为 transcript。

## 密码生命周期

### 6. 创建与重置统一强制改密

- 创建用户：`must_change_password = 1`（首登强制改密）。
- 管理员重置密码：同样写 `must_change_password = 1`，并**删除该用户全部会话**（立即失效）。
- 用户自助改密（`changeUserPassword`）：成功后写 `must_change_password = 0`，同样删除全部会话。
- 密码强度：≥ 8 位，服务端 `hashOrNull` 兜底校验（前后端一致）。
- **约束**：`authorizeAnyRole` 对 `mustChangePassword` 的账号返回 403 + `mustChangePassword: true`，前端由 `AppHeader` 引导至 `/change-password`。

## 测试约束

- 权限回归测试 `tests/verify-permissions.mjs`：直接读写本地开发库插入临时用户，**严禁在生产/共享环境执行**；角色归并、隔离、403、会话失效均由该脚本覆盖。
