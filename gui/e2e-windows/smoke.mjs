#!/usr/bin/env node
// The one thing a terminal (and macOS) cannot check: that the window really
// paints on the platform the product ships to first — Windows, in WebView2.
//
// `scripts/dom-smoke.sh` renders the same shell in Chrome on macOS and reads
// the DOM back. That catches "the shell painted nothing" and "a string changed"
// early, but it is still Chrome on macOS: the real webview, the real fonts, the
// real `invoke()` bridge and the real window are never exercised. Tauri's own
// WebDriver support runs on Windows (Edge WebDriver, `msedgedriver`) and on
// Linux (WebKitWebDriver); macOS has no native driver, so this is the only way
// to answer "does it actually come up on Windows".
//
// What it does, in order:
//
//   1. first run: builds nothing (CI builds first), starts `tauri-driver`,
//      opens a session against the built binary, waits for the shell to paint
//      and asserts the first-run wizard — the same strings `dom-smoke.sh`
//      asserts, so the two gates cannot drift apart silently;
//   2. provisioned machine: relaunches the app with an enterprise config file
//      (`CANTE_ADMIN_CONFIG`, the documented path from `admin_config.rs`), so
//      the wizard is skipped and the home screen shows. Then it presses a real
//      task card, types one sentence, presses 生成计划, and asserts the
//      confirmation sheet — stopping there on purpose: the next step in the
//      product opens a **native** file dialog, which WebDriver cannot drive, and
//      faking it would test a different app.
//
// On any failure it writes artifacts next to this file (`artifacts/`): the
// rendered text, the page HTML and a screenshot, so the difference between "it
// never rendered" and "the wording changed" is visible without re-running.
//
// Run it on Windows only:
//
//   cd gui && bunx tauri build --debug --no-bundle
//   node e2e-windows/smoke.mjs
//
// Env knobs (all optional): CANTE_APP_BINARY, CANTE_MSEDGEDRIVER, CANTE_WD_PORT,
// CANTE_WD_WAIT_MS, CANTE_WD_SESSION_TIMEOUT_MS, CANTE_WD_SKIP_HOME=1.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { Builder, By, Capabilities } from "selenium-webdriver";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUI_DIR = path.resolve(HERE, "..");
const ARTIFACT_DIR = path.join(HERE, "artifacts");

const PORT = Number(process.env.CANTE_WD_PORT ?? 4444);
const SERVER_URL = `http://127.0.0.1:${PORT}`;
/** Creating a session launches the app and waits for its window: allow for a
 *  cold WebView2 start on a loaded CI runner. */
const SESSION_TIMEOUT_MS = Number(process.env.CANTE_WD_SESSION_TIMEOUT_MS ?? 120_000);
/** How long to wait for a screen to appear once the app is up. */
const WAIT_MS = Number(process.env.CANTE_WD_WAIT_MS ?? 90_000);

/** The card the "key path" half of the test presses. Three conditions made it
 *  the only safe choice: it takes no file (so no native dialog sits in the
 *  way), it is not in the 微信 group (which opens its own import screen rather
 *  than the four-step runner), and it is reachable from a plain home screen. */
const CARD_TITLE = "写一份通知";
const CARD_SENTENCE = "写一份五一放假通知，5月1日到5月5日放假，5月6日上班";

/** Every failed assertion, so one run reports everything it found. */
const failures = [];
/** Facts about this machine/webview. Printed, never asserted on. */
const notes = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (...parts) => console.log(...parts);
const note = (line) => {
  notes.push(line);
  say(`  · ${line}`);
};

// ---------------------------------------------------------------------------
// Finding the things we were given
// ---------------------------------------------------------------------------

/** The built app: `tauri build --debug --no-bundle` leaves it in target/debug. */
function resolveAppBinary() {
  if (process.env.CANTE_APP_BINARY) return process.env.CANTE_APP_BINARY;

  const debugDir = path.join(GUI_DIR, "src-tauri", "target", "debug");
  // `tauri build` names the binary after `productName`; a bare `cargo build`
  // leaves the crate name. Accept both rather than guess which one ran.
  for (const name of ["Cante.exe", "cante-gui.exe"]) {
    const candidate = path.join(debugDir, name);
    if (existsSync(candidate)) return candidate;
  }

  const helpers = new Set(["cante-sheets.exe", "cante-pdf.exe", "msedgedriver.exe"]);
  const found = (existsSync(debugDir) ? readdirSync(debugDir) : []).filter(
    (entry) => entry.toLowerCase().endsWith(".exe") && !helpers.has(entry.toLowerCase()),
  );
  if (found.length > 0) return path.join(debugDir, found[0]);

  throw new Error(
    `找不到构建好的程序（看过 ${debugDir}）。先在 gui/ 里跑：bunx tauri build --debug --no-bundle`,
  );
}

/** `tauri-driver` looks for `msedgedriver.exe` on PATH, but pointing at the
 *  exact file avoids depending on how PATH was assembled. */
function resolveNativeDriver() {
  if (process.env.CANTE_MSEDGEDRIVER) return process.env.CANTE_MSEDGEDRIVER;
  const candidates = [
    path.join(HERE, "msedgedriver", "msedgedriver.exe"),
    path.join(os.homedir(), "msedgedriver", "msedgedriver.exe"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// ---------------------------------------------------------------------------
// tauri-driver + the WebDriver session
// ---------------------------------------------------------------------------

/** `tauri-driver` is installed by CI with `cargo install`, but spell out the
 *  usual location so a PATH that was assembled differently fails loudly and
 *  fast instead of looking like a hung session. */
function resolveTauriDriver() {
  if (process.env.CANTE_TAURI_DRIVER) return process.env.CANTE_TAURI_DRIVER;
  const cargoBin = path.join(os.homedir(), ".cargo", "bin", "tauri-driver.exe");
  return existsSync(cargoBin) ? cargoBin : "tauri-driver";
}

async function startTauriDriver(extraEnv) {
  const args = ["--port", String(PORT)];
  const native = resolveNativeDriver();
  if (native) {
    args.push("--native-driver", native);
    say(`==> 原生驱动：${native}`);
  } else {
    say("==> 原生驱动：交给 tauri-driver 在 PATH 上找 msedgedriver.exe");
  }

  const command = resolveTauriDriver();
  say(`==> tauri-driver：${command}`);
  const proc = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[tauri-driver] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[tauri-driver] ${chunk}`));

  await waitForServer(proc);
  return proc;
}

/** Poll the WebDriver server until it answers, so a slow start is not an error. */
async function waitForServer(proc) {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`${proc.spawnfile ?? "tauri-driver"} 退出了（code ${proc.exitCode}）：装了吗？`);
    }
    try {
      const response = await fetch(`${SERVER_URL}/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(500);
  }
  throw new Error(`tauri-driver 没有在 ${SERVER_URL} 上就绪（最后一次：${last}）`);
}

/** Open a session: this is where a mismatched msedgedriver version hangs. */
async function openSession(application) {
  const capabilities = new Capabilities();
  // Tauri's own Selenium example: the app is selected through `tauri:options`.
  capabilities.setBrowserName("wry");
  capabilities.set("tauri:options", { application });

  const building = new Builder()
    .usingServer(SERVER_URL)
    .withCapabilities(capabilities)
    .build();
  // The race below owns the failure; without this, a session that fails *after*
  // the timeout fires would surface as an unhandled rejection and Node would
  // abort with a stack instead of the diagnosis we just built.
  building.catch(() => {});

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `创建 WebDriver 会话超过 ${SESSION_TIMEOUT_MS}ms —— 多半是 msedgedriver 与这台电脑的 ` +
              `WebView2 版本不匹配（版本对不上时它是挂住，不是报错）。先跑 install-msedgedriver.sh。`,
          ),
        ),
      SESSION_TIMEOUT_MS,
    );
  });

  try {
    return await Promise.race([building, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function stopProcess(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill();
}

/**
 * One app lifetime: start the driver (with `env`), open a session, run `body`,
 * always quit, and on failure leave artifacts behind.
 */
async function withSession(tag, application, env, body) {
  const proc = await startTauriDriver(env);
  let driver = null;
  try {
    say(`==> 打开会话（${tag}）`);
    driver = await openSession(application);
    await body(driver, (evidenceTag) => collectEvidence(driver, evidenceTag));
  } catch (error) {
    if (driver) {
      const saved = await collectEvidence(driver, `${tag}-failure`);
      say(`==> 失败证据：${saved.length ? saved.join(", ") : "（没能保存）"}`);
    }
    throw error;
  } finally {
    if (driver) await driver.quit().catch(() => {});
    stopProcess(proc);
    // Give the app and the driver a moment to release the port before the next
    // phase starts another one.
    await sleep(1500);
  }
}

// ---------------------------------------------------------------------------
// Reading the window
// ---------------------------------------------------------------------------

const rendered = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

async function bodyText(driver) {
  const body = await driver.findElement(By.css("body"));
  return await body.getText();
}

async function waitForText(driver, predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await bodyText(driver);
    } catch {
      last = "";
    }
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  const lines = rendered(last).slice(0, 25);
  throw new Error(
    `等「${label}」超时（${timeoutMs}ms）。${lines.length ? `当前页面文字：\n${lines.join("\n")}` : "页面上一个字都没有。"}`,
  );
}

async function waitForElement(driver, by, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await driver.findElements(by).catch(() => []);
    if (found.length > 0) return found[0];
    await sleep(400);
  }
  throw new Error(`找不到「${label}」（${timeoutMs}ms 内）`);
}

/** Assert one string is on screen. Line-based, exactly like dom-smoke.sh, so a
 *  needle split across two elements does not count as present. */
function mustShow(label, text, needle) {
  const lines = rendered(text);
  const ok = lines.some((line) => line.includes(needle));
  say(`  ${ok ? "ok  " : "FAIL"} ${label}  «${needle}»`);
  if (!ok) failures.push(`${label}：页面上没有「${needle}」`);
  return ok;
}

async function collectEvidence(driver, tag) {
  const saved = [];
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const write = (name, data) => {
    const target = path.join(ARTIFACT_DIR, name);
    writeFileSync(target, data);
    saved.push(name);
  };
  const step = async (name, produce) => {
    try {
      write(name, await produce());
    } catch (error) {
      say(`  （${tag}: 存不了 ${name}：${error.message}）`);
    }
  };
  await step(`${tag}.txt`, () => bodyText(driver));
  await step(`${tag}.html`, () => driver.getPageSource());
  await step(`${tag}.png`, async () => Buffer.from(await driver.takeScreenshot(), "base64"));
  return saved;
}

/** Everything we want to know about the real Windows webview but do not want
 *  to fail a build over: fonts, scale, and the runtime the app is using. */
async function recordEnvironment(driver) {
  const facts = await driver.executeScript(() => {
    const probe = document.createElement("span");
    probe.style.fontSize = "16px";
    probe.textContent = "汉字Ab";
    document.body.appendChild(probe);
    const box = probe.getBoundingClientRect();
    const body = getComputedStyle(document.body);
    const out = {
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      bodyFont: body.fontFamily,
      sample: `${Math.round(box.width)}×${Math.round(box.height)}`,
    };
    probe.remove();
    return out;
  });
  note(`WebView2 / UA：${facts.userAgent}`);
  note(`窗口视口：${facts.viewport}，devicePixelRatio ${facts.devicePixelRatio}`);
  note(`body 字体栈：${facts.bodyFont}`);
  note(`16px「汉字Ab」的盒子：${facts.sample}`);
  return facts;
}

// ---------------------------------------------------------------------------
// Phase 1 — first run (the wizard)
// ---------------------------------------------------------------------------

/** Exactly the strings `dom-smoke.sh` pins for the first-run screen. */
const WIZARD_STRINGS = {
  "app name": "Cante",
  "history entry": "历史",
  "privacy entry": "隐私",
  "wizard step 1": "欢迎",
  "wizard step 2": "检查电脑",
  "wizard step 3": "开始使用",
  "no-touch promise": "原文件我不会乱动",
};

async function firstRunPhase(application) {
  say("\n=== 第一步：第一次打开（向导） ===");
  await withSession("first-run", application, {}, async (driver, evidence) => {
    // Wait for the shell to paint: any Chinese text means the frame rendered,
    // the promise means the wizard did.
    const text = await waitForText(
      driver,
      (current) => current.includes("原文件我不会乱动"),
      "向导首屏",
    );
    await recordEnvironment(driver);

    say(`--- 窗口里渲染出来的文字（${rendered(text).length} 行）---`);
    for (const line of rendered(text).slice(0, 20)) say("  |", line.slice(0, 96));

    for (const [label, needle] of Object.entries(WIZARD_STRINGS)) mustShow(label, text, needle);
    await evidence("first-run");
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — a provisioned machine: home, one card, the confirmation sheet
// ---------------------------------------------------------------------------

/** What an administrator drops on the machine (`admin_config.rs` documents the
 *  shape). `present` is derived from "the file parsed", not written here. */
function writeAdminConfig() {
  const file = path.join(os.tmpdir(), "cante-e2e-admin.json");
  writeFileSync(
    file,
    JSON.stringify(
      { default_provider: null, default_model: null, allow_network: true, disabled_tasks: [] },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

async function homePhase(application) {
  say("\n=== 第二步：被预置过的电脑（首页 → 确认页） ===");
  const adminFile = writeAdminConfig();
  say(`==> 预置配置：${adminFile}`);

  await withSession("home", application, { CANTE_ADMIN_CONFIG: adminFile }, async (driver, evidence) => {
    const home = await waitForText(
      driver,
      (current) => current.includes("需要我帮你做什么"),
      "首页（向导让位给首页）",
    );
    for (const [label, needle] of Object.entries({
      "home greeting": "需要我帮你做什么",
      "free-text box": "直接说一句话",
      "card-or-sentence hint": "点一张卡片",
    })) {
      mustShow(label, home, needle);
    }
    await evidence("home");

    say(`==> 点任务卡「${CARD_TITLE}」`);
    const card = await waitForElement(
      driver,
      By.xpath(`//button[starts-with(@aria-label, "${CARD_TITLE}")]`),
      `任务卡 ${CARD_TITLE}`,
    );
    // Cards for 文书 sit below the fold; scrolling first keeps the click a
    // plain click instead of a "the click point is outside the window" error.
    await driver.executeScript("arguments[0].scrollIntoView({block:'center'});", card).catch(() => {});
    await card.click();

    say("==> 写一句话");
    const box = await waitForElement(driver, By.css("#task-instruction"), "输入框 #task-instruction");
    await box.sendKeys(CARD_SENTENCE);

    say("==> 点「生成计划」");
    const planButton = await waitForElement(
      driver,
      By.xpath('//button[normalize-space(.)="生成计划"]'),
      "按钮 生成计划",
    );
    await planButton.click();

    const confirm = await waitForText(
      driver,
      (current) => current.includes("它打算这样做"),
      "确认页",
    );
    say("--- 确认页上的文字 ---");
    for (const line of rendered(confirm).slice(0, 20)) say("  |", line.slice(0, 96));

    mustShow("confirmation sheet", confirm, "它打算这样做");
    mustShow("the card's own title", confirm, CARD_TITLE);
    // This card takes no file, so the sheet must say so — it is what tells us
    // the sentence went through the text path instead of a file picker.
    mustShow("no files involved", confirm, "这次不涉及文件");

    await evidence("confirm");
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function report() {
  if (notes.length > 0) {
    say("\n--- 这台机器上看到的东西（不参与判定）---");
    for (const line of notes) say(`  · ${line}`);
  }
  if (failures.length === 0) {
    say("\nwindows-ui-smoke: OK — 真实 WebView2 窗口里，首屏和确认页上的每一条文案都在。");
    return;
  }
  say(`\nwindows-ui-smoke: FAIL（${failures.length} 条）`);
  for (const line of failures) say(`  - ${line}`);
  say(`证据在 ${ARTIFACT_DIR}`);
}

async function main() {
  if (process.platform !== "win32") {
    say("windows-ui-smoke: 只跑 Windows —— macOS 上没有能给 WKWebView 用的原生 WebDriver。");
    say("在 macOS 上请用 gui/scripts/dom-smoke.sh（Chrome 渲染 DOM 的那一个）。");
    process.exit(2);
  }

  const application = resolveAppBinary();
  say(`==> 应用：${application}`);

  try {
    await firstRunPhase(application);
  } catch (error) {
    failures.push(`第一次打开（向导）：${error.message}`);
  }

  if (process.env.CANTE_WD_SKIP_HOME === "1") {
    say("==> CANTE_WD_SKIP_HOME=1：跳过首页那一段");
  } else {
    try {
      await homePhase(application);
    } catch (error) {
      failures.push(`首页 → 确认页：${error.message}`);
    }
  }

  report();
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  say(`windows-ui-smoke: 没能跑起来：${error?.stack ?? error}`);
  report();
  process.exit(1);
});
