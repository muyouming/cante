// 「装好的应用 + 包里的桥 + 这台机器上的 pi → 点一张卡 → 真的出一份文件」的驱动。
//
// 它由 `accept-install.ps1` 用一组 ACCEPT_* 环境变量启动，做三件事：
//   1. 起 tauri-driver，对着**装好的** cante-gui.exe 开一个 WebDriver 会话；
//   2. 在真实 WebView2 里点卡片 → 选文件（原生对话框交给 accept-file-dialog.ps1）→
//      写一句话 → 生成计划 → 开始；
//   3. 跑的过程中替她把审批页点成「允许这次」（并把次数记下来），最后把结果页文字、
//      截图、每一步耗时写成 JSON。
//
// 它**不判断**产出文件对不对 —— 那是 accept-install.ps1 用应用自带的 cante-sheets 做的，
// 因为「界面说成功」不算证据（AGENTS.md §3.6）。
//
// 为什么单独一个 .mjs：WebDriver 的客户端是 selenium-webdriver（gui/node_modules 里已有），
// 而 PowerShell 里没有对应的库。PowerShell 负责安装/卸载/取证，Node 负责驱动窗口。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Builder, By, Capabilities } from "selenium-webdriver";

const env = process.env;
const APP = env.ACCEPT_APP ?? "";
const CANTE_BIN = env.ACCEPT_CANTE_BIN ?? "";
const PI_BIN = env.ACCEPT_PI_BIN ?? "";
/**
 * 零环境变量模式（#150 第二步）：不替她设 CANTE_BIN / PI_BIN，让**应用自己**在它旁边
 * 找桥与执行组件。这一步真正要证的是"装完就能用"——环境变量是脚本替她做的，
 * 那层便利能盖住"包里根本没带组件"这种错。
 */
const ZERO_ENV = env.ACCEPT_ZERO_ENV === "1";
const MSEDGEDRIVER = env.ACCEPT_MSEDGEDRIVER ?? "";
const TAURI_DRIVER = env.ACCEPT_TAURI_DRIVER ?? "";
const WORKDIR = env.ACCEPT_WORKDIR ?? "";
const INPUT = env.ACCEPT_INPUT ?? "";
const CARD = env.ACCEPT_CARD ?? "从大表里挑出想要的行";
const INSTRUCTION = env.ACCEPT_INSTRUCTION ?? "把华东区的记录挑出来，另存成一张新表";
const ARTIFACTS = env.ACCEPT_ARTIFACTS ?? WORKDIR;
const RESULT_JSON = env.ACCEPT_RESULT_JSON ?? path.join(ARTIFACTS, "accept-drive-result.json");
const HELPER = env.ACCEPT_DIALOG_HELPER ?? path.join(env.ACCEPT_SCRIPT_DIR ?? ".", "accept-file-dialog.ps1");
const PORT = Number(env.ACCEPT_WD_PORT ?? 4444);
const RUN_TIMEOUT_MS = Number(env.ACCEPT_TIMEOUT_MS ?? 15 * 60 * 1000);
const SESSION_TIMEOUT_MS = Number(env.ACCEPT_SESSION_TIMEOUT_MS ?? 120_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...parts) => console.log(...parts);

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
  error.acceptFailure = true;
  throw error;
}

function requireFile(label, value) {
  if (!value || !existsSync(value)) fail(`${label} 不存在：${value || "(空)"}`);
}

/** 给子进程一份干净的环境：把本机 pi 会话/网关那些 PI_* 拿掉，只留我们指定的。
 *  零环境变量模式下连 PI_BIN 与 CANTE_BIN 一起拿掉 —— 否则"它自己找到的"就说不清。 */
function cleanEnv(extra) {
  const merged = { ...env, ...extra };
  for (const key of Object.keys(merged)) {
    if (key.startsWith("PI_") && (ZERO_ENV || key !== "PI_BIN")) delete merged[key];
  }
  if (ZERO_ENV) {
    delete merged.CANTE_BIN;
    delete merged.CANTE_SHEETS_BIN;
    delete merged.CANTE_PDF_BIN;
  }
  return merged;
}

async function waitForDriver(proc) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) fail(`tauri-driver 退出了（code ${proc.exitCode}）`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
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
    try {
      last = await bodyText(driver);
    } catch {
      last = "";
    }
    if (last && test(last)) return last;
    await sleep(400);
  }
  fail(`等「${label}」超时（${timeoutMs}ms）。最后看到的页面：\n${last.slice(0, 1200)}`);
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

async function clickButton(driver, label, selector = `//button[normalize-space(.)="${label}"]`) {
  const button = await waitForElement(driver, By.xpath(selector), `按钮 ${label}`);
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", button).catch(() => {});
  await button.click();
  return button;
}

/** 点开原生对话框之前先把「填对话框」的助手挂起来，它自己会等到窗口出现。 */
function startDialogHelper() {
  const started = Date.now();
  const helper = spawn(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HELPER, "-Path", INPUT, "-TimeoutSec", "90",
      ...(process.env.ACCEPT_DIALOG_DUMP === "1" ? ["-Dump"] : [])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  helper.stdout.on("data", (c) => {
    output += c;
    process.stdout.write(`[dialog] ${c}`);
  });
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

/** 跑起来之后替她点：审批 → 允许这次；结构化提问 → 按它的建议来；追问 → 你看着办。 */
async function driveToResult(driver) {
  const counters = { approvals: 0, questions: 0, followups: 0 };
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastText = "";
  while (Date.now() < deadline) {
    lastText = await bodyText(driver).catch(() => lastText);
    if (lastText.includes("做好了")) return { counters, resultText: lastText };

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
    if (/没能做成|出错了|失败了|连不上/.test(lastText) && !lastText.includes("做好了")) {
      fail(`跑的过程中出现了错误页：\n${lastText.slice(0, 1200)}`);
    }
    await sleep(1000);
  }
  fail(`等了 ${RUN_TIMEOUT_MS}ms 还没看到结果页。最后页面：\n${lastText.slice(0, 1200)}`);
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

async function main() {
  requireFile("应用", APP);
  if (ZERO_ENV) {
    if (CANTE_BIN || PI_BIN) fail("零环境变量模式下不该再传 ACCEPT_CANTE_BIN / ACCEPT_PI_BIN");
  } else {
    requireFile("包里的桥", CANTE_BIN);
    requireFile("pi", PI_BIN);
  }
  requireFile("msedgedriver", MSEDGEDRIVER);
  requireFile("tauri-driver", TAURI_DRIVER);
  requireFile("输入文件", INPUT);
  if (!existsSync(HELPER)) fail(`对话框助手不存在：${HELPER}`);
  mkdirSync(ARTIFACTS, { recursive: true });

  const adminFile = path.join(ARTIFACTS, "admin.json");
  writeFileSync(
    adminFile,
    JSON.stringify({ default_provider: null, default_model: null, allow_network: true, disabled_tasks: [] }, null, 2),
  );

  log(`==> 应用：${APP}`);
  if (ZERO_ENV) {
    log("==> 零环境变量模式：不设 CANTE_BIN / PI_BIN，桥与执行组件由应用自己在旁边找");
  } else {
    log(`==> 包里的桥：${CANTE_BIN}`);
    log(`==> pi：${PI_BIN}`);
  }
  log(`==> 工作目录：${WORKDIR}`);

  let driver = null;
  let driverProc = null;
  const result = { ok: false, steps, counters: {}, resultText: "", outputs: [], artifacts: [] };
  try {
    driverProc = spawn(TAURI_DRIVER, ["--port", String(PORT), "--native-driver", MSEDGEDRIVER], {
      env: cleanEnv({
        ...(ZERO_ENV ? {} : { CANTE_BIN, PI_BIN }),
        CANTE_ADMIN_CONFIG: adminFile,
      }),
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
        timer = setTimeout(
          () => reject(new Error(`创建会话超过 ${SESSION_TIMEOUT_MS}ms（多半是 msedgedriver 与 WebView2 版本不匹配）`)),
          SESSION_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([building, timeout]);
      } finally {
        clearTimeout(timer);
      }
    });

    const home = await phase("首页出现", () =>
      waitForText(driver, (t) => t.includes("需要我帮你做什么"), "首页"),
    );
    log(`--- 首页 ---\n${home.split("\n").map((l) => "  | " + l).slice(0, 14).join("\n")}`);

    await phase(`点卡片「${CARD}」`, async () => {
      const card = await waitForElement(
        driver,
        By.xpath(`//button[starts-with(@aria-label, "${CARD}")]`),
        `任务卡 ${CARD}`,
      );
      await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", card).catch(() => {});
      await card.click();
    });

    await phase("选文件（原生对话框）", async () => {
      await waitForText(driver, (t) => t.includes("选择文件"), "选文件这一步");
      const helper = startDialogHelper();
      await clickButton(driver, "选择文件");
      const finished = await helper.done;
      if (finished.code !== 0) fail(`填原生对话框的助手退出码 ${finished.code}（见上面的 [dialog] 行）`);
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

    const { counters, resultText } = await phase("干活（含审批/提问）", () => driveToResult(driver));
    result.counters = counters;
    result.resultText = resultText;
    log(`--- 结果页 ---\n${resultText.split("\n").map((l) => "  | " + l).slice(0, 24).join("\n")}`);
    log(`==> 替她点了：审批 ${counters.approvals} 次、结构化提问 ${counters.questions} 次、追问 ${counters.followups} 次`);

    result.artifacts = await capture(driver, "result");
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
    log(`accept-drive: FAIL — ${result.error}`);
    process.exit(1);
  }
  log("accept-drive: OK — 应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」。");
  process.exit(0);
}

main().catch((error) => {
  try {
    writeFileSync(RESULT_JSON, JSON.stringify({ ok: false, steps, error: error?.message ?? String(error) }, null, 2));
  } catch {}
  log(`accept-drive: FAIL — ${error?.stack ?? error}`);
  process.exit(1);
});
