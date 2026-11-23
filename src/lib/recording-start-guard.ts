/**
 * 「本轮录音启动是否已作废」的判定（issue #74-2）。
 *
 * 为什么用「Map 身份」而不是代次计数器：`startRecording` 会把局部 `clients` Map 放进
 * `asrClientsRef`，而所有取消路径都是把 ref **换成一个新 Map**（不是原地清空）。
 * 所以「ref 里那个 Map 还是不是我这一轮创建的那个」就等价于「我这一轮有没有被取消」，
 * 不需要在每个取消点都记得去递增一个计数器（漏一处就失效）。
 */
export function isStartCancelled<C>(
  currentClients: Map<string, C> | null | undefined,
  myClients: Map<string, C>,
): boolean {
  return currentClients !== myClients;
}
