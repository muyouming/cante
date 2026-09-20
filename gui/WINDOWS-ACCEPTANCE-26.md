# Windows 验收 26：真窗口、真鼠标点「我做的结果」里那行的「复制位置」

日期：2026-09-21　机器：那台 Windows 11 验收机（真 WebView2 + 真剪贴板）
这一轮只回答一个问题：**#290 在真机上成不成立** —— 结果面板每行的「复制 X 的位置」，
点下去是不是真把**那一行自己的完整位置**放进她的剪贴板。命令与原始输出逐条记在下面，可复跑 ✓。

---

## 0. 一句话结论

**通过** ✓：#290 在真 Windows + 真 WebView2 + **真剪贴板**上成立 ✓。

- 面板每行都有「复制 结果_….xlsx 的位置」（名字带文件名 ✓、高 **49px** ✓ ≥44）；
- **真鼠标点第一行** → 剪贴板 = `C:\…\seed\结果_挑出华东区-1.xlsx`（**逐字相等** ✓、反斜杠 ✓、无正斜杠 ✓）；
- 三行逐行点（UIA 读屏式点击）→ **各拿各的**、互不相同 ✓；
- 点完出现「已经复制好了…」✓、**没有**「没能复制上」✗、面板不关 ✓。

**同时记一条会让下一轮踩空的坑**（§5）：任务里写的 `cargo build --release --bin cante-gui`
**单独跑出来是 dev 二进制**（窗口去连 `localhost:1420`，显示"拒绝连接"✗）——
必须加 `--features tauri/custom-protocol` 才是"用打进包的前端"的产物 ✓。
它**时间戳会变、看着像新产物**，但界面是坏的 —— 正是 AGENTS.md §3.6 说的那类假证据 ✗。

---

## 1. 产物（先核时间戳再往下走 ✓）

| 项 | 值 |
| --- | --- |
| 文件 | `C:\cante\gui\src-tauri\target\release\cante-gui.exe` |
| LastWriteTime | **2026-09-21 05:18:44** |
| 大小 | 10405376 |
| sha256 | `2AC80A8E6CB96BB2431DD6E522CC2903F03EF9C28EF376C914101E334B5BEEB5` |
| 前端标记（`dist` 里） | `CANTE-BUILD\|2026-09-21 05:18\|0.2.3` ✓ |

`cante-sheets.exe / cante-bridge.exe / cante-pdf.exe` 同在 `target\release\`（铺夹具行用 `cante-sheets` ✓）。
"时间戳 + 前端标记"两处都对得上，才继续往下点 ✓。

---

## 2. 怎么编的（两步；命令要带对 feature）

```
cd C:\cante\gui
bun run build:web                                  # vite，1.66s
cd src-tauri
cargo build --release --bin cante-gui --features tauri/custom-protocol   # 约 38s
```

`tauri.conf.json` 的 `beforeBuildCommand = "bun scripts/stage-executor.ts && bun run build:web"` ✓——
这一步在 `cargo build` 里**会再跑一次**（实测 dist 的 mtime 与 build stamp 都变成 05:18 ✓，
与 exe 同一时刻 ✓），所以 exe 里嵌的前端就是当前这份 ✓。

**反例（不带 feature，编出来的界面是坏的）**：见 §5。

---

## 3. 做到了哪一步（时间线）

| 步 | 做了什么 | 结果 |
| --- | --- | --- |
| 1 | `bun run build:web`（05:14:47） | `✓ built in 1.66s` ✓ |
| 2 | 第一次 `cargo build`（不带 feature） | **先红**：残留的 `cante-gui`（PID 4880，04:19 起）锁住 exe → `拒绝访问 (os error 5)`；杀掉后 05:15:34 编出 exe |
| 3 | dump 窗口 | 窗口显示 **`localhost 拒绝连接`** ✗ → 断定命令漏了 feature（§5） |
| 4 | 带 `--features tauri/custom-protocol` 重编（05:18:06→05:18:44） | 真界面 ✓（首页出现「打开我做的结果（3 个）」✓） |
| 5 | `seed-result-rows.ps1 -Mode seed -Rows 3` | 3 份真 xlsx + 3 条 `runs.json` ✓（面板每行一份） |
| 6 | 真鼠标点第一行 + UIA 点三行，逐字核对 `Get-Clipboard` | 见 §4 ✓ |
| 7 | `seed-result-rows.ps1 -Mode restore` | `RESTORE OK` ✓（与备份逐字相同，§8） |

---

## 4. 逐字输出

### 4.1 面板里每行的按钮（3 个，名字带文件名，高 49px）

```
按钮数：3（期望 3）
  复制 结果_挑出华东区-1.xlsx 的位置   [106x49 @ 592,558]
  复制 结果_挑出华东区-2.xlsx 的位置   [106x49 @ 592,786]
  复制 结果_挑出华东区-3.xlsx 的位置   [106x49 @ 592,1014]
```

（第 2、3 行的矩形在任务栏/屏幕外 —— 屏幕 1280x800，工作区高 752 ✓；所以真鼠标点只点得了第一行，
其余两行走 UIA `InvokePattern` ✓，两条路分开记 ✓。）

### 4.2 **真鼠标点击**（第一行：SetCursorPos + mouse_event）

```
=== 真鼠标点击（第一行）===
  目标：复制 结果_挑出华东区-1.xlsx 的位置  矩形=592,558 106x49 -> 645,582
  点击前在前台：True
  期望完整位置：C:\Users\<用户名>\AppData\Local\Temp\cante-copy-location\seed\结果_挑出华东区-1.xlsx
  剪贴板（逐字）：C:\Users\<用户名>\AppData\Local\Temp\cante-copy-location\seed\结果_挑出华东区-1.xlsx
  与期望逐字相等：True
```

### 4.3 三行各拿各的（UIA 读屏式点击，逐字核对）

```
--- 第 1 行：结果_挑出华东区-1.xlsx ---
  期望完整位置：C:\…\seed\结果_挑出华东区-1.xlsx
  剪贴板（逐字）：C:\…\seed\结果_挑出华东区-1.xlsx
  与期望逐字相等：True
--- 第 2 行：结果_挑出华东区-2.xlsx ---
  剪贴板（逐字）：C:\…\seed\结果_挑出华东区-2.xlsx
  与期望逐字相等：True
--- 第 3 行：结果_挑出华东区-3.xlsx ---
  剪贴板（逐字）：C:\…\seed\结果_挑出华东区-3.xlsx
  与期望逐字相等：True
三行复制的值互不相同：True（3/3）
```

（"三行各拿各的"是关键 —— 面板一屏好几行，复制错行是这条最可能的错法 ✓。）

### 4.4 提示句 + 面板不关

```
出现「已经复制好了」：True
出现「没能复制上」：False
面板仍开着（「回到首页」还在）：True
```

### 4.5 独立复跑一次（早先那条脚本，第一行也真鼠标点过）

```
  剪贴板（逐字）：C:\Users\<用户名>\r16-seed\seed\结果_挑出华东区-1.xlsx
  与期望逐字相等：True
  首字符：'C'   尾字符：'x'
  含反斜杠：True  含正斜杠：False
  点完面板还在：True
  出现「已经复制好了」：True  出现「没能复制上」：False
```

---

## 5. 编错命令那一下（**反例，下一轮别再踩**）

按任务里写的 `cargo build --release --bin cante-gui`（**没有** `--features tauri/custom-protocol`）
编出来的 exe（05:15:34，大小 10253824 ≠ 上面那份），窗口 dump 出来是：

```
Window | Cante
Pane | localhost
Pane | localhost - 网络错误 - Web 内容
Text | 嗯… 无法访问此页面
Text | ERR_CONNECTION_REFUSED
```

原因（代码事实）：`gui/src-tauri/Cargo.toml` 里 `tauri = { version = "2", features = [] }`，
`custom-protocol` 这个 feature 只在带上时，`tauri-build` 才把 `dev` 置 false、才用
`frontendDist`（打包进去的前端）；不带它就按 `devUrl` 去连 `localhost:1420` ✓
（`tauri-build::is_dev()` 读 `DEP_TAURI_DEV`；`tauri` 的 build script 用它自己的 `custom-protocol` feature 决定 ✓）。
`tauri build`（`bun run build`）会自动带这个 feature ✓，**裸 `cargo build` 不会** ✗。

**判据**：下次编完，先 dump 一眼首页是不是真的界面（有没有 `localhost`/`ERR_CONNECTION_REFUSED`）✓，
不要只看时间戳 ✓。本轮正是靠这一步把坏产物挡在前面 ✓。

---

## 6. 结论（只指向上面贴出的输出）

1. **#290 成立** ✓：结果面板每行有「复制 X 的位置」；真鼠标点第一行、UIA 点三行，
   剪贴板拿到的都是**那一行自己的完整位置**（逐字相等、盘符开头、反斜杠、以 `.xlsx` 收尾）✓；
   三行互不相同 ✓；成功提示与"未失败"都对得上 ✓；面板不关 ✓。
2. 这条判据是**真窗口 + 真剪贴板**得到的 ✓（不是 SSR 单测、不是 DOM 自述）——正是 #289 缺的那一面 ✓。

---

## 7. 没验的（分开写）

- **真键盘（她按 Tab / Enter）这条**：**没验** ✗。用它验的时候（`SetFocus` + 合成 `Enter`），
  复制**没发生**（剪贴板停在哨兵），随后退回 UIA `InvokePattern` 才成功；而且那一次合成 `Enter`
  把面板**退回了首页**（UIA `SetFocus` 未必真给 WebView2 的 DOM 焦点，合成键可能落在别处）。
  → 结论是"合成键盘输入在这台机器上不可靠"，**不能**据此说产品键盘路径有问题 ✗；
  真键盘与读屏那面由 `gui\scripts\windows\a11y-uia.ps1` 覆盖（结果面板的名字重复已由 #290 修成带文件名 ✓）。
- **结果面板里"这份文件还在不在"**：本轮夹具模式下显示的是「**没能核对**它还在不在」（`fetchFileFacts` 的回退），
  因为夹具没有真 bridge。这与 #290 无关，但如实记下 —— 本轮**没有**验"在/不在"的真实分支 ✗。
- **显示缩放 ≠ 100%**、**装机版那份 `cante-gui.exe`**（`%LOCALAPPDATA%\Cante\`）、**真实鼠标体感**、
  **粘到微信之后的观感**：**都没验** ✗。
- **跑完当屏的 ResultCard 上的「复制位置」（#283）**：本轮没跑真任务，**没验** ✗。

---

## 8. 机器状态（没留痕）

- `runs.json`：**已还原**，与备份**逐字相同**（`diff -q` = IDENTICAL ✓；`grep -c seedrun` = 0 ✓；marker 已删 ✓）。
- 残留进程：`Get-Process cante-gui,cante-bridge` **无输出** ✓（起跑前清掉过一个 04:19 起的老进程 ✓）。
- 仓库改动只有：本报告 + 复跑脚本（`gui\scripts\windows\accept-copy-location.ps1`）+ `VERIFICATION-MAP.md` 一行 ✓；**没改产品代码** ✓。
- 未跟踪的 `gui\accept-drive-result.json`（05:17、内容 `"应用 不存在：(空)"`）**不是这一轮产生的**，没动它 ✓。

---

## 9. 时限

- 起：**05:14:47**；交：**05:28**（≈**13 分钟**，含两次重编约 40s、三轮点击与两次脚本复跑）。
- 单条命令都在 3 分钟内返回（`cargo build` 38s ✓；每次起窗口 + 点 + 核对 ≈ 90s ✓）。
- 本条结论**是逐字输出支撑的**，没有"应该没问题" ✓。

---

## 10. 怎么复跑（给我自己下一次的一条命令）

```
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-copy-location.ps1
```

它自己铺 3 行 → 起窗口 → **真鼠标**点第一行 + UIA 点三行 → 逐字核对 → 还原 `runs.json`。
退出码：`0`=通过 / `2`=环境问题 / `3`=产品问题 ✓（沿用 `accept-first-screen.ps1` 的约定 ✓）。
