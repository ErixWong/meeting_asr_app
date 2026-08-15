// TTS 网关：对接本地 CosyVoice 容器（cosyvoice-tts :8010）
// 职责：
//   1. 配置读取（环境变量 > app_settings(tts 段) > 默认值）
//   2. 断句切分（按句合成 → 降低首音延迟）
//   3. 全局串行队列（TTS 容器单实例，避免并发打爆）
//   4. HTTP 端点：/api/tts/health、/api/tts/voices、/api/tts/synthesize（支持流式 SSE）
//   5. OpenAI 兼容：POST /v1/audio/speech（返回 wav）

import { getDb } from "./db-shared.mjs";

const DEFAULT_ENDPOINT = "http://localhost:8010";
const DEFAULT_VOICE = "中文女";
const CONFIG_TTL_MS = 10_000;
const MAX_SENTENCE_CHARS = 80;
const SENTENCE_TIMEOUT_MS = 60_000;

// ---------- 配置 ----------

let cachedConfig = null;
let cachedConfigAt = 0;

function readSetting(db, section, mark) {
  const row = db
    .prepare("SELECT item_value FROM app_settings WHERE item_section = ? AND item_mark = ?")
    .get(section, mark);
  return row?.item_value ?? "";
}

function loadTtsConfig() {
  const envEndpoint = process.env.TTS_ENDPOINT;
  const envVoice = process.env.TTS_DEFAULT_VOICE;
  let db = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }

  const dbEndpoint = db ? readSetting(db, "tts", "endpoint") : "";
  const dbVoice = db ? readSetting(db, "tts", "default_voice") : "";

  return {
    endpoint: (envEndpoint || dbEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    defaultVoice: envVoice || dbVoice || DEFAULT_VOICE,
  };
}

export function getTtsRuntimeConfig() {
  const now = Date.now();
  if (!cachedConfig || now - cachedConfigAt > CONFIG_TTL_MS) {
    cachedConfig = loadTtsConfig();
    cachedConfigAt = now;
  }
  return cachedConfig;
}

export function invalidateTtsRuntimeConfig() {
  cachedConfig = null;
  cachedConfigAt = 0;
}

// ---------- 断句 ----------

// 按标点切句（保留标点），忽略空白；超长句强制按长度再切。
const SENTENCE_SPLIT_RE = /[^。！？；…\n]+[。！？；…\n]?/g;

export function splitSentences(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const sentences = raw.match(SENTENCE_SPLIT_RE) || [];
  const result = [];
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_SENTENCE_CHARS) {
      // 长句按逗号/空格再切，仍超长则硬切
      const parts = trimmed.match(/[^，,、\s]+[，,、]?/g) || [];
      let buffer = "";
      for (const part of parts) {
        if (buffer.length + part.length > MAX_SENTENCE_CHARS && buffer) {
          result.push(buffer);
          buffer = part;
        } else {
          buffer += part;
        }
      }
      if (buffer) result.push(buffer);
    } else {
      result.push(trimmed);
    }
  }
  return result;
}

// ---------- 串行队列 ----------

let queueChain = Promise.resolve();

function enqueue(task) {
  const run = queueChain.then(task, task);
  // 失败不阻塞后续任务
  queueChain = run.catch(() => {});
  return run;
}

// ---------- 容器调用 ----------

function buildWavHeader(pcmLength, sampleRate = 22050, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

function pcmToWav(pcmBuffer) {
  return Buffer.concat([buildWavHeader(pcmBuffer.length), pcmBuffer]);
}

async function callContainer(endpoint, text, voice, { stream = false, signal } = {}) {
  const form = new FormData();
  form.append("tts_text", text);
  form.append("spk_id", voice);
  form.append("stream", stream ? "true" : "false");

  const response = await fetch(`${endpoint}/inference_sft`, {
    method: "POST",
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`TTS container error ${response.status}: ${detail.slice(0, 200)}`);
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length === 0) throw new Error("TTS container returned empty audio");
  return pcm;
}

// 按句切分 + 逐句合成（串行），返回 [{ text, wav }]
async function synthesizeSentences(config, text, voice, { signal } = {}) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) throw new Error("Empty TTS text");

  const chunks = [];
  for (const sentence of sentences) {
    const pcm = await callContainer(config.endpoint, sentence, voice, { signal });
    chunks.push({ text: sentence, wav: pcmToWav(pcm) });
  }
  return chunks;
}

// ---------- HTTP 工具 ----------

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

// ---------- 端点处理 ----------

async function handleSynthesize(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendError(response, 400, error.message);
  }

  const text = String(body.text ?? "").trim();
  if (!text) return sendError(response, 400, "text is required");
  const voice = String(body.voice || body.voice_id || "").trim() || getTtsRuntimeConfig().defaultVoice;
  const stream = Boolean(body.stream);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENTENCE_TIMEOUT_MS * Math.max(splitSentences(text).length, 1));
  request.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const config = getTtsRuntimeConfig();

    if (!stream) {
      // 非流式：整段合成后返回单个 wav
      const chunks = await enqueue(() => synthesizeSentences(config, text, voice, { signal: controller.signal }));
      const wav = Buffer.concat(chunks.map((chunk) => chunk.wav));
      response.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": wav.length,
        "Cache-Control": "no-store",
      });
      response.end(wav);
      return;
    }

    // 流式：SSE，每个句子一个 chunk 事件，逐句合成边出边发
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    response.write(`event: start\ndata: ${JSON.stringify({ voice, sentenceCount: splitSentences(text).length })}\n\n`);

    await enqueue(async () => {
      const sentences = splitSentences(text);
      for (const sentence of sentences) {
        const pcm = await callContainer(config.endpoint, sentence, voice, { signal: controller.signal });
        const wav = pcmToWav(pcm);
        const payload = JSON.stringify({ text: sentence, wav: wav.toString("base64") });
        response.write(`event: chunk\ndata: ${payload}\n\n`);
      }
    });

    response.write(`event: done\ndata: {}\n\n`);
    response.end();
  } catch (error) {
    if (error.name === "AbortError") {
      if (!response.writableEnded) {
        response.write(`event: error\ndata: ${JSON.stringify({ error: "aborted" })}\n\n`);
        response.end();
      }
      return;
    }
    if (!response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
      response.end();
    }
  } finally {
    clearTimeout(timeout);
  }
}

// OpenAI 兼容 POST /v1/audio/speech
async function handleOpenAiSpeech(request, response) {
  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return sendError(response, 400, error.message);
  }

  const text = String(body.input ?? "").trim();
  if (!text) return sendError(response, 400, "input is required");
  const voice = String(body.voice || "").trim() || getTtsRuntimeConfig().defaultVoice;
  const responseFormat = String(body.response_format || "wav").toLowerCase();
  if (responseFormat !== "wav") {
    return sendError(response, 400, `Unsupported response_format "${responseFormat}" (only wav)`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENTENCE_TIMEOUT_MS * Math.max(splitSentences(text).length, 1));

  try {
    const config = getTtsRuntimeConfig();
    const chunks = await enqueue(() => synthesizeSentences(config, text, voice, { signal: controller.signal }));
    const wav = Buffer.concat(chunks.map((chunk) => chunk.wav));
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": wav.length,
      "Cache-Control": "no-store",
    });
    response.end(wav);
  } catch (error) {
    if (error.name !== "AbortError") {
      sendError(response, 502, `TTS synthesis failed: ${error.message}`);
    } else if (!response.writableEnded) {
      sendError(response, 504, "TTS synthesis timed out");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleVoices(request, response) {
  const config = getTtsRuntimeConfig();
  try {
    const res = await fetch(`${config.endpoint}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`container /voices ${res.status}`);
    const data = await res.json();
    sendJson(response, 200, data);
  } catch (error) {
    sendError(response, 502, `TTS container unreachable: ${error.message}`);
  }
}

async function handleHealth(request, response) {
  const config = getTtsRuntimeConfig();
  try {
    const res = await fetch(`${config.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`container /health ${res.status}`);
    const data = await res.json();
    sendJson(response, 200, { ok: true, container: data });
  } catch (error) {
    sendJson(response, 200, { ok: false, container: { error: error.message } });
  }
}

// ---------- 挂载 ----------

// 返回 { handle(request, response) }：匹配 TTS 路径则处理并返回 true，否则 false。
// 调用方在 createServer 回调中先调用 handle，命中则不再交给 Next.js。
export function createTtsGateway(options = {}) {
  const basePath = options.path || "/api/tts";
  const openAiPath = options.openAiPath || "/v1/audio/speech";

  return {
    handle(request, response) {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname;

      if (request.method === "GET" && path === `${basePath}/health`) {
        handleHealth(request, response);
        return true;
      }
      if (request.method === "GET" && path === `${basePath}/voices`) {
        handleVoices(request, response);
        return true;
      }
      if (request.method === "POST" && path === `${basePath}/synthesize`) {
        handleSynthesize(request, response);
        return true;
      }
      if (request.method === "POST" && path === openAiPath) {
        handleOpenAiSpeech(request, response);
        return true;
      }
      return false;
    },
  };
}
