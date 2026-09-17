# 第二次 Windows 真机验收：#112（两个自带工具真的进包了吗）

这是接第一次验收（[WINDOWS-ACCEPTANCE-1.md](./WINDOWS-ACCEPTANCE-1.md)）的第二轮。第一次的结论是：
NSIS 与 MSI 里**各自只有** `cante-gui.exe` 与 `uninstall.exe`，没有 `cante-sheets.exe` / `cante-pdf.exe`。
这一轮的任务是：**在那台真 Windows 上出包、装一次，确认修好了**。

- 验收机器：Windows 11 Home 25H2 / build 26200.9457 / x64（真机，不是虚拟机）
- 受测分支：`fix/112-bundle-tools`（HEAD = `a404fed`）
- 关键提交：`411dfaa fix(gui): 让两个自带工具真的进 Windows 安装包（#112）`
- 出包方式：**本机编译**（Rust 1.98.1 + MSVC 14.44 + Windows SDK），`bunx tauri build --bundles nsis` 与 `--bundles msi`
- 验收人：跑在那台机器上的 pi（**SSH 会话，没有交互桌面**，限制见最后一节）
- 原始输出：`%TEMP%\cante-acc2\evidence\`（文件名与下面各节一一对应）

---

## 0. 结论先行

**#112 修好了。** 三条断言全部成立，而且都有现场证据：

1. **包里有了**：新出的 NSIS 包里含 `cante-sheets.exe`（2,512,384 字节）与 `cante-pdf.exe`（2,176,512 字节）；
   新出的 MSI 里也一样。
2. **装完在**：安装目录里同时有 `cante-gui.exe`、`cante-sheets.exe`、`cante-pdf.exe` —— 而且**两个位置都有**
   （安装根目录 + `target\release\` 子目录，见第 3 节；这正是解析器查的那两个位置）。
3. **能跑**：从安装目录直接执行 `cante-sheets.exe --version` → `cante-sheets 0.1.0`（退出码 0），
   `cante-pdf.exe --version` → `cante-pdf 0.1.0`（退出码 0）。不是空壳。

解析器那半边也过了：`cargo test --lib commands` → **29 通过 / 0 失败**，其中就包含这次新增的
`finds_a_tool_bundled_under_target_release`、`finds_a_tool_bundled_under_the_macos_resources_tree`、
`a_tool_of_the_other_platforms_name_does_not_count` 三条。

**顺带撞见一个大好消息**（第一次验收里"王姐看到英文开发者界面"那条已经不成立了）：
这个包在真 WebView2 窗口里打开就是**中文简单模式**——向导三步 + 首页 32 张任务卡（第 5 节）。
用 UI Automation 把窗口里的文字读出来，第一屏是"欢迎使用 Cante / 我帮你把表格、文件这些麻烦事做完。
原文件我不会乱动，动手前会先让你确认。"

**但有两个必须写下来的问题，都不影响上面的结论、但都值得下一轮处理**（第 6 节）：

- 安装目录里混进了 4 个垃圾文件（2 个 0 字节的无扩展名文件 + 2 个 cargo 的 `.d` 依赖清单）——
  这是这次新用的 glob 顺手扫进来的；
- 安装根目录那两个 `.exe` 是 NSIS 脚本里**另一节**（字面写着 "Copy external binaries"）装的，
  而 `tauri.conf.json` 里**并没有** `externalBin`。这一节的来源**我没有查清，不猜**。

---

## 1. 怎么出的包

```bash
cd C:\cante
git fetch origin                       # 超时 180s
git checkout fix/112-bundle-tools      # 工作区当时是干净的，不需要 stash

cd C:\cante\gui
bun install                            # 超时 600s → 17 个包，1.2 秒
timeout 3300 bunx tauri build --bundles nsis     # 前台跑，超时 3300s
timeout 900  bunx tauri build --bundles msi      # 前台跑，超时 900s
```

两次都**前台跑**（SSH 会话里后台进程会被回收，消息里已经说明），都设了超时，**都没有超时**，退出码都是 0。

| | NSIS | MSI |
| --- | --- | --- |
| 起止（UTC） | 02:22:53 → 02:26:17 | （紧接其后） |
| 编译 | `Finished release profile … in 3m 03s` | `Finished release profile … in 1m 02s` |
| 打包器 | `Running makensis`（下载 nsis-3.11） | `Running candle` + `light`（下载 wix314） |
| 退出码 | 0 | 0 |
| 日志里的 warning / error | **无** | **无** |

原始日志：`evidence/01-tauri-build.log`（320 行）、`evidence/07-tauri-build-msi.log`（27 行）。
两处 `grep -i "warning|error|failed"` 命中的只有包名里带 `thiserror` 的 `Compiling` 行，不是真警告。

---

## 2. 包里有什么（拆开看）

产物：

```
gui\src-tauri\target\release\bundle\nsis\Cante_0.1.0_x64-setup.exe
  3,461,026 字节   SHA256 c08e0457452b676a31c62d81046f18709bdd0eb898d6cd81992c6c27912c7c9f
gui\src-tauri\target\release\bundle\msi\Cante_0.1.0_x64_en-US.msi
  5,541,888 字节   SHA256 78d1735653accc81169d0ab946fd8018d874feddc1d5613c6e2378eb310389d3
```

对照第一次验收的 rc1（NSIS 1,929,671 字节）：新包大了约 1.5MB，正好是两个工具的体积。

### 2.1 NSIS（7-Zip 26.03 列出，`Type = Nsis`，`SubType = NSIS-3 Unicode`）

```
$PLUGINSDIR\System.dll                   12288
$PLUGINSDIR\modern-wizard.bmp            26494
$PLUGINSDIR\nsDialogs.dll                 9728
$PLUGINSDIR\nsis_tauri_utils.dll         34304
$PLUGINSDIR\StartMenu.dll                13316
$PLUGINSDIR\NSISdl.dll                   15360
cante-gui.exe                         10324992
target\release\cante-pdf                     0     ← 0 字节
target\release\cante-pdf.d                1614     ← cargo 依赖清单
target\release\cante-pdf.exe           2176512     ← ★ 真工具
cante-pdf.exe                          2176512     ← ★ 真工具（根目录同一份）
target\release\cante-sheets                  0     ← 0 字节
target\release\cante-sheets.d             1620     ← cargo 依赖清单
target\release\cante-sheets.exe        2512384     ← ★ 真工具
cante-sheets.exe                       2512384     ← ★ 真工具（根目录同一份）
uninstall.exe                            79156
```

**两个工具都在**，而且出现在两个位置。这不是偶然，生成出来的 NSIS 脚本写得很清楚
（`target\release\nsis\x64\installer.nsi` 第 641-651 行，原样引用）：

```nsis
  ; Copy resources
    CreateDirectory "$INSTDIR\target\release"
    File /a "/oname=target\release\cante-pdf" "…\target\release\cante-pdf"
    File /a "/oname=target\release\cante-pdf.d" "…\target\release\cante-pdf.d"
    File /a "/oname=target\release\cante-pdf.exe" "…\target\release\cante-pdf.exe"
    File /a "/oname=target\release\cante-sheets" "…\target\release\cante-sheets"
    File /a "/oname=target\release\cante-sheets.d" "…\target\release\cante-sheets.d"
    File /a "/oname=target\release\cante-sheets.exe" "…\target\release\cante-sheets.exe"

  ; Copy external binaries
    File /a "/oname=cante-pdf.exe" "…\target\release\cante-pdf.exe"
    File /a "/oname=cante-sheets.exe" "…\target\release\cante-sheets.exe"
```

也就是说：

- **`resources` 用数组 + glob 时，落点保留目录结构** → `$INSTDIR\target\release\<名字>`。
  任务里让我"顺序也要看一眼"的这一点，确认成立：**确实是 `target\release\` 子目录**。
- 同时，NSIS 模板还有一节 "Copy external binaries"，把两个 `.exe` 又放在**安装根目录**。
  好消息是解析器两个位置都查（`commands.rs` 里 `dir.join(bin_name)` 与 `dir/target/release/bin_name`），
  所以无论用户从哪一份调，都能找到。
- 卸载脚本也对称地删了这 8 条路径（`installer.nsi` 第 768-777 行），不会留垃圾。

### 2.2 MSI

`msiexec /a`（管理安装，只解包不注册）解出来的真实文件名 —— 7-Zip 在 MSI 里只能看到
`Path` / `PathFile_<hash>` / `Bin_cante_pdf` 这种短名，所以必须用这一步：

```
/Cante_0.1.0_x64_en-US.msi                       (311296)
/PFiles/Cante/cante-gui.exe                     (10324992)
/PFiles/Cante/cante-pdf.exe                      (2176512)   ← ★
/PFiles/Cante/cante-sheets.exe                   (2512384)   ← ★
/PFiles/Cante/target/release/cante-pdf                 (0)   ← 0 字节
/PFiles/Cante/target/release/cante-pdf.d            (1614)   ← cargo 依赖清单
/PFiles/Cante/target/release/cante-pdf.exe       (2176512)
/PFiles/Cante/target/release/cante-sheets              (0)   ← 0 字节
/PFiles/Cante/target/release/cante-sheets.d         (1620)   ← cargo 依赖清单
/PFiles/Cante/target/release/cante-sheets.exe    (2512384)
msiexec /a ExitCode = 0
```

**MSI 也修好了**，而且混进去的 4 个垃圾文件与 NSIS 完全一样（同一个 glob，同一批文件）。

---

## 3. 装完有什么（安装目录原样清单）

先把第一次装的 rc1 静默卸掉（`uninstall.exe /S` → 退出码 0，安装目录已不存在），再装新包。
这样看到的清单一尘不染，不会把两代产物混在一起。

```
setup     = gui\src-tauri\target\release\bundle\nsis\Cante_0.1.0_x64-setup.exe
install ExitCode = 0
```

安装目录 `C:\Users\<用户名>\AppData\Local\Cante`（`Get-ChildItem -Recurse -Force` 原样）：

```
DIR  \target
DIR  \target\release
  10324992  \cante-gui.exe
   2176512  \cante-pdf.exe              ← ★
   2512384  \cante-sheets.exe           ← ★
     79156  \uninstall.exe
         0  \target\release\cante-pdf
      1614  \target\release\cante-pdf.d
   2176512  \target\release\cante-pdf.exe
         0  \target\release\cante-sheets
      1620  \target\release\cante-sheets.d
   2512384  \target\release\cante-sheets.exe

合计：19,785,174 字节 / 10 个文件
```

**不是只看"文件在"**——直接跑它们，确认是真二进制：

```
$ .\cante-sheets.exe --version     →  cante-sheets 0.1.0      exit=0
$ .\cante-pdf.exe --version        →  cante-pdf 0.1.0         exit=0
$ .\target\release\cante-sheets.exe --version  →  cante-sheets 0.1.0   exit=0
$ .\target\release\cante-pdf.exe --version     →  cante-pdf 0.1.0      exit=0
```

那 4 个 0 字节 / `.d` 文件跑不了（0 字节当然跑不了），它们是第 6.1 节要说的垃圾。

---

## 4. 解析器测试结果

```bash
cd C:\cante\gui\src-tauri
timeout 2400 cargo test --lib commands        # 超时 2400s，实际 8 秒，退出码 0
```

```
running 29 tests
…
test commands::tests::finds_a_tool_bundled_under_target_release ... ok
test commands::tests::finds_a_tool_bundled_under_the_macos_resources_tree ... ok
test commands::tests::a_tool_of_the_other_platforms_name_does_not_count ... ok
…

test result: ok. 29 passed; 0 failed; 0 ignored; 0 measured; 45 filtered out; finished in 0.03s
```

**29 通过 / 0 失败**，三条新测试都在里面（原始输出 `evidence/02-cargo-test-commands.log`）。

跑之前 PATH 里把**官方 bun.exe**（`C:\Users\<用户名>\tools\bun`）放在最前面，避免 npm 那份没有 `.exe` 的
bun 让测试红——消息里提到的坑，这次没有踩到。

**现场文件和代码路径是对得上的**（`commands.rs`）：

- 工具名是平台相关的：`SHEET_BIN_NAME = if cfg!(windows) { "cante-sheets.exe" } else { "cante-sheets" }`（第 16 行）；
- 解析顺序里第一条就是"与可执行文件同目录"：`existing(dir.join(bin_name))`（第 75 行附近），
  而 `C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe` 确实存在；
- 第二条新增的是 `dir/target/release/<名字>`，现场也有。

所以 `sheet_capability()` / `tool_capabilities()` 在这台机器上会报**可用**：
第一条就命中了，根本走不到"这台电脑还没有表格读写工具。"那句兜底文案。

（严格说：**这句"会报可用"是我根据"现场文件 + 解析顺序"推出来的，不是在屏幕上看到的一句话**——
原因见第 7 节。想要屏幕上的一句话，得等守护进程那件事解决，因为向导第二步先卡在"缺组件"上。）

---

## 5. 顺带撞见：这个包打开就是中文简单界面

第一次验收最刺眼的一条是"窗口里是英文开发者界面"。那个包（rc1）比"简单模式成为唯一界面"早一轮，
当时我没法验证新包。这次能了：装完之后启动它，用 UI Automation 把窗口里的文字读出来。

**第一屏（向导第 1 步）**：

```
Button | 历史
Button | 隐私
List | 进度
  ListItem | 1欢迎
  ListItem | 2检查电脑
  ListItem | 3开始使用
Text | 欢迎使用 Cante
Text | 我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先花十秒钟检查一下你的电脑，好吗？
Button | 开始检查
```

**点"开始检查"之后（第 2 步）** —— 守护进程那件事现在的说法（中文、有人话、有出路）：

```
Text | 检查你的电脑
Text | 这台电脑还缺一个必须的组件
Text | 这台电脑上还没有装好 Cante 需要的那个组件。
Text | 这不是网络问题，也不是你操作错了，是这台电脑少了一个真正干活的组件。装好它，任务才能跑起来。
Text | 请让帮你配置这台电脑的技术同事装一次 Cante 的组件，装好后点「重新检查」。
Button | 复制详情（给技术同事看）
Button | 重新检查
Button | 先看看界面
```

**点"先看看界面" → "开始使用" 之后（首页）**：中文首页 + **32 张任务卡**，
表格 15 张 / 文件 7 张 / 微信 5 张 / 文书 4 张 / 资料 1 张，加一个"直接说一句话"的输入框。
例如：

```
Text | 你好，需要我帮你做什么？
Text | 点一张卡片，或者直接在下面说一句话。
Text | 表格 / 合并、拆分、汇总、去重
Button | 把几张表合成一张（自动去掉重复行）…
Button | 把照片或截图里的表格变成 Excel。把这张表的照片变成 Excel，看不清的地方空着，别猜
Text | 微信 / 整理聊天记录、写草稿（绝不自动发送）
```

**怎么"点"的**：SSH 会话里没有鼠标，我用 UI Automation 的 `InvokePattern.Invoke()` 直接触发按钮
（原始输出 `evidence/03-window-text.txt`、`04-click-check.txt`、`06-click-home-screen.txt`）。
这不是真的鼠标点击，见第 7 节。

**这条对 #112 的意义**：功能是"做完了"，但#112 修的是"工具能不能到用户手上"。
现在能看到的是——**工具在安装目录里、能跑；而界面这一侧，用户拿到的是一个说得清楚的中文向导**。

---

## 6. 两个必须写下来的问题（都超出 #112 本身，都没有改任何代码）

### 6.1 安装目录里混进了 4 个垃圾文件（glob 扫得太宽）

现场（第 3 节清单）里这 4 个不是我们想装的东西：

| 文件 | 大小 | 是什么 |
| --- | --- | --- |
| `target\release\cante-pdf` | 0 | 0 字节占位符 |
| `target\release\cante-sheets` | 0 | 0 字节占位符 |
| `target\release\cante-pdf.d` | 1,614 | cargo 的依赖清单 |
| `target\release\cante-sheets.d` | 1,620 | cargo 的依赖清单 |

**0 字节那两个的来源查清了**：`gui/src-tauri/build.rs` 里 `seed_placeholder()` 会在编译前
往 `target/release/<名字>` 里写一个**空文件**，理由是"`tauri-build` 校验 `bundle.resources` 时路径必须存在"。
它在 macOS 上会被真正的二进制覆盖，**但在 Windows 上不会**——因为 Windows 的产物叫
`cante-sheets.exe`，名字对不上，那个空文件就一直留在原地（现场时间戳可以看出来：
`cante-sheets` 是 10:23 创建的、`cante-sheets.exe` 是 11:26 编译的）。

**`.`d` 那两个的来源也查清了**：它们是 cargo 给每个 `[[bin]]` 写的 dep-info 文件
（内容就是那一长串源文件路径），只要编译过就一定有——**所以这不是我这台机器的偶然，
是每个 Windows 包里都会带上它们**。

**这事严重吗？** 不严重，三条理由：① 解析器找的是 `.exe`，不会被那个 0 字节的空文件骗到——
新增的测试 `a_tool_of_the_other_platforms_name_does_not_count` 正是钉这一点；② 卸载脚本会删掉它们；
③ 一共多占约 3.2KB。但它是"配置和实现没对齐"的又一个实例，而且**静默**（打包不会报错）。

**可能的方向**（我没改代码，只是记下来）：

- 占位符按平台命名（Windows 用 `cante-sheets.exe`），那样真二进制会覆盖它，0 字节文件就不会留下；
- 或者 `resources` 不写通配，两个名字都显式列出来（`…/cante-sheets` 与 `…/cante-sheets.exe`），
  但这样"另一个平台上会静默漏打包"的老毛病要靠 `packaging.test.ts` 那条 glob 断言继续挡着；
- `.d` 要挡住，通配就得排除它（显式列名是最省事的）。

**macOS 那一半我没验证**：这台机器出不了 dmg（不能交叉打包），所以"macOS 包里会不会也带
`cante-sheets.d`"我**没有确认**。按同一套 glob 逻辑推，会。**这是推理，不是验证。**

### 6.2 安装根目录那两个 `.exe` 是另一节装的，来源没查清

`tauri.conf.json` 的 `bundle` 里**只有** `resources`（两个 glob），**没有** `externalBin`，
仓库里也没有平台覆盖文件（`tauri.windows.conf.json` 之类）、`grep -rn externalBin` 只命中
`node_modules` 里的 schema。但生成出来的 NSIS 脚本里确实有一节写着 `; Copy external binaries`，
把两个 `.exe` 装到了安装根目录（第 2.1 节引的原文）。

看起来像 tauri-cli 从 crate 的额外 `[[bin]]` 目标自动推导出来的，**但我没有验证这个机制**，
所以不写成结论。**这条不影响 #112 的验收结果**（工具在不在、能不能跑都验过了），
只是提醒：**安装目录里的文件有两个来源**，以后改资源布局时要两边都看。

（另外记一笔，避免下次重复困惑：`bunx tauri build` 会重写
`gui/src-tauri/gen/schemas/windows-schema.json`（这次 +341 行，是 opener 插件的权限 schema）。
**这是构建产物，我没有提交**，收尾时已经还原。）

---

## 7. 我没能验证什么

**这一节和结论一样重要。** 下面每一条都是"没验证"，不是"通过"。

1. **`sheet_capability()` 在屏幕上报什么，我没看到。**
   原因不是工具的问题，而是**顺序问题**：向导第二步"检查电脑"先卡在"缺组件（守护进程）"上，
   界面根本没走到能报"表格工具可用/不可用"的那一步。
   我验证的是它的**前置条件**：解析器第一条就查"与可执行文件同目录"，而那个文件确实在、能跑（第 3、4 节）。
   **"推出来的可用"和"屏幕上看到的可用"是两回事**，这里只有前者。
2. **没有用真鼠标点击，也没有人眼看着窗口。**
   我是 SSH 会话（控制台上没有登录用户），点按钮是用 UI Automation 的 `Invoke()` 触发的，
   截图是 `PrintWindow` 抓的。所以**字体、字号、中文排版、emoji 回退、有没有闪黑窗、
   有没有卡顿**，一条都没验证。**16GB 无独显画像机的手感**同样没验证（这台机器不是画像机）。
3. **SmartScreen / 杀软的第一印象没有验证。**
   这次装的是**本机编译出来的包**，不是从浏览器下载的：没有 Mark of the Web，而且静默安装（`/S`）
   本身就绕过了"资源管理器双击"那个动作。**"确认没有拦截"和"没有触发"要分开看**：
   这次是**没有触发**，不是"确认没有"。（第一次验收里记过：rc1 与这次的三个二进制都未签名。）
4. **macOS 那一半没验证。** 这台机器出不了 dmg，所以"glob 在 macOS 上也能同时匹配无扩展名的产物"
   这条**只有 CI/macOS 机器能证**。整个 `packaging.test.ts` 里关于 glob 的断言是在
   macOS 上写的，我这次**只跑了 `cargo test --lib commands` 那 29 条**，没有跑完整 e2e。
5. **完整的 Rust 测试套件没跑。** 按要求只跑了 `cargo test --lib commands`（29 条）。
   `cargo test` 全量、`-D warnings`、`bun test src`、`tsc` 这些**这次都没跑**——它们属于 CI 的门禁，
   不在这件任务的范围内。（第一次验收时前端那半是绿的。）
6. **没有走完整任务。** 选一张卡 → 选文件（中文/带空格路径）→ 出结果 → 点「打开所在文件夹」，
   这条链路依然没走：需要守护进程 + 真鼠标，两样都没有。
7. **"超时"与"确认没有"**：这次所有长命令都设了超时（出包 3300s / 900s、cargo test 2400s、
   `bun install` 600s、`git fetch` 180s），**一次都没有超时**。第 6.1 节的 `.d` 文件是我在安装目录里
   **实际看到**的，不是"没找到"。

---

## 附：这次动过的东西

| 文件 | 动作 |
| --- | --- |
| `gui/WINDOWS-ACCEPTANCE-2.md` | 新增（本文件） |

**产品代码、配置、测试、`AGENTS.md`：一个字节都没改。** 这次是纯验收。
构建顺手改写的 `gui/src-tauri/gen/schemas/windows-schema.json` 已还原，没有提交。

原始输出（在那台机器的 `%TEMP%\cante-acc2\evidence\`）：

```
01-tauri-build.log            出 NSIS 包的完整输出（320 行）
02-cargo-test-commands.log    cargo test --lib commands
03-window-text.txt            装好后第一次读窗口
04-click-check.txt            点「开始检查」前后的界面
05-click-home.txt             点「先看看界面」前后
06-click-home-screen.txt      一路点到首页（32 张卡）
07-tauri-build-msi.log        出 MSI 包的输出
08-msi-admin.log              msiexec /a 的日志
```
