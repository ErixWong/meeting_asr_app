/**
 * 声纹音频编码辅助（服务端模块，勿在客户端 import）
 * 客户端上传 Float32Array(LE, 16k 单声道) base64 → 服务端转 int16 PCM base64 转发声纹服务。
 */

const MAX_AUDIO_SAMPLES = 60 * 16000; // 单句最长 60s
const MAX_B64_BYTES = 32 * 1024 * 1024;

export function base64Float32ToInt16Pcm(b64: string, sampleRate: number): { pcmBase64: string; sampleRate: number } {
  if (typeof b64 !== "string" || !b64) {
    throw new Error("audio is required (base64 float32)");
  }
  if (b64.length > MAX_B64_BYTES) {
    throw new Error("audio payload too large");
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length % 4 !== 0) {
    throw new Error("audio payload is not float32 samples");
  }
  const sampleCount = buf.length / 4;
  if (sampleCount < 1600) {
    throw new Error("audio too short");
  }
  if (sampleCount > MAX_AUDIO_SAMPLES) {
    throw new Error("audio too long");
  }

  const out = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const f = buf.readFloatLE(i * 4);
    const s = Math.max(-1, Math.min(1, f));
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }

  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 16000;
  return { pcmBase64: out.toString("base64"), sampleRate: rate };
}
