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

/**
 * 随应用一起发布的辅助程序：它们在 Cargo.toml 里都是额外的 `[[bin]]`，tauri 会把
 * 它们装到**主程序旁边**（第三次真机验收确认过：装完就是主程序 + 这三个 + 卸载程序）。
 *
 * 三个文件的**落点**一样，**被找到的方式**不一样，别把这两件事混起来：
 *
 *   * `cante-sheets` / `cante-pdf`：`commands.rs::resolve_tool_bin` 在主程序旁边找
 *     （下面有一条测试把这个落点钉住）；
 *   * `cante-bridge`：它是守护进程的替身，由 `daemon.rs` 按 `CANTE_BIN` 找 ——
 *     躺在安装目录里**不会**自己被用上（`WINDOWS-ACCEPTANCE-3.md` §6）。
 *
 * 但"进不进包"三个是同一件事：少一个 `[[bin]]`，安装包里就根本没有这个文件。
 */
const BUNDLED_BINARIES = ["cante-sheets", "cante-pdf", "cante-bridge"];

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

/** tauri.conf.json 的 `bundle` 段。 */
function bundleConfig(): Record<string, unknown> {
  const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"));
  return (config?.bundle ?? {}) as Record<string, unknown>;
}

/** `bundle.resources` 的条目（对象写法与数组写法都算）。 */
function resourceEntries(bundle: Record<string, unknown>): string[] {
  const resources = bundle.resources;
  if (!resources) return [];
  return Array.isArray(resources) ? resources.map(String) : Object.keys(resources as object);
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

// ---------------------------------------------------------------------------
// 三个自带程序怎么进包：走 crate 的额外 [[bin]]，**不要**走 bundle.resources
// ---------------------------------------------------------------------------
//
// #112（第一次真机验收）：`bundle.resources` 写的是没有扩展名的字面路径
// （`target/release/cante-sheets`），而 Windows 上产物叫 `.exe` —— 路径不存在就
// **静默不打包**，装完两个工具都不在。
//
// #112 的修法改成了 glob（`target/release/cante-sheets*`），工具是进包了，
// 但第二次真机验收发现 glob **顺带把那个目录里的东西一起扫了进来**：
//
//   * `build.rs` 为了让 `tauri-build` 的资源校验通过而写的 0 字节占位符
//     （`target/release/cante-sheets`）—— Windows 上真产物叫 `.exe`，名字对不上，
//     占位符永远不会被覆盖，于是"0 字节的假工具"也被打进包；
//   * cargo 给每个 `[[bin]]` 写的 dep-info（`cante-sheets.d`）。
//
// 第三次（本文件改的这一次）的做法：**不声明**，让 tauri 自己把 crate 的额外
// `[[bin]]` 当辅助程序装到**主程序旁边**。真机验证过（NSIS 与安装目录都干净）：
// 装完只有 5 个文件 —— cante-gui/cante-bridge/cante-pdf/cante-sheets/uninstall，
// 没有 `.d`、没有 0 字节文件。而"主程序旁边"正好是解析器的第一条候选。
//
// 为什么不用 `bundle.externalBin`（那才是"官方"的辅助程序写法）：它要求文件叫
// `<名字>-<target-triple>[.exe]`，校验发生在 **build script** 里，而 crate 自己的
// bin 是在那次 cargo 调用里**稍后**才编译出来的 —— 真机上直接报
// `resource path target\release\cante-sheets-x86_64-pc-windows-msvc.exe doesn't exist`，
// 包都出不来。要让它成立得额外加一步"先编译再改名"的打包前脚本，代价大于收益。
test("三个自带程序必须在 Cargo.toml 里是 [[bin]]，且不许再写进 bundle.resources", () => {
  const cargo = readFileSync(path.join(SRC_TAURI, "Cargo.toml"), "utf8");
  const bins = binaryNames(cargo);

  // 1) 它们是 crate 的额外 bin —— 这正是 tauri 把"辅助程序装到主程序旁边"的依据。
  for (const tool of BUNDLED_BINARIES) {
    expect(
      bins,
      `src-tauri/Cargo.toml 里没有 ${tool} 这个 [[bin]]：它不会进安装包，` +
        `应用会告诉用户"这台电脑还没有工具"，而这个结果没人会及时发现。`,
    ).toContain(tool);
  }

  // 2) `bundle.resources` 里**不许**再出现 `target/release`。
  //
  //    注意这条不能只查工具名：`target/release/*` 这种宽 glob 一样能把 `.d` 和
  //    0 字节占位符扫进去（而它并不包含 "cante-sheets" 字面量，只查名字会漏）。
  //    所以要挡的是"把编译产物目录交给 resources"这件事本身。
  const bundle = bundleConfig();
  for (const entry of resourceEntries(bundle)) {
    expect(
      entry.replace(/\\/g, "/").includes("target/release"),
      `bundle.resources 里不该再有 "${entry}"：tauri 用数组形式会保留目录结构，` +
        `而 target/release 里躺着 cargo 的 .d 与 build.rs 的 0 字节占位符 —— ` +
        `上一轮它们就是这么被 glob 扫进安装包的（真机验收 2 的证据）。` +
        `工具走 crate 的额外 [[bin]]，tauri 会把它们装到主程序旁边。`,
    ).toBe(false);
  }

  // 3) `externalBin` 也不要用它来放这些程序：真机上它是硬报错（见上面那段注释）。
  //    这条断言是"别重复踩同一个坑"，不是"externalBin 永远不能用" —— 如果哪天真加了
  //    "先编译再按 target triple 改名"的打包前步骤，把这条和上面那段注释一起改掉。
  const externalBin = (bundle.externalBin ?? []) as unknown[];
  for (const entry of Array.isArray(externalBin) ? externalBin.map(String) : []) {
    for (const tool of BUNDLED_BINARIES) {
      expect(
        entry.includes(tool),
        `bundle.externalBin 里不该列 ${tool}：tauri 要求同名文件带 target triple 后缀` +
          `（<名字>-<三元组>.exe），而 crate 自己的 bin 在 build script 跑的时候还没编译出来，` +
          `真机上直接打包失败。`,
      ).toBe(false);
    }
  }
});

// 桥的"进包"与"被找到"是两件事：它和两个工具一样躺在主程序旁边，但守护进程的解析
// 只看 `CANTE_BIN`（或 PATH 上的 `cante`）—— 所以包里有 `cante-bridge.exe`，而要用
// 它必须把 `CANTE_BIN` 指过去。这条把差异钉在明处，免得以后有人以为装进包就等于
// "Windows 上自动有干活组件了"（第三次真机验收的结论，`WINDOWS-ACCEPTANCE-3.md` §6）。
test("cante-bridge 进包，但只有 CANTE_BIN 会用到它", () => {
  const cargo = readFileSync(path.join(SRC_TAURI, "Cargo.toml"), "utf8");
  expect(
    binaryNames(cargo),
    "cante-bridge 必须是 [[bin]]：它是包里的第三个程序，少一个就没人能把它指给应用。",
  ).toContain("cante-bridge");

  // 反面：两个工具的解析器**不该**顺手认领它 —— 桥的命令行是「守护进程替身」，
  // 与「给助手用的小工具」不是同一种东西，混进 resolve_tool_bin 会让能力提示说谎。
  const commands = readFileSync(path.join(SRC_TAURI, "src", "commands.rs"), "utf8");
  const start = commands.indexOf("pub fn resolve_tool_bin");
  expect(start, "commands.rs 里找不到 resolve_tool_bin").toBeGreaterThan(-1);
  const body = commands.slice(start, commands.indexOf("\n}", start));
  expect(
    body.includes("cante-bridge"),
    "resolve_tool_bin 不该解析 cante-bridge：它由守护进程按 CANTE_BIN 启动，" +
      "混进工具解析会让界面上的能力提示与真正的启动路径不一致。",
  ).toBe(false);

  // 而守护进程侧确实只认 CANTE_BIN（或默认的 cante）——这是桥现在唯一被用到的入口。
  const daemon = readFileSync(path.join(SRC_TAURI, "src", "daemon.rs"), "utf8");
  expect(
    daemon.includes("CANTE_BIN"),
    "daemon.rs 里没有 CANTE_BIN：桥就没有任何入口，安装包里的 cante-bridge.exe 是摆设。",
  ).toBe(true);
});

// 打包后的落点必须与 Rust 解析器查的第一条候选**一致**：装上以后工具就躺在
// 主程序旁边（Windows 的安装根目录、macOS 的 Contents/MacOS），而
// commands.rs 的第一条候选就是"与可执行文件同目录"。这条把两边钉在一起：
// 以后谁改了打包方式（工具不再落在同目录），或者谁把解析顺序调了，都会红。
test("两个工具的解析器必须先在主程序旁边找它们，打包方式也要把工具放在那里", () => {
  const resolver = readFileSync(path.join(SRC_TAURI, "src", "commands.rs"), "utf8");
  const start = resolver.indexOf("pub fn resolve_tool_bin");
  expect(start, "commands.rs 里找不到 resolve_tool_bin").toBeGreaterThan(-1);
  const body = resolver.slice(start, resolver.indexOf("\n}", start));
  expect(body, "resolve_tool_bin 读不出函数体").toContain("exe_dir");

  const sameDir = body.indexOf("dir.join(bin_name)");
  expect(
    sameDir,
    "resolve_tool_bin 必须查「与可执行文件同目录」——打包把工具放在那里",
  ).toBeGreaterThan(-1);

  const nested = body.indexOf('join("release")');
  if (nested > -1) {
    expect(
      sameDir < nested,
      "同目录那条候选必须在 target/release 那条之前：打包把工具放在主程序旁边，" +
        "先查同目录才找得到（顺序反了会在某些机器上先撞到旧路径）。",
    ).toBe(true);
  }
});
