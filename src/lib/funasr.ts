/**
 * FunASR browser client.
 * The browser only connects to the local ASR Gateway; provider credentials and
 * upstream protocol details stay on the server side.
 */

export interface FunASROptions {
  hotWords?: string[];
  onResult: (text: string, isFinal: boolean, speakerId?: number | null, audioData?: Float32Array) => void;
  onError: (error: Error) => void;
  onStatusChange?: (status: string) => void;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class FunASRClient {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private options: FunASROptions | null = null;
  private isRecording = false;
  private isPaused = false;
  private sessionId: string = "";
  private captureSessionId: string = "";
  private audioBuffer: Float32Array[] = [];
  private audioBufferStartTime: number = 0;

  getCaptureSessionId(): string {
    return this.captureSessionId;
  }

  async transcribeFile(
    file: File,
    onResult: (text: string, isFinal: boolean, speakerId?: number | null) => void,
    onProgress?: (progress: number) => void
  ): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") await ctx.resume();

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const rawData = audioBuffer.getChannelData(0);

    const resampled = this.resample(rawData, audioBuffer.sampleRate, 16000);
    const pcmData = this.convertFloat32ToInt16(resampled);

    const wsUrl = this.getWebSocketUrl();
    console.log("[FunASR] Transcribing file, connecting to:", wsUrl);
    const sessionId = generateUUID();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    this.captureSessionId = "";

    const totalChunks = Math.ceil(pcmData.length / 3200);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("连接超时")), 15000);

      ws.onopen = () => {
        console.log("[FunASR] WebSocket opened, starting ASR session");
        ws.send(JSON.stringify({
          type: "session.start",
          sessionId,
          audio: {
            format: "pcm",
            sampleRate: 16000,
          },
        }));
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const msg = JSON.parse(event.data);

        if (msg.type === "session.started") {
          this.captureSessionId = msg.captureSessionId || "";
          console.log("[FunASR] Session started, sending audio...");
          clearTimeout(timeout);

          (async () => {
            for (let i = 0; i < totalChunks; i++) {
              const start = i * 3200;
              const end = Math.min(start + 3200, pcmData.length);
              const chunk = pcmData.slice(start, end);
              ws.send(chunk.buffer);
              onProgress?.(Math.floor((i / totalChunks) * 100));
              await new Promise((r) => setTimeout(r, 20));
            }
            console.log("[FunASR] All audio sent, finishing ASR session");
            ws.send(JSON.stringify({
              type: "session.finish",
              sessionId,
            }));
          })();

        } else if (msg.type === "transcript.partial" || msg.type === "transcript.final") {
          if (msg.text) {
            onResult(msg.text, msg.type === "transcript.final", msg.speakerId ?? null);
          }
        } else if (msg.type === "session.finished") {
          console.log("[FunASR] Session finished");
          resolve();
        } else if (msg.type === "session.failed") {
          const errMsg = msg.error || "ASR session failed";
          console.error("[FunASR] Session failed:", errMsg);
          reject(new Error(errMsg));
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("无法连接到语音识别服务，请确认应用服务已启动 (npm run dev)"));
      };
    });

    ws.close();
    ctx.close();
  }

  private resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return data;
    const ratio = fromRate / toRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIdx = i * ratio;
      const idx = Math.floor(srcIdx);
      const frac = srcIdx - idx;
      result[i] = idx + 1 < data.length
        ? data[idx] * (1 - frac) + data[idx + 1] * frac
        : data[idx];
    }
    return result;
  }

  private getWebSocketUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/asr`;
  }

  async startRecording(options: FunASROptions, deviceId?: string): Promise<void> {
    this.options = options;
    this.sessionId = generateUUID();
    this.captureSessionId = "";
    this.sessionStarted = false;

    try {
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.audioContext = new AudioContext({ sampleRate: 16000 });
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      await this.connectWebSocket();
      this.startAudioCapture();
      this.isRecording = true;
    } catch (error) {
      this.options.onError(error as Error);
      throw error;
    }
  }

  private async connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.getWebSocketUrl();
      this.ws = new WebSocket(url);
      this.ws.binaryType = "arraybuffer";

      const timeout = setTimeout(() => {
        this.options?.onError(new Error("连接超时：未收到 session.started"));
        reject(new Error("timeout"));
      }, 15000);

      this.ws.onopen = () => {
        console.log("[FunASR] WebSocket connected, starting ASR session...");
        this.ws!.send(JSON.stringify({
          type: "session.start",
          sessionId: this.sessionId,
          audio: {
            format: "pcm",
            sampleRate: 16000,
          },
          hotWords: this.options?.hotWords ?? [],
        }));
        this.sessionStartedResolve = () => { clearTimeout(timeout); resolve(); };
        this.sessionStartedReject = (err) => { clearTimeout(timeout); reject(err); };
      };

      this.ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          this.handleMessage(event.data);
        }
      };

      this.ws.onerror = (error) => {
        clearTimeout(timeout);
        console.error("[FunASR] WebSocket error:", error);
        this.options?.onError(new Error("WebSocket connection failed"));
        reject(error);
      };

      this.ws.onclose = (event) => {
        clearTimeout(timeout);
        console.log("[FunASR] WebSocket closed:", event.code, event.reason);
        this.options?.onStatusChange?.("disconnected");
      };
    });
  }

  private sessionStartedResolve: (() => void) | null = null;
  private sessionStartedReject: ((err: Error) => void) | null = null;
  private sessionStarted = false;

  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data);
      console.log("[FunASR] Received:", message);

      if (message.type) {
        if (message.type === "session.started") {
          console.log("[FunASR] Session started!");
          this.sessionStarted = true;
          this.captureSessionId = message.captureSessionId || "";
          this.options?.onStatusChange?.("recording");
          if (this.sessionStartedResolve) {
            this.sessionStartedResolve();
            this.sessionStartedResolve = null;
          }
        } else if (message.type === "transcript.partial" || message.type === "transcript.final") {
          const text = message.text || "";
          const isFinal = message.type === "transcript.final";
          const speakerId = message.speakerId ?? null;
          if (text) {
            let audioData: Float32Array | undefined;
            if (isFinal && message.beginTime != null && message.endTime != null) {
              audioData = this.extractAudioSegment(message.beginTime, message.endTime);
            }
            this.options?.onResult(text, isFinal, speakerId, audioData);
          }
        } else if (message.type === "session.finished") {
          console.log("[FunASR] Session finished");
        } else if (message.type === "session.failed") {
          const errorMessage = message.error || "ASR session failed";
          console.error("[FunASR] Session failed:", errorMessage);
          if (this.sessionStartedReject) {
            this.sessionStartedReject(new Error(errorMessage));
            this.sessionStartedReject = null;
          }
          this.options?.onError(new Error(errorMessage));
        }
      }
    } catch (error) {
      console.error("[FunASR] Parse error:", error);
    }
  }

  private startAudioCapture(): void {
    if (!this.audioContext || !this.mediaStream) return;

    console.log("[FunASR] Starting audio capture, tracks:", this.mediaStream.getTracks().length);
    console.log("[FunASR] AudioContext state:", this.audioContext.state, "sampleRate:", this.audioContext.sampleRate);

    this.audioBuffer = [];
    this.audioBufferStartTime = performance.now();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

    let sentCount = 0;
    this.scriptProcessor.onaudioprocess = (event) => {
      if (!this.isRecording || this.isPaused || !this.sessionStarted || this.ws?.readyState !== WebSocket.OPEN) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const pcmData = this.convertFloat32ToInt16(inputData);
      this.ws.send(pcmData.buffer);

      this.audioBuffer.push(new Float32Array(inputData));

      if (sentCount < 5) {
        sentCount++;
        console.log(`[FunASR] Sent audio chunk #${sentCount}, samples:`, pcmData.length);
      }
    };

    this.sourceNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
    console.log("[FunASR] Audio graph connected");
  }

  private extractAudioSegment(beginTimeMs: number, endTimeMs: number): Float32Array {
    const sampleRate = 16000;
    const startSample = Math.floor((beginTimeMs / 1000) * sampleRate);
    const endSample = Math.floor((endTimeMs / 1000) * sampleRate);
    const totalSamples = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);

    if (startSample >= totalSamples) return new Float32Array(0);

    const result: number[] = [];
    let currentSample = 0;

    for (const chunk of this.audioBuffer) {
      for (let i = 0; i < chunk.length; i++) {
        if (currentSample >= startSample && currentSample < endSample) {
          result.push(chunk[i]);
        }
        currentSample++;
        if (currentSample >= endSample) break;
      }
      if (currentSample >= endSample) break;
    }

    return new Float32Array(result);
  }

  private convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  async stopRecording(): Promise<void> {
    this.isRecording = false;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "session.finish", sessionId: this.sessionId }));

      await new Promise((r) => setTimeout(r, 2000));
    }

    this.scriptProcessor?.disconnect();
    this.sourceNode?.disconnect();
    this.audioContext?.close();
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.ws?.close();

    this.scriptProcessor = null;
    this.sourceNode = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.ws = null;
    this.sessionStarted = false;
  }
}

export async function getAudioDevices(): Promise<
  { deviceId: string; label: string }[]
> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === "audioinput")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || `麦克风 ${device.deviceId.slice(0, 8)}`,
      }));
  } catch (error) {
    console.error("Failed to get audio devices:", error);
    return [{ deviceId: "default", label: "默认麦克风" }];
  }
}
