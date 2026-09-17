# 第三次 Windows 真机验收：把 glob 扫进安装包的垃圾清掉

承接第二次验收（[WINDOWS-ACCEPTANCE-2.md](./WINDOWS-ACCEPTANCE-2.md)）。那一轮的结论是 #112 修好了
（两个工具确实进包了），但**顺带发现**：`bundle.resources` 用 glob 之后，把 `target/release/` 里
别的东西一起扫进了安装包 —— 2 个 0 字节的无扩展名占位符 + 2 个 cargo 的 `.d` 依赖清单。

这一轮的任务：**换个打包方式，让安装目录只剩该有的 `.exe`，并在真机上复验。**

- 验收机器：Windows 11 Home 25H2 / build 26200.9457 / x64（真机）
- 起始提交：`main` = `1ef87b2`（这一轮从**最新 main** 起，不是旧分支）
- 工作分支：`ws/win11-bundle-clean`
- 出包方式：本机编译（Rust 1.98.1 + MSVC 14.44 + Windows SDK）
- 验收人：跑在那台机器上的 pi（**SSH 会话，没有交互桌面**，限制见最后一节）
- 原始输出：`%TEMP%\cante-acc3\evidence\`（文件名与各节一一对应）

---

## 0. 结论先行：干净了吗

**干净了。** 装完的安装目录**只有 5 个文件、没有 `.d`、没有 0 字节文件**：

```
    603648  \cante-bridge.exe
  10337792  \cante-gui.exe
   2179072  \cante-pdf.exe
   2511872  \cante-sheets.exe
     79142  \uninstall.exe
--- 5 个文件 / 15,711,526 字节
--- 0 字节文件：0
--- .d 文件：0
```

三个自带工具都在**主程序旁边**（Windows 的安装根目录），而且都能跑：

```
cante-sheets --version  →  cante-sheets 0.2.0   exit=0
cante-pdf    --version  →  cante-pdf 0.2.0      exit=0
cante-bridge --version  →  cante-bridge 0.2.0   exit=0
```

**但做法和任务里设想的不一样**，这点必须先说清楚：

| 方案 | 结果 |
| --- | --- |
| ① 原样（glob 写在 `bundle.resources` 里） | 工具进包了，但**带进来 4 个垃圾文件**（第二次验收的发现） |
| ② `bundle.externalBin`（任务建议的） | **包都出不来**：真机上硬报错 `resource path target\release\cante-sheets-x86_64-pc-windows-msvc.exe doesn't exist` |
| ③ **本轮的最终做法：配置里根本不声明** | tauri 自己会把 crate 的额外 `[[bin]]`（`cante-sheets` / `cante-pdf` / `cante-bridge`）当辅助程序装到**主程序旁边** —— 干净、且正好是解析器的第一条候选 |

也就是说：`externalBin` 这条官方路**在真机上走不通**（原因见第 4 节，是"编译顺序"决定的，不是配错了），
而"什么都不声明"反而得到最干净的结果。这个行为我是**观察到的**（生成出来的 NSIS 脚本 + 装完的目录），
**没有找到它的文档**，所以在第 6 节把它当作"这次成立的观察"写下来，不当成"tauri 保证如此"。

---

## 1. 怎么出的包

```bash
cd C:\cante
git fetch origin                                  # 超时 240s
git checkout -b ws/win11-bundle-clean main        # 超时 120s 的 pull，从最新 main 起

cd C:\cante\gui
timeout 600  bun install                          # 超时 600s → 「no changes」，36 毫秒
timeout 3300 bunx tauri build --bundles nsis      # 前台跑，超时 3300s
```

**所有长命令都前台跑、都设了超时，一次都没有超时。**

### 1.1 中途真的失败过一次（`externalBin`）

按任务先把配置改成 `externalBin`，本机出包**直接失败**（`evidence/01-tauri-build-nsis.log`）：

```
   Compiling cante-gui v0.2.0 (C:\cante\gui\src-tauri)
error: failed to run custom build command for `cante-gui v0.2.0 (…\gui\src-tauri)`
Caused by:
  process didn't exit successfully: `…\build-script-build` (exit code: 1)
  --- stdout
  …
  cargo:rustc-env=TAURI_ENV_TARGET_TRIPLE=x86_64-pc-windows-msvc
  resource path `target\release\cante-sheets-x86_64-pc-windows-msvc.exe` doesn't exist
```

也就是说 tauri 把 `externalBin: ["target/release/cante-sheets"]` 解释成
**`target/release/cante-sheets-<target-triple>.exe`**。这个校验发生在 **build script** 里
（`tauri-build`），而 crate 自己的 `[[bin]]` 是在同一次 cargo 调用里**稍后**才编译出来的 ——
所以那个文件在校验时**永远不可能**存在。要让它成立，得先单独编译、再按三元组改名，
也就是额外加一个"打包前"的脚本步骤。任务说过"行不通就不要硬凑"，所以我没有加那一步
（两条路的差别见第 4 节）。

### 1.2 最终出包成功

把 `externalBin` 也去掉（配置里对这两个工具**不做任何声明**）之后再出包：

```
     Running makensis to produce …\bundle\nsis\Cante_0.2.0_x64-setup.exe
    Finished 1 bundle at:  …\Cante_0.2.0_x64-setup.exe
```

退出码 0，日志里**没有 warning**（`evidence/02-experiment-no-declaration.log`）。

产物：

```
gui\src-tauri\target\release\bundle\nsis\Cante_0.2.0_x64-setup.exe
  3,536,610 字节   SHA256 058f3df0acb32269ebd6d2a2e92ceaa0c59460af34ad9894e6f3bb3bb351d599
```

> 说明：`bundle\nsis\` 里还躺着上一轮留下的 `Cante_0.1.0_x64-setup.exe`，容易看错版本，
> 我把它删了再看。这一轮**只出了 NSIS**（任务说 NSIS 更快），MSI 这一轮没有出（见第 7 节）。

---

## 2. 包里有什么

`7z l` 的完整清单（`evidence/06-package-listing.txt`）：

```
$PLUGINSDIR\System.dll            12288
$PLUGINSDIR\modern-wizard.bmp     26494
$PLUGINSDIR\nsDialogs.dll          9728
$PLUGINSDIR\nsis_tauri_utils.dll  34304
$PLUGINSDIR\StartMenu.dll         13316
$PLUGINSDIR\NSISdl.dll            15360
cante-gui.exe                  10337792
cante-bridge.exe                 603648
cante-pdf.exe                   2179072
cante-sheets.exe                2511872
uninstall.exe
```

`$PLUGINSDIR` 那六条是 NSIS 自己的插件与向导图，不是我们的东西。
**除它们之外，包里就只有 4 个 `.exe` + 卸载器 —— 没有 `.d`、没有 0 字节文件、没有 `target\` 子目录。**

这不是"我挑着看的"，是 `7z` 的全部输出，一条没漏。

---

## 3. 装完的目录清单（原样、完整）

先把上一轮装的静默卸掉（干净起点），再装新包：

```
uninstall ExitCode = 0
卸载后安装目录存在 = False
install    ExitCode = 0
```

`C:\Users\<用户名>\AppData\Local\Cante`（`Get-ChildItem -Recurse -Force`，原样全列）：

```
    603648  \cante-bridge.exe
  10337792  \cante-gui.exe
   2179072  \cante-pdf.exe
   2511872  \cante-sheets.exe
     79142  \uninstall.exe
--- 5 个文件 / 15,711,526 字节
--- 0 字节文件：0
--- .d 文件：0
```

（`evidence/07-install-dir.txt`。递归列出来的就是这 5 条，没有子目录。）

和上一轮（glob 那版）的对比：

| | 第二轮（glob） | 这一轮 |
| --- | --- | --- |
| 安装目录文件数 | 10 | **5** |
| 字节数 | 19,785,174 | **15,711,526** |
| 0 字节的无扩展名文件 | 2 | **0** |
| cargo 的 `.d` | 2 | **0** |
| 工具放了几份 | 两份（根目录 + `target\release\`） | **一份（主程序旁边）** |

省下来的 ~4.1MB 主要就是那两份重复的工具副本。

**三个工具都真的能跑**（从安装目录直接执行）：

```
$ .\cante-sheets.exe --version   →  cante-sheets 0.2.0    exit=0
$ .\cante-pdf.exe    --version   →  cante-pdf 0.2.0       exit=0
$ .\cante-bridge.exe --version   →  cante-bridge 0.2.0    exit=0
```

---

## 4. externalBin 与 glob 的差别（以及为什么最后两条都没用）

### 4.1 三条路摆在一起

| | **glob + `resources`**（第二轮） | **`externalBin`**（任务建议） | **不声明**（本轮采用） |
| --- | --- | --- | --- |
| 配置长什么样 | `"resources": ["target/release/cante-sheets*", …]` | `"externalBin": ["target/release/cante-sheets", …]` | 两个键都不写 |
| 装到哪 | `$INSTDIR\target\release\<名字>`（保留目录结构） | 主程序旁边（`Contents/MacOS` / 安装根目录） | 主程序旁边（同左） |
| Windows 上包得出来吗 | 能 | **不能**（见 1.1 的硬报错） | 能 |
| 会带进垃圾吗 | **会**（`.d` + build.rs 的 0 字节占位符，实测 4 个文件） | 不会（但先得能包出来） | **不会**（实测 0 个） |
| 解析器怎么找到 | 靠 `commands.rs` 里那条 `target/release` 候选 | 靠第一条候选（同目录） | 靠第一条候选（同目录） |
| 额外要加东西吗 | 不要 | **要**：加一步"先编译、再按 target triple 改名"的打包前脚本 | 不要 |

### 4.2 为什么 glob 会带进垃圾（第二轮已经查清，这里一句话重复）

`target/release/` 那个目录里除了真二进制，还躺着：`build.rs` 为了让 `tauri-build` 的资源校验
通过而写的 **0 字节同名占位符**（Windows 上真产物叫 `.exe`，名字对不上，占位符永远不会被覆盖），
以及 cargo 给每个 `[[bin]]` 写的 **`.d` 依赖清单**。glob 一匹配，"这两个是"的判据就只有文件名前缀。

### 4.3 `externalBin` 为什么不行（这是这次新查清的）

- 它要求文件叫 `<配置里写的名字>-<target-triple>[.exe]` —— 真机上的原始报错就是
  `target\release\cante-sheets-x86_64-pc-windows-msvc.exe`；
- 这个校验在 **build script** 阶段（`tauri-build`）就做了，而 crate 自己的 `[[bin]]`
  要到同一次 cargo 调用的**后面**才编译出来 → 顺序上不可能满足；
- 让它成立要额外做"先 `cargo build --bin …`、再复制成带三元组的名字、然后才开始打包"，
  多一个脚本、多一次编译、还要在两个平台上都对。**代价大于收益**，所以按任务的指示没有硬凑。

### 4.4 最后为什么选"不声明"

把 `resources` 删掉、也不写 `externalBin` 之后，生成出来的 NSIS 脚本里出现了这样一节
（`gui\src-tauri\target\release\nsis\x64\installer.nsi`，原样引用）：

```nsis
  ; Copy resources

  ; Copy external binaries
    File /a "/oname=cante-bridge.exe" "…\target\release\cante-bridge.exe"
    File /a "/oname=cante-pdf.exe"    "…\target\release\cante-pdf.exe"
    File /a "/oname=cante-sheets.exe" "…\target\release\cante-sheets.exe"
```

也就是说：**我们什么都没声明，tauri 还是把 crate 里"主程序之外的那些 `[[bin]]`"当成了辅助程序**
（"Copy external binaries" 那一节），按平台补上 `.exe`，装到**主程序旁边**。
这正好是 `commands.rs::resolve_tool_bin` 的**第一条**候选（`dir.join(bin_name)`），
所以工具既装得进、也找得到。

（顺带解释了上一轮那个"我没查清"的疑问：第二轮生成的脚本里同样有这一节，而那轮配置里也没有
`externalBin`。来源就是这里，不是 `resources`。）

**风险要说清楚**：这条行为**我没找到文档**，也没读 tauri-cli 的实现。它可靠不可靠，
目前只有"真机上确实这么干"这一条证据。所以：

- 我把"工具必须在 `Cargo.toml` 里是 `[[bin]]`"和"不许再把编译产物目录交给 `resources`"
  写成了测试（第 5 节），**这样它至少不会无声无息地退回去**；
- 但万一哪天 tauri 不再这么做，症状仍然是"安装包里少了工具"（就是 #112 那一类），
  **只有真机验收会先发现**。这条我写进报告，不当成已解决。

---

## 5. 改了什么、测试结果

### 5.1 改动（两个文件）

**`gui/src-tauri/tauri.conf.json`**：删掉

```json
"resources": [
  "target/release/cante-sheets*",
  "target/release/cante-pdf*"
],
```

（`externalBin` 试过一次、失败后也去掉了，所以最终这两个键都不存在。）

**`gui/src/packaging.test.ts`**：把原来那两条"resources 里必须是 glob 或两种文件名"的断言换掉，
新的三条：

1. `多个 binary 时必须声明 default-run…` —— **没动**（原来就有的守卫）；
2. `两个自带工具必须在 Cargo.toml 里是 [[bin]]，且不许再写进 bundle.resources`：
   - 工具必须在 `Cargo.toml` 里有 `[[bin]]`（这才是"装到主程序旁边"的依据）；
   - `bundle.resources` 里**不许出现 `target/release`**（注意不是只查工具名：
     `target/release/*` 这种宽 glob 一样会把垃圾扫进去，而它并不含 `cante-sheets` 字面量）；
   - `bundle.externalBin` 里也不许列这两个工具（并附上真机报错的原因）；
3. `解析器必须先在主程序旁边找工具，打包方式也要把工具放在那里`：
   读 `commands.rs`，断言 `resolve_tool_bin` 的候选里 **`dir.join(bin_name)` 存在、
   且在 `join("release")` 之前** —— 把"打包落点"和"解析顺序"钉在一起。

**这条测试不是空的**：我把 glob 临时加回配置，测试**立刻变红**，失败信息指名要改哪里：

```
error: bundle.resources 里不该再有 "target/release/cante-sheets*"：tauri 用数组形式会保留
目录结构，而 target/release 里躺着 cargo 的 .d 与 build.rs 的 0 字节占位符 —— 上一轮它们
就是这么被 glob 扫进安装包的（真机验收 2 的证据）。工具走 crate 的额外 [[bin]]，tauri 会把
它们装到主程序旁边。
(fail) 两个自带工具必须在 Cargo.toml 里是 [[bin]]，且不许再写进 bundle.resources
```

（验完把配置恢复原样。）

### 5.2 测试结果

| 命令 | 结果 |
| --- | --- |
| `bun test src` | **605 通过 / 0 失败**（2.9 秒） |
| `bunx tsc --noEmit` | 干净（无输出） |
| `cargo test --lib commands` | **29 通过 / 0 失败**（含"能不能在同目录/`target/release` 找到工具"那几条） |
| 出 NSIS 包 | 退出码 0，无 warning |
| 带 glob 的负向检查 | 3 个测试里 1 个红，信息如上 |

**没跑**：`bash gui/scripts/e2e.sh` 的第 6 步（整仓 `cargo test`）与 MSI 打包 ——
这次是"按任务范围内跑"，完整门禁交给 CI（PR 上会跑）。

---

## 6. 顺带发现：`cante-bridge.exe` 装进去了，但没人会认这个名字

这个包里有第三个工具 `cante-bridge.exe`（#116 加的、用来顶替 `cante serve` 的桥）。
它和另外两个一样被装到了主程序旁边 —— 但**守护进程的解析不认这个名字**：

- 解析器找的是 `cante` / `cante.exe`（`gui/src-tauri/src/commands.rs`：
  `const DAEMON_BIN_NAME: &str = "cante";`、`const DAEMON_BIN_NAME_EXE: &str = "cante.exe";`，
  以及 `existing_daemon()` 里那两个 `dir.join(...)`）；
- 现在按 `CANTE_BIN` 指过去的用法写在 `gui/docs/BRIDGE-spike.md`
  （"把 `CANTE_BIN` 指到 `cante-bridge`"）。

所以：**它躺在安装目录里，但不会自己被用上**；用户那边的"检查电脑"还是照旧要靠环境变量，
才算有这个组件。这**不是**这次任务要改的东西（也不在改动范围内），我把它记下来是因为它和
这一轮清的是同一类问题 —— **"装进包里"和"程序找得到"是两件事**，而 #112 与这次都是栽在这条缝里。

（这条我只做到"读源码 + 看安装目录"，**没有**在界面上验证"检查电脑"现在报什么：
向导因为档案里记着"已完成"被跳过了，见第 7 节。）

---

## 7. 我没能验证什么

**照旧：这一节和上面的结论一样重要。**

1. **界面上"工具可用"那句话，还是没看到。**
   第二次验收时想验、这次仍然没验成：向导第二屏「检查电脑」说的是**守护进程**（不是这两个工具），
   而这次启动时 WebView2 档案里记着向导已完成、直接进了首页；点一张表格卡进到第 1 步「选文件」，
   那一屏没有能力提示（能力提示在后面的「确认」页，而要点到那一步得先真的选一个文件）。
   我验的仍然是**前置条件**：文件就在主程序旁边（`<安装目录>\cante-sheets.exe`），
   解析器第一条候选就是"同目录"，三个 `.exe` 也都能跑出 `0.2.0`。
   **"推出来的可用"和"屏幕上看到的可用"仍然是两回事。**
2. **真鼠标、真观感、闪黑窗。** SSH 会话没有交互桌面；点按钮是用 UI Automation 的 `Invoke()`。
   字体、排版、中文输入、有没有黑窗一闪、画像机手感，一条都没验。
3. **SmartScreen。** 这次装的是**本机编译**的包：没有 Mark of the Web，而且用的是静默安装（`/S`）。
   所以是**没有触发**，不是"确认没有"。
4. **macOS / Linux 那一半。** 出不了 dmg。这次的做法依赖"tauri 把额外 `[[bin]]` 装到主程序旁边"，
   这个行为我**只在 Windows 上验过**；macOS 的 `.app` 里到底落在 `Contents/MacOS/` 还是别处、
   `../Resources/` 那条解析候选还有没有用，**没有验证**。
5. **MSI。** 这一轮只出了 NSIS（任务说 NSIS 更快）。**MSI 里现在长什么样，没有验证。**
6. **完整门禁。** 整仓 `cargo test`、`-D warnings`、e2e 全流程没在本机跑（只跑了上面表里那几条）；
   交给 CI。**CI 结果见 PR 上的评论**（这一轮 PR 会触发 workflow）。
7. **"超时"与"确认没有"分开写**：这次所有长命令（`git fetch` 240s、`git pull` 120s、
   `bun install` 600s、`tauri build` 3300s、`cargo test` 2400s）**一次都没有超时**；
   第 3 节里"0 字节文件：0、`.d` 文件：0"是**递归列目录后统计出来的**（**确认没有**），
   不是"没找到"。

---

## 附：这次动过的东西

| 文件 | 动作 |
| --- | --- |
| `gui/src-tauri/tauri.conf.json` | 删掉 `bundle.resources` 那两条 glob（`externalBin` 试过后也去掉了） |
| `gui/src/packaging.test.ts` | 换掉两条与 resources/glob 绑定的断言，新增三条（见 5.1） |
| `gui/WINDOWS-ACCEPTANCE-3.md` | 新增（本文件） |

产品代码（`gui/src/**`、`gui/src-tauri/src/**`）、`AGENTS.md` **一个字节都没改**。
构建顺手改写的 `gui/src-tauri/gen/schemas/windows-schema.json` 已还原，没有提交。

原始输出（在那台机器的 `%TEMP%\cante-acc3\evidence\`）：

```
01-tauri-build-nsis.log              externalBin 那次失败的完整输出（含硬报错原文）
02-experiment-no-declaration.log     最终成功那次的输出
03-cargo-test-lib-commands.log       cargo test --lib commands
04-app-probe.txt                     装完后读窗口（首页 32 张卡）
05-click-sheet-card.txt              点一张表格卡 → 第 1 步「选文件」
06-package-listing.txt               7z 列出 NSIS 包内容（完整）
07-install-dir.txt                   安装目录递归清单 + 0 字节/.d 统计
```
