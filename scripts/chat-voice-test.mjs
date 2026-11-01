/**
 * /chat 语音按钮单测（node --test）
 *
 * 运行：npm run test:chat（= node --test scripts/chat-voice-test.mjs，需 Node 24）
 *
 * 覆盖：
 *   1. ChatVoiceButton 的按住/松开状态机（真机回归 fix-261101-01 F1）：
 *      「启动期间松手」「60s 兜底」「正常长按释放」三条场景，断言最终 phase 回到 idle、
 *      计时器被清、且 stopRecording（= 一次 session.finish）只发一次。
 *
 * 做法（本机无浏览器 / 无 react-dom 测试渲染器）：
 *   - 用 tsc 把 ChatVoiceButton.tsx 编译到临时目录（临时 tsconfig 提供 @/* 路径别名）；
 *   - 把编译产物里的 import 说明符改写到 stub（`react` / `react/jsx-runtime` / `@/lib/funasr`），
 *     改一个断言一个命中（不命中就抛，避免「改了个寂寞」式的假绿）；
 *   - stub react 提供最小 hooks 运行时（useState/useRef/useCallback/useEffect），
 *     stub FunASRClient 让 startRecording 可控地「迟到返回」；
 *   - 假定时器（setTimeout/setInterval）由探针自己推进，才能验证 60s 兜底与 tick 是否被清。
 *
 * 假定时器会替换全局 timer，为避免干扰 node:test 自身，状态机探针在**子进程**里跑：
 * 父进程只 spawn 自己（`--probe`）并断言退出码。
 *
 * 反向验证（对基点 main 的旧代码跑同一探针）：
 *   CHAT_VOICE_SRC_ROOT=<含 src/ 的旧代码树> node --test scripts/chat-voice-test.mjs
 *   → 旧代码应失败（探针输出逐条断言原文）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const SRC_ROOT = resolve(process.env.CHAT_VOICE_SRC_ROOT || ".");
const IS_PROBE_CHILD = process.argv.includes("--probe");

/** 把 "from \"spec\"" 逐个改写到 stub，命中 0 次直接抛（防止静默没改）。 */
function rewriteImports(file, mapping) {
  let code = readFileSync(file, "utf-8");
  for (const [spec, target] of Object.entries(mapping)) {
    const needle = `from "${spec}"`;
    const hits = code.split(needle).length - 1;
    if (hits < 1) {
      throw new Error(`编译产物里找不到 import "${spec}"（${file}），无法改写到 stub`);
    }
    code = code.split(needle).join(`from "${pathToFileURL(target).href}"`);
  }
  writeFileSync(file, code);
}

const STUB_REACT = `// 最小 React hooks 运行时（仅探针用）
let slots = [];
let cursor = 0;
let visited = [];
let component = null;
let scheduled = false;
let tree = null;

function sameDeps(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    if (component) render();
  });
}

function runEffects() {
  for (const i of visited) {
    const s = slots[i];
    if (!s || s.kind !== "effect") continue;
    if (s.mounted && sameDeps(s.deps, s.nextDeps)) continue;
    if (s.mounted && typeof s.cleanup === "function") s.cleanup();
    s.deps = s.nextDeps;
    s.mounted = true;
    const c = s.fn();
    s.cleanup = typeof c === "function" ? c : undefined;
  }
}

function render() {
  cursor = 0;
  visited = [];
  const out = component();
  runEffects();
  tree = out;
  return out;
}

export function __reset() {
  slots = [];
  cursor = 0;
  visited = [];
  scheduled = false;
  tree = null;
}

export function __mount(fn) {
  component = fn;
  return render();
}

export function __tree() {
  return tree;
}

export function useState(initial) {
  const i = cursor++;
  visited.push(i);
  const s = slots[i] || (slots[i] = { kind: "state", value: typeof initial === "function" ? initial() : initial });
  if (!s.set) {
    s.set = (v) => {
      const next = typeof v === "function" ? v(s.value) : v;
      if (Object.is(next, s.value)) return;
      s.value = next;
      schedule();
    };
  }
  return [s.value, s.set];
}

export function useRef(initial) {
  const i = cursor++;
  visited.push(i);
  const s = slots[i] || (slots[i] = { kind: "ref", current: initial });
  return s;
}

export function useCallback(fn, deps) {
  const i = cursor++;
  visited.push(i);
  const s = slots[i] || (slots[i] = { kind: "callback", deps: undefined, fn });
  if (!sameDeps(s.deps, deps)) {
    s.deps = deps;
    s.fn = fn;
  }
  return s.fn;
}

export function useEffect(fn, deps) {
  const i = cursor++;
  visited.push(i);
  const s = slots[i] || (slots[i] = { kind: "effect", mounted: false, deps: undefined, cleanup: undefined });
  s.fn = fn;
  s.nextDeps = deps;
}
`;

const STUB_JSX = `// 最小 jsx-runtime（仅探针用）：元素就是普通对象，探针可直接读 props / 派发事件
export function jsx(type, props, key) {
  return { type, props: props || {}, key };
}
export const jsxs = jsx;
export const jsxDEV = jsx;
export const Fragment = Symbol.for("react.fragment");
`;

const STUB_FUNASR = `// FunASRClient stub：startRecording 由探针控制何时返回，stopRecording 计数
export const instances = [];

export class FunASRClient {
  constructor() {
    this.startCalls = 0;
    this.stopCalls = 0;
    this.finishSent = 0;
    this.recording = false;
    this.options = null;
    this.startPromise = new Promise((res) => {
      this._resolveStart = res;
    });
    instances.push(this);
  }

  startRecording(options) {
    this.startCalls += 1;
    this.options = options;
    return this.startPromise;
  }

  /** 模拟「连接就绪、启动流程迟到返回」 */
  resolveStart() {
    this.recording = true;
    this._resolveStart();
  }

  /** 模拟真实 client：stopRecording 置 stopRequested，启动流程随后安静返回（funasr.ts:205-208） */
  async stopRecording() {
    this.stopCalls += 1;
    if (this.recording) {
      this.finishSent += 1;
      this.recording = false;
    }
    // 真实 client 是在自己的下一个 await 之后才检查 stopRequested 并安静返回（funasr.ts:205-208），
    // 这里也延后一个微任务，别让「同步 resolve」把真实时序抹平
    await null;
    this._resolveStart();
  }
}
`;

/**
 * 准备 stub + 编译产物，返回 { workDir, outDir, stubsDir, componentPath, funasrStubPath }。
 * reuseDir 非空时（子进程）直接复用父进程已编译好的目录，不再跑 tsc。
 */
function prepare(reuseDir) {
  const workDir = reuseDir || process.env.CHAT_VOICE_PROBE_DIR || mkdtempSync(join(tmpdir(), "chat-voice-test-"));
  const outDir = join(workDir, "out");
  const stubsDir = join(workDir, "stubs");
  mkdirSync(stubsDir, { recursive: true });

  writeFileSync(join(stubsDir, "stub-react.mjs"), STUB_REACT);
  writeFileSync(join(stubsDir, "stub-jsx.mjs"), STUB_JSX);
  writeFileSync(join(stubsDir, "stub-funasr.mjs"), STUB_FUNASR);

  const componentPath = join(outDir, "components/chat/ChatVoiceButton.js");
  if (reuseDir) {
    if (!existsSync(componentPath)) throw new Error(`复用的编译产物不存在: ${componentPath}`);
    return { workDir, outDir, stubsDir, componentPath, funasrStubPath: join(stubsDir, "stub-funasr.mjs") };
  }

  const tsconfigPath = join(workDir, "tsconfig.probe.json");
  writeFileSync(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          esModuleInterop: true,
          outDir,
          rootDir: join(SRC_ROOT, "src"),
          baseUrl: SRC_ROOT,
          paths: { "@/*": ["./src/*"] },
          types: [],
        },
        files: [join(SRC_ROOT, "src/components/chat/ChatVoiceButton.tsx")],
      },
      null,
      2
    )
  );

  const tsc = spawnSync("npx", ["tsc", "-p", tsconfigPath], { encoding: "utf-8" });
  if (tsc.status !== 0) {
    throw new Error(`tsc 编译 ChatVoiceButton.tsx 失败:\n${tsc.stdout || ""}${tsc.stderr || ""}`);
  }

  rewriteImports(componentPath, {
    react: join(stubsDir, "stub-react.mjs"),
    "react/jsx-runtime": join(stubsDir, "stub-jsx.mjs"),
    "@/lib/funasr": join(stubsDir, "stub-funasr.mjs"),
  });

  return { workDir, outDir, stubsDir, componentPath, funasrStubPath: join(stubsDir, "stub-funasr.mjs") };
}

// ---------------------------------------------------------------- 探针（子进程）

const flush = () => new Promise((r) => setImmediate(r));

function createClock() {
  const timers = new Map();
  let seq = 1;
  let now = 0;
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  return {
    install() {
      globalThis.setTimeout = (fn, ms = 0, ...args) => {
        const id = seq++;
        timers.set(id, { fn, args, at: now + ms, interval: null });
        return id;
      };
      globalThis.setInterval = (fn, ms = 0, ...args) => {
        const id = seq++;
        timers.set(id, { fn, args, at: now + (ms || 1), interval: ms || 1 });
        return id;
      };
      globalThis.clearTimeout = (id) => timers.delete(id);
      globalThis.clearInterval = (id) => timers.delete(id);
    },
    uninstall() {
      Object.assign(globalThis, real);
    },
    pendingIntervals: () => [...timers.values()].filter((t) => t.interval !== null).length,
    pendingTimers: () => timers.size,
    /** 推进假时钟：到点就执行回调，每次回调后清空微任务（让 state 更新/重渲染落地） */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let pick = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
        }
        if (!pick) break;
        const [id, t] = pick;
        now = t.at;
        if (t.interval !== null) t.at = now + t.interval;
        else timers.delete(id);
        t.fn(...t.args);
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.props) flatten(node.props.children, out);
    return out;
  }
  out.push(String(node));
  return out;
}

function findButton(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findButton(n);
      if (hit) return hit;
    }
    return null;
  }
  if (node.type === "button") return node;
  return node.props ? findButton(node.props.children) : null;
}

function buttonLabel(tree) {
  const btn = findButton(tree);
  if (!btn) throw new Error("渲染树里找不到 <button>");
  return flatten(btn.props.children).join("");
}

function fullText(tree) {
  return flatten(tree).join("");
}

async function runProbe() {
  const prepared = prepare(process.env.CHAT_VOICE_PROBE_DIR);
  const react = await import(pathToFileURL(join(prepared.stubsDir, "stub-react.mjs")).href);
  const funasr = await import(pathToFileURL(prepared.funasrStubPath).href);
  const { default: ChatVoiceButton } = await import(pathToFileURL(prepared.componentPath).href);

  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, msg: err?.message ?? String(err) });
    }
  };
  const eq = (name, actual, expected) => check(name, () => assert.equal(actual, expected));

  /** 一条场景：装好 stub + 假时钟，跑完清理 */
  async function scenario(fn) {
    react.__reset();
    funasr.instances.length = 0;
    const clock = createClock();
    clock.install();
    const utterances = [];
    react.__mount(() => ChatVoiceButton({ onUtterance: (t) => utterances.push(t), disabled: false }));
    await flush();
    const ctx = {
      clock,
      utterances,
      tree: () => react.__tree(),
      label: () => buttonLabel(react.__tree()),
      text: () => fullText(react.__tree()),
      client: () => funasr.instances[0],
      press: () => {
        const btn = findButton(react.__tree());
        btn.props.onPointerDown({
          button: 0,
          pointerId: 1,
          preventDefault() {},
          currentTarget: { setPointerCapture() {} },
        });
      },
      release: () => {
        const btn = findButton(react.__tree());
        btn.props.onPointerUp({ pointerId: 1 });
      },
      /** 模拟 ASR 返回一句 final 结果 */
      finalResult: (text) => {
        funasr.instances[0].options.onResult(text, true);
      },
    };
    try {
      await fn(ctx);
    } finally {
      await flush();
      clock.uninstall();
    }
  }

  const only = process.env.CHAT_VOICE_PROBE_SCENARIO || "";

  // 场景 A：按下即松手（startRecording 还在 await）→ 启动流程迟到返回时不得复活 holding
  if (!only || only === "A") {
    await scenario(async (c) => {
      eq("A: 初始为 idle", c.label(), "🎙 按住说话");
      c.press();
      await flush();
      eq("A: 按下后进入 starting", c.label(), "🎙 正在启动…");
      eq("A: starting 阶段未建 tick", c.clock.pendingIntervals(), 0);

      c.release(); // 启动还没返回就松手
      await flush();
      eq("A: 松手后（微任务排空）回 idle", c.label(), "🎙 按住说话");
      eq("A: 松手时 stopRecording 只调一次", c.client().stopCalls, 1);

      c.client().resolveStart(); // 启动流程此刻才迟到返回（真机上的竞态）
      await flush();
      await flush();
      eq("A: 启动迟到返回后仍是 idle（不得复活 holding）", c.label(), "🎙 按住说话");
      eq("A: 迟到返回不得起 tick", c.clock.pendingIntervals(), 0);
      // 启动期间松手时 WS 还没 OPEN，真实 client 也不会发 session.finish（finishSent 恒 0），
      // 所以这里只断言「stopRecording 不被二次调用」——那才是二次 session.finish 的来源
      eq("A: 迟到返回不得二次 stopRecording", c.client().stopCalls, 1);

      await c.clock.advance(1_000);
      eq("A: 迟到返回后推进 1s 仍 idle（tick 没在跑）", c.label(), "🎙 按住说话");
    });
  }

  // 场景 B：60s 兜底 —— B1 正常长按到 60s 自动结束；B2 卡死态（旧代码的现场）也要能自救
  if (!only || only === "B") {
    await scenario(async (c) => {
      c.press();
      await flush();
      c.client().resolveStart();
      await flush();
      eq("B1: 启动完成后进入 holding", c.label(), "🎙 正在听… 00:00");
      eq("B1: holding 阶段 tick 在跑", c.clock.pendingIntervals(), 1);
      await c.clock.advance(60_000);
      eq("B1: 60s 兜底后回 idle", c.label(), "🎙 按住说话");
      eq("B1: 60s 兜底后 tick 被清", c.clock.pendingIntervals(), 0);
      eq("B1: 60s 兜底后 stopRecording 只调一次", c.client().stopCalls, 1);
    });

    await scenario(async (c) => {
      // 现场复刻：按下即松手 + 启动迟到返回（旧代码此时把 phase 复活成 holding、tick 一直跑）
      c.press();
      await flush();
      c.release();
      await flush();
      c.client().resolveStart();
      await flush();
      await flush();
      await c.clock.advance(61_000); // 真机实测 01:00 不自愈
      eq("B2: 卡死态下 60s 兜底必须能救回 idle", c.label(), "🎙 按住说话");
      eq("B2: 卡死态兜底后 tick 必须被清", c.clock.pendingIntervals(), 0);
      eq("B2: 全程 stopRecording 只调一次", c.client().stopCalls, 1);
    });
  }

  // 场景 C：正常长按 → 松开 → idle，且只发一次 session.finish
  if (!only || only === "C") {
    await scenario(async (c) => {
      c.press();
      await flush();
      c.client().resolveStart();
      await flush();
      eq("C: 长按中为 holding", c.label(), "🎙 正在听… 00:00");
      eq("C: 有「录音中」徽标", c.text().includes("录音中，松开即发送"), true);
      c.finalResult("你好");
      await flush();
      await c.clock.advance(3_000);
      eq("C: 计时器在走", c.label(), "🎙 正在听… 00:03");

      c.release();
      await flush();
      await flush();
      eq("C: 松手后回 idle", c.label(), "🎙 按住说话");
      eq("C: 计时归零", c.text().includes("正在听"), false);
      eq("C: 只调一次 stopRecording", c.client().stopCalls, 1);
      eq("C: 只发一次 session.finish", c.client().finishSent, 1);
      eq("C: 松手后 tick 被清", c.clock.pendingIntervals(), 0);
      eq("C: 最终文本回传一次", c.utterances.join("|"), "你好");
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} - ${r.name}${r.ok ? "" : `\n       ${r.msg}`}`);
  }
  console.log(`\n探针汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log(`失败断言原文：\n${failed.map((f) => `- ${f.name}\n  ${f.msg}`).join("\n")}`);
  }
  // 只在「自己新建的临时目录」里清理（复用父进程目录时删了会把后面两个场景的产物带走）
  if (!process.env.CHAT_VOICE_PROBE_DIR) rmSync(prepared.workDir, { recursive: true, force: true });
  process.exitCode = failed.length ? 1 : 0;
}

// ---------------------------------------------------------------- 测试（父进程）

// 父进程只编译一次，三个场景各自 spawn 一个子进程（假定时器不污染 node:test）
let preparedDir = null;
function probeDir() {
  if (!preparedDir) preparedDir = prepare().workDir;
  return preparedDir;
}

process.on("exit", () => {
  if (preparedDir) rmSync(preparedDir, { recursive: true, force: true });
});

function runProbeChild(scenario) {
  const env = { ...process.env, CHAT_VOICE_PROBE_SCENARIO: scenario, CHAT_VOICE_PROBE_DIR: probeDir() };
  return spawnSync(process.execPath, [SELF, "--probe"], { encoding: "utf-8", env });
}

if (IS_PROBE_CHILD) {
  await runProbe();
} else {
  test("状态机 A：按下即松手（启动期间释放）最终回 idle、tick 被清", () => {
    const r = runProbeChild("A");
    assert.equal(r.status, 0, `探针失败（exit ${r.status}）:\n${r.stdout || ""}${r.stderr || ""}`);
  });

  test("状态机 B：60s 兜底（含卡死态自救）回 idle、tick 被清", () => {
    const r = runProbeChild("B");
    assert.equal(r.status, 0, `探针失败（exit ${r.status}）:\n${r.stdout || ""}${r.stderr || ""}`);
  });

  test("状态机 C：正常长按释放回 idle，且只发一次 session.finish", () => {
    const r = runProbeChild("C");
    assert.equal(r.status, 0, `探针失败（exit ${r.status}）:\n${r.stdout || ""}${r.stderr || ""}`);
  });
}
