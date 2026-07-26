import WebSocket from "ws";
import { readFileSync } from "fs";

const env = {};
readFileSync(".env.local", "utf-8").split("\n").forEach((line) => {
  const t = line.trim();
  if (!t || t.startsWith("#")) return;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i)] = t.slice(i + 1);
});

const API_KEY = env.DASHSCOPE_API_KEY;
const WORKSPACE_ID = env.FUNASR_WORKSPACE_ID;
const URL = `wss://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`;
const TASK_ID = crypto.randomUUID();

console.log("URL:", URL);
console.log("Task ID:", TASK_ID);

const ws = new WebSocket(URL, {
  headers: { Authorization: `Bearer ${API_KEY}` },
});

ws.on("open", () => {
  console.log("Connected! Sending run-task...");
  ws.send(JSON.stringify({
    header: { action: "run-task", task_id: TASK_ID, streaming: "duplex" },
    payload: {
      task_group: "audio", task: "asr", function: "recognition",
      model: "fun-asr-realtime",
      parameters: { format: "pcm", sample_rate: 16000 },
      input: {},
    },
  }));
});

ws.on("message", (data) => {
  console.log("Response:", data.toString());
});

ws.on("error", (err) => {
  console.error("Error:", err.message);
});

ws.on("close", (code, reason) => {
  console.log("Closed:", code, reason.toString());
  process.exit(0);
});

setTimeout(() => {
  console.log("Timeout - no response after 10s");
  ws.close();
  process.exit(1);
}, 10000);
