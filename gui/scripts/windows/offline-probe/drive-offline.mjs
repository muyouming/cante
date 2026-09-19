// 跑一张卡，并把**结局那一屏**原样截回来（成功或失败都算一个有价值的结局）。
//
// 与 accept-drive.mjs 的关系：那一份是"验收通过"的驱动，遇到失败页会 fail()；
// 这一份专门用来验收**失败页本身**，所以：
//   * 它不把失败当失败——它把那一屏的文字、HTML、截图落盘，作为证据；
//   * 它比 accept-drive.mjs 多传两个环境变量进去：`PI_CODING_AGENT_DIR`（把 pi 指到
//     我们摆好的假服务方）与 `CANTE_BRIDGE_STALL_SECS`（把停滞后判据压到可观测的量级）。
//     accept-drive.mjs 的 cleanEnv() 会把所有 PI_* 删掉（那是为了证明"零环境变量"），
//     所以这一条路只能单独一个驱动，不能改那份 —— 一改就把"零环境变量"验丢了。
//
// 环境变量（全部由 run-offline.ps1 设好）：
//   OFFLINE_APP / OFFLINE_INPUT / OFFLINE_WORKDIR / OFFLINE_SCENARIO / OFFLINE_TIMEOUT_MS
//   OFFLINE_MSEDGEDRIVER / OFFLINE_TAURI_DRIVER / OFFLINE_PI_CONFIG_DIR / OFFLINE_RESULT_JSON

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Builder, By, Capabilities } from "selenium-webdriver";

const env = process.env;
const APP = env.OFFLINE_APP ?? "";
const INPUT = env.OFFLINE_INPUT ?? "";
const WORKDIR = env.OFFLINE_WORKDIR ?? "";
const SCENARIO = env.OFFLINE_SCENARIO ?? "";
const MSEDGEDRIVER = env.OFFLINE_MSEDGEDRIVER ?? "";
const TAURI_DRIVER = env.OFFLINE_TAURI_DRIVER ?? "";
const PI_CONFIG_DIR = env.OFFLINE_PI_CONFIG_DIR ?? "";
const STALL_SECS = env.OFFLINE_STALL_SECS ?? "";
const ARTIFACTS = env.OFFLINE_ARTIFACTS ?? WORKDIR;
const RESULT_JSON = env.OFFLINE_RESULT_JSON ?? path.join(ARTIFACTS, "offline-result.json");
const HELPER = env.OFFLINE_DIALOG_HELPER ?? "";
const PORT = Number(env.OFFLINE_WD_PORT ?? 4445);
const RUN_TIMEOUT_MS = Number(env.OFFLINE_TIMEOUT_MS ?? 20 * 60 * 1000);
const SESSION_TIMEOUT_MS = 120_000;
const CARD = env.OFFLINE_CARD ?? "从大表里挑出想要的行";
const INSTRUCTION = env.OFFLINE_INSTRUCTION ?? "把华东区的记录挑出来，另存成一张新表";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => console.log(...p);

const steps = [];
async function phase(name, fn) {
  const started = Date.now();
  log(`[phase] ${name} …`);
  const value = await fn();
  const ms = Date.now() - started;
  steps.push({ name, ms });
  log(`[phase] ${name} — ${ms} ms`);
  return value;
}

function fail(message) {
  const error = new Error(message);
  error.offlineFailure = true;
  throw error;
}

function requireFile(label, value) {
  if (!value || !existsSync(value)) fail(`${label} 不存在：${value || "(空)"}`);
}

/**
 * 给子进程一份干净的环境。
 *
 * 为什么必须清：驱动自身跑在**这台机器上线的 pi 会话里**（PI_PROVIDER / PI_MODEL /
 * PI_SESSION_FILE / PI_SESSION_ID … 全在环境里）。这些会一路继承到应用 → 桥 → pi，
 * 把「用哪个服务方」盖掉——于是我们摆的假服务方根本没被用上，现场就没造出来。
 * 只留 `PI_CODING_AGENT_DIR`（把 pi 指到我们摆的配置目录）与停滞后判据，其余 PI_* 全删。
 */
function childEnv() {
  const merged = { ...env };
  for (const key of Object.keys(merged)) {
    if (key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR") delete merged[key];
  }
  merged.CANTE_ADMIN_CONFIG = path.join(ARTIFACTS, "admin.json");
  merged.PI_CODING_AGENT_DIR = PI_CONFIG_DIR;
  if (STALL_SECS) merged.CANTE_BRIDGE_STALL_SECS = STALL_SECS;
  return merged;
}

async function waitForDriver(proc) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`tauri-driver 退出了（code ${proc.exitCode}）`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await sleep(400);
  }
  fail(`tauri-driver 没有在 ${PORT} 上就绪`);
}

async function bodyText(driver) {
  return await (await driver.findElement(By.css("body"))).getText();
}

async function waitForText(driver, test, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { last = await bodyText(driver); } catch { last = ""; }
    if (last && test(last)) return last;
    await sleep(400);
  }
  fail(`等「${label}」超时（${timeoutMs}ms）。最后看到的页面：\n${last.slice(0, 1500)}`);
}

async function waitForElement(driver, by, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await driver.findElements(by).catch(() => []);
    if (found.length) return found[0];
    await sleep(300);
  }
  fail(`找不到「${label}」（${timeoutMs}ms）`);
}

async function clickButton(driver, label) {
  const b = await waitForElement(driver, By.xpath(`//button[normalize-space(.)="${label}"]`), `按钮 ${label}`);
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", b).catch(() => {});
  await b.click();
  return b;
}

function startDialogHelper() {
  const started = Date.now();
  const helper = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HELPER, "-Path", INPUT, "-TimeoutSec", "90"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  helper.stdout.on("data", (c) => { output += c; process.stdout.write(`[dialog] ${c}`); });
  helper.stderr.on("data", (c) => process.stderr.write(`[dialog] ${c}`));
  const done = new Promise((resolve) => helper.on("exit", (code) => resolve({ code, output, ms: Date.now() - started })));
  return { helper, done };
}

async function capture(driver, tag) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const saved = [];
  const write = (name, data) => {
    const target = path.join(ARTIFACTS, name);
    writeFileSync(target, data);
    saved.push(name);
  };
  try { write(`${tag}.txt`, await bodyText(driver)); } catch {}
  try { write(`${tag}.html`, await driver.getPageSource()); } catch {}
  try { write(`${tag}.png`, Buffer.from(await driver.takeScreenshot(), "base64")); } catch {}
  return saved;
}

const DONE_TEXT = "做好了";
// 结局面那几种标题（都是产品文案的原文，不自己编）。
const ERROR_TITLE = "这次没能做完";
const FAIL_TITLE = "这件事没有做完";

/**
 * 跑到「结局」为止：成功（结果页「做好了」）、失败（出错页「这次没能做完」）、
 * 或结果卡说「这件事没有做完」。三条都算结局。
 *
 * 超时**不算驱动失败**：这一轮要的可观测现象有时就是「一直转圈、一直不说」
 * （假的安静与真的断网在界面上长得很像）。所以超时就原样把那一屏交回去，交给人判断。
 */
async function driveToOutcome(driver) {
  const counters = { approvals: 0, questions: 0, followups: 0 };
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  const beat = path.join(ARTIFACTS, "progress.txt");
  let lastText = "";
  let blank = 0;
  while (Date.now() < deadline) {
    try {
      const now = await bodyText(driver);
      if (now && now !== lastText) {
        lastText = now;
        try { writeFileSync(beat, `${new Date().toISOString()}\n${now}\n`); } catch {}
      } else if (!now) {
        blank += 1;
      }
    } catch (error) {
      // 读不到页面：记下来但不立刻放弃 —— WebDriver 会话偶发一次读失败，
      // 继续拖着看它能不能恢复。
      try { writeFileSync(beat, `${new Date().toISOString()} 读页面失败：${error?.message}\n${lastText}\n`); } catch {}
      blank += 1;
      // 会话真的死了（invalid session id / 连不上驱动端口）就立刻收手：
      // 再等下去只会把剩下的时间耗完，而且这一屏的空白是**工具链**的问题，
      // 不是产品的现象 —— 不能把它当成“她看到的”。
      const message = String(error?.message ?? "");
      if (/invalid session id|ECONNREFUSED|no such session|not connected/i.test(message)) {
        return { counters, outcomeText: lastText, timedOut: true, blank, sessionDied: true, sessionError: message };
      }
    }

    if (lastText.includes(DONE_TEXT) || lastText.includes(ERROR_TITLE) || lastText.includes(FAIL_TITLE)) {
      return { counters, outcomeText: lastText, timedOut: false, blank };
    }

    if (lastText.includes("要不要允许它继续？")) {
      const before = counters.approvals;
      await clickButton(driver, "允许这次").catch(() => {});
      await sleep(600);
      const after = await bodyText(driver).catch(() => "");
      if (!after.includes("要不要允许它继续？")) counters.approvals = before + 1;
      continue;
    }
    if (lastText.includes("它想问你几件事")) {
      await clickButton(driver, "按它的建议来").catch(() => {});
      counters.questions += 1;
      await sleep(800);
      continue;
    }
    if (lastText.includes("它有一件事想问你")) {
      await clickButton(driver, "你看着办").catch(() => {});
      counters.followups += 1;
      await sleep(800);
      continue;
    }
    await sleep(1000);
  }
  return { counters, outcomeText: lastText, timedOut: true, blank };
}

function listOutputs() {
  const found = [];
  if (!existsSync(WORKDIR)) return found;
  for (const name of readdirSync(WORKDIR)) {
    const full = path.join(WORKDIR, name);
    try {
      const info = statSync(full);
      if (info.isFile()) found.push({ name, path: full, bytes: info.size });
    } catch {}
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 首次向导：只有全新档案时才会出现（跑一遍就走过去了）。不处理的话，首页永远等不到。
 * 三步：欢迎 → 检查电脑 → 开始使用；后两步可能自己跳过去（探测很快），所以每一步
 * 都“能点就点，点不到就算了”，最后再用“需要我帮你做什么”确认已经到首页。
 */
async function skipWizardIfPresent(driver) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = await bodyText(driver).catch(() => "");
    if (text.includes("需要我帮你做什么")) return;
    for (const label of ["开始检查", "下一步", "开始使用"]) {
      const found = await driver.findElements(By.xpath(`//button[normalize-space(.)="${label}"]`)).catch(() => []);
      if (found.length) {
        await found[0].click().catch(() => {});
        await sleep(800);
        break;
      }
    }
    await sleep(600);
  }
}

async function main() {
  requireFile("应用", APP);
  requireFile("msedgedriver", MSEDGEDRIVER);
  requireFile("tauri-driver", TAURI_DRIVER);
  requireFile("输入文件", INPUT);
  requireFile("对话框助手", HELPER);
  if (!PI_CONFIG_DIR) fail("没有给 OFFLINE_PI_CONFIG_DIR —— 这一轮必须把 pi 指到我们摆好的假服务方");
  mkdirSync(ARTIFACTS, { recursive: true });

  log(`==> 场景：${SCENARIO}`);
  log(`==> 应用：${APP}`);
  log(`==> pi 配置目录：${PI_CONFIG_DIR}（假服务方在这里面）`);
  if (STALL_SECS) log(`==> 停滞后判据：${STALL_SECS} 秒（产品默认 600；这里压低是为了可观测）`);
  log(`==> 工作目录：${WORKDIR}`);

  let driver = null;
  let driverProc = null;
  const result = {
    ok: false, scenario: SCENARIO, steps, counters: {},
    outcomeText: "", outcome: "", outputs: [], artifacts: [], piConfigDir: PI_CONFIG_DIR,
    stallSecs: STALL_SECS || "(默认)",
  };
  try {
    driverProc = spawn(TAURI_DRIVER, ["--port", String(PORT), "--native-driver", MSEDGEDRIVER], {
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    driverProc.stdout.on("data", (c) => process.stdout.write(`[tauri-driver] ${c}`));
    driverProc.stderr.on("data", (c) => process.stderr.write(`[tauri-driver] ${c}`));

    await phase("tauri-driver 就绪", () => waitForDriver(driverProc));

    driver = await phase("打开 WebDriver 会话（启动应用）", async () => {
      const capabilities = new Capabilities();
      capabilities.setBrowserName("wry");
      capabilities.set("tauri:options", { application: APP });
      const building = new Builder().usingServer(`http://127.0.0.1:${PORT}`).withCapabilities(capabilities).build();
      building.catch(() => {});
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`创建会话超过 ${SESSION_TIMEOUT_MS}ms`)), SESSION_TIMEOUT_MS);
      });
      try { return await Promise.race([building, timeout]); } finally { clearTimeout(timer); }
    });

    const home = await phase("首页出现", async () => {
      await skipWizardIfPresent(driver);
      return waitForText(driver, (t) => t.includes("需要我帮你做什么"), "首页");
    });
    log(`--- 首页 ---\n${home.split("\n").map((l) => "  | " + l).slice(0, 14).join("\n")}`);

    await phase(`点卡片「${CARD}」`, async () => {
      const card = await waitForElement(driver, By.xpath(`//button[starts-with(@aria-label, "${CARD}")]`), `任务卡 ${CARD}`);
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", card).catch(() => {});
      await card.click();
    });

    await phase("选文件（原生对话框）", async () => {
      await waitForText(driver, (t) => t.includes("选择文件"), "选文件这一步");
      const helper = startDialogHelper();
      await clickButton(driver, "选择文件");
      const finished = await helper.done;
      if (finished.code !== 0) fail(`填原生对话框的助手退出码 ${finished.code}`);
      steps.push({ name: "  填原生对话框", ms: finished.ms });
      const basename = path.basename(INPUT);
      await waitForText(driver, (t) => t.includes(basename), `选中的文件 ${basename}`, 30_000);
      await clickButton(driver, "下一步");
    });

    await phase("写一句话并生成计划", async () => {
      const box = await waitForElement(driver, By.css("#task-instruction"), "输入框 #task-instruction");
      await box.sendKeys(INSTRUCTION);
      await clickButton(driver, "生成计划");
    });

    await phase("确认页 → 开始", async () => {
      const confirm = await waitForText(driver, (t) => t.includes("它打算这样做"), "确认页");
      log(`--- 确认页（节选）---\n${confirm.split("\n").map((l) => "  | " + l).slice(0, 16).join("\n")}`);
      await clickButton(driver, "开始");
    });

    const { counters, outcomeText, timedOut, blank, sessionDied, sessionError } = await phase("干活（含审批/提问）", () => driveToOutcome(driver));
    result.counters = counters;
    result.outcomeText = outcomeText;
    result.timedOut = !!timedOut;
    result.blankPolls = blank;
    result.sessionDied = !!sessionDied;
    if (sessionError) result.sessionError = sessionError;
    result.outcome = outcomeText.includes(DONE_TEXT)
      ? "done"
      : (outcomeText.includes(ERROR_TITLE) ? "error-page"
        : (outcomeText.includes(FAIL_TITLE) ? "failed-card" : "timeout-no-outcome"));
    log(`--- 结局页（${result.outcome}）---\n${outcomeText.split("\n").map((l) => "  | " + l).slice(0, 30).join("\n")}`);
    log(`==> 替她点了：审批 ${counters.approvals} 次、结构化提问 ${counters.questions} 次、追问 ${counters.followups} 次`);
    log(`==> 读页面失败次数：${blank}`);
    if (sessionDied) {
      log(`==> 注意：WebDriver 会话中途死了（${result.sessionError}）—— 这一轮的屏幕空白是**工具链**的问题，不是产品现象，报告里要如实标出来。`);
    }

    result.artifacts = await capture(driver, `outcome-${result.outcome}`);
    result.outputs = listOutputs();
    result.ok = true;
  } catch (error) {
    result.error = error?.message ?? String(error);
    if (driver) result.artifacts = await capture(driver, "failure").catch(() => []);
    result.outputs = listOutputs();
  } finally {
    if (driver) await driver.quit().catch(() => {});
    if (driverProc) driverProc.kill();
    await sleep(1500);
    writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2));
  }

  if (!result.ok) {
    log(`drive-offline: FAIL — ${result.error}`);
    process.exit(1);
  }
  log(`drive-offline: OK — 到了结局页（${result.outcome}），原文已落盘。`);
  process.exit(0);
}

main().catch((error) => {
  try { writeFileSync(RESULT_JSON, JSON.stringify({ ok: false, steps, error: error?.message ?? String(error) }, null, 2)); } catch {}
  log(`drive-offline: FAIL — ${error?.stack ?? error}`);
  process.exit(1);
});
