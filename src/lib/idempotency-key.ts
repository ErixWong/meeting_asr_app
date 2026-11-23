/**
 * 生成保存幂等键（issue #74-3）。
 *
 * ⚠ 不能直接用 `crypto.randomUUID()`：它**只在安全上下文**（HTTPS / `http://localhost`）可用。
 * 本应用按 `http://<内网IP>:3123` 部署（compose 里 `AUTH_COOKIE_SECURE` 默认 false），
 * 那里的 `crypto.randomUUID` 是 undefined，直接调用会让**每次保存都抛错**。
 * 因此按能力逐级降级；`getRandomValues` 不受安全上下文限制，是首选兜底。
 */
type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
};

export function newIdempotencyKey(webCrypto: CryptoLike | undefined = globalThis.crypto as CryptoLike | undefined): string {
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // 最后兜底：只用于幂等键（不是安全令牌），可接受弱随机。
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
