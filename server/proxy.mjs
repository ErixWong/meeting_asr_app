import { WebSocketServer, WebSocket } from "ws";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env.local");

function loadEnv() {
  const content = readFileSync(envPath, "utf-8");
  const env = {};
  content.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  });
  return env;
}

const env = loadEnv();
const API_KEY = env.DASHSCOPE_API_KEY || "";
const WORKSPACE_ID = env.FUNASR_WORKSPACE_ID || "";
const CUSTOM_FUNASR_URL = env.FUNASR_SERVER_WS_URL || "";
const DASHSCOPE_WS_URL = `wss://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;

function normalizeFunasrUrl(rawUrl) {
  if (!rawUrl) return "";

  const normalized = rawUrl.startsWith("ws://") || rawUrl.startsWith("wss://")
    ? rawUrl
    : rawUrl.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");

  const url = new URL(normalized);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/ws";
  }

  return url.toString();
}

const TARGET_WS_URL = CUSTOM_FUNASR_URL ? normalizeFunasrUrl(CUSTOM_FUNASR_URL) : DASHSCOPE_WS_URL;
const USE_CUSTOM_FUNASR = Boolean(CUSTOM_FUNASR_URL);

const PORT = 8080;

const wss = new WebSocketServer({ port: PORT });

function parseJsonMessage(value) {
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toTaskStartedMessage(taskId) {
  return JSON.stringify({
    header: {
      event: "task-started",
      task_id: taskId,
    },
  });
}

function toTaskFinishedMessage(taskId) {
  return JSON.stringify({
    header: {
      event: "task-finished",
      task_id: taskId,
    },
  });
}

function toResultGeneratedMessage(taskId, payload) {
  return JSON.stringify({
    header: {
      event: "result-generated",
      task_id: taskId,
    },
    payload: {
      output: {
        sentence: payload,
      },
    },
  });
}

function extractSpeakerId(message) {
  if (typeof message.speaker_id === "number") return message.speaker_id;
  if (typeof message.spk === "number") return message.spk;
  if (Array.isArray(message.stamp_sents)) {
    const segment = message.stamp_sents.find((item) => typeof item?.spk === "number");
    if (segment) return segment.spk;
  }
  return null;
}

function extractTiming(message) {
  if (!Array.isArray(message.stamp_sents) || message.stamp_sents.length === 0) {
    return { begin_time: undefined, end_time: undefined };
  }

  const first = message.stamp_sents[0] || {};
  const last = message.stamp_sents[message.stamp_sents.length - 1] || {};

  return {
    begin_time: typeof first.start === "number" ? first.start : undefined,
    end_time: typeof last.end === "number" ? last.end : undefined,
  };
}

function extractHotwords(parsedMessage) {
  const context = parsedMessage?.payload?.input?.context;
  if (!Array.isArray(context)) return "";

  const values = context.flatMap((item) => {
    if (!Array.isArray(item?.content)) return [];
    return item.content
      .filter((contentItem) => contentItem?.type === "input_text" && typeof contentItem?.text === "string")
      .map((contentItem) => contentItem.text.trim())
      .filter(Boolean);
  });

  return values.join(" ");
}

function buildCustomFunasrInitMessage(parsedMessage, taskId) {
  const sampleRate = Number(parsedMessage?.payload?.parameters?.sample_rate || 16000);
  const hotwords = extractHotwords(parsedMessage);

  return JSON.stringify({
    mode: "2pass",
    chunk_size: [5, 10, 5],
    chunk_interval: 10,
    encoder_chunk_look_back: 4,
    decoder_chunk_look_back: 0,
    audio_fs: sampleRate,
    wav_format: "pcm",
    wav_name: taskId || "wav-default-id",
    is_speaking: true,
    itn: true,
    hotwords,
    svs_lang: "auto",
    svs_itn: true,
  });
}

function translateCustomFunasrMessage(message, taskId) {
  if (message?.header) {
    return { forward: JSON.stringify(message), isFinal: false };
  }

  const mode = typeof message?.mode === "string" ? message.mode.toLowerCase() : "";
  const isFinal = Boolean(message?.is_final) || Boolean(message?.is_eof) || mode.includes("offline");

  const text = typeof message?.text === "string"
    ? message.text
    : typeof message?.text_2pass === "string"
      ? message.text_2pass
      : typeof message?.asr_result === "string"
        ? message.asr_result
        : "";

  if (!text) {
    return { forward: null, isFinal };
  }

  const speakerId = extractSpeakerId(message);
  const timing = extractTiming(message);

  return {
    forward: toResultGeneratedMessage(taskId, {
      text,
      sentence_end: isFinal,
      speaker_id: speakerId,
      ...timing,
    }),
    isFinal,
  };
}

console.log(`[Proxy] Running on ws://localhost:${PORT}`);
console.log(`[Proxy] Mode: ${USE_CUSTOM_FUNASR ? "custom-funasr" : "dashscope"}`);
console.log(`[Proxy] Target: ${TARGET_WS_URL}`);

wss.on("connection", (clientWs) => {
  console.log("[Proxy] ===== New client connection =====");

  const targetWs = USE_CUSTOM_FUNASR
    ? new WebSocket(TARGET_WS_URL)
    : new WebSocket(TARGET_WS_URL, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

  let targetReady = false;
  let customTaskId = "";
  let customFinishRequested = false;
  const pendingMessages = [];

  function forwardToTarget(rawData, isText) {
    const msg = typeof rawData === "string" ? rawData : rawData.toString();

    if (USE_CUSTOM_FUNASR && isText) {
      const parsed = parseJsonMessage(msg);
      const action = parsed?.header?.action;

      if (action === "run-task") {
        customTaskId = parsed?.header?.task_id || customTaskId;
        customFinishRequested = false;
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(toTaskStartedMessage(customTaskId));
          console.log("[Proxy] Emitted synthetic task-started");
        }
        targetWs.send(buildCustomFunasrInitMessage(parsed, customTaskId));
        console.log("[Proxy] Translated run-task to custom FunASR init");
        return;
      }

      if (action === "finish-task") {
        customFinishRequested = true;
        targetWs.send(JSON.stringify({
          is_speaking: false,
          is_eof: true,
          wav_name: customTaskId || "wav-default-id",
        }));
        console.log("[Proxy] Translated finish-task to custom FunASR EOF");
        return;
      }
    }

    targetWs.send(isText ? msg : rawData);
  }

  targetWs.on("open", () => {
    console.log(`[Proxy] ${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} connection OPEN`);
    targetReady = true;
    console.log(`[Proxy] Sending ${pendingMessages.length} queued messages`);
    pendingMessages.forEach((item) => {
      console.log("[Proxy] Sending queued:", item.isText ? item.data.substring(0, 200) : `audio ${item.data.length} bytes`);
      forwardToTarget(item.data, item.isText);
    });
    pendingMessages.length = 0;
  });

  targetWs.on("message", (data, isBinary) => {
    const msg = typeof data === "string" ? data : data.toString();
    console.log(`[Proxy] ${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} → Client:`, msg.substring(0, 500));

    if (USE_CUSTOM_FUNASR) {
      const translated = translateCustomFunasrMessage(parseJsonMessage(msg), customTaskId);
      if (translated.forward && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(translated.forward);
        console.log("[Proxy] Forwarded translated custom FunASR message");
      }

      if (translated.isFinal && customFinishRequested && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(toTaskFinishedMessage(customTaskId));
        customFinishRequested = false;
        console.log("[Proxy] Emitted synthetic task-finished");
      }
      return;
    }

    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg);
      console.log("[Proxy] Forwarded to client");
    } else {
      console.log("[Proxy] Client NOT ready, readyState:", clientWs.readyState);
    }
  });

  targetWs.on("error", (err) => {
    console.error(`[Proxy] ${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} error:`, err.message, err.code);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        header: { event: "task-failed", error_message: err.message }
      }));
      clientWs.close();
    }
  });

  targetWs.on("close", (code, reason) => {
    console.log(`[Proxy] ${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} closed: code=${code} reason=${reason.toString()}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      if (USE_CUSTOM_FUNASR && customFinishRequested) {
        clientWs.send(toTaskFinishedMessage(customTaskId));
        customFinishRequested = false;
        console.log("[Proxy] Emitted synthetic task-finished on close");
      }
      clientWs.send(JSON.stringify({
        header: { event: "task-failed", error_message: `${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} closed: ${code}` }
      }));
      clientWs.close();
    }
  });

  clientWs.on("message", (data, isBinary) => {
    const isText = !isBinary;
    const msg = typeof data === "string" ? data : data.toString();
    if (isText) {
      console.log("[Proxy] Client → DashScope:", msg.substring(0, 300));
    } else {
      console.log("[Proxy] Client → DashScope: audio", data.length, "bytes");
    }
    if (targetReady) {
      forwardToTarget(data, isText);
    } else {
      console.log(`[Proxy] ${USE_CUSTOM_FUNASR ? "FunASR" : "DashScope"} not ready, queuing`);
      pendingMessages.push({ isText, data: isText ? msg : data });
    }
  });

  clientWs.on("close", () => {
    console.log("[Proxy] Client disconnected");
    if (targetWs.readyState === WebSocket.OPEN || targetWs.readyState === WebSocket.CONNECTING) {
      targetWs.close();
    }
  });

  clientWs.on("error", (err) => {
    console.error("[Proxy] Client error:", err.message);
    if (targetWs.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
  });
});
