#!/usr/bin/env node
/**
 * #103 探针 runner：起 `pi --mode rpc`，把它指向假端点，按行记录 stdout。
 *
 * 用法（每条都必须带 timeout，见 AGENTS.md §5）：
 *   timeout 90 node probe.mjs stream
 *   timeout 90 node probe.mjs approval --decision allow
 *   timeout 90 node probe.mjs approval --decision deny
 *   timeout 90 node probe.mjs approval --decision deny --ui confirm
 *   timeout 90 node probe.mjs abort
 *
 * 产物（都不提交，见 .gitignore）：gui/probes/rpc/.run/<name>.jsonl（原始 stdout）
 *   .run/<name>.events.txt（事件序列摘要）
 *   .run/<name>.stderr.log、.run/<name>.pi-config/models.json、.run/<name>.ext.log
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startFakeOpenAI } from "./fake-openai.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = path.join(HERE, ".run");
const PI_BIN = process.env.PI_BIN || "pi";
const EXTENSION = path.join(HERE, "approval-gate.ts");
const HARD_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 60_000);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
    else args._.push(a);
  }
  return args;
}

/** 严格按 rpc.md §Framing：只在 \n 上切，剥掉行尾 \r。 */
function jsonlReader(stream, onLine) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buf += chunk;
    for (;;) {
      const i = buf.indexOf("\n");
      if (i === -1) break;
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buf.length > 0) onLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
  });
}

function writeConfig(cfgDir, baseUrl) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          probe: {
            baseUrl,
            api: "openai-completions",
            apiKey: "probe-key-not-a-secret",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: "probe-model",
                name: "Probe Model (fake localhost endpoint)",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd) throw new Error("用法: node probe.mjs <stream|approval|abort> [--decision allow|deny] [--ui select|confirm]");

  const decision = args.decision === "deny" ? "deny" : args.decision === "cancel" ? "cancel" : "allow";
  const ui = ["confirm", "batch", "batch2"].includes(args.ui) ? args.ui : "select";
  const multi = Boolean(args.multi);
  const name = cmd === "approval" ? `${multi ? "multi" : "approval"}-${decision}-${ui}` : cmd;
  const scenario = cmd === "abort" ? "slow" : multi ? "multi" : "tool";
  const delayMs = cmd === "abort" ? 400 : 250;

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const cfgDir = path.join(RUN_DIR, `${name}.pi-config`);
  const scratchDir = path.join(RUN_DIR, `${name}.scratch`);
  fs.mkdirSync(scratchDir, { recursive: true });
  const markerFile = path.join(scratchDir, "tool-ran.txt");
  const markerFile2 = path.join(scratchDir, "tool-ran-2.txt");
  fs.rmSync(markerFile, { force: true });
  fs.rmSync(markerFile2, { force: true });
  const jsonlPath = path.join(RUN_DIR, `${name}.jsonl`);
  const stderrPath = path.join(RUN_DIR, `${name}.stderr.log`);
  const extLogPath = path.join(RUN_DIR, `${name}.ext.log`);
  const summaryPath = path.join(RUN_DIR, `${name}.events.txt`);
  fs.rmSync(extLogPath, { force: true });

  const fake = await startFakeOpenAI({
    scenario,
    delayMs,
    toolCommand: `echo CANTE-RPC-PROBE > ${JSON.stringify(markerFile)}`,
    secondToolCommand: `echo CANTE-RPC-PROBE-2 > ${JSON.stringify(markerFile2)}`,
    log: (m) => process.stderr.write(m + "\n"),
  });
  writeConfig(cfgDir, fake.url);

  const piArgs = [
    "--mode", "rpc",
    "--no-session",
    "--provider", "probe",
    "--model", "probe-model",
    ...(cmd === "stream" ? [] : ["-e", EXTENSION]),
  ];
  const child = spawn(PI_BIN, piArgs, {
    cwd: scratchDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: cfgDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PROBE_EXT_LOG: extLogPath,
      PROBE_UI_METHOD: ui,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const jsonlStream = fs.createWriteStream(jsonlPath);
  const stderrStream = fs.createWriteStream(stderrPath);
  child.stderr.pipe(stderrStream);

  /** @type {any[]} */
  const events = [];
  let exited = false;
  let exitInfo = null;
  child.on("exit", (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });

  jsonlReader(child.stdout, (line) => {
    jsonlStream.write(line + "\n");
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      events.push({ type: "<unparseable>", raw: line });
      return;
    }
    events.push(obj);
  });

  const send = (obj) => {
    if (child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify(obj) + "\n");
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeoutMs = 25_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (exited && Date.now() > deadline - 20_000) throw new Error(`进程已退出，等不到 ${label}`);
      if (Date.now() > deadline) throw new Error(`超时：等 ${label} 超过 ${timeoutMs}ms`);
      await sleep(25);
    }
  }

  const abortController = new AbortController();
  const hardTimer = setTimeout(() => {
    process.stderr.write(`\n[probe] 硬超时 ${HARD_TIMEOUT_MS}ms，杀掉 pi 并如实报告\n`);
    abortController.abort();
    child.kill("SIGKILL");
  }, HARD_TIMEOUT_MS);

  let aborted = false;
  const uiRequests = [];
  const handleUiRequest = async (req) => {
    uiRequests.push(req);
    if (!["select", "confirm", "input", "editor"].includes(req.method)) return; // fire-and-forget
    if (decision === "cancel") {
      // 模拟用户关掉对话框 / 客户端不回答（文档：extension 侧 select 得到 undefined，confirm 得到 false）。
      send({ type: "extension_ui_response", id: req.id, cancelled: true });
      return;
    }
    if (req.method === "confirm") {
      send({ type: "extension_ui_response", id: req.id, confirmed: decision === "allow" });
    } else if (req.method === "select") {
      send({ type: "extension_ui_response", id: req.id, value: decision === "allow" ? "允许一次" : "拒绝" });
    }
  };

  // 每收到一条 extension_ui_request 就按脚本回一次。
  const uiWatcher = setInterval(() => {
    for (const e of events) {
      if (e.type === "extension_ui_request" && !uiRequests.some((r) => r.id === e.id)) void handleUiRequest(e);
    }
  }, 20);

  try {
    const firstPrompt = { id: "p1", type: "prompt", message: "请把这件事做了" };
    send(firstPrompt);

    if (cmd === "abort") {
      await waitFor(
        (e) => e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta",
        "第一条 text_delta",
      );
      send({ id: "a1", type: "abort" });
      aborted = true;
    }

    await waitFor((e) => e.type === "agent_settled", "agent_settled");
    // 收尾：再问一次状态（SessionInfo 证据），然后关 stdin。
    send({ id: "s1", type: "get_state" });
    send({ id: "s2", type: "get_session_stats" });
    await waitFor((e) => e.type === "response" && e.command === "get_session_stats", "get_session_stats 回应");
  } catch (err) {
    process.stderr.write(`[probe] ${err.message}\n`);
  } finally {
    clearInterval(uiWatcher);
    clearTimeout(hardTimer);
    child.stdin.end();
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) {
      child.kill("SIGKILL");
      process.stderr.write("[probe] pi 在 stdin EOF 后 5s 没退出，SIGKILL\n");
      await sleep(100);
    }
    jsonlStream.end();
    await fake.close();
  }

  const types = events.map((e) => {
    if (e.type === "message_update") return `message_update/${e.assistantMessageEvent?.type ?? "?"}`;
    if (e.type === "response") return `response/${e.command}${e.success === false ? "(failed)" : ""}`;
    if (e.type === "extension_ui_request") return `extension_ui_request/${e.method}`;
    return e.type;
  });
  fs.writeFileSync(summaryPath, types.join("\n") + "\n");

  const assistantEnds = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
  const lastAssistant = assistantEnds.at(-1)?.message;
  const toolEnds = events.filter((e) => e.type === "tool_execution_end");
  const report = {
    probe: name,
    scenario,
    ui,
    decision,
    aborted,
    exit: exitInfo,
    markerFileExists: fs.existsSync(markerFile),
    markerFile2Exists: fs.existsSync(markerFile2),
    eventCount: events.length,
    sequence: types,
    uiRequests: uiRequests.map((r) => ({ method: r.method, id: r.id, title: r.title, options: r.options, message: r.message })),
    toolExecutionEnd: toolEnds.map((e) => ({ toolName: e.toolName, toolCallId: e.toolCallId, isError: e.isError, result: e.result })),
    stopReason: lastAssistant?.stopReason ?? null,
    lastAssistantText: Array.isArray(lastAssistant?.content)
      ? lastAssistant.content.filter((c) => c.type === "text").map((c) => c.text).join("")
      : null,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
