# 登录与初始管理员

## 初始账号

首次启动且 `data/meeting-asr-app.db` 中没有用户时，系统会创建 bootstrap 管理员。

- 默认账号：`admin`
- 开发默认密码：`admin123`

使用默认密码登录后，系统会要求先修改密码。

## 生产部署建议

生产环境不要依赖默认密码，建议在启动环境中显式设置：

```bash
BOOTSTRAP_ADMIN_ACCOUNT=admin
BOOTSTRAP_ADMIN_PASSWORD=your-strong-initial-password
```

如果未设置 `BOOTSTRAP_ADMIN_PASSWORD`，系统仍会创建 `admin/admin123` 作为兜底初始账号，并在服务日志中输出警告。交付时应把首次改密作为上线检查项。

## 认证机制

- 登录接口：`POST /api/auth/login`
- 当前用户：`GET /api/auth/me`
- 修改密码：`POST /api/auth/change-password`
- 退出登录：`POST /api/auth/logout`

登录成功后，服务端签发 `HttpOnly` session cookie。业务 API 继续使用已有 RBAC 守卫，未登录或角色不足会返回 `401/403`。
