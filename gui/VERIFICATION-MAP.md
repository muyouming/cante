# 验证地图：**哪条验证在哪台机器上跑、拿什么当证据**

这张表的存在理由（`AGENTS.md` §3.6 与目标里的"两端都要有证据"）：
**"已验证"必须能回答"在哪台机器上、看的是什么产物"** ✗✓。表里每一行都指到**可执行的脚本**或**具体的记录文件** ✓，
不写"应该没问题" ✗。

## 一、本机（macOS，开发者机器）

| 验证 | 怎么跑 | 看什么当证据 | 什么**不**覆盖 ✗ |
| --- | --- | --- | --- |
| **完整本地门禁（8 步）** | `bash gui/scripts/e2e.sh` | 每步的原始输出；任一步红即停 | 真 Windows 才能验的东西（见第二节）✗ |
| 秘密扫描（第 1 步） | `bash gui/scripts/secret-scan.sh` | 命中的 `文件:行` + 它打印的原因 ✓ | 未跟踪文件（扫描只扫 `git ls-files` 里的 ✓）|
| 许可清单是否过期（第 3 步） | `bash gui/scripts/license-inventory.sh --check` | 变了哪几个组件（版本/许可/新增/删除）✓ | 许可**原文**是否齐全（那是生成物里的事 ✓）|
| 界面三屏 + 键盘 + 两种窗口尺寸 | `bash gui/scripts/dom-smoke.sh` | 每屏的可见文字、键盘走查、两个尺寸的版面数字 ✓ | **显示缩放**（125%/150%）✗、真 WebView2 ✗ |
| 界面性能基线 | `bash gui/scripts/measure-web.sh` | 首页到关键元素的**中位数**、DOM 节点数、资源字节 ✓ | 真机 GPU 下的数字 ✗ |
| 提示词体量 | `bun gui/scripts/measure-prompts.ts` | 有没有整句重复、按内容裁段是否安全 ✓ | 模型是否**理解**那段话 ✗ |
| 打包产物闸门（配置≠产物 ✓） | `bash gui/scripts/verify-bundle.sh --dmg <dmg>` | 挂载后的**真实目录清单** + 工具能否在包里跑 ✓ | Windows 安装包内容（那边单独跑 ✓）|
| 真机任务普查 | `bash gui/scripts/task-sweep.sh` | 逐卡结果 + 与基线的差异 + 总耗时 ✓ | 需要真 Windows 桌面的卡 ✗ |

## 二、Windows 验收机（真 Windows + 真 WebView2）

**前置**：`gui/DEVELOPING-WINDOWS.md` 与 `gui/DEVELOPING-WINDOWS-VM.md`（我踩过的坑都写在那儿 ✓：
`.ps1` 必须带 BOM ✓、SSH 是 Session 0 没有桌面 ✓、**提权会让 WebView2 忽略 `WEBVIEW2_*`** ✗、
Guest Agent 还要装 virtio-serial ✓）。

| 验证 | 怎么跑 | 看什么当证据 | 什么**不**覆盖 ✗ |
| --- | --- | --- | --- |
| **装得上 / 装出来干净** | `gui\scripts\windows\inspect-installer.ps1` | 安装目录清单：四个可执行文件在 ✓、无 `.d` ✓、无 0 字节 ✓ | 卸载是否干净（`accept-install.ps1` 里有 ✓）|
| **她第一次打开看到的第一屏** | `gui\scripts\windows\accept-first-screen.ps1` | UIA 读回的**窗口真实文字**，逐条对照 `copy.ts` ✓；退出码 **2=环境 / 3=产品** ✓ | 字体手感、动画 ✗ |
| **装完就能干活（端到端，零环境变量）** | `gui\scripts\windows\run-accept-drive.ps1`（一行命令 ✓，也可用 `accept-install.ps1 -ZeroEnv` ✓） | phase 行耗时 ✓、结果页出现「做好了」✓、**产出文件读回核对** ✓、**原件 sha256 前后一致** ✓ | 慢模型下的耗时 ✗（本地桥+pi 不是 850s 那种 ✓）|
| **产物闸门（安装目录）** | `gui\scripts\windows\verify-bundle.sh --dir <安装目录>` | 四个可执行文件 + 随包执行组件都在、都能跑 ✓ | 安装包内部（要装完才看得到 ✓）|
| **周度自动普查** | 计划任务 `CanteWeeklySweep` | `C:\cante-sweep\report-YYYYMMDD.md` ✓ | 需要桌面的场景 ✗ |
| 纯取证（**不进门禁** ✗） | `capture-window.ps1` / `collect-environment.ps1` / `probe-installed-app.ps1` / `dump-window-text.ps1` | 截图、环境事实、窗口文字 | **它们只产出证据、不做断言** ✓（`dump-window-text.ps1` 被上面的脚本复用 ✓）|

## 三、CI（另一台机器上的双平台 ✓）

| 验证 | 在哪 | 看什么 |
| --- | --- | --- |
| `gate` job（Linux） | `.github/workflows/gui.yml` | 与本地 e2e 同判据（**判据必须一致** ✓ —— 曾经"本地绿 CI 红"✗）|
| `windows` job（windows-latest） | 同上 | 同一份测试在 Windows 上跑 ✓ + `tauri-driver` 界面冒烟 ✓ + msedgedriver 与 WebView2 版本匹配 ✓ |
| 发布流水线 | `.github/workflows/gui-release.yml` | 双平台安装包 + **产物闸门跑在打出来的 dmg 上** ✓ |

## 四、这张表自己怎么保持不腐

- 新增验证脚本 → **补一行**（否则下一个人不知道它属于哪一层 ✓）；
- 某个验证**只在 CI 跑**、或**只在真机跑** → 在这张表里写清原因是**能力限制** ✗（例如"要真 WebView2"✓、
  "要真 Windows 桌面"✓），**不要**让人以为本地 e2e 覆盖了它 ✗；
- 记录文件（`WINDOWS-ACCEPTANCE-N.md` / `SWEEP-*.md`）是**证据** ✓，这张表是**索引** ✓ ——
  两者别混：`SWEEP-0.2.1.md` 是一次运行的记录 ✓，不是"我们每次都这样"的承诺 ✓。
