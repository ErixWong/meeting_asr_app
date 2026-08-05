import { NextRequest, NextResponse } from "next/server";
import { ADMIN_ROLES, withRequiredRoles } from "@/lib/api-auth";
import { getSettingValue } from "@/lib/admin-store";

type DiagnosticStep = {
  step: string;
  ok: boolean;
  detail: string;
  elapsedMs?: number;
};

type AsrDiagnostics = {
  providerType: string;
  inputEndpoint: string;
  targetUrl: string;
  hasApiKey: boolean;
  workspaceId?: string;
  steps: DiagnosticStep[];
};

type HttpRequestOptions = import("http").RequestOptions & {
  rejectUnauthorized?: boolean;
};

type HttpClient = {
  request: (
    options: HttpRequestOptions,
    callback: (response: import("http").IncomingMessage) => void
  ) => import("http").ClientRequest;
};

type WebSocketProbe = {
  terminate: () => void;
  close: () => void;
  on: {
    (event: "open", listener: () => void): WebSocketProbe;
    (event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number; statusMessage?: string }) => void): WebSocketProbe;
    (event: "close", listener: (code: number, reason: Buffer) => void): WebSocketProbe;
    (event: "error", listener: (error: Error) => void): WebSocketProbe;
  };
};

type WebSocketConstructor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocketProbe;

function normalizeFunasrUrl(rawUrl: string) {
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

function elapsedStep(step: string, startedAt: number, ok: boolean, detail: string): DiagnosticStep {
  return { step, ok, detail, elapsedMs: Date.now() - startedAt };
}

function errorDetail(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error ? String((error as Error & { code?: string }).code || "") : "";
  return [code, error.message].filter(Boolean).join(" ");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string) {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function probeDns(hostname: string): Promise<DiagnosticStep> {
  const startedAt = Date.now();
  try {
    const dns = (eval("require") as NodeRequire)("dns").promises as typeof import("dns").promises;
    const records = await withTimeout(dns.lookup(hostname, { all: true }), 3000, "DNS lookup");
    return elapsedStep(
      "dns",
      startedAt,
      true,
      records.map((record) => `${record.address} IPv${record.family}`).join(", ")
    );
  } catch (error) {
    return elapsedStep("dns", startedAt, false, errorDetail(error));
  }
}

async function probeTcp(hostname: string, port: number): Promise<DiagnosticStep> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const net = (eval("require") as NodeRequire)("net") as typeof import("net");
    const socket = net.createConnection({ host: hostname, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(elapsedStep("tcp", startedAt, false, "TCP timeout after 5000ms"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(elapsedStep("tcp", startedAt, true, `connected to ${hostname}:${port}`));
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      resolve(elapsedStep("tcp", startedAt, false, errorDetail(error)));
    });
  });
}

async function probeHttp(url: URL, headers?: Record<string, string>): Promise<DiagnosticStep> {
  const startedAt = Date.now();
  const step = `${url.protocol === "wss:" ? "https" : "http"} ${url.pathname || "/"}`;

  return new Promise((resolve) => {
    const client = (eval("require") as NodeRequire)(
      url.protocol === "wss:" ? "https" : "http"
    ) as HttpClient;
    const req = client.request(
      {
        hostname: url.hostname,
        port: Number(url.port || (url.protocol === "wss:" ? 443 : 80)),
        path: `${url.pathname || "/"}${url.search}`,
        method: "GET",
        headers,
        timeout: 5000,
        rejectUnauthorized: false,
      },
      (res: import("http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").slice(0, 240).replace(/\s+/g, " ");
          resolve(
            elapsedStep(
              step,
              startedAt,
              true,
              `HTTP ${res.statusCode}; server=${res.headers.server || "unknown"}; body=${body || "<empty>"}`
            )
          );
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(elapsedStep(step, startedAt, false, "HTTP timeout after 5000ms"));
    });
    req.on("error", (error) => resolve(elapsedStep(step, startedAt, false, errorDetail(error))));
    req.end();
  });
}

async function probeWebSocket(url: string, headers?: Record<string, string>): Promise<DiagnosticStep> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const Ws = (eval("require") as NodeRequire)("ws").WebSocket as WebSocketConstructor;
    const ws = new Ws(url, headers ? { headers } : undefined);
    let settled = false;
    const finish = (step: DiagnosticStep) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(step);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      finish(elapsedStep("websocket", startedAt, false, "WebSocket handshake timeout after 8000ms"));
    }, 8000);

    ws.on("open", () => {
      ws.close();
      finish(elapsedStep("websocket", startedAt, true, "handshake succeeded"));
    });
    ws.on("unexpected-response", (_req: unknown, response: { statusCode?: number; statusMessage?: string }) => {
      finish(
        elapsedStep(
          "websocket",
          startedAt,
          false,
          `unexpected HTTP ${response.statusCode || "unknown"} ${response.statusMessage || ""}`.trim()
        )
      );
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (code !== 1000 && code !== 1005) {
        finish(elapsedStep("websocket", startedAt, false, `closed before open: code=${code} reason=${reason.toString()}`));
      }
    });
    ws.on("error", (error: Error) => {
      finish(elapsedStep("websocket", startedAt, false, errorDetail(error)));
    });
  });
}

async function diagnoseWebSocket(
  targetUrl: string,
  providerType: string,
  inputEndpoint: string,
  apiKey: string,
  workspaceId: string
) {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const parsedUrl = new URL(targetUrl);
  const port = Number(parsedUrl.port || (parsedUrl.protocol === "wss:" ? 443 : 80));
  const diagnostics: AsrDiagnostics = {
    providerType,
    inputEndpoint,
    targetUrl,
    hasApiKey: Boolean(apiKey),
    workspaceId: workspaceId || undefined,
    steps: [],
  };

  diagnostics.steps.push(await probeDns(parsedUrl.hostname));
  diagnostics.steps.push(await probeTcp(parsedUrl.hostname, port));
  diagnostics.steps.push(await probeHttp(parsedUrl, headers));
  diagnostics.steps.push(await probeWebSocket(targetUrl, headers));

  return diagnostics;
}

export async function POST(req: NextRequest) {
  return withRequiredRoles(req, ADMIN_ROLES, async () => {
  try {
      const body = await req.json();
      const providerType = body.providerType || "local_funasr";
      const endpoint = String(body.endpoint || "");
      const apiKey = String(body.apiKey || getSettingValue("asr", "api_key"));
      const workspaceId = String(body.workspaceId || "");

      const targetUrl = providerType === "dashscope"
        ? `wss://${workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`
        : normalizeFunasrUrl(endpoint);

      if (!targetUrl || (providerType === "dashscope" && (!apiKey || !workspaceId))) {
        return NextResponse.json({ ok: false, error: "ASR config incomplete" }, { status: 400 });
      }

      const diagnostics = await diagnoseWebSocket(targetUrl, providerType, endpoint, apiKey, workspaceId);
      const wsStep = diagnostics.steps.find((step) => step.step === "websocket");
      if (!wsStep?.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: wsStep?.detail || "ASR WebSocket handshake failed",
            diagnostics,
          },
          { status: 502 }
        );
      }

      return NextResponse.json({ ok: true, diagnostics });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : "ASR test failed" },
        { status: 500 }
      );
    }
  });
}
