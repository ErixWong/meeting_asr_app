export type LlmTaskType = "translate" | "summary" | "test";

export interface LlmQueueStatus {
  inFlight: number;
  queued: number;
  dropped: number;
}

export interface LlmQueueConfig {
  maxConcurrency: number;
  capacity: number;
}

type ConfigReader = () => LlmQueueConfig;

interface QueueTask {
  type: LlmTaskType;
  run: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_CONFIG: LlmQueueConfig = { maxConcurrency: 2, capacity: 10 };
const DEFAULT_WAIT_MS: Record<LlmTaskType, number> = {
  translate: 30_000,
  test: 30_000,
  summary: 180_000,
};

let configReader: ConfigReader = () => DEFAULT_CONFIG;

export function setLlmQueueConfigReader(reader: ConfigReader) {
  configReader = reader;
}

class LlmQueue {
  private inflight = 0;
  private pending: QueueTask[] = [];
  private droppedCount = 0;

  enqueue<T>(type: LlmTaskType, task: () => Promise<T>, waitMs = DEFAULT_WAIT_MS[type]): Promise<T> {
    const { maxConcurrency, capacity } = configReader();

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
          this.pump(configReader().maxConcurrency);
        });
    }
  }
}

const globalForLlmQueue = globalThis as unknown as { __llmQueue?: LlmQueue };
export const llmQueue = globalForLlmQueue.__llmQueue ?? (globalForLlmQueue.__llmQueue = new LlmQueue());
