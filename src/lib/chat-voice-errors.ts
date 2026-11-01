/**
 * `/chat` 语音按钮的错误文案（纯函数）。
 *
 * 该文件**不允许有任何外部 import**：`scripts/chat-voice-test.mjs` 用
 * `npx tsc <file> --outDir <tmp>` 单文件编译后直接 `node --test` 测它。
 */

/** 权限被拒（优先级最高：权限问题重试也没用，必须先让用户改浏览器设置） */
const PERMISSION_RE = /permission|NotAllowedError|denied|not allowed|权限/i;
/** 用户/系统主动中断（松手、切页、取消权限弹窗）——安静处理，不弹错误 */
const ABORT_RE = /AbortError|aborted|用户中断/i;
/** 没有可用的录音设备 */
const NO_DEVICE_RE = /NotFoundError|device not found|no audio devices|no microphone|未找到.*(麦克风|设备)/i;
/** 设备存在但被别的程序占用 */
const NOT_READABLE_RE = /NotReadable|被占/i;
const TIMEOUT_RE = /timeout|超时/i;
const CONNECT_RE = /connect|websocket|ECONN|socket/i;

/**
 * 把底层错误翻译成用户能看懂的话。
 *
 * @returns 面向用户的文案；**空串表示安静处理**（调用方据此不显示错误徽标）。
 *          没有任何规则命中时原样返回 `err.message`（保留原始信息便于排查）。
 */
export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  // DOMException 这类错误的判别信息在 name 上（如 NotFoundError），message 里可能没有，
  // 所以匹配用「name + message」，但原样透传时只回 message（不凭空造出 "Error: xxx"）。
  const haystack = name && name !== "Error" ? `${name} ${message}` : message;

  if (PERMISSION_RE.test(haystack))
    return "麦克风权限被拒绝：请在浏览器地址栏允许麦克风后重试";
  if (ABORT_RE.test(haystack)) return "";
  if (NO_DEVICE_RE.test(haystack)) return "未找到可用麦克风设备，请检查系统音频输入后重试";
  if (NOT_READABLE_RE.test(haystack)) return "麦克风不可用或被占用，请检查设备";
  if (TIMEOUT_RE.test(haystack)) return "语音服务启动超时，请检查网络或稍后再试";
  if (CONNECT_RE.test(haystack)) return "语音识别服务连接失败，请稍后再试";
  return message;
}
