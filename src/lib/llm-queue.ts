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

  /**
   * 等到「没有在跑的任务」且「最后一次收尾刷新已落定」。
   *
   * 用途：**关库前 drain**。队列在任务结束后会 fire-and-forget 读一次配置，
   * 若此时直接 closeDb()，那次读会重新打开库、向已销毁的池 acquire，
   * 白等 acquireTimeoutMillis（issue #80）。
   *
   * 刷新本身可能 pump 出新任务（新任务的结束又触发新刷新），所以循环到两者同时为空。
   * 调用方若担心永不收敛，自己加超时。
   */
  async whenQuiescent(): Promise<void> {
    for (;;) {
      await this.settleTail;
      if (this.inflight === 0 && this.pending.length === 0) return;
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
          this.settleTail = Promise.resolve(configReader())
            .then((config) => this.pump(config.maxConcurrency))
            .catch(() => this.pump(DEFAULT_CONFIG.maxConcurrency));
        });
    }
  }
}

const globalForLlmQueue = globalThis as unknown as { __llmQueue?: LlmQueue };
export const llmQueue = globalForLlmQueue.__llmQueue ?? (globalForLlmQueue.__llmQueue = new LlmQueue());
