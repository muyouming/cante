// 把 UIA 读回来的「结果页」「我做的结果」两屏文字，逐条对照产品源码里的新文案。
//
// 为什么单独一个脚本：报告里要的是「屏幕上那句话，等于源码里哪一条」这种**可核对**的对照，
// 不是"看着像"。这里从 copy-print.ts / location.ts / copy-results.ts 里**读源码取字符串**
// （不手抄 —— 手抄会漂移），再去屏幕原文里找。
//
// 还有一条硬判据：**屏幕上不许出现机器路径**。这一条扫的是所有形如
// `C:\...`、`\\server\share`、`/home/<用户>`、`/Users/<用户>`、`AppData` 的字样。
//
// 用法：
//   node check-result-copy.mjs <result-page.txt> [results-panel.txt]
// 退出码：0 = 全部命中且没有机器路径；1 = 有缺失/有机器路径。

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => readFileSync(path.join(guiRoot, rel), "utf8");

const copyPrint = read("src/simple/copy-print.ts");
const copyResults = read("src/simple/copy-results.ts");
const copyPeek = read("src/simple/copy-sheet-peek.ts");

/** 从源码里取出一个字面量字符串（不手抄，避免和产品漂移）。 */
function grab(source, re, label) {
  const m = source.match(re);
  if (!m) throw new Error(`取不到 ${label}（源码改了？正则要跟着改）`);
  return m[1];
}

const LOCATION = {
  desktop: grab(copyPrint, /desktop:\s*"([^"]+)"/, "LOCATION.desktop"),
  downloads: grab(copyPrint, /downloads:\s*"([^"]+)"/, "LOCATION.downloads"),
  documents: grab(copyPrint, /documents:\s*"([^"]+)"/, "LOCATION.documents"),
  pictures: grab(copyPrint, /pictures:\s*"([^"]+)"/, "LOCATION.pictures"),
  wechat: grab(copyPrint, /wechat:\s*"([^"]+)"/, "LOCATION.wechat"),
  other: grab(copyPrint, /other:\s*"([^"]+)"/, "LOCATION.other"),
};
const PRINT_HINT = grab(copyPrint, /hint:\s*"([^"]+)"/, "PRINT.hint");
const KEEP_HINT = grab(copyResults, /keepHint:\s*"([^"]+)"/, "RESULTS.keepHint");
const PANEL_TITLE = grab(copyResults, /title:\s*"([^"]+)"/, "RESULTS.title");
const OPEN_FILE = grab(copyResults, /open:\s*"([^"]+)"/, "RESULTS.actions.open");
const OPEN_FOLDER = grab(copyResults, /openFolder:\s*"([^"]+)"/, "RESULTS.actions.openFolder");
const PANEL_SUBTITLE = grab(copyResults, /subtitle:\s*"([^"]+)"/, "RESULTS.subtitle");
// #215 —— 「她自己能核对的那三个数」那一块的小标题（表类结果才有）。
const PEEK_TITLE = grab(copyPeek, /title:\s*"([^"]+)"/, "SHEET_PEEK.title");

const args = process.argv.slice(2);
// 容忍 Git Bash 传进来的 MSYS 路径（/c/foo）—— 不然 node 会把它当 C:\c\foo。
const toWin = (p) => (p && /^\/[a-zA-Z]\//.test(p) ? `${p[1].toUpperCase()}:${p.slice(2).replace(/\//g, "\\")}` : p);
const pagePath = toWin(args[0]);
const panelPath = toWin(args[1]);
if (!pagePath) {
  console.log("用法： node check-result-copy.mjs <result-page.txt> [results-panel.txt]");
  process.exit(2);
}
// 文件不在时给一句人话（不然 node 抛一堆栈，看着像脚本坏了）。
for (const p of [pagePath, panelPath].filter(Boolean)) {
  if (!existsSync(p)) {
    console.log(`找不到文件：${p}`);
    process.exit(2);
  }
}
const page = readFileSync(pagePath, "utf8");
const panel = panelPath ? readFileSync(panelPath, "utf8") : "";

// 屏幕上**必须**出现的那几条（结果页）。位置那一条是六选一：结果落在哪儿取决于这张卡，
// 所以"至少命中一条位置说明"才算过，而不是钉死某一条。
const mustOnPage = [
  ["PRINT.hint（怎么打印）", PRINT_HINT],
  ["RESULTS.keepHint（以后在哪找回来）", KEEP_HINT],
  ["actions.open（按钮）", OPEN_FILE],
  ["actions.openFolder（按钮）", OPEN_FOLDER],
];
// 表类结果才会出现的（#215）：读不到就如实说，不算失败，但报告里要能看出有没有。
const peekLines = [
  ["SHEET_PEEK.title", PEEK_TITLE],
];
const locationLines = Object.entries(LOCATION).map(([k, v]) => [`LOCATION.${k}`, v]);

const mustOnPanel = [
  ["RESULTS.title", PANEL_TITLE],
  ["RESULTS.subtitle", PANEL_SUBTITLE],
  ["actions.open（按钮）", OPEN_FILE],
];

function report(title, text, checks) {
  console.log(`\n=== ${title} ===`);
  let missing = 0;
  for (const [label, needle] of checks) {
    const hit = text.includes(needle);
    if (!hit) missing++;
    console.log(`${hit ? "✓" : "✗"} ${label}`);
    console.log(`    ${needle}`);
  }
  return missing;
}

let failures = 0;
console.log("（期望值全部从产品源码里取，不手抄）");
failures += report("结果页：必须出现的几条", page, mustOnPage);

// #215 的「表里是什么样」：表类结果才有，所以只报命中与否，不判红。
console.log("\n=== 结果页：#215「她自己能核对的那三个数」=== ");
for (const [label, v] of peekLines) {
  const hit = page.includes(v);
  console.log(`${hit ? "✓" : "·"} ${label}  ${v}`);
  if (!hit) console.log("    （没命中：这张卡的结果也许不是表格，或读表格的工具没就位）");
}

// 位置那一条：至少命中一个。
const locHit = locationLines.filter(([, v]) => page.includes(v));
console.log("\n=== 结果页：文件位置那一句（至少命中一条）===");
for (const [label, v] of locationLines) {
  console.log(`${page.includes(v) ? "✓" : "·"} ${label}  ${v}`);
}
if (locHit.length === 0) {
  failures++;
  console.log("✗ 一条位置说明都没命中 —— 屏幕上没有告诉她在哪儿");
} else {
  console.log(`（命中 ${locHit.length} 条）`);
}

if (panelPath) {
  failures += report("「我做的结果」面板：必须出现的几条", panel, mustOnPanel);
}

// --- 硬判据：屏幕上不许有机器路径 ---
const PATH_PATTERNS = [
  [/[A-Za-z]:\\/g, "Windows 绝对路径（C:\\…）"],
  [/\\\\[A-Za-z0-9._-]+\\/g, "UNC 路径（\\\\主机\\共享）"],
  [/\/home\/[^\s"']+/g, "Linux 家目录（/home/<用户>）"],
  [/\/Users\/[^\s"']+/g, "macOS 家目录（/Users/<用户>）"],
  [/AppData/gi, "AppData"],
  [/USERPROFILE|LOCALAPPDATA|Program Files/gi, "环境变量/程序目录名"],
];

function pathScan(title, text, origin) {
  console.log(`\n=== ${title}：机器路径扫描 ===`);
  let found = 0;
  for (const [re, label] of PATH_PATTERNS) {
    const hits = [...text.matchAll(re)].map((m) => m[0]);
    if (hits.length) {
      found += hits.length;
      console.log(`✗ ${label} ×${hits.length}`);
      for (const h of [...new Set(hits)].slice(0, 8)) {
        // 只报"长什么样"，不把真实家目录抄进报告：把用户名段打码。
        console.log(`    ${origin}: ${h.replace(/Users\\[^\\]+|Users\/[^/]+|[A-Za-z0-9._-]+(?=\\)/g, "<脱敏>")}`);
      }
    } else {
      console.log(`✓ ${label}：没有`);
    }
  }
  return found;
}

failures += pathScan("结果页", page, "result-page");
if (panelPath) failures += pathScan("「我做的结果」面板", panel, "results-panel");

console.log("");
if (failures === 0) {
  console.log("check-result-copy: 全部命中，且两屏都没有机器路径。");
  process.exit(0);
}
console.log(`check-result-copy: ${failures} 处不符合（上面打了 ✗）。`);
process.exit(1);
