// 「结果交付」这一条的驱动：只做一件事 —— 把「我做的结果」面板上**逐字的话**取回来。
//
// 为什么只做这一件事：跑一轮那部分**已经有**一份验过的入口（`run-accept-drive.ps1`：
// 装好的应用 → 点卡 → 真出一份文件 → 用 cante-sheets 读回来核对）。这一条要验的是
// **结果页之后**的最后一公里：她做完一件事，东西在哪、找不到时屏幕说什么。硬把
// 「读面板」塞进 accept-drive.mjs 会让两份职责互相绊住，所以由 run-results-audit.ps1
// 先跑那份现成的入口拿到结果文件，再用这个驱动分**破坏前 / 破坏后**各看一次面板。
//
// 它做三件事：
//   1. 开首页 → 点「我做的结果」；
//   2. 把面板整屏文字 + **每一条**的文字落盘（屏幕说什么就记什么，不做解释）；
//   3. 若 RESULTS_CLICK_REVEAL=1，再点一次「打开所在文件夹」——它到底有没有真的开出
//      那个文件夹，由 PowerShell 用 Shell.Application 在点击前后各取一次（DOM 说不了）。
//
// 环境变量（由 run-results-audit.ps1 设）：
//   RESULTS_APP / RESULTS_ARTIFACTS / RESULTS_RESULT_JSON / RESULTS_TAG
//   RESULTS_MSEDGEDRIVER / RESULTS_TAURI_DRIVER / RESULTS_WD_PORT
//   RESULTS_CLICK_REVEAL=1

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Builder, By, Capabilities } from "selenium-webdriver";

const env = process.env;
const APP = env.RESULTS_APP ?? "";
const ARTIFACTS = env.RESULTS_ARTIFACTS ?? "";
const RESULT_JSON = env.RESULTS_RESULT_JSON ?? path.join(ARTIFACTS, "results-audit.json");
const MSEDGEDRIVER = env.RESULTS_MSEDGEDRIVER ?? "";
const TAURI_DRIVER = env.RESULTS_TAURI_DRIVER ?? "";
const PORT = Number(env.RESULTS_WD_PORT ?? 4455);
const TAG = env.RESULTS_TAG ?? "panel";
const CLICK_REVEAL = env.RESULTS_CLICK_REVEAL === "1";
// 面板里可能有好几条**同名**的结果文件（每一轮跑出来的都叫 结果_挑出华东区.xlsx），
// 而且好几条来自同一张卡、同一句话 —— 光按「来自「…」」那一行找会认错那一条。
// 所以调用方给**两个**线索，两个都对上才算：
//   RESULTS_MATCH_NAME = 文件名（那一行的第一行，逐字相等）
//   RESULTS_MATCH_LINE = 来自「…」那一行（逐字相等）
const MATCH_LINE = env.RESULTS_MATCH_LINE ?? "";
const MATCH_NAME = env.RESULTS_MATCH_NAME ?? "";
const SESSION_TIMEOUT_MS = 120_000;

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
  const e = new Error(message);
  e.resultsFailure = true;
  throw e;
}
function requireFile(label, value) {
  if (!value || !existsSync(value)) fail(`${label} 不存在：${value || "(空)"}`);
}

/** 干净环境：把验收 agent 自己的 PI_* 与驱动变量拿掉，别让它们漏进应用。 */
function cleanEnv() {
  const merged = { ...env };
  for (const key of Object.keys(merged)) {
    if (key.startsWith("PI_") || key.startsWith("RESULTS_") || key.startsWith("ACCEPT_")) delete merged[key];
  }
  delete merged.CANTE_BIN;
  delete merged.CANTE_SHEETS_BIN;
  delete merged.CANTE_PDF_BIN;
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
  fail(`等「${label}」超时（${timeoutMs}ms）。最后页面：\n${last.slice(0, 1500)}`);
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

/** 首次向导只在全新档案时出现：能点就点过去，最后以首页文案为准。 */
async function skipWizardIfPresent(driver) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = await bodyText(driver).catch(() => "");
    if (text.includes("需要我帮你做什么")) return;
    for (const label of ["开始检查", "下一步", "开始使用", "先看看界面"]) {
      const found = await driver.findElements(By.xpath(`//button[normalize-space(.)="${label}"]`)).catch(() => []);
      if (found.length) { await found[0].click().catch(() => {}); await sleep(800); break; }
    }
    await sleep(600);
  }
}

async function capture(driver, name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const write = (file, data) => { writeFileSync(path.join(ARTIFACTS, file), data); };
  try { write(`${name}.txt`, await bodyText(driver)); } catch {}
  try { write(`${name}.html`, await driver.getPageSource()); } catch {}
  try { write(`${name}.png`, Buffer.from(await driver.takeScreenshot(), "base64")); } catch {}
}

/** 列出当前**打开的文件夹窗口**（Shell.Application）。
 *  为什么要在驱动里做：点「打开所在文件夹」与「shell 里多不多出那个文件夹」必须在
 *  同一次会话里成对取证 —— 隔到 PowerShell 那边再查时，应用已经退了，窗口是不是还在
 *  就说不准了。它只报事实，不下结论。 */
function shellFolders() {
  const script = "$ErrorActionPreference='Continue'; try { $s=New-Object -ComObject Shell.Application; @($s.Windows()) | ForEach-Object { try { $_.LocationURL } catch {} } } catch {}";
  const proc = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let out = "";
    proc.stdout.on("data", (c) => (out += c));
    proc.on("exit", () => resolve(out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)));
  });
}

/** 打开「我做的结果」，把每一条的原文读回来。字段全来自 DOM，不做任何解释。 */
async function readResultsPanel(driver) {
  const entry = await waitForElement(
    driver,
    By.xpath('//button[starts-with(normalize-space(.), "打开我做的结果")]'),
    "首页的「我做的结果」入口",
  );
  const entryLabel = (await entry.getText()).trim();
  await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", entry).catch(() => {});
  await entry.click();
  await waitForText(driver, (t) => t.includes("我做的结果") && t.includes("回到首页"), "「我做的结果」面板");
  await sleep(1200);

  const panel = await driver.findElement(By.css('[role="dialog"][aria-label="我做的结果"]')).catch(() => null);
  const panelText = panel ? (await panel.getText()) : (await bodyText(driver));
  const listItems = await driver.findElements(By.css('[role="dialog"][aria-label="我做的结果"] li')).catch(() => []);

  const entries = [];
  for (const li of listItems) {
    const text = (await li.getText()).trim();
    const openButtons = await li.findElements(By.xpath('.//button[normalize-space(.)="打开文件"]')).catch(() => []);
    const folderButtons = await li.findElements(By.xpath('.//button[normalize-space(.)="打开所在文件夹"]')).catch(() => []);
    const openDisabled = openButtons.length ? !(await openButtons[0].isEnabled().catch(() => true)) : null;
    entries.push({
      text,
      lines: text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
      hasOpen: openButtons.length > 0,
      openDisabled,
      hasOpenFolder: folderButtons.length > 0,
    });
  }

  const result = { tag: TAG, matchLine: MATCH_LINE, matchName: MATCH_NAME, entryLabel, itemCount: listItems.length, entries, matchedIndex: -1 };
  if (MATCH_LINE || MATCH_NAME) {
    for (let i = 0; i < entries.length; i++) {
      // 两个线索**都对上**才算（逐字相等）：
      //   * 文件名（第一行）永远有；
      //   * 「来自「…」」那一行在同卡同句话时会重复，所以它只当**辅助**，不当唯一依据。
      const lines = entries[i].lines;
      const nameOk = !MATCH_NAME || lines.some((l) => l === MATCH_NAME);
      const lineOk = !MATCH_LINE || lines.some((l) => l === MATCH_LINE);
      if (nameOk && lineOk) { result.matchedIndex = i; break; }
    }
  }
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(path.join(ARTIFACTS, `panel-${TAG}.txt`), panelText);
  writeFileSync(path.join(ARTIFACTS, `panel-${TAG}.json`), JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  requireFile("应用", APP);
  requireFile("msedgedriver", MSEDGEDRIVER);
  requireFile("tauri-driver", TAURI_DRIVER);
  mkdirSync(ARTIFACTS, { recursive: true });

  log(`==> 看面板（${TAG}）：应用 ${APP}`);

  let driver = null;
  let driverProc = null;
  const result = { ok: false, tag: TAG, steps, panel: null, reveal: null };
  try {
    driverProc = spawn(TAURI_DRIVER, ["--port", String(PORT), "--native-driver", MSEDGEDRIVER], {
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    driverProc.stdout.on("data", (c) => process.stdout.write(`[tauri-driver] ${c}`));
    driverProc.stderr.on("data", (c) => process.stderr.write(`[tauri-driver] ${c}`));

    await phase("tauri-driver 就绪", () => waitForDriver(driverProc));
    driver = await phase("打开 WebDriver 会话（启动应用）", async () => {
      const caps = new Capabilities();
      caps.setBrowserName("wry");
      caps.set("tauri:options", { application: APP });
      const building = new Builder().usingServer(`http://127.0.0.1:${PORT}`).withCapabilities(caps).build();
      building.catch(() => {});
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`创建会话超过 ${SESSION_TIMEOUT_MS}ms`)), SESSION_TIMEOUT_MS);
      });
      try { return await Promise.race([building, timeout]); } finally { clearTimeout(timer); }
    });

    await phase("首页出现", async () => {
      await skipWizardIfPresent(driver);
      return waitForText(driver, (t) => t.includes("需要我帮你做什么"), "首页");
    });

    result.panel = await phase("打开「我做的结果」并读面板", () => readResultsPanel(driver));

    if (CLICK_REVEAL) {
      await phase("点「打开所在文件夹」（点的是匹配到的那一条）", async () => {
        // 只点**这一场那一条**的按钮：面板里可能有好几条同名结果，点错了就验的是别人。
        // 用「文件名 + 来自那行」两个线索定位那一条 <li>。
        const esc = (s) => s.replace(/"/g, "");
        let cond = "";
        if (MATCH_NAME) cond += `.//p[normalize-space(.)="${esc(MATCH_NAME)}"]`;
        if (MATCH_LINE) cond += ` and .//p[normalize-space(.)="${esc(MATCH_LINE)}"]`;
        const prefix = cond ? `//li[${cond}]` : "//li";
        const buttons = await driver.findElements(By.xpath(`${prefix}//button[normalize-space(.)="打开所在文件夹"]`));
        if (!buttons.length) fail(`没有找到「打开所在文件夹」按钮（匹配：${MATCH_NAME} / ${MATCH_LINE}）`);
        const before = await shellFolders();
        await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", buttons[0]).catch(() => {});
        await buttons[0].click();
        await sleep(3000);
        const after = await shellFolders();
        result.reveal = { clicked: true, matchName: MATCH_NAME, matchLine: MATCH_LINE, shellBefore: before, shellAfter: after };
        writeFileSync(path.join(ARTIFACTS, `panel-${TAG}-shell.json`), JSON.stringify(result.reveal, null, 2));
      });
      result.afterRevealText = await bodyText(driver).catch(() => "");
      writeFileSync(path.join(ARTIFACTS, `panel-${TAG}-after-reveal.txt`), result.afterRevealText);
      await capture(driver, `panel-${TAG}-after-reveal`);
    }

    await capture(driver, `panel-${TAG}-final`);
    result.ok = true;
  } catch (error) {
    result.error = error?.message ?? String(error);
    if (driver) await capture(driver, `panel-${TAG}-failure`).catch(() => {});
  } finally {
    if (driver) await driver.quit().catch(() => {});
    if (driverProc) driverProc.kill();
    await sleep(1500);
    writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2));
  }

  if (!result.ok) { log(`results-audit: FAIL — ${result.error}`); process.exit(1); }
  log(`results-audit: OK — 面板原文已落盘（${result.panel?.itemCount ?? 0} 条，tag=${TAG}）。`);
  process.exit(0);
}

main().catch((error) => {
  try { writeFileSync(RESULT_JSON, JSON.stringify({ ok: false, tag: TAG, steps, error: error?.message ?? String(error) }, null, 2)); } catch {}
  log(`results-audit: FAIL — ${error?.stack ?? error}`);
  process.exit(1);
});
