// feat-261101-04（#44）：新增 "title"（会议 AI 标题），沿用同一个队列/并发/容量/记账，不另造调度。
export type LlmTaskType = "translate" | "summary" | "test" | "chat" | "title";

export interface LlmQueueStatus {
  inFlight: number;
  queued: number;
  dropped: number;
}

export interface LlmQueueConfig {
  maxConcurrency: number;
  capacity: number;
}

type ConfigReader = () => LlmQueueConfig | Promise<LlmQueueConfig>;

interface QueueTask {
  type: LlmTaskType;
  run: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONFIG: LlmQueueConfig = { maxConcurrency: 2, capacity: 10 };
const DEFAULT_WAIT_MS: Record<LlmTaskType, number> = {
  translate: 30_000,
  test: 30_000,
  summary: 300_000,
  chat: 60_000,
  // 标题是一次短生成，但排在同队列里可能前面压着纪要/翻译；给 120s 排队预算。
  title: 120_000,
};

let configReader: ConfigReader = () => DEFAULT_CONFIG;

export interface LlmQueueContextHooks {
  capture: () => unknown;
  run: <R>(context: unknown, task: () => Promise<R>) => Promise<R>;
}

let contextHooks: LlmQueueContextHooks | null = null;

/**
 * 让任务在**入队时**的异步上下文里执行（issue #69）。
 * 不接这个钩子时任务跑在「启动 pump 的那个请求」的上下文里 —— 对用
 * AsyncLocalStorage 承载身份的宿主来说，等于把别人的身份借给了排队者。
 */
export function setLlmQueueContextHooks(hooks: LlmQueueContextHooks | null) {
  contextHooks = hooks;
}

export function setLlmQueueConfigReader(reader: ConfigReader) {
  configReader = reader;
}

class LlmQueue {
  private inflight = 0;
  private pending: QueueTask[] = [];
  private droppedCount = 0;
  /**
   * 最后一次「收尾刷新」的 promise（pump 的 .finally 里那次 configReader 读）。
   *
   * 为什么需要：那次刷新是 fire-and-forget 的，调用方无从得知它何时落定。
   * 关库前若它还在飞，就会重新 openDatabase() 并向已销毁的连接池 acquire，
   * 白等 tarn 的 acquireTimeoutMillis（默认 60000ms）——issue #80 就是这个。
   */
  private settleTail: Promise<void> = Promise.resolve();
  /** 在飞的「收尾刷新」个数（刷新期间队列不算静默）。 */
  private refreshing = 0;
  /**
   * 等待「队列静默」的唤醒者。
   *
   * 为什么不用轮询：`whenQuiescent()` 的用途是**优雅关闭前 drain**，那时任务正在飞。
   * 若循环 `await` 一个已 resolved 的 promise 去看状态，就变成**微任务空转** ——
   * 微任务队列永不为空会让 `setTimeout` 永不触发，正在飞的任务永远跑不完，
   * `inflight` 永远不归零，形成真死锁（issue #80 修复过程中实测复现）。
   */
  private idleWaiters: Array<() => void> = [];

  async enqueue<T>(type: LlmTaskType, task: () => Promise<T>, waitMs = DEFAULT_WAIT_MS[type]): Promise<T> {
    // 配置读取是异步的（#54：app_settings 走 AsyncDb）；读到之前不占位、不排队，
    // 与改动前「同步读配置再判定」的顺序一致。
    const { maxConcurrency, capacity } = await configReader();

    if (this.inflight >= maxConcurrency && this.pending.length >= capacity) {
      this.droppedCount += 1;
      return Promise.reject(new Error(`LLM queue is full (capacity=${capacity})`));
    }

    // 入队时捕获上下文，执行时恢复（issue #69）
    const enqueuedContext = contextHooks?.capture();
    return new Promise<T>((resolve, reject) => {
      const wrapped: QueueTask = {
        type,
        run: async () => {
          try {
            const hooks = contextHooks;
            resolve(await (hooks ? hooks.run(enqueuedContext, task) : task()));
          } catch (error) {
            reject(error);
          }
        },
        timer: setTimeout(() => {
          const index = this.pending.indexOf(wrapped);
          if (index >= 0) {
            this.pending.splice(index, 1);
            this.droppedCount += 1;
          }
          reject(new Error(`LLM queue wait timeout after ${waitMs}ms`));
        }, waitMs),
      };

      this.pending.push(wrapped);
      this.pump(maxConcurrency);
    });
  }

  getStatus(): LlmQueueStatus {
    return {
      inFlight: this.inflight,
      queued: this.pending.length,
      dropped: this.droppedCount,
    };
  }

  /** 队列是否完全静默：没有在跑的任务、没有排队项、没有在飞的收尾刷新。 */
  private isQuiescent(): boolean {
    return this.inflight === 0 && this.pending.length === 0 && this.refreshing === 0;
  }

  /** 静默时唤醒所有等待者（幂等，没人等就什么都不做）。 */
  private notifyIfQuiescent(): void {
    if (!this.isQuiescent()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /**
   * 等到「没有在跑的任务」且「最后一次收尾刷新已落定」。
   *
   * 用途：**关库前 drain**。队列在任务结束后会 fire-and-forget 读一次配置，
   * 若此时直接 closeDb()，那次读会重新打开库、向已销毁的池 acquire，
   * 白等 acquireTimeoutMillis（issue #80）。
   *
   * 实现是**等待者模式**，不是轮询：静默时被 `notifyIfQuiescent()` 唤醒。
   * 调用方若担心永不收敛，自己加超时。
   */
  async whenQuiescent(): Promise<void> {
    while (!this.isQuiescent()) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve);
      });
    }
  }

  private pump(maxConcurrency: number) {
    while (this.inflight < maxConcurrency && this.pending.length > 0) {
      const next = this.pending.shift()!;
      clearTimeout(next.timer);
      this.inflight += 1;
      void next
        .run()
        .catch(() => {
          // rejection is delivered to the caller via wrapped.run
        })
        .finally(() => {
          this.inflight -= 1;
          // 记成可 await 的 tail，供 whenQuiescent() / 优雅关闭等待（issue #80）。
          this.refreshing += 1;
          this.settleTail = Promise.resolve(configReader())
            .then((config) => this.pump(config.maxConcurrency))
            .catch(() => this.pump(DEFAULT_CONFIG.maxConcurrency))
            .finally(() => {
              this.refreshing -= 1;
              // 刷新结束后队列可能才真正静默（它可能又 pump 出了新任务）。
              this.notifyIfQuiescent();
            });
        });
    }
    // 循环可能因为 pending 空而退出（此时 inflight 仍可能 > 0），也可能刚把队列清空；
    // 两种情况都重新看一眼静默条件。
    this.notifyIfQuiescent();
  }
}

const globalForLlmQueue = globalThis as unknown as { __llmQueue?: LlmQueue };
export const llmQueue = globalForLlmQueue.__llmQueue ?? (globalForLlmQueue.__llmQueue = new LlmQueue());
