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

export function setLlmQueueConfigReader(reader: ConfigReader) {
  configReader = reader;
}

class LlmQueue {
  private inflight = 0;
  private pending: QueueTask[] = [];
  private droppedCount = 0;

  async enqueue<T>(type: LlmTaskType, task: () => Promise<T>, waitMs = DEFAULT_WAIT_MS[type]): Promise<T> {
    // 配置读取是异步的（#54：app_settings 走 AsyncDb）；读到之前不占位、不排队，
    // 与改动前「同步读配置再判定」的顺序一致。
    const { maxConcurrency, capacity } = await configReader();

    if (this.inflight >= maxConcurrency && this.pending.length >= capacity) {
      this.droppedCount += 1;
      return Promise.reject(new Error(`LLM queue is full (capacity=${capacity})`));
    }

    return new Promise<T>((resolve, reject) => {
      const wrapped: QueueTask = {
        type,
        run: async () => {
          try {
            resolve(await task());
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
          void Promise.resolve(configReader())
            .then((config) => this.pump(config.maxConcurrency))
            .catch(() => this.pump(DEFAULT_CONFIG.maxConcurrency));
        });
    }
  }
}

const globalForLlmQueue = globalThis as unknown as { __llmQueue?: LlmQueue };
export const llmQueue = globalForLlmQueue.__llmQueue ?? (globalForLlmQueue.__llmQueue = new LlmQueue());
