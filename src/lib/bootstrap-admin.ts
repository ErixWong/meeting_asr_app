/**
 * 初始管理员的「口令来源 → 是否强制首次改密」判定（issue #68 待拍板项）。
 *
 * 抽成纯函数是为了能直接单测：这条逻辑之前在 `admin-store.ts` 的播种函数里，
 * 只能靠起一个空库跑一遍才能验证。
 *
 * 规则：
 * - 无论口令来自 env 还是内置回退值，**默认都要求首次登录改密**；
 * - 只有在显式设置 `BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE=true` 时才豁免
 *   （给备份恢复演练、e2e 之类的自动化流程用，它们会用固定口令直接调 API）。
 */
export type BootstrapAdminPassword = {
  password: string;
  mustChangePassword: boolean;
  source: "env" | "default";
};

export const BOOTSTRAP_ADMIN_FALLBACK_PASSWORD = "admin123";

export function resolveBootstrapAdminPassword(
  env: Record<string, string | undefined>
): BootstrapAdminPassword {
  const skipPasswordChange = String(env.BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE || "").toLowerCase() === "true";
  const configuredPassword = String(env.BOOTSTRAP_ADMIN_PASSWORD || "");
  if (configuredPassword) {
    return { password: configuredPassword, mustChangePassword: !skipPasswordChange, source: "env" };
  }
  return {
    password: BOOTSTRAP_ADMIN_FALLBACK_PASSWORD,
    mustChangePassword: !skipPasswordChange,
    source: "default",
  };
}
