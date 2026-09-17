// 构建期把「动手的执行组件」取回来、验校验值、摆成应用旁边的布局（#150 第二步）。
//
// 为什么要有它：决定走 C（执行组件随安装包一起发，`gui/docs/DECISION-windows-runtime.md` §10）
// 之后，她那台机器上**不能**在首次运行时下载任何东西。所以下载只发生在这里（构建期）：
//
//   1. 按 `gui/executor/versions.json` 里的 url 取回 pi 的 npm 包与 Windows 版 bun；
//   2. **按 sha256 校验**——对不上就删掉并失败，绝不"下载完直接用"；
//   3. 摆成 `gui/src-tauri/executor/pi/{bun.exe,package.json,dist/bundle/cli.js,…}`，
//      也就是 `gui/src-tauri/src/program.rs` 的 `locate_assistant()` 会读的那个形状；
//   4. 生成随包发的许可说明 `pi/THIRD-PARTY-NOTICES.md`（pi 与 bun 的原文 + 被内联的依赖清单）。
//
// 平台：这一份只给 Windows x64（macOS 用上游 cante 守护进程）。别的平台上本脚本**直接跳过**
// （打印一行说明），因为 `tauri.windows.conf.json` 才把 resources 指到这里——macOS 的 dmg
// 不该因为一个它不用的组件而变大。
//
// 用法：
//   bash gui/scripts/stage-executor.sh            # 构建期（beforeBuildCommand）与人工都能跑
//   bash gui/scripts/stage-executor.sh --force    # 忽略已摆好的缓存，重来一遍
//   CANTE_EXECUTOR_FORCE=1 …                      # 在非 Windows 上强行跑一遍（只用于本机验证）

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(GUI_ROOT, "..");
const MANIFEST = join(GUI_ROOT, "executor", "versions.json");
const CACHE = join(GUI_ROOT, "executor", ".cache");
const STAGE = join(GUI_ROOT, "src-tauri", "executor");
const PI_DIR = join(STAGE, "pi");
const MARKER = join(STAGE, ".staged.json");
/** 一次下载最多等多久（大包在慢网下也就几分钟）。 */
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force") || process.env.CANTE_EXECUTOR_FORCE === "1";

function say(line: string): void {
  console.log(`stage-executor: ${line}`);
}
function die(line: string): never {
  console.error(`stage-executor: ✗ ${line}`);
  process.exit(1);
}

interface Part {
  version: string;
  url: string;
  sha256: string;
  bytes: number;
  licenseFile: string;
  licenseSource: string;
  licenseSha256: string;
  projectUrl: string;
  publisher?: string;
  license: string;
  member?: string;
  package?: string;
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  pi: Part;
  bun: Part;
  layout: Record<string, string>;
};

if (process.platform !== "win32" && !FORCE) {
  say(`这台机器不是 Windows（${process.platform}），跳过：执行组件只随 Windows 安装包发。`);
  say("（想在别的平台上验证这段脚本：CANTE_EXECUTOR_FORCE=1。）");
  process.exit(0);
}

for (const [key, part] of [["pi", manifest.pi], ["bun", manifest.bun]] as const) {
  if (!/^[0-9a-f]{64}$/.test(part.sha256)) die(`${key} 的 sha256 不是 64 位十六进制：${part.sha256}`);
  if (!part.url.startsWith("https://")) die(`${key} 的 url 必须是 https：${part.url}`);
}

async function sha256Of(path: string): Promise<string> {
  const hasher = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk as Uint8Array);
  return hasher.digest("hex");
}

/** 取回一个包：先看缓存（缓存也要验校验值），没有再下载。返回本地路径。 */
async function fetchVerified(key: string, part: Part, fileName: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const cached = join(CACHE, fileName);
  if (existsSync(cached)) {
    const got = await sha256Of(cached);
    if (got === part.sha256) {
      say(`${key}：用缓存 ${fileName}（sha256 对上）`);
      return cached;
    }
    say(`${key}：缓存里的 sha256 对不上（${got.slice(0, 12)}… ≠ ${part.sha256.slice(0, 12)}…），删掉重下`);
    rmSync(cached, { force: true });
  }

  say(`${key}：下载 ${part.url}`);
  const started = Date.now();
  const response = await fetch(part.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) die(`${key}：下载失败 HTTP ${response.status}（${part.url}）`);
  await Bun.write(cached, response);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const size = statSync(cached).size;
  say(`${key}：下载完成 ${(size / 1048576).toFixed(1)} MB，${seconds} 秒`);

  const got = await sha256Of(cached);
  if (got !== part.sha256) {
    rmSync(cached, { force: true });
    die(
      `${key}：校验值对不上！\n` +
        `  期望 ${part.sha256}\n` +
        `  实际 ${got}\n` +
        `  这一份已经删掉，不会进安装包。要么是上游换了内容，要么是下载被改了——` +
        `先查清楚，再决定是改 gui/executor/versions.json 还是别用这一份。`,
    );
  }
  say(`${key}：校验值对上 ✓`);
  return cached;
}

/**
 * 解包。坑有两个，都在 Windows 上踩过：
 *   * zip 不一定有 `unzip`；
 *   * Git 自带的 GNU tar 在这台机器上读这个 tgz 会 "unexpected end of file"，
 *     而 Windows 自带的 `System32\tar.exe`（bsdtar）两种包都认、还快。
 * 所以 Windows 上先试系统那个 tar，再按 unzip → tar → PowerShell 依次退。
 */
function extractorCandidates(archive: string, into: string, zip: boolean): Array<[string, string[]]> {
  const systemTar = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tar.exe")
    : "";
  const tars: Array<[string, string[]]> = [];
  if (process.platform === "win32" && systemTar && existsSync(systemTar)) {
    tars.push([systemTar, ["-xf", archive, "-C", into]]);
  }
  tars.push(["tar", ["-xf", archive, "-C", into]]);
  if (!zip) return tars.map(([c, a]) => [c, a] as [string, string[]]);
  return [
    ["unzip", ["-q", "-o", archive, "-d", into]],
    ...tars,
    [
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
      ],
    ],
  ];
}

function extract(archive: string, into: string, zip: boolean): void {
  mkdirSync(into, { recursive: true });
  const tried: string[] = [];
  for (const [command, argv] of extractorCandidates(archive, into, zip)) {
    const result = spawnSync(command, argv, { stdio: "pipe" });
    if (result.error) {
      tried.push(`${command}（${(result.error as NodeJS.ErrnoException).code ?? "?"}）`);
      continue;
    }
    if (result.status === 0) {
      say(`解包：${command}`);
      return;
    }
    tried.push(`${command}（退出码 ${result.status}：${String(result.stderr).trim().slice(0, 120)}）`);
  }
  die(`解不开 ${archive}；试过：${tried.join("、")}`);
}

/** 只留运行时真的要用的那些：`dist/` + package.json + 依赖清单 + README。 */
const KEEP = ["dist", "package.json", "npm-shrinkwrap.json", "README.md"];

function noticeText(pi: Part, bun: Part, dependencyLines: string[]): string {
  const piLicense = readFileSync(join(GUI_ROOT, "executor", pi.licenseFile), "utf8").trimEnd();
  const bunLicense = readFileSync(join(GUI_ROOT, "executor", bun.licenseFile), "utf8").trimEnd();
  return [
    "# 随这个软件一起发的组件，用了哪些别人的东西",
    "",
    "这份文件随安装包一起发到这台电脑上，不需要联网看。它是构建时自动生成的"
      + "（`gui/scripts/stage-executor.ts`），不要手改。",
    "",
    "## 1. 动手干活的组件",
    "",
    `- ${pi.package} ${pi.version} —— ${pi.license}，${pi.publisher ?? ""}`.trimEnd(),
    `  - 项目：${pi.projectUrl}`,
    `  - 取回地址：${pi.url}`,
    `  - sha256：${pi.sha256}`,
    "",
    "## 2. 跑它的运行时",
    "",
    `- bun ${bun.version}（${bun.target}）—— ${bun.license}`,
    `  - 项目：${bun.projectUrl}`,
    `  - 取回地址：${bun.url}`,
    `  - sha256：${bun.sha256}`,
    "",
    "## 3. 被它打进一个文件里的那些库",
    "",
    "下面这些是上面那个组件自带的依赖（`npm-shrinkwrap.json` 里逐条列出，已逐条核对过"
      + "许可：都是宽松许可，没有 copyleft）。它们被合并进 `dist/bundle` 的同一个文件里，"
      + "所以不会有单独的目录；要查原文就按包名与版本去 npm 上取。",
    "",
    ...dependencyLines,
    "",
    "## 4. 许可原文",
    "",
    `### ${pi.package}`,
    "",
    "```",
    piLicense,
    "```",
    "",
    "### bun",
    "",
    "```",
    bunLicense,
    "```",
    "",
  ].join("\n");
}

function dependencyList(shrinkwrapPath: string): string[] {
  const data = JSON.parse(readFileSync(shrinkwrapPath, "utf8")) as {
    packages?: Record<string, { version?: string; license?: string }>;
  };
  const rows: string[] = [];
  for (const [key, value] of Object.entries(data.packages ?? {})) {
    if (!key) continue;
    const name = key.split("node_modules/").pop() ?? key;
    const version = value.version ?? "?";
    const license = value.license ?? "（未标注）";
    rows.push(`- ${name}@${version} — ${license}`);
  }
  rows.sort();
  return rows.length > 0 ? rows : ["- （清单是空的：上游没带 npm-shrinkwrap.json，去项目主页查）"];
}

/** 一个目录里所有文件的字节数（报告里要贴数字，别用目录项自己的大小）。 */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size;
  }
  return total;
}

/** 一个目录里所有文件的字节数（报告里要贴数字，别用目录项自己的大小）。 */
function directorySize(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(path) : statSync(path).size;
  }
  return total;
}

/** 摆好之后自查一遍：布局与 `program.rs` 的读法一致，否则宁可不产包。 */
function assertLayout(): void {
  const required = ["bun.exe", "package.json", "dist/bundle/cli.js", "THIRD-PARTY-NOTICES.md"];
  const missing = required.filter((rel) => !existsSync(join(PI_DIR, ...rel.split("/"))));
  if (missing.length > 0) die(`摆好之后少了：${missing.join("、")}（program.rs 会找不到它）`);
}

async function main(): Promise<void> {
  const stamp = createHash("sha256")
    .update(JSON.stringify({ pi: manifest.pi.sha256, bun: manifest.bun.sha256 }))
    .digest("hex");

  if (!FORCE && existsSync(MARKER) && existsSync(PI_DIR)) {
    const previous = JSON.parse(readFileSync(MARKER, "utf8")) as { stamp?: string };
    if (previous.stamp === stamp) {
      assertLayout();
      say(`已经摆好了（${manifest.pi.version} + bun ${manifest.bun.version}），跳过。`);
      return;
    }
  }

  const piArchive = await fetchVerified("pi", manifest.pi, "pi-coding-agent.tgz");
  const bunArchive = await fetchVerified("bun", manifest.bun, "bun-windows-x64.zip");

  // 目录里那个 README.md 是仓库里的占位说明（tauri-build 在编译期就要这个路径存在，
  // 见该文件）。摆之前先把它读出来，摆完再写回去 —— 这样 `git status` 一直是干净的。
  const placeholder = join(PI_DIR, "README.md");
  let placeholderText = "";
  try {
    placeholderText = readFileSync(placeholder, "utf8");
  } catch {
    /* 第一次跑（目录还是空的）没有占位文件，正常。 */
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(PI_DIR, { recursive: true });

  // pi：解开 npm 包，只留运行时用得着的那些。
  const piTmp = join(STAGE, ".unpack-pi");
  extract(piArchive, piTmp, false);
  const packed = join(piTmp, "package");
  if (!existsSync(packed)) die(`npm 包里没有 package/ 目录，改过的上游？`);
  for (const entry of KEEP) {
    const from = join(packed, entry);
    if (!existsSync(from)) die(`npm 包里少了 ${entry}（布局变了，先看 versions.json 的说明）`);
    renameSync(from, join(PI_DIR, entry));
  }
  rmSync(piTmp, { recursive: true, force: true });

  // bun：zip 里只有一个成员，挑出 bun.exe。
  const bunTmp = join(STAGE, ".unpack-bun");
  extract(bunArchive, bunTmp, true);
  const member = manifest.bun.member ?? "bun-windows-x64/bun.exe";
  const memberPath = join(bunTmp, ...member.split("/"));
  if (!existsSync(memberPath)) die(`bun 压缩包里没有 ${member}（上游改了布局）`);
  renameSync(memberPath, join(PI_DIR, "bun.exe"));
  rmSync(bunTmp, { recursive: true, force: true });

  writeFileSync(
    join(PI_DIR, "THIRD-PARTY-NOTICES.md"),
    noticeText(manifest.pi, manifest.bun, dependencyList(join(PI_DIR, "npm-shrinkwrap.json"))),
    "utf8",
  );
  writeFileSync(MARKER, JSON.stringify({ stamp, pi: manifest.pi.version, bun: manifest.bun.version }, null, 2), "utf8");

  if (placeholderText) writeFileSync(placeholder, placeholderText, "utf8");

  assertLayout();
  const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`;
  say(`摆好了：${STAGE.replace(`${REPO_ROOT}/`, "")}（整个 ${mb(directorySize(STAGE))}）`);
  say(`  pi ${manifest.pi.version}  ${mb(directorySize(join(PI_DIR, "dist")))}（dist）+ 依赖清单 + 许可说明`);
  say(`  bun ${manifest.bun.version}  ${mb(statSync(join(PI_DIR, "bun.exe")).size)}`);
  say("这两样会由 tauri.windows.conf.json 的 bundle.resources 装到应用旁边（pi\\）。");
}

await main();
