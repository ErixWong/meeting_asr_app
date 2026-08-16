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
const DEFAULT_PROVIDER = "cosyvoice";
const DEFAULT_MODEL = "tts-1";
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
  const envProvider = process.env.TTS_PROVIDER;
  const envModel = process.env.TTS_MODEL;
  let db = null;
  try {
    db = getDb();
  } catch {
    db = null;
  }

  const dbEndpoint = db ? readSetting(db, "tts", "endpoint") : "";
  const dbVoice = db ? readSetting(db, "tts", "default_voice") : "";
  const dbProvider = db ? readSetting(db, "tts", "provider") : "";
  const dbModel = db ? readSetting(db, "tts", "model") : "";

  return {
    endpoint: (envEndpoint || dbEndpoint || DEFAULT_ENDPOINT).replace(/\/+$/, ""),
    defaultVoice: envVoice || dbVoice || DEFAULT_VOICE,
    provider: (envProvider || dbProvider || DEFAULT_PROVIDER).trim().toLowerCase(),
    model: envModel || dbModel || DEFAULT_MODEL,
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
// 支持中文标点（。！？；…）与英文标点（.!?;），并避免误切：
//   1. 中文标点 / 半角 !?; 直接断句；
//   2. 英文句点 . 先保护常见缩写（Mr. / U.S. / e.g. 等），再要求其前字符
//      不是数字（避免 3.14 / v1.2.3）且后随空白或行尾时才断句；
//   3. 换行也作为断句点。
const ABBR_DOT = "\u0001";
const ABBR_RE = /\b(?:Mr|Mrs|Ms|Dr|Prof|St|Sr|Jr|vs|etc|Inc|Ltd|Co|Corp|e\.g|i\.e|a\.m|p\.m|U\.S|U\.K)\./gi;
const SENTENCE_END_RE = /[。！？；…!?;]|(?<![0-9])\.(?=\s|$)|[\n]+/g;

function protectAbbreviations(text) {
  return text.replace(ABBR_RE, (m) => m.replace(/\.$/, ABBR_DOT));
}

function splitByEndMarks(text) {
  const protectedText = protectAbbreviations(text);
  const parts = [];
  let last = 0;
  SENTENCE_END_RE.lastIndex = 0;
  let match;
  while ((match = SENTENCE_END_RE.exec(protectedText)) !== null) {
    const end = match.index + match[0].length;
    parts.push(protectedText.slice(last, end));
    last = end;
  }
  if (last < protectedText.length) parts.push(protectedText.slice(last));
  return parts.map((part) => part.replaceAll(ABBR_DOT, "."));
}

export function splitSentences(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const sentences = splitByEndMarks(raw);
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

// ---------- 语言检测与自动音色 ----------

// 常见粤语用字（用于把粤语回复映射到粤语女声）
const YUE_CHARS_RE = /[唔嘅咗喺哋喇噉㗎啲乜嘢嚟]/g;

/** 简单语言检测：ja / ko / yue / en / zh（按字符占比，返回保守结果） */
export function detectTextLang(text) {
  const raw = String(text ?? "");
  const ja = (raw.match(/[\u3040-\u30ff\u31f0-\u31ff]/g) || []).length;
  const ko = (raw.match(/[\uac00-\ud7af\u1100-\u11ff]/g) || []).length;
  const han = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (raw.match(/[A-Za-z]/g) || []).length;
  const yue = (raw.match(YUE_CHARS_RE) || []).length;
  const total = ja + ko + han + latin;
  if (total === 0) return "zh";
  const jaRatio = ja / total;
  const koRatio = ko / total;
  const latinRatio = latin / total;
  if (jaRatio > 0.2) return "ja";
  if (koRatio > 0.2) return "ko";
  if (latinRatio > 0.6) return "en";
  if (yue > 0 && han > 0 && yue / han > 0.03) return "yue";
  return "zh";
}

// 语言 → 默认音色映射（音色名需与容器 /voices 一致；容器缺失该音色时回退默认）
const LANG_VOICE_MAP = {
  zh: "中文女",
  yue: "粤语女",
  en: "英文女",
  ja: "日语男",
  ko: "韩语女",
};

let voicesCache = null;
let voicesCacheAt = 0;
const VOICES_TTL_MS = 60_000;

async function listContainerVoices(config) {
  const now = Date.now();
  if (voicesCache && now - voicesCacheAt < VOICES_TTL_MS) return voicesCache;
  try {
    const res = await fetch(`${config.endpoint}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`container /voices ${res.status}`);
    const data = await res.json();
    // 兼容 { voices: [...] } 与裸数组两种返回
    const list = Array.isArray(data) ? data : data.voices;
    voicesCache = Array.isArray(list) ? list.map(String) : [];
  } catch {
    voicesCache = null;
  }
  voicesCacheAt = now;
  return voicesCache ?? [];
}

/** 按文本自动选择音色；容器没有该音色时回退默认音色（openai 协议无语言音色概念，直接返回默认） */
export async function pickVoiceForText(config, text) {
  if (config.provider === "openai") return config.defaultVoice;
  const lang = detectTextLang(text);
  const candidate = LANG_VOICE_MAP[lang];
  if (!candidate) return config.defaultVoice;
  const voices = await listContainerVoices(config);
  if (voices.length === 0 || voices.includes(candidate)) return candidate;
  return config.defaultVoice;
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

// 协议分发：cosyvoice（私有 inference_sft + PCM）| openai（标准 /v1/audio/speech + wav）
async function callTts(config, text, voice, { stream = false, signal } = {}) {
  if (config.provider === "openai") return callOpenAi(config, text, voice, { signal });
  return callCosyVoice(config, text, voice, { stream, signal });
}

// CosyVoice 私有协议：multipart form + 裸 PCM（16bit mono 22.05kHz）
async function callCosyVoice(config, text, voice, { stream = false, signal } = {}) {
  const form = new FormData();
  form.append("tts_text", text);
  form.append("spk_id", voice);
  form.append("stream", stream ? "true" : "false");

  const response = await fetch(`${config.endpoint}/inference_sft`, {
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

// OpenAI 兼容标准协议：JSON body + 音频字节（wav；服务商不支持时可在错误里带 hint）
async function callOpenAi(config, text, voice, { signal } = {}) {
  const response = await fetch(`${config.endpoint}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice,
      response_format: "wav",
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS error ${response.status}: ${detail.slice(0, 300)}`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new Error("OpenAI TTS returned empty audio");
  return audio;
}

function buildWavHeader(pcmLength, sampleRate = 22050, channels = 1, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
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

// 按句切分 + 逐句合成（串行），返回 [{ text, wav }]
// cosyvoice：逐句 PCM→wav（降低首音延迟）；openai：整段一次调用（标准协议无逐句/多音色语义）
async function synthesizeSentences(config, text, voice, { signal } = {}) {
  if (config.provider === "openai") {
    const audio = await callOpenAi(config, text, voice, { signal });
    return [{ text, wav: audio }];
  }
  const sentences = splitSentences(text);
  if (sentences.length === 0) throw new Error("Empty TTS text");

  const chunks = [];
  for (const sentence of sentences) {
    const pcm = await callCosyVoice(config, sentence, voice, { signal });
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
  const explicitVoice = String(body.voice || body.voice_id || "").trim();
  const stream = Boolean(body.stream);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENTENCE_TIMEOUT_MS * Math.max(splitSentences(text).length, 1));
  request.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const config = getTtsRuntimeConfig();
    // 未指定音色时按文本语言自动选择（多语言自动切换）
    const voice = explicitVoice || (await pickVoiceForText(config, text));

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
      if (config.provider === "openai") {
        // 标准协议：整段一次合成（无逐句语义），单 chunk 输出
        const audio = await callOpenAi(config, text, voice, { signal: controller.signal });
        const payload = JSON.stringify({ text, voice, wav: audio.toString("base64") });
        response.write(`event: chunk\ndata: ${payload}\n\n`);
        return;
      }
      const sentences = splitSentences(text);
      for (const sentence of sentences) {
        // 逐句自动选音色（支持中英混说），显式指定则始终用指定音色
        const sentenceVoice = explicitVoice || (await pickVoiceForText(config, sentence));
        const pcm = await callCosyVoice(config, sentence, sentenceVoice, { signal: controller.signal });
        const wav = pcmToWav(pcm);
        const payload = JSON.stringify({ text: sentence, voice: sentenceVoice, wav: wav.toString("base64") });
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
  const explicitVoice = String(body.voice || "").trim();
  const responseFormat = String(body.response_format || "wav").toLowerCase();
  if (responseFormat !== "wav") {
    return sendError(response, 400, `Unsupported response_format "${responseFormat}" (only wav)`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SENTENCE_TIMEOUT_MS * Math.max(splitSentences(text).length, 1));

  try {
    const config = getTtsRuntimeConfig();
    // 未指定音色时按文本语言自动选择（多语言自动切换）
    const voice = explicitVoice || (await pickVoiceForText(config, text));
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
  if (config.provider === "openai") {
    // OpenAI 标准协议没有音色列表 API，返回空列表（由前端提示按服务商文档手填）
    sendJson(response, 200, { voices: [] });
    return;
  }
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
  // cosyvoice 用私有 /health；openai 标准协议无 health，用 /v1/models 探测可达性
  const probe = config.provider === "openai" ? "/v1/models" : "/health";
  try {
    const res = await fetch(`${config.endpoint}${probe}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`${probe} ${res.status}`);
    const data = await res.json().catch(() => ({}));
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
