import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  appendCaptureEvent,
  cleanupExpiredCaptureSessions,
  createCaptureSession,
  finishCaptureSession,
  getAsrRuntimeConfig,
} from "./runtime-store.mjs";

const PORT = Number(process.env.ASR_GATEWAY_PORT || 8123);
const HOST = process.env.ASR_GATEWAY_HOST || "127.0.0.1";
const DEFAULT_ALLOWED_ORIGINS = "http://localhost:3123,http://127.0.0.1:3123";
const allowedOrigins = new Set(
  (process.env.ASR_GATEWAY_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

const wss = new WebSocketServer({ host: HOST, port: PORT });

function isAllowedClientOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function parseJsonMessage(value) {
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sendAppMessage(clientWs, type, payload = {}) {
  if (clientWs.readyState !== WebSocket.OPEN) return;
  clientWs.send(JSON.stringify({ type, ...payload }));
}

function extractSpeakerId(message) {
  if (typeof message?.speaker_id === "number") return message.speaker_id;
  if (typeof message?.spk === "number") return message.spk;
  if (Array.isArray(message?.stamp_sents)) {
    const segment = message.stamp_sents.find((item) => typeof item?.spk === "number");
    if (segment) return segment.spk;
  }
  return null;
}

function extractTiming(message) {
  if (!Array.isArray(message?.stamp_sents) || message.stamp_sents.length === 0) {
    return { beginTime: undefined, endTime: undefined };
  }

  const first = message.stamp_sents[0] || {};
  const last = message.stamp_sents[message.stamp_sents.length - 1] || {};

  return {
    beginTime: typeof first.start === "number" ? first.start : undefined,
    endTime: typeof last.end === "number" ? last.end : undefined,
  };
}

function buildLocalFunasrStartMessage(session, hotwords) {
  const sampleRate = Number(session.audio?.sampleRate || 16000);
  const hotwordsJson = Object.keys(hotwords).length > 0 ? JSON.stringify(hotwords) : "";

  return JSON.stringify({
    mode: "2pass",
    chunk_size: [5, 10, 5],
    chunk_interval: 10,
    encoder_chunk_look_back: 4,
    decoder_chunk_look_back: 0,
    audio_fs: sampleRate,
    wav_format: session.audio?.format || "pcm",
    wav_name: session.sessionId,
    is_speaking: true,
    itn: true,
    hotwords: hotwordsJson,
    svs_lang: "auto",
    svs_itn: true,
  });
}

function buildLocalFunasrFinishMessage(sessionId) {
  return JSON.stringify({
    is_speaking: false,
    is_eof: true,
    wav_name: sessionId,
  });
}

function buildDashScopeStartMessage(session) {
  const sampleRate = Number(session.audio?.sampleRate || 16000);
  const hotWords = Array.isArray(session.hotWords) ? session.hotWords.filter(Boolean) : [];
  const input = {};

  if (hotWords.length > 0) {
    input.context = [
      {
        role: "user",
        content: [{ type: "input_text", text: hotWords.join(" ") }],
      },
    ];
  }

  return JSON.stringify({
    header: {
      action: "run-task",
      task_id: session.sessionId,
      streaming: "duplex",
    },
    payload: {
      task_group: "audio",
      task: "asr",
      function: "recognition",
      model: "fun-asr-realtime",
      parameters: {
        format: session.audio?.format || "pcm",
        sample_rate: sampleRate,
      },
      input,
    },
  });
}

function buildDashScopeFinishMessage(sessionId) {
  return JSON.stringify({
    header: {
      action: "finish-task",
      task_id: sessionId,
      streaming: "duplex",
    },
    payload: {
      input: {},
    },
  });
}

function parseLocalFunasrTranscript(message) {
  const mode = typeof message?.mode === "string" ? message.mode.toLowerCase() : "";
  const isFinal = Boolean(message?.is_final) || Boolean(message?.is_eof) || mode.includes("offline");
  const text = typeof message?.text === "string"
    ? message.text
    : typeof message?.text_2pass === "string"
      ? message.text_2pass
      : typeof message?.asr_result === "string"
        ? message.asr_result
        : "";

  if (!text) return { transcript: null, isFinal };

  return {
    transcript: {
      text,
      speakerId: extractSpeakerId(message),
      ...extractTiming(message),
    },
    isFinal,
  };
}

function parseDashScopeEvent(message) {
  const event = message?.header?.event || message?.header?.action;

  if (event === "task-started") {
    return { type: "started" };
  }

  if (event === "task-finished") {
    return { type: "finished" };
  }

  if (event === "task-failed") {
    return {
      type: "failed",
      error: message?.header?.error_message || "ASR upstream task failed",
    };
  }

  if (event === "result-generated") {
    const sentence = message?.payload?.output?.sentence;
    const text = typeof sentence?.text === "string" ? sentence.text : "";
    if (!text) return { type: "ignored" };

    return {
      type: "transcript",
      isFinal: sentence?.sentence_end === true,
      transcript: {
        text,
        speakerId: sentence?.speaker_id ?? null,
        beginTime: sentence?.begin_time,
        endTime: sentence?.end_time,
      },
    };
  }

  return { type: "ignored" };
}

function createProviderAdapter(runtimeConfig, session) {
  if (runtimeConfig.isLocalFunasr) {
    return {
      name: "local_funasr",
      headers: undefined,
      startsAfterOpen: true,
      startMessage: () => buildLocalFunasrStartMessage(session, runtimeConfig.hotwords),
      finishMessage: () => buildLocalFunasrFinishMessage(session.sessionId),
      parseMessage: (message) => {
        const { transcript, isFinal } = parseLocalFunasrTranscript(message);
        if (!transcript) return { type: "ignored", isFinal };
        return { type: "transcript", transcript, isFinal };
      },
    };
  }

  if (runtimeConfig.isDashScope) {
    return {
      name: "dashscope",
      headers: runtimeConfig.apiKey ? { Authorization: `Bearer ${runtimeConfig.apiKey}` } : undefined,
      startsAfterOpen: false,
      startMessage: () => buildDashScopeStartMessage(session),
      finishMessage: () => buildDashScopeFinishMessage(session.sessionId),
      parseMessage: parseDashScopeEvent,
    };
  }

  return null;
}

console.log(`[ASR Gateway] Running on ws://${HOST}:${PORT}`);

wss.on("connection", (clientWs, req) => {
  if (!isAllowedClientOrigin(req)) {
    console.warn(`[ASR Gateway] Rejected client origin: ${req.headers.origin || "(missing)"}`);
    clientWs.close(1008, "Origin is not allowed");
    return;
  }

  cleanupExpiredCaptureSessions();

  const runtimeConfig = getAsrRuntimeConfig();
  let targetWs = null;
  let targetReady = false;
  let sessionStarted = false;
  let providerStarted = false;
  let finishRequested = false;
  let sessionId = "";
  let captureSessionId = "";
  let providerAdapter = null;
  const pendingAudio = [];

  function failSession(errorMessage) {
    console.error("[ASR Gateway] Session failed:", errorMessage);
    if (captureSessionId) {
      finishCaptureSession(captureSessionId, "failed");
    }
    sendAppMessage(clientWs, "session.failed", { sessionId, error: errorMessage });
    clientWs.close();
  }

  function ensureCaptureSession() {
    if (captureSessionId) return captureSessionId;

    captureSessionId = `capture-${randomUUID()}`;
    createCaptureSession({
      captureSessionId,
      taskId: sessionId,
      asrProvider: runtimeConfig.providerType,
      asrConfigSnapshot: {
        providerType: runtimeConfig.providerType,
        endpoint: runtimeConfig.endpoint,
        workspaceId: runtimeConfig.workspaceId,
        hasApiKey: Boolean(runtimeConfig.apiKey),
      },
      hotwords: runtimeConfig.hotwords,
    });

    return captureSessionId;
  }

  function flushPendingAudio() {
    if (!targetReady || !targetWs) return;
    if (!providerStarted) return;
    while (pendingAudio.length > 0) {
      targetWs.send(pendingAudio.shift());
    }
  }

  function finishSession() {
    if (captureSessionId) {
      finishCaptureSession(captureSessionId);
    }
    sendAppMessage(clientWs, "session.finished", { sessionId });
    clientWs.close();
  }

  function startSession(message) {
    if (sessionStarted) {
      failSession("ASR session has already started");
      return;
    }

    if (!runtimeConfig.targetWsUrl) {
      failSession("ASR endpoint is not configured");
      return;
    }

    sessionStarted = true;
    sessionId = String(message.sessionId || `asr-${randomUUID()}`);
    ensureCaptureSession();
    providerAdapter = createProviderAdapter(runtimeConfig, { ...message, sessionId });
    if (!providerAdapter) {
      failSession(`Unsupported ASR provider: ${runtimeConfig.providerType}`);
      return;
    }

    targetWs = providerAdapter.headers
      ? new WebSocket(runtimeConfig.targetWsUrl, { headers: providerAdapter.headers })
      : new WebSocket(runtimeConfig.targetWsUrl);
    targetWs.on("open", () => {
      targetReady = true;
      targetWs.send(providerAdapter.startMessage());
      if (providerAdapter.startsAfterOpen) {
        providerStarted = true;
        sendAppMessage(clientWs, "session.started", { sessionId, captureSessionId });
        flushPendingAudio();
      }
    });

    targetWs.on("message", (data) => {
      const rawMessage = typeof data === "string" ? data : data.toString();
      const messageFromAsr = parseJsonMessage(rawMessage);
      if (captureSessionId && messageFromAsr) {
        appendCaptureEvent(captureSessionId, messageFromAsr);
      }

      const event = providerAdapter.parseMessage(messageFromAsr);
      if (event.type === "started") {
        providerStarted = true;
        sendAppMessage(clientWs, "session.started", { sessionId, captureSessionId });
        flushPendingAudio();
        return;
      }

      if (event.type === "failed") {
        failSession(event.error || "ASR upstream task failed");
        return;
      }

      if (event.type === "finished") {
        finishRequested = false;
        finishSession();
        return;
      }

      if (event.type === "transcript") {
        sendAppMessage(clientWs, event.isFinal ? "transcript.final" : "transcript.partial", {
          sessionId,
          ...event.transcript,
        });
      }

      if (event.isFinal && finishRequested && providerAdapter.name === "local_funasr") {
        finishRequested = false;
        finishSession();
      }
    });

    targetWs.on("error", (error) => {
      failSession(error instanceof Error ? error.message : "ASR upstream failed");
    });

    targetWs.on("close", (code, reason) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;

      if (finishRequested) {
        finishRequested = false;
        finishSession();
        return;
      }

      failSession(`ASR upstream closed: ${code} ${reason.toString()}`.trim());
    });
  }

  function finishUpstream() {
    if (!sessionStarted || !targetWs) {
      failSession("ASR session has not started");
      return;
    }

    finishRequested = true;
    if (targetReady && providerAdapter) {
      targetWs.send(providerAdapter.finishMessage());
    }
  }

  clientWs.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!sessionStarted) {
        failSession("Audio received before session.start");
        return;
      }

      if (targetReady && providerStarted && targetWs) {
        targetWs.send(data);
      } else {
        pendingAudio.push(data);
      }
      return;
    }

    const message = parseJsonMessage(data.toString());
    if (!message || typeof message.type !== "string") {
      failSession("Invalid ASR gateway message");
      return;
    }

    if (message.type === "session.start") {
      startSession(message);
      return;
    }

    if (message.type === "session.finish") {
      finishUpstream();
      return;
    }

    failSession(`Unsupported ASR gateway message: ${message.type}`);
  });

  clientWs.on("close", () => {
    if (targetWs?.readyState === WebSocket.OPEN || targetWs?.readyState === WebSocket.CONNECTING) {
      targetWs.close();
    }
  });

  clientWs.on("error", (error) => {
    console.error("[ASR Gateway] Client error:", error instanceof Error ? error.message : error);
    if (targetWs?.readyState === WebSocket.OPEN) {
      targetWs.close();
    }
  });
});
