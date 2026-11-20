/**
 * Markdown 链接协议白名单（issue #69）。
 *
 * 只放行 http / https / mailto 与站内相对路径（`/`、`#`、`?`、`./`、`../`）；
 * `javascript:` / `data:` / `vbscript:` / `file:` 等一律返回 null，由调用方降级为纯文本。
 *
 * 抽成独立模块，是为了让单测能直接跑**真实实现**。之前的测试跑的是函数副本 ——
 * 那有假绿风险：实现哪天放开了危险协议，只要签名和调用点没变，测试照样通过。
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(\/|#|\?|\.{1,2}\/)/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") {
      return trimmed;
    }
  } catch {
    // 既不是绝对 URL，也不匹配站内前缀 → 拒绝
  }
  return null;
}
