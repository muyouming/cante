# 桥在 Windows 上：编译、打包、真跑（issue #116 的最后一公里）

> 这份文档把「`cante-bridge` + `pi` 在没有守护进程的 Windows 上可用」从**应该是**
> 变成**可核对**：哪些是在 macOS 上量到的，哪些必须在那台 Windows 上跑，以及哪一条
> 到今天我仍然没有验证。事实与推断分开写，带命令/断言的是量到的。
>
> 上游 `cante`/`ante` 没有 Windows 构建（官方 README 建议 WSL），而 `pi` 在 Windows 上
> 原生能跑 —— 所以「桥 + pi」这条路上，**Windows 不需要 WSL**（`DECISION-windows-runtime.md`
> §4 方案 C 的前提）。

---

## 0. 结论先行

| 问题 | 结论 | 一句话证据 |
| --- | --- | --- |
| 本机能编出 `cante-bridge` 吗？ | **能**（macOS 产物 + Windows 目标交叉检查） | release 产物 907,216 字节（macOS arm64）；`cargo check --target x86_64-pc-windows-msvc` 也过（见 §1） |
| `--version` / `catalog` 在 Windows 上也成立吗？ | **解析层面成立**（真机未验） | `binary_spec.rs` 新增 4 条 Windows `.exe` 形态用例；两个输出都是普通 UTF-8 行，不依赖平台 |
| `CANTE_BIN` 指向 `C:\…\cante-bridge.exe` 时，`daemon.rs` 会把它拼对？ | **会** | `serve_argv` 只追加一个 `serve`；`.exe` 不被当特殊 token。20 条解析测试全绿（§2） |
| 桥会自动进安装包吗？ | **会，而且是真机确认过的** | 第三次真机验收：NSIS 与安装目录里都有 `cante-bridge.exe`（603,648 字节），躺在主程序旁边 |
| 装进包就等于能被用上吗？ | **不** | 守护进程只认 `CANTE_BIN` / PATH 上的 `cante`（`WINDOWS-ACCEPTANCE-3.md` §6）；要用桥必须设 `CANTE_BIN` |
| 那台机器上的 `pi` 一定是能起的吗？ | **不一定（最大的未知数）** | `PI_BIN` 是单个程序名，`Command::new` 走 `CreateProcess`，**起不了 npm 的 `pi.cmd`**（§3 第一段；与 `bun` 那个坑同源） |
| 桥能跑真实任务吗？ | **本机 macOS 上跑通过**（真 `pi` + 假端点）；**Windows 上交给那台机器** | `BRIDGE-spike.md` / `BRIDGE-gate.md`；Windows 命令清单在 §5 |

---

## 1. 编译事实（本机 macOS 上量到的）

```bash
cd gui && source scripts/toolchain.sh
cargo build --release --bin cante-bridge --manifest-path src-tauri/Cargo.toml
```

- 冷启动（含依赖）`Finished release profile in 48.11s`；增量重编只跑 `cante-gui` 一个 crate（加完 §3.2 那个修复后重编是 30.32s）。
- 产物：`gui/src-tauri/target/release/cante-bridge`，**907,216 字节**（Mach-O arm64；加 §3.2
  的落盘修复前是 905,680，差 1.5KB 上下，都属于「这是个几百 KB 的小壳」的量级）。
  它是应用本体之外的一个**独立** `[[bin]]`（`src-tauri/Cargo.toml`），不带 webview、不带 tauri runtime 的窗口部分。
- 对照：同一份 release 配置在 Windows x64 上的产物是 **603,648 字节**（第三次真机验收量到的
  `cante-bridge.exe`）。两个数字都只说明「这是个几百 KB 的小壳」，**不是**体积预算。

三个子命令的旁证（本机）：

```text
$ cante-bridge --version     →  cante-bridge 0.2.0        exit 0
$ cante-bridge catalog       →  {"providers":[]}          exit 0
$ cante-bridge nope          →  cante-bridge: unknown subcommand: nope   exit 2（stderr）
```

`--version` 打印的是一行 UTF-8 文本，`catalog` 是一行合法 JSON（Rust 的 `println!` 不翻译成
CRLF，所以按行读的 `daemon.rs` 在两个平台上都读得动）。**没有** unix 专有的东西：不碰信号、
不 exec 脚本、不用 `/dev/*`。`src/bin/cante-bridge.rs` 只做 `args.first()` 分发。

### 交叉检查：Windows 分支真的会编（本机可跑）

macOS 上链不出 `.exe`，但可以让 cargo **按 Windows 目标编一遍** —— 这会真的编译 `cfg(windows)`
的那些分支（`bridge.rs` 与 `daemon.rs` 里的两份 `hide_console`）以及新加的 Windows 解析测试。
需要 LLVM 的 `llvm-rc`（`tauri-build` 用它嵌 Windows 资源；找不到时报 `NotAttempted("llvm-rc")`）：

```bash
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"   # 只是本机装的 LLVM；Windows/CI 上不需要
cargo check --target x86_64-pc-windows-msvc --bin cante-bridge --manifest-path gui/src-tauri/Cargo.toml
cargo check --target x86_64-pc-windows-msvc --tests        --manifest-path gui/src-tauri/Cargo.toml
```

两条都加上 `RUSTFLAGS="-D warnings"`（CI 的判据）后 **exit 0**（本机 2026-09 实测）。
注意 `cargo check` **不链接**：它证明的是「Windows 分支能编过」，**不是**「Windows 上能出
`.exe` / 能跑」。后者交给 CI 的 windows-latest job 与 §5 的真机清单。

---

## 2. `CANTE_BIN` 的 Windows 形态（纯解析，本机就能验）

`daemon.rs` 把 `CANTE_BIN` 当**命令规格**（不是路径）：先按引号/空白切词，再把 `serve`
追加到最后一个 token 后面。Windows 上要设的值就是桥自己的路径：

```powershell
$env:CANTE_BIN = "C:\path\to\cante-bridge.exe"
```

三种规范都必须成立，`gui/src-tauri/tests/binary_spec.rs` 里各有一条（本机纯解析，**不需要** Windows）：

| 规范 | 解析结果（program, args） | 测试 |
| --- | --- | --- |
| `C:\tools\cante\cante-bridge.exe` | `(C:\tools\cante\cante-bridge.exe, [serve])` | `a_windows_bridge_exe_gets_exactly_one_serve` |
| `"C:\Program Files\Cante\cante-bridge.exe"` | `(C:\Program Files\Cante\cante-bridge.exe, [serve])` | `a_quoted_windows_bridge_path_with_spaces_stays_one_token` |
| `C:\tools\cante\cante-bridge.exe serve` | 同上，**不会**变 `serve serve` | `a_windows_bridge_spec_that_names_serve_is_not_doubled` |

以及两个探活：`helper_argv(spec, ["--version"])` / `["catalog"]` 必须把参数插在 `serve`
**前面**（`a_windows_bridge_exe_can_be_probed`）—— 否则应用首次检查会以为「组件没装好」。

要点：反斜杠**不是**转义符（只认引号），所以 Windows 路径原样保留；带空格的路径**必须加引号**。

---

## 3. 平台假设逐条检查

### 3.1 进程启动方式：`pi` 必须是 `CreateProcess` 起得来的东西（**已知边界**）

`bridge.rs::pi_program()` 读 `PI_BIN`（默认 `"pi"`），然后 `Command::new(program)` 直接 spawn。
Rust 在 Windows 上用 `CreateProcessW`，它**不会**按 `PATHEXT` 找 `.cmd`/`.bat`。而 `pi` 是 npm
包（`package.json` 的 `bin: pi → dist/bundle/cli.js`），npm 在 Windows 上装的 wrapper 是
`pi.cmd` / `pi.ps1`，**没有** `pi.exe`。

这和 `DECISION-windows-runtime.md` §8 记的那个坑是同一个（npm 版 `bun` 让 4 个 Rust 测试红过）：

- 若那台机器的 `pi` 是 `pi.cmd`，`PI_BIN=pi`（或任何指到 `pi.cmd` 的值）都会以
  「没能把助手启动起来」收场；
- 能起得来的是**真 `.exe`**：例如 `bun install -g` 在 `~\.bun\bin\` 落的 `pi.exe` shim，
  或者任何指向 `.exe` 的路径。

**这一段没有把它改成「自动包一层 `cmd.exe`」**：那会让桥的直接子进程从 `pi` 变成 `cmd`，
而收尾是靠「关掉子进程 stdin → pi 自己退」，父子链一变，Windows 上会不会留下孤儿进程
就没法在本机验证了（`reap` 只 kill 直接子进程，Windows 不杀进程树）。宁可在报告里写清前提，
也不要在不能验证的平台上改收尾路径。**这是给那台机器的第一条检查项（§5 第 3 步）。**

#### 3.1.1 #150 定下的形态：随包发「运行时 + 入口脚本」（**已实测**）

决定走 C 之后（`DECISION-windows-runtime.md` §10），执行组件随安装包一起发，用户那台
机器上没有任何东西可以指路。所以**应用旁边的那一份**有固定形态，桥和探测都按它找：

```
<安装目录>\
  cante-gui.exe
  cante-bridge.exe
  cante-sheets.exe
  cante-pdf.exe
  pi\
    bun.exe          ← 官方 bun 单文件（实测 83 MB），当运行时
    package.json     ← pi 自己的（它靠它认版本/找自己的东西）
    dist\            ← pi 发布的整份 `dist/`（实测 19 MB）：
      bundle\cli.js  ←   入口就是它，运行时是 `pi\bun.exe` + 这个参数
      bundle\chunks\…←   它 import 的同目录分片
      modes\…          ←   主题等运行时要读的 JSON：**少了它 pi 一起就挂**
```

**实测踩过的坑**（两句都是真机上的报错原文，不是推演）：

- 只把 `dist/bundle/{cli.js,chunks}` 拷贝进 `pi\` → 起不来：
  `ENOENT: no such file or directory, open '…\pi\chunks\dist\modes\interactive\theme\dark.json'`。
  所以随包发的是**整份 pi 发布内容（package.json + dist/）**，不是把 cli.js 抠出来 —— 少一层
  目录就会在启动时找 `modes/interactive/theme/*.json` 之类的东西。
- 官方那个 `pi.exe`（`bun install -g` 落在 `~\.bun\bin\` 的 shim）自己要求 `bun` 在 PATH 上：
  `error: bun is not installed in %PATH%`。我们的安装包不能要求用户 PATH 里有 bun（也可能被人
  改过），所以桥直接起旁边的 `pi\bun.exe`，把入口脚本当第一个参数 —— 运行时不依赖 PATH，
  引号由 `daemon::split_binary` 管（安装目录带空格、用户名非 ASCII 都不会被拆碎）。

找的顺序只有一份实现（`gui/src-tauri/src/program.rs`），探测（`commands.rs` 的
「检查你的电脑」）与拉起进程（`daemon.rs` / `bridge.rs`）都调它 —— 这样探测说「就绪」
就一定起得来：

1. **环境变量**（`CANTE_BIN` / `PI_BIN` 原样当命令规格用，一旦给了就不再往下找）；
2. **应用自己旁边**：守护进程先认 `cante`、再认 `cante-bridge`；执行组件先认 `pi.exe` /
   `pi\pi.exe`，再认上面那一组 `pi\bun.exe` + `pi\dist\bundle\cli.js`；
3. `$HOME/.cante/bin/`；
4. `PATH`。

找不到时给用户看的是**中文人话 + 一个具体下一步**（「这台电脑上缺一个动手的组件，
重新安装一次 Cante 就能补上。」），技术细节（找过哪些位置、系统原话）只进 stderr。
起得来但启动失败（杀毒软件拦未签名程序是 Windows 上最现实的一种）说的是另一句：
「动手的组件没能启动。重新安装一次 Cante，或者请技术同事看一下。」

#### 3.1.2 它怎么进包（#150 第二步）：构建期取回 + 产物闸门

这一份不是手摆的，是构建的一部分：

1. `gui/executor/versions.json` 钉住 pi 与 bun 的版本、下载地址、**sha256**、许可与来源；
2. `tauri.conf.json` 的 `build.beforeBuildCommand` 在打壳前跑 `bun scripts/stage-executor.ts`：
   下载 → **按 sha256 校验**（对不上就删掉并非零退出，绝不“下载完直接用”）→ 摆成上面那个
   形状（`gui/src-tauri/executor/pi/`，构建产物、不入版本库）。缓存按 sha256 命中，重复构建不
   再下载；
3. `tauri.windows.conf.json` 的 `bundle.resources` 用**映射写法**把 `executor/pi` 放到 `pi/`
   （**只有 Windows**：macOS 用上游 cante 守护进程）；
4. 产物层由 `gui/scripts/verify-bundle.sh` 的第 ④ 条检查：Windows 上少了
   `pi\bun.exe` / `pi\dist\bundle\cli.js` / `pi\package.json` / `pi\THIRD-PARTY-NOTICES.md`，
   或者那个 `bun.exe` 在安装目录里跑不起来，就红；非 Windows 不要求它（**在场却残缺**照样红）。

量到的大小（本机实测）：pi 的 `dist` 16.7 MB + `bun.exe` 82.1 MB = 打包前 98.9 MB；
Windows 安装包从 **3.39 MB → 35.5 MB**（37,204,183 字节，NSIS，比 7z 估的略大）。

真机验收走的是 [`scripts/windows/accept-install.ps1`](scripts/windows/accept-install.ps1)
 的 **`-ZeroEnv`** 模式（不设任何环境变量，让应用自己在旁边找）。这道闸门真的抓住了东西：
上一条（PATH 上的 `pi` 盖过随包那一组）就是它先红的 —— 而第一步的验收当时把 PATH 清了，
永远看不到它。**验收的环境要像王姐的机器，不是像我们的实验室。**

**杀毒软件那条要如实说**：本机实测（把随包的 `bun.exe` 拷到一个全新临时目录里跑）
`bun.exe --version` 0.53 秒、经它跑 `pi` 1.08 秒，没有被拦、没被隔离、没有拦截记录 ——
但**这台机器的实时保护是关的**（`RealTimeProtectionEnabled = False`），所以它
**不能**证明「王姐那台开着实时保护的机器上不会被拦」。未签名安装包的 SmartScreen 弹窗
是另一道门（下载来的文件带 MotW 才会触发），本轮没有交互桌面、没验；
而中文出路已经写好了（「动手的组件没能启动。重新安装一次 Cante，或者请技术同事看一下。」）。

### 3.2 路径分隔符与临时文件：审批扩展的落盘（**已修**）

闸门扩展是 `include_str!` 编进二进制的，运行时按内容哈希写到 `std::env::temp_dir()`，
再交给 `pi -e <路径>`。`temp_dir()` 在 Windows 上是 `%TEMP%`，`Path::join` 给的是反斜杠 ——
这些都没问题（`pi -e` 收的是原生路径，`serde_json` 负责转义）。

问题在**落盘那一步**：原来直接 `rename(scratch, path)`。unix 会静默替换已存在的目标，
而 Windows 的 `MoveFile` 在目标存在时**报 `AlreadyExists`**。于是：

- 两个桥进程（或两个测试二进制）同时落同一个内容哈希文件时，抢输的那个会把
  「没能准备好审批要用的文件」当成致命错误 —— 而审批闸门起不来时，产品律 2 就不成立了；
- 一个崩溃/旧版本留下的**内容不同**的同名文件，会让这台机器**以后每次会话都失败**。

现在抽成 `materialize()`：先比内容，命中就复用；否则写 pid 命名的临时文件再 rename；
rename 失败时先看目标内容是否已经是我们要的（那就是别人赢了竞争，算成功），否则删掉陈旧的
目标再试一次。**再试这一圈只有 Windows 会走到**，但行为在两个平台上都能单测：

`a_stale_gate_file_is_replaced_not_blamed`（内容不同 → 被替换、不报错、不留 `.tmp`）、
`materialize_writes_the_gate_file_when_the_directory_is_empty`。

### 3.3 信号与收尾：没有 unix 专有假设

桥不用任何 unix signal。收尾是：`Shutdown`/stdin EOF → 关 `pi` 的 stdin → 5 秒宽限
（`PI_EXIT_GRACE`）→ 还没退就 `child.kill()`。`Command::kill` 在 Windows 上走
`TerminateProcess`，行为等价。`hide_console`（`CREATE_NO_WINDOW`）在 `bridge.rs` 与
`daemon.rs` 里各有一份 `cfg(windows)` 实现，Windows 上不会闪黑窗。

**未验证**：Windows 上「关 stdin 后 `pi` 是否真的自己退」这一步没有真跑过（本机 macOS 上成立）。

---

## 4. 打包：桥已经在包里，这一轮把它钉进测试

第三次真机验收（`WINDOWS-ACCEPTANCE-3.md`）已经确认：`tauri` 会把 crate 的**额外 `[[bin]]`**
（`cante-sheets` / `cante-pdf` / `cante-bridge`）装到**主程序旁边**，安装目录干净、没有
`.d`、没有 0 字节占位符。所以这一轮不改打包方式，只补**守卫**：

`gui/src/packaging.test.ts` 现在有一份 `BUNDLED_BINARIES = ["cante-sheets", "cante-pdf",
"cante-bridge"]` 清单，三条：

1. 三个都必须在 `Cargo.toml` 里是 `[[bin]]`（少一个，安装包里就没有这个文件）；
2. `bundle.resources` 里**不许**再出现 `target/release`（第一、二次真机验收的教训，
   另一个 PR 加的，原样保留）；
3. `bundle.externalBin` 不许列这三个（build script 阶段产物还没编出来，包都出不来）。

另有一条 `cante-bridge 进包，但只有 CANTE_BIN 会用到它`：断言它**不在**
`commands.rs::resolve_tool_bin` 的解析链上（混进去会让界面上的能力提示与真正的启动路径
说两套话），而 `daemon.rs` 里确实有 `CANTE_BIN` —— 这是桥现在**唯一**的入口。

> **「进包」和「程序找得到」是两件事。** 两个工具靠「与主程序同目录」被找到，桥不是：
> 它躺在安装目录里不会自己被用上，必须把 `CANTE_BIN` 指过去。要把这条缝补上（比如
> 守护进程在找不到 `cante` 时回退到同目录的 `cante-bridge.exe`）不在本轮范围内，
> 那属于 `daemon.rs`/`commands.rs`。

---

## 5. 在 Windows 上跑真实任务：精确命令清单（给那台机器）

前提：那台机器上有**原生 `pi`**（含凭据）、有安装好的 Cante、有网关可达。**不需要 WSL。**

> 命令都在**同一个 PowerShell 窗口**里跑，`CANTE_BIN` / `PI_BIN` 才传得给从该窗口启动的
> 应用。路径按实际安装位置替换；**不要**把真实用户名/网关地址贴进仓库。

**第 1 步：确认桥在安装目录里**

```powershell
Get-ChildItem $env:LOCALAPPDATA -Recurse -Filter cante-bridge.exe -ErrorAction SilentlyContinue |
  Select-Object -First 3 FullName
```

期望：至少一行 `...\Cante\cante-bridge.exe`。没有 → 包不对，先别往下走。

**第 2 步：桥自己能不能起**

```powershell
$bridge = "<第 1 步输出的完整路径>"
& $bridge --version      # 期望：cante-bridge 0.2.0
& $bridge catalog        # 期望：{"providers":[]}
```

**第 3 步：`pi` 是 `.exe` 还是 npm 的 `.cmd`（本清单的关键一步）**

```powershell
Get-Command pi | Format-List Name,Source,CommandType
& pi --version           # 期望：形如 0.85.1
```

- `Source` 以 `.exe` 结尾（例如 `~\.bun\bin\pi.exe`）→ 记下这个**完整路径**，继续。
- `Source` 以 `.cmd` / `.ps1` 结尾 → `PI_BIN` 直接指它**起不来**（§3.1）。
  记下实际值并**停下**：这一条要么换一个 `.exe` 形态的 pi，要么等我们决定是否在桥里包一层
  `cmd.exe`。**把 `Get-Command` 的原始输出贴进报告**，别看窗口在不在就下结论。

**第 4 步：让 `pi` 认识网关（凭据走 pi 自己的配置，不走 Cante）**

前端在简单模式里**不传** provider/model（`store.ts` 只传 `permission_mode`），所以桥这条路上
模型与凭据由 `pi` 自己决定，读的是 `~\.pi\agent\` 下的配置：

```powershell
Test-Path "$env:USERPROFILE\.pi\agent\models.json"   # 自建网关：provider 写在这里
Test-Path "$env:USERPROFILE\.pi\agent\auth.json"     # /login 存的密钥在这里
```

自建 OpenAI 兼容网关的最小 `models.json`（`apiKey` 也可是 env 里的名字，按 pi 的
`models.md`；**密钥不要写进仓库、不要贴进报告**）：

```json
{
  "providers": {
    "<自定义名字>": {
      "baseUrl": "https://<网关>/v1",
      "api": "openai-completions",
      "apiKey": "<密钥或占位符>",
      "models": [{ "id": "<模型名>" }]
    }
  }
}
```

先单独验一次 pi 能出话（**不要**用真实密钥文本进日志）：

```powershell
& pi -p "只回复两个字：可以"      # 期望：能打出模型回复；失败就是凭据/网关问题，不是桥的问题
```

**第 5 步：把两个变量设好，从同一个窗口启动应用**

```powershell
$env:CANTE_BIN = $bridge
$env:PI_BIN    = "<第 3 步的 .exe 完整路径>"
& "$env:LOCALAPPDATA\Cante\Cante.exe"     # 名字按实际安装位置；也可能是 cante-gui.exe
```

**第 6 步：怎么确认真的连上了（别只看窗口在不在）**

| 看什么 | 通过的标准 |
| --- | --- |
| 应用首次检查 | 走到「准备好了」，**不是**「干活需要的组件还没装好」（后者=版本探测没到位） |
| 会话 | 点开一张卡、走完确认页，**有会话起来**（不是一直转圈） |
| 流式文字 | 回答是**一个字一个字**出来的，不是最后一次性冒出来 |
| 审批 | 助手要用工具时，出现**审批页**；选「不允许」后它确实不做那件事 |
| 产出一个文件 | 挑一张只读卡（例如合并两张表），结果文件落在**原文件旁边**、资源管理器里看得到 |
| 日志 | 没有「组件没装好」、没有意外的 `cante://exit`；`pi` 的 stderr 里没有一堆非 JSON 行 |

一条卡至少留 **1800 秒**（慢模型实测 850 秒；设 600 会把成功误判成失败）。

**第 7 步：报告里必须带回来的四样**

1. 第 1–3 步的**原始输出**（尤其 `Get-Command pi` 与两个 `--version`）；
2. 第 6 步里那张「准备好了」/会话起来之后的**截图**（要看窗口需要 RDP，SSH 里没有交互桌面）；
3. 产出文件的**路径与内容**（哪怕只有一行）；
4. 这一轮 `CANTE_BIN` / `PI_BIN` 的**实际值**（网关地址与密钥擦掉）。

---

## 6. 我没验证什么

**这一节和上面的结论一样重要。**

1. **Windows 上的真跑：一条都没跑。** 本文的 Windows 侧结论全部来自**读源码 + 第三次真机
   验收的旧证据 + 本机解析测试**，没有一次是在那台机器上执行 §5 得来的。
2. **`pi` 在 Windows 上能不能被 `Command::new` 起来** —— 未知，且**很可能不能**（§3.1）。
   这是这条路上最大的未知数，也是 §5 第 3 步存在的理由。
3. **`pi` 能不能访问局域网网关 / 卡片提示词里的工具在 Windows 上还在不在** —— 探针只有
   macOS 与 Linux 结论（`PROBE-pi-rpc.md` §5.5 原文保留），Windows 上为零信息。
4. **关 stdin → `pi` 退出** 这条收尾路径在 Windows 上没跑过（§3.3）。
5. **黑窗**：`CREATE_NO_WINDOW` 两份实现都在，但**没有**在真 Windows 上盯过（第三次验收
   因为 `cante serve` 根本没起来，这条路径是零信息）。
6. **审批语义与 `cante` 是否一致**：闸门在 macOS + 假端点上成立（`BRIDGE-gate.md`），但
   「哪些调用该问」的**权限策略**两边都还没有，谈不上「一致」。
7. **桥的体积对安装包/SmartScreen 的影响** —— 只用两个平台的字节数说明它是小壳，没做
   安装包体积对比。

---

## 7. 顺手评估：要让「桥 + pi」成为 Windows 的正规路径，必须解决的三件事

（只要结论，本轮**不动手**。）

1. **`pi` 从哪来、怎么起。** 现在 `pi` 是用户/我们机器上的 npm 包，桥用 `Command::new`
   起它 —— 而 npm 在 Windows 上只落 `.cmd`，起不来（§3.1）。要成为产品路径，必须二选一：
   要么随包带一个能 `CreateProcess` 的 `.exe`（自建 shim / bun 的 shim / 换宿主分发方式），
   要么在桥里明确包一层 `cmd.exe` 并把进程树收尾（关 stdin、必要时按树杀）一并解决。
   这同时也是**许可证**问题：`pi` 的 license 还没核（`DECISION-windows-runtime.md` §7.3）。
2. **凭据与「谁来处理」的账要对上。** 简单模式的 provider/model 不走桥，凭据读的是
   `~\.pi\agent\`（`auth.json` / `models.json` / 各家 `*_API_KEY`），而产品红线要求界面
   **如实说明发给谁**。要么让应用把 provider/model/网关安全地交给 pi（并让界面的说法来自同一处），
   要么在界面上明确「模型由本机的 pi 自己配置」——**不能两边各说一套**。企业预置
   （默认网关、只许本机、禁用某些卡）也得在这条链上落地。
3. **审批语义与产品律要对齐，而不是「能弹窗」。** 闸门现在拦的是**所有** `tool_call`
   （强度=扩展覆盖率），没有 `strict`/`auto`/`yolo` 三档、没有危险命令识别、没有持久授权；
   而 `cante` 那边有一套权限语义。要当正规路径，必须回答「哪一种调用该问」「拒绝的理由
   怎么回到模型」「授权能不能落盘」，并让它与卡片提示词、结果交付共用同一套判断 ——
   否则「先问人」只是个动作，不是产品律 2 的实现。
