#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FunASR 声纹识别服务（CAM++ 说话人 embedding + 注册制 1:N 识别）
============================================================
独立容器 / 独立进程，与 ASR 转写服务解耦（规避 CAM++ 挂 ASR 全管线的内存问题）。

依赖（funasr-runtime-sdk 镜像内已具备，无需额外 pip 安装）：
  - Python 标准库（http.server / sqlite3 / wave）
  - numpy / torch / torchaudio（重采样）
  - funasr（AutoModel + spk_model=CAM++）

环境变量：
  VOICEPRINT_MODEL_DIR   模型目录（默认 /workspace/models/iic/speech_campplus_sv_zh-cn_16k-common）
  VOICEPRINT_DB_PATH     声纹库 SQLite 路径（默认 /data/voiceprints.db）
  VOICEPRINT_PORT        监听端口（默认 10097）
  VOICEPRINT_THRESHOLD   识别阈值（默认 0.35，可在运行时经 /config 调整）

API 契约（均为 JSON；audio 为 base64）：
  GET  /health                         健康检查 + 状态
  POST /embedding   {audio, format?, sample_rate?}          → {embedding:[192], elapsedMs, dim}
  POST /register    {name, audio, format?, sample_rate?}    → {ok, name, samples, elapsedMs}
  POST /identify    {audio, format?, sample_rate?}          → {matched, speaker, score, elapsedMs, top}
  GET  /speakers                        说话人列表
  DELETE /speakers/{name}               删除说话人
  GET  /config                          识别阈值等配置
  PUT  /config      {threshold}         更新配置

audio 说明：
  format 缺省 "wav"：完整 WAV 文件（任意采样率/声道，服务端自动转 16k 单声道）
  format "pcm"：裸 s16le PCM，需带 sample_rate
"""

import base64
import io
import json
import logging
import os
import re
import sqlite3
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import numpy as np
import torch
import torchaudio

# ---------------------------------------------------------------- 常量与配置

MODEL_DIR = os.environ.get(
    "VOICEPRINT_MODEL_DIR",
    "/workspace/models/iic/speech_campplus_sv_zh-cn_16k-common",
)
DB_PATH = os.environ.get("VOICEPRINT_DB_PATH", "/data/voiceprints.db")
PORT = int(os.environ.get("VOICEPRINT_PORT", "10097"))
DEFAULT_THRESHOLD = float(os.environ.get("VOICEPRINT_THRESHOLD", "0.35"))

TARGET_FS = 16000            # CAM++ 要求 16k
EMB_DIM = 192                # CAM++ embedding 维度
MIN_AUDIO_SAMPLES = int(TARGET_FS * 0.2)   # 最短有效音频 0.2s
MIN_SAMPLE_RATE = 8000       # 采样率校验下限（防 Resample 极端上采样 OOM）
MAX_SAMPLE_RATE = 96000      # 采样率校验上限
MAX_BODY_BYTES = 8 * 1024 * 1024           # 请求体上限 8MB（句级音频足够）
NAME_RE = re.compile(r"^[\w\-\u4e00-\u9fa5 ]{1,64}$")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("voiceprint")


# ---------------------------------------------------------------- 音频解码

def decode_audio(payload):
    """把请求里的 audio 字段解码为 (float32 单声道 16k numpy, 原采样率)。"""
    raw = payload.get("audio")
    if not isinstance(raw, str) or not raw:
        raise ValueError("audio is required (base64)")
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"audio base64 decode failed: {exc}") from exc
    if not data:
        raise ValueError("audio is empty")

    fmt = payload.get("format") or "wav"
    if fmt == "pcm":
        fs = int(payload.get("sample_rate") or 0)
        if not (MIN_SAMPLE_RATE <= fs <= MAX_SAMPLE_RATE):
            raise ValueError(f"sample_rate must be between {MIN_SAMPLE_RATE} and {MAX_SAMPLE_RATE}")
        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    elif fmt == "wav":
        try:
            with wave.open(io.BytesIO(data)) as wav:
                fs = wav.getframerate()
                channels = wav.getnchannels()
                width = wav.getsampwidth()
                if width != 2:
                    raise ValueError(f"only 16-bit WAV supported, got {width * 8}-bit")
                frames = wav.readframes(wav.getnframes())
        except ValueError as exc:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"invalid WAV data: {exc}") from exc
        samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            samples = samples.reshape(-1, channels)[:, 0]
    else:
        raise ValueError(f"unsupported format: {fmt}")

    # WAV 头里的采样率同样要防极端值（重采样 OOM）
    if not (MIN_SAMPLE_RATE <= fs <= MAX_SAMPLE_RATE):
        raise ValueError(f"sample_rate must be between {MIN_SAMPLE_RATE} and {MAX_SAMPLE_RATE}")

    if samples.size < MIN_AUDIO_SAMPLES:
        raise ValueError(f"audio too short: {samples.size / fs:.2f}s (min {MIN_AUDIO_SAMPLES / TARGET_FS:.1f}s)")

    # 重采样到 16k
    if fs != TARGET_FS:
        resampler = torchaudio.transforms.Resample(fs, TARGET_FS)
        samples = resampler(torch.from_numpy(samples)).numpy()

    return samples.astype(np.float32), fs


# ---------------------------------------------------------------- 声纹引擎

class VoicePrintEngine:
    """CAM++ 模型封装：加载一次，串行推理（线程锁）。"""

    def __init__(self, model_dir):
        self.model_dir = model_dir
        self.model = None
        self.lock = threading.Lock()
        self.load_error = None
        self.loaded_at = None

    def load(self):
        from funasr import AutoModel  # 延迟导入，避免启动报错阻塞 health

        try:
            t0 = time.time()
            self.model = AutoModel(
                model=self.model_dir,
                device="cpu",
                disable_update=True,
                disable_pbar=True,
            )
            self.loaded_at = time.time()
            logger.info("model loaded from %s in %.2fs", self.model_dir, time.time() - t0)
        except Exception as exc:  # noqa: BLE001
            self.load_error = f"{type(exc).__name__}: {exc}"
            logger.error("model load failed: %s", self.load_error)
            raise

    def extract(self, samples):
        """提取归一化 192 维 embedding。"""
        if self.model is None:
            raise RuntimeError("model not loaded")
        with self.lock:
            t0 = time.time()
            res = self.model.generate(input=samples)
            emb = np.asarray(res[0]["spk_embedding"]).reshape(-1).astype(np.float64)
        norm = np.linalg.norm(emb)
        if norm > 0:
            emb = emb / norm
        return emb, (time.time() - t0) * 1000


# ---------------------------------------------------------------- 声纹库

class VoicePrintStore:
    """SQLite 声纹库：说话人 → 均值 embedding（单位向量）。"""

    def __init__(self, db_path):
        self.db_path = db_path
        self.lock = threading.Lock()
        os.makedirs(os.path.dirname(db_path) or ".", exist_ok=True)
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS speakers (
                name       TEXT PRIMARY KEY,
                embedding  TEXT NOT NULL,
                samples    INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """
        )
        self.conn.commit()
        logger.info("voiceprint store ready at %s", db_path)

    def _get_meta(self, key, default=""):
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def _set_meta(self, key, value):
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        self.conn.commit()

    def get_threshold(self):
        raw = self._get_meta("threshold", str(DEFAULT_THRESHOLD))
        try:
            return float(raw)
        except ValueError:
            return DEFAULT_THRESHOLD

    def set_threshold(self, value):
        if not (0.0 <= float(value) <= 1.0):
            raise ValueError("threshold must be between 0 and 1")
        self._set_meta("threshold", str(float(value)))

    def register(self, name, embedding):
        """注册/追加样本：均值 embedding 并归一化。"""
        with self.lock:
            row = self.conn.execute(
                "SELECT embedding, samples FROM speakers WHERE name=?", (name,)
            ).fetchone()
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            if row:
                old = np.array(json.loads(row[0]), dtype=np.float64)
                n = row[1]
                mean = (old * n + embedding) / (n + 1)
                norm = np.linalg.norm(mean)  # 均值向量重新归一化为单位向量（保证 1:N 余弦阈值语义一致）
                if norm > 0:
                    mean = mean / norm
                samples = n + 1
                self.conn.execute(
                    "UPDATE speakers SET embedding=?, samples=?, updated_at=? WHERE name=?",
                    (json.dumps(mean.tolist()), samples, now, name),
                )
            else:
                mean = embedding
                samples = 1
                self.conn.execute(
                    "INSERT INTO speakers (name, embedding, samples, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (name, json.dumps(mean.tolist()), samples, now, now),
                )
            self.conn.commit()
            return samples

    def identify(self, embedding, top_k=3):
        """1:N 余弦匹配（库中均为单位向量，余弦=点积）。返回 (matched, speaker, score, top)。"""
        with self.lock:
            rows = self.conn.execute(
                "SELECT name, embedding FROM speakers ORDER BY samples DESC, name ASC"
            ).fetchall()
        scores = []
        for name, emb_json in rows:
            vec = np.array(json.loads(emb_json), dtype=np.float64)
            score = float(np.dot(vec, embedding))
            scores.append({"speaker": name, "score": round(score, 4)})
        scores.sort(key=lambda item: item["score"], reverse=True)
        top = scores[:top_k]
        if not top:
            return False, None, 0.0, []
        threshold = self.get_threshold()
        best = top[0]
        return (best["score"] >= threshold, best["speaker"], best["score"], top)

    def list_speakers(self):
        with self.lock:
            rows = self.conn.execute(
                "SELECT name, samples, created_at, updated_at FROM speakers "
                "ORDER BY created_at ASC"
            ).fetchall()
        return [
            {"name": r[0], "samples": r[1], "createdAt": r[2], "updatedAt": r[3]}
            for r in rows
        ]

    def delete(self, name):
        with self.lock:
            cur = self.conn.execute("DELETE FROM speakers WHERE name=?", (name,))
            self.conn.commit()
            return cur.rowcount > 0

    def count(self):
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) FROM speakers").fetchone()[0]

    def close(self):
        self.conn.close()


# ---------------------------------------------------------------- HTTP 服务

class VoicePrintHandler(BaseHTTPRequestHandler):
    server_version = "VoicePrint/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 工具方法 ----
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("request body too large")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON body: {exc}") from exc

    def _resolve_audio(self, payload):
        samples, fs = decode_audio(payload)
        emb, elapsed_ms = self.server.engine.extract(samples)
        return emb, elapsed_ms

    def _error(self, exc):
        logger.warning("request failed: %s", exc)
        # 不向客户端透传内部异常细节（路径/模块版本等），统一收敛
        status = 500 if isinstance(exc, (RuntimeError, OSError)) else 400
        message = "internal error" if status == 500 else str(exc)
        self._send_json({"error": message}, status=status)

    # ---- 路由 ----
    def do_GET(self):
        try:
            path = self.path.split("?")[0].rstrip("/")
            if path == "/health":
                self._send_json({
                    "status": "ok",
                    "version": "1.0.0",
                    "modelLoaded": self.server.engine.model is not None,
                    "modelPath": self.server.engine.model_dir,
                    "loadError": self.server.engine.load_error,
                    "speakers": self.server.store.count(),
                    "threshold": self.server.store.get_threshold(),
                    "uptimeSec": round(time.time() - self.server.started_at, 1),
                })
            elif path == "/speakers":
                self._send_json({"speakers": self.server.store.list_speakers()})
            elif path == "/config":
                self._send_json({"threshold": self.server.store.get_threshold()})
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    def do_POST(self):
        try:
            payload = self._read_body()
            path = self.path.split("?")[0].rstrip("/")
            if path == "/embedding":
                emb, elapsed_ms = self._resolve_audio(payload)
                self._send_json({
                    "embedding": [round(v, 6) for v in emb.tolist()],
                    "dim": len(emb),
                    "elapsedMs": round(elapsed_ms, 1),
                })
            elif path == "/register":
                name = str(payload.get("name") or "").strip()
                if not NAME_RE.match(name):
                    raise ValueError("name must be 1-64 chars of letters/digits/_/-/space/Chinese")
                emb, elapsed_ms = self._resolve_audio(payload)
                samples = self.server.store.register(name, emb)
                self._send_json({
                    "ok": True,
                    "name": name,
                    "samples": samples,
                    "elapsedMs": round(elapsed_ms, 1),
                })
            elif path == "/identify":
                emb, elapsed_ms = self._resolve_audio(payload)
                matched, speaker, score, top = self.server.store.identify(emb)
                self._send_json({
                    "matched": matched,
                    "speaker": speaker,
                    "score": score,
                    "elapsedMs": round(elapsed_ms, 1),
                    "top": top,
                })
            else:
                self._send_json({"error": "not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    def do_DELETE(self):
        try:
            path = self.path.split("?")[0].rstrip("/")
            prefix = "/speakers/"
            if not path.startswith(prefix):
                self._send_json({"error": "not found"}, 404)
                return
            name = unquote(path[len(prefix):])
            if self.server.store.delete(name):
                self._send_json({"ok": True, "name": name})
            else:
                self._send_json({"error": "speaker not found"}, 404)
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    def do_PUT(self):
        try:
            path = self.path.split("?")[0].rstrip("/")
            if path != "/config":
                self._send_json({"error": "not found"}, 404)
                return
            payload = self._read_body()
            if "threshold" not in payload:
                raise ValueError("threshold is required")
            self.server.store.set_threshold(payload["threshold"])
            self._send_json({"ok": True, "threshold": self.server.store.get_threshold()})
        except Exception as exc:  # noqa: BLE001
            self._error(exc)

    def log_message(self, fmt, *args):  # 精简访问日志
        logger.info("%s %s", self.command, self.path)


class VoicePrintServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, engine, store):
        super().__init__(addr, VoicePrintHandler)
        self.engine = engine
        self.store = store
        self.started_at = time.time()


def main():
    engine = VoicePrintEngine(MODEL_DIR)
    store = VoicePrintStore(DB_PATH)

    # 模型加载失败不阻断 HTTP 服务（health 可探活并暴露原因）
    try:
        engine.load()
    except Exception:  # noqa: BLE001
        logger.error("voiceprint engine unavailable, serving degraded /health")

    server = VoicePrintServer(("0.0.0.0", PORT), engine, store)
    logger.info("voiceprint server listening on :%d (threshold=%.2f)", PORT, store.get_threshold())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        store.close()
        server.server_close()


if __name__ == "__main__":
    main()
