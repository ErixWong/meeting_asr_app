/**
 * 初始管理员口令策略单测（issue #68，node --test）
 *
 * 判据矩阵：
 *   1. env 设了口令 → 必须强制首次改密（这是本次修复的核心）
 *   2. env 没设 → 用内置回退口令，也必须强制改密
 *   3. 显式 BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE=true → 豁免（给自动化流程）
 *   4. 豁免开关只认字符串 "true"（大小写不敏感），其他值不生效
 *
 * 运行：npm run test:bootstrap-admin
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = join(repoRoot, "src", specifier.slice(2));
      return next(pathToFileURL(`${base}.ts`).href, context);
    }
    return next(specifier, context);
  },
});

const { resolveBootstrapAdminPassword, BOOTSTRAP_ADMIN_FALLBACK_PASSWORD } = await import(
  pathToFileURL(join(repoRoot, "src", "lib", "bootstrap-admin.ts")).href
);

test("env 提供了口令 → 仍然必须强制首次改密（修复前这里是 false）", () => {
  const result = resolveBootstrapAdminPassword({ BOOTSTRAP_ADMIN_PASSWORD: "s3cret-from-env" });
  assert.equal(result.password, "s3cret-from-env");
  assert.equal(result.source, "env");
  assert.equal(result.mustChangePassword, true);
});

test("env 没提供口令 → 内置回退口令 + 强制改密", () => {
  const result = resolveBootstrapAdminPassword({});
  assert.equal(result.password, BOOTSTRAP_ADMIN_FALLBACK_PASSWORD);
  assert.equal(result.source, "default");
  assert.equal(result.mustChangePassword, true);
});

test("显式豁免：BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE=true 时不强制", () => {
  for (const env of [
    { BOOTSTRAP_ADMIN_PASSWORD: "x", BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE: "true" },
    { BOOTSTRAP_ADMIN_PASSWORD: "x", BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE: "TRUE" },
    { BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE: "true" },
  ]) {
    assert.equal(resolveBootstrapAdminPassword(env).mustChangePassword, false, JSON.stringify(env));
  }
});

test("豁免开关只认 true：其它值一律仍然强制改密", () => {
  for (const value of ["false", "1", "yes", "", " true "]) {
    const result = resolveBootstrapAdminPassword({
      BOOTSTRAP_ADMIN_PASSWORD: "x",
      BOOTSTRAP_ADMIN_SKIP_PASSWORD_CHANGE: value,
    });
    assert.equal(result.mustChangePassword, true, `value=${JSON.stringify(value)}`);
  }
});
