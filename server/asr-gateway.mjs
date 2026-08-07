import { randomUUID } from "crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  appendCaptureEvent,
  authorizeAsrGatewaySession,
  createCaptureSession,
  finishCaptureSession,
  getAsrRuntimeConfig,
} from "./runtime-store.mjs";

const APP_PORT = Number(process.env.PORT || 3123);
const DEFAULT_ALLOWED_ORIGINS = `http://localhost:${APP_PORT},http://127.0.0.1:${APP_PORT}`;
const allowedOrigins = new Set(
  (process.env.ASR_GATEWAY_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function isAllowedClientOrigin(req) {
  const origin = req.headers.origin;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

function readCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  const cookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.slice(name.length + 1));
  } catch {
    return "";
  }
}

function rejectUpgrade(socket, status, message) {
  const statusText = status === 403 ? "Forbidden" : "Unauthorized";
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
  );
  socket.destroy();
}

function parseJsonMessage(value) {
  if (typeof value !== "string") return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const MAX_PARTIAL_ACCUM_CHARS = 2000;

// Local FunASR 2pass 的 online partial 是增量文本（每次只含新识别出的片段），
// 而前端契约是"当前句完整文本"整体替换。这里把增量累积成完整句子再转发；
// 若增量恰好是已累积文本的尾部（上游重复/重发），直接跳过，避免拼接重复。
function accumulatePartialText(accum, delta) {
  const text = typeof delta === "string" ? delta : "";
  if (!text) return accum;
  if (accum.endsWith(text)) return accum;
  let next = accum + text;
  if (next.length > MAX_PARTIAL_ACCUM_CHARS) {
    next = next.slice(-MAX_PARTIAL_ACCUM_CHARS);
  }
  return next;
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
  const svsLang = typeof session.svsLang === "string" && session.svsLang ? session.svsLang : "auto";

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
    svs_lang: svsLang,
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
      headers: runtimeConfig.apiKey ? { Authorization: `Bearer ${runtimeConfig.apiKey}` } : undefined,
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

export function attachAsrGateway(server, { path = "/asr", onUnhandledUpgrade, devMode = false } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (clientWs, req) => {
  if (!isAllowedClientOrigin(req)) {
    console.warn(`[ASR Gateway] Rejected client origin: ${req.headers.origin || "(missing)"}`);
    clientWs.close(1008, "Origin is not allowed");
    return;
  }

  const runtimeConfig = getAsrRuntimeConfig();
  let targetWs = null;
  let targetReady = false;
  let sessionStarted = false;
  let providerStarted = false;
  let finishRequested = false;
  let sessionFailed = false;
  let sessionFinished = false;
  let sessionId = "";
  let captureSessionId = "";
  let providerAdapter = null;
  let upstreamConnectTimer = null;
  let partialAccumText = "";
  const pendingAudio = [];
  const MAX_PENDING_AUDIO_CHUNKS = 120;
  const UPSTREAM_CONNECT_TIMEOUT_MS = 10000;
  const MAX_SEND_BUFFERED_BYTES = 16 * 1024 * 1024;

  function failSession(errorMessage) {
    if (sessionFinished || sessionFailed) return;
    sessionFailed = true;
    partialAccumText = "";
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
      if (!safeSend(targetWs, pendingAudio.shift())) {
        failSession("ASR upstream send buffer overflow");
        return;
      }
    }
  }

  function safeSend(ws, data) {
    if (ws.bufferedAmount > MAX_SEND_BUFFERED_BYTES) return false;
    ws.send(data);
    return true;
  }

  function finishSession() {
    if (sessionFinished || sessionFailed) return;
    sessionFinished = true;
    partialAccumText = "";
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
    upstreamConnectTimer = setTimeout(() => {
      if (targetWs?.readyState === WebSocket.CONNECTING) {
        targetWs.terminate();
        failSession(`ASR upstream connection timeout after ${UPSTREAM_CONNECT_TIMEOUT_MS}ms`);
      }
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    targetWs.on("open", () => {
      clearTimeout(upstreamConnectTimer);
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
        const accepted = appendCaptureEvent(captureSessionId, messageFromAsr);
        if (!accepted) {
          failSession("ASR capture event limit exceeded or session expired");
          return;
        }
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
        if (providerAdapter.name === "local_funasr") {
          if (event.isFinal) {
            partialAccumText = "";
          } else {
            partialAccumText = accumulatePartialText(partialAccumText, event.transcript.text);
            event.transcript = { ...event.transcript, text: partialAccumText };
          }
        }
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
      clearTimeout(upstreamConnectTimer);
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
        if (!safeSend(targetWs, data)) {
          failSession("ASR upstream send buffer overflow");
        }
      } else {
        if (pendingAudio.length >= MAX_PENDING_AUDIO_CHUNKS) {
          failSession("ASR upstream not ready, audio buffer overflow");
          return;
        }
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
    clearTimeout(upstreamConnectTimer);
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

  function handleUpgrade(req, socket, head) {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname !== path) {
      onUnhandledUpgrade?.(req, socket, head);
      return;
    }

    if (!isAllowedClientOrigin(req)) {
      console.warn(`[ASR Gateway] Rejected client origin: ${req.headers.origin || "(missing)"}`);
      rejectUpgrade(socket, 403, "Origin is not allowed");
      return;
    }

    const devAccountName = devMode ? process.env.DEV_ACTOR_ACCOUNT || "" : "";
    const authorization = authorizeAsrGatewaySession(
      readCookie(req, "meeting_asr_session"),
      devAccountName
    );
    if (!authorization.ok) {
      console.warn(`[ASR Gateway] Rejected client authentication: ${authorization.error}`);
      rejectUpgrade(socket, authorization.status, authorization.error);
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, req, authorization.actor);
    });
  }

  server.on("upgrade", handleUpgrade);

  return {
    close: () => {
      server.off("upgrade", handleUpgrade);
      wss.close();
    },
  };
}
