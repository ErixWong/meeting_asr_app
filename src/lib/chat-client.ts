// 语音对话前端客户端：SSE 流式解析、增量断句、TTS 播放队列（M3）

// ---------- /api/chat SSE 流式 ----------

export interface StreamChatOptions {
  message: string;
  conversationId?: string;
  onStart: (conversationId: string) => void;
  onDelta: (text: string) => void;
  onDone: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * POST /api/chat（stream: true），按 SSE 事件回调。
 * 会话 id 由服务端在 start 事件返回，前端持有并用于下一轮。
 */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: options.message,
      conversationId: options.conversationId ?? "",
      stream: true,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error(String((data as { error?: string }).error ?? `HTTP ${response.status}`));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];

  const dispatchEvent = () => {
    if (!eventName) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (eventName === "start") {
      try {
        const parsed = JSON.parse(payload) as { conversationId?: string };
        if (parsed.conversationId) options.onStart(parsed.conversationId);
      } catch {
        // ignore malformed start
      }
    } else if (eventName === "delta") {
      try {
        const parsed = JSON.parse(payload) as { text?: string };
        if (typeof parsed.text === "string" && parsed.text) options.onDelta(parsed.text);
      } catch {
        // ignore malformed delta
      }
    } else if (eventName === "done") {
      try {
        const parsed = JSON.parse(payload) as { text?: string };
        options.onDone(String(parsed.text ?? ""));
      } catch {
        options.onDone("");
      }
    } else if (eventName === "error") {
      try {
        const parsed = JSON.parse(payload) as { error?: string };
        throw new Error(String(parsed.error ?? "对话失败"));
      } catch (error) {
        throw error instanceof Error ? error : new Error("对话失败");
      }
    }
    eventName = "";
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 帧：event: X\ndata: Y\n\n（data 可能多行）
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        } else if (line.trim() === "") {
          // blank line inside frame
        }
      }
      dispatchEvent();
    }
  }
  // flush 尾部残帧
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    dispatchEvent();
  }
}

// ---------- 增量断句 ----------

const SENTENCE_END_RE = /[。！？…；\n]+/g;

/**
 * 从流式累积文本中提取完整句子（含结束标点）。
 * 返回完整句列表与残余（未成句的尾巴）。
 */
export function extractCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  SENTENCE_END_RE.lastIndex = 0;
  while ((match = SENTENCE_END_RE.exec(rest)) !== null) {
    const end = match.index + match[0].length;
    const sentence = rest.slice(0, end);
    // 过滤纯标点/空句
    if (sentence.replace(/[。！？…；\s]/g, "").length > 0) {
      sentences.push(sentence);
    }
    rest = rest.slice(end);
    lastIndex = 0;
    SENTENCE_END_RE.lastIndex = 0;
  }
  return { sentences, rest };
}

// ---------- TTS 播放队列 ----------

type PlayerState = "idle" | "playing";

export interface TtsPlayer {
  /** 合成一句并排队播放（wav 二进制）。返回该句实际播放开始的时间戳（可空）。 */
  enqueue(wav: ArrayBuffer): Promise<void>;
  /** 立即停止当前播放并清空队列（打断）。 */
  stop(): void;
  state: PlayerState;
  onStateChange?: (state: PlayerState) => void;
}

export function createTtsPlayer(): TtsPlayer {
  const audioContextRef: { current: AudioContext | null } = { current: null };
  let currentSource: AudioBufferSourceNode | null = null;
  let queue: Array<{ buffer: AudioBuffer; startAt: number }> = [];
  let chain: Promise<void> = Promise.resolve();
  let state: PlayerState = "idle";
  let generation = 0;

  const setState = (next: PlayerState) => {
    if (state === next) return;
    state = next;
    player.onStateChange?.(state);
  };

  const ensureContext = async (): Promise<AudioContext> => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }
    return ctx;
  };

  const playOne = (item: { buffer: AudioBuffer; startAt: number }, gen: number) =>
    new Promise<void>((resolve) => {
      const ctx = audioContextRef.current;
      if (!ctx || gen !== generation) {
        resolve();
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = item.buffer;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain).connect(ctx.destination);
      currentSource = source;
      setState("playing");
      source.onended = () => {
        if (currentSource === source) currentSource = null;
        setState(queue.length > 0 ? "playing" : "idle");
        resolve();
      };
      const delay = Math.max(0, item.startAt - ctx.currentTime);
      source.start(ctx.currentTime + delay);
    });

  const player = {
    async enqueue(wav: ArrayBuffer) {
      const ctx = await ensureContext();
      const buffer = await ctx.decodeAudioData(wav).catch(() => null);
      if (!buffer) return;

      // 排队：接在当前链尾播放（间隔 120ms 避免句间粘连）
      const startAt = ctx.currentTime + 0.12;
      const item = { buffer, startAt };
      const gen = generation;
      chain = chain.then(() => playOne(item, gen)).catch(() => {});
      await chain;
    },
    stop() {
      generation += 1;
      queue = [];
      if (currentSource) {
        try {
          currentSource.stop();
        } catch {
          // already stopped
        }
        currentSource = null;
      }
      setState("idle");
      chain = Promise.resolve();
    },
  } as unknown as TtsPlayer;

  // 只读 state getter
  Object.defineProperty(player, "state", { get: () => state });

  return player;
}
