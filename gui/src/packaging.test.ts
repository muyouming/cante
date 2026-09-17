// 打包相关的守卫。
//
// 这里挡的是一类"单元测试看不见、只有打包时才炸"的故障：桌面应用这个 crate
// 除了窗口本体，还带两个给助手用的命令行工具（cante-sheets / cante-pdf）。
// Cargo 允许一个 crate 有多个 binary，但 tauri-bundler 必须被明确告知哪个才是
// 应用本体，否则会报 "failed to find main binary, make sure you have a
// `package > default-run`" —— 本地 `cargo test`、`bun test`、CI 的 e2e 全绿，
// 等到出安装包时才红，而发布流水线只在打 tag 时跑。
//
// 所以这条测试直接读 Cargo.toml 与 tauri.conf.json 做一致性检查：便宜、确定、
// 在三个平台上都能跑，而且失败信息直接告诉你缺哪一行。
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const SRC_TAURI = path.resolve(import.meta.dir, "..", "src-tauri");

/** `[[bin]]` 段里的 name，按出现顺序。 */
function binaryNames(cargo: string): string[] {
  const names: string[] = [];
  for (const block of cargo.split("[[bin]]").slice(1)) {
    const match = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (match) names.push(match[1]!);
  }
  return names;
}

/** `[package]` 段里的字段（只读这一段，避免误取依赖里的同名键）。 */
function packageField(cargo: string, key: string): string | null {
  const start = cargo.indexOf("[package]");
  if (start < 0) return null;
  const rest = cargo.slice(start + "[package]".length);
  const end = rest.indexOf("\n[");
  const section = end < 0 ? rest : rest.slice(0, end);
  const match = section.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  return match ? match[1]! : null;
}

test("多个 binary 时必须声明 default-run，否则打安装包会失败", () => {
  const cargo = readFileSync(path.join(SRC_TAURI, "Cargo.toml"), "utf8");
  const bins = binaryNames(cargo);
  const crateName = packageField(cargo, "name");
  expect(crateName).toBeTruthy();

  if (bins.length <= 1) {
    // 只有一个 binary 时 Cargo 不需要它，但留着也无害。
    expect(bins.length).toBeLessThanOrEqual(1);
    return;
  }

  const defaultRun = packageField(cargo, "default-run");
  expect(
    defaultRun,
    "src-tauri/Cargo.toml 有多个 [[bin]]，但没有 [package] default-run —— " +
      "tauri build 会报 failed to find main binary（CI 不会发现，只有打包时炸）",
  ).toBeTruthy();
  // 应用本体是隐式主程序（`src/main.rs`，名字等于 crate 名），它不会出现在
  // [[bin]] 列表里；default-run 要么指向它，要么指向某个显式声明的 bin。
  if (defaultRun === crateName) {
    const main = path.join(SRC_TAURI, "src", "main.rs");
    expect(existsSync(main), `default-run = "${defaultRun}" 要求存在 src/main.rs`).toBe(true);
  } else {
    expect(bins, `default-run = "${defaultRun}" 必须指向一个真实的 [[bin]]`).toContain(defaultRun!);
  }
});

test("打包带上给助手用的工具，名字和 sources 一致", () => {
  const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"));
  const resources = config?.bundle?.resources ?? [];
  const keys = Array.isArray(resources) ? resources : Object.keys(resources);
  const joined = JSON.stringify(keys);

  // 应用会告诉助手这些工具在哪，所以它们必须真的进包；漏一个就会出现
  // "助手被告知有这个工具、实际调不到"的最差情况。
  for (const tool of ["cante-sheets", "cante-pdf"]) {
    expect(joined, `tauri.conf.json 的 bundle.resources 里缺少 ${tool}`).toContain(tool);
  }
});

// #112：真机验收时发现 Windows 的安装包里**根本没有**两个工具——NSIS/MSI 里只有
// cante-gui.exe 与 uninstall.exe。原因是 resources 写的是"没有扩展名"的字面路径，
// 而 Windows 上产物叫 `cante-sheets.exe`：**路径不存在 → 静默不打包**（不报错）。
//
// 这条测试要挡住的正是"静默"：每个工具在配置里必须用一个 **glob**（`…cante-sheets*`）
// 或者把两种文件名都列出来，否则窄的名字会随平台变，而漏掉的时候没有任何提示。
test("每个自带工具都按平台可能的文件名打包，而不是写死一个不带扩展名的路径", () => {
  const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"));
  const resources = config?.bundle?.resources ?? [];
  const entries: string[] = Array.isArray(resources) ? resources : Object.keys(resources);
  const joined = entries.join(" ");

  for (const tool of ["cante-sheets", "cante-pdf"]) {
    const hasGlob = new RegExp(`${tool}\\*`).test(joined);
    const hasBothNames = joined.includes(tool) && joined.includes(`${tool}.exe`);
    expect(
      hasGlob || hasBothNames,
      `bundle.resources 里的 ${tool} 只匹配一种文件名（在另一个平台上会静默漏打包）。` +
        `要么写成 glob（…${tool}*），要么把 ${tool} 与 ${tool}.exe 都列出来。现在是：${joined}`,
    ).toBe(true);
  }

  // 打包后的落点必须与 Rust 解析器查的位置**一致**：tauri 用数组形式会把路径原样保留，
  // 于是文件落在 $RESOURCE/target/release/<名字>，而 commands.rs 里就是查的这里。
  // 两边任意一边改了，这条会红——不然"打包了但找不到"会再次发生。
  const resolver = readFileSync(path.join(SRC_TAURI, "src", "commands.rs"), "utf8");
  const resolverLooksNested = /join\("target"\)[\s\S]{0,120}join\("release"\)/.test(resolver);
  expect(
    resolverLooksNested,
    "commands.rs 的 resolve_tool_bin 必须查 $RESOURCE/target/release/（数组形式打包会保留目录结构）",
  ).toBe(true);
  expect(joined, "bundle.resources 的路径要在 target/release 下，才能被解析器找到").toContain("target/release");
});
