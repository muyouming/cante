# 库/系统的原话，到底能走到她面前的哪些地方

**这是什么**：#282 那轮修了两条英文泄漏（`write` 路径的 GBK、`read` 路径的坏 xlsx），
但**没有一份完整清单**——那份清单只留在会话日志里 ✗。这份文档把 `gui/src-tauri/**/*.rs`
**每一条**「库 / 系统 / 子进程的原话可能端到王姐面前」的路都列出来，
逐条给：原话从哪来 → 拼进哪个字符串 → 到前端哪个控件 → 现在到不到得了她。

**基线**：`origin/main` = `e587aa2`（#279 / #282 之后）。
**行号取自本 worktree**（含本轮 `commands.rs` 的改动；改完行号是对的）。

**判据（AGENTS.md §3.6）**：每条都跟到**生产路径上真正渲染它的那一行**，
不跟「我们以为会渲染的那一行」。读到她面前之前先经过哪道闸门，也在下面写清楚。

---

## 0. 结论先行

- **清单共 31 条路径**（§2 表内编号 1–30；`#6` 有两个消费方，按 `6a`/`6b` 两条算）。
- **五类**：
  - **已分层 ✓：4 条** —— 她看中文那句；原文要么进日志，要么只在**折叠的
    「看看细节 / 复制详情」**里（产品律 3 允许技术详情含原文）。`#1`、`#6a`、`#7`、`#22`。
  - **到不了她 ✓：23 条** —— 被前端闸门翻译掉、被静默吞掉、只进日志、
    或前端根本不调那条命令。
  - **只是数据、不是错误文案：2 条** —— `#5`（单元格内容）、`#9`（表格 stdout）。
  - **会到她 ✗：1 条（`#10`）→ 本轮后 0 条** —— `commands.rs` 的 `read_result_sheet`
    在**阻塞任务自己 panic** 时，会把 `JoinError` 的英文原文（`task … panicked`）
    拼进那句子，经 `shareReadFailed` 直接显示。本轮按 #282 的分层模式修掉（§3）。
  - **间接、无代码闸门：1 条（`#6b`）** —— `cante-sheets write` 的 stderr
    只有**助手**会读（GUI 自己不跑 `write`）。#279/#282 让先出现的是中文那句，
    但**助手若原样转述**，标记后的原文会跟着到——这不是我们的渲染路径，代码挡不住（§4）。

  合计：4 + 23 + 2 + 1 + 1 = 31 ✓

---

## 1. 前端的三道闸门（为什么大多数 Rust 错误到不了她）

在数「到不到得了」之前，先说清她面前的三道闸门。**Rust 返回的错误字符串不是直接
上屏的**；它要先过其中一道。

| 闸门 | 位置 | 它做什么 | 认不出来时 |
| --- | --- | --- | --- |
| `noticeView` / `explainError` | `gui/src/simple/copy-notice.ts:92`、`gui/src/simple/copy.ts:405` | 用**她自己写的**中文规则把 `store.notice()` 的原话翻成 what/how；只用 `what`/`how` 渲染（`gui/src/simple/Notice.tsx`） | 返回 `null` → **整句不显示**（宁可不说，也不把英文端出去） |
| `openFailureView` | `gui/src/simple/copy-results.ts:248` | 只认「打不开…」两个前缀，把正文与**已知错误特征**（`os error 32/1155/EACCES`…）比对，给中文出口 | 给通用中文出口，**原文一句都不渲染** |
| `shareReadFailed` | `gui/src/simple/copy-share.ts:32` | **唯一**会把一段原文**直接拼在中文后面显示**的：`这个表暂时读不出来。…（{reason}）` | 无——它就是那个「不设防」的出口，所以上游必须先把原文切掉 |

出错页的技术详情（`ErrorView.tsx:199` 的 `<details>`、`ResultCard.tsx:417` 的
「看看细节」、`ApprovalSheet.tsx:120` 的折叠）**故意允许**含原文——那是产品律 3 的
「复制详情给技术同事」，不算泄漏。

`invoke` 的包装在 `gui/src/tauri.ts:148-187`：Rust 的 `Err(String)` 被塞进
`CommandRejected.message`，所以她面前能出现的原文，形状就是 Rust 那句 `String`。

---

## 2. 总表：每一条原话的来路

> 「她的那一句」= 生产路径上真正渲染到屏幕的文案（给 `文件:行`）。
> 「原文去哪」= 库/系统原话最终落到哪。

### 2.1 `sheets.rs`（calamine / zip / rust_xlsxwriter）

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 1 | calamine：`Xlsx error: Worksheet '数据' not found` | `SheetError::BrokenSheet.raw` @ `sheets.rs:215` | `read_result_sheet` → `shareReadFailed` @ `ResultCard.tsx:309`→`:659` | **已分层 ✓** | `detail()` @ `sheets.rs:137` → 壳的标记之后 → `commands.rs:336-341` 切掉，只 `eprintln`（#282） |
| 2 | calamine：打开工作簿失败的原文 | `map_err(|_| SheetError::Broken(path))` @ `sheets.rs:238` | 同上 | **到不了她 ✓** | 丢弃（`|_|`），只剩路径 |
| 3 | `std::str::from_utf8`：`stream did not contain valid UTF-8` | `SheetError::NotText(path)` @ `sheets.rs:389-390` | 同上 | **到不了她 ✓** | 丢弃（#279），改说「另存为」那一步 |
| 4 | rust_xlsxwriter：写表/写数字/写日期/存盘失败的原文 | `map_err(|_| write_failed(...))` @ `sheets.rs:339,342,346,350,357,366-376` | 同上 | **到不了她 ✓** | 丢弃（#279），只剩中文 why |
| 5 | `Data::Error(_)` → `value.to_string()` @ `sheets.rs:258` | 单元格的值，进「复制成微信能贴的文字」的表 | 同上 | **不是错误文案 ✓** | 是**她表里的内容**（公式错误值），本来就要原样显示 |

### 2.2 `bin/cante-sheets.rs`（薄命令行壳）

| # | 原话 | 拼进哪里 | 谁消费 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 6 | 库/系统原文 | `error_stderr()` @ `sheets.rs:150-155`：中文那句 + `DETAIL_MARKER` + 原文 | a) **应用**（`read` 路径）；b) **助手**（`write`/`sheets` 等） | a) **已分层 ✓**；b) **间接（无代码闸门）** | a) `commands.rs:358 split_sheet_stderr` 只取标记前那段；b) 见 §4 |

### 2.3 `commands.rs`（Tauri 命令）

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 7 | `cante-sheets read` 的 stderr（可能含英文） | `String::from_utf8_lossy` @ `commands.rs:336` | `shareReadFailed` | **已分层 ✓** | `split_sheet_stderr` @ `:358`；原文 `eprintln`（#282） |
| 8 | `Command::output()` 失败（工具不在/跑不起来） | `SHEET_UNAVAILABLE_WHY` @ `commands.rs:331` | 同上 | **到不了她 ✓** | 操作系统的话被换成中文常量 |
| 9 | `cante-sheets read` 的 stdout | `from_utf8_lossy` @ `commands.rs:346` | 表格内容 | **是数据 ✓** | 解析成 CSV 行；不是错误文案 |
| 10 | `spawn_blocking` 的 `JoinError`（`task … panicked` / 运行时关停） | `read_task_failed()` @ `commands.rs:376-378`（**本轮新增**） | `shareReadFailed` | **本轮修好 ✓** | 原文 `eprintln`；她只看到 `SHEET_READ_FAILED_WHY` |

### 2.4 `files.rs`

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 11 | `tauri_plugin_opener`：`os error N` / 插件英文 | `打不开 {path}：{error}` @ `files.rs:668` | `store.openPath` @ `store.ts:1111` → `openFailureView` @ `ResultCard.tsx:902` | **到不了她 ✓** | 正文只跟已知特征比对；认不出→中文通用出口，原文不渲染（`copy-results.ts:248-274`） |
| 12 | 同上（文件夹） | `打不开文件夹：{error}` @ `files.rs:679` | `store.revealPath` @ `store.ts:1125` → `openFailureView` | **到不了她 ✓** | 同上 |
| 13 | `std::fs` 原文（撤销时移动/还原失败） | `{path}（没能移走：{error}…）` @ `files.rs:372,395` | `undo_run` 的 `failed[]` → `undoOutcome` @ `undo.ts:29-32`、`History.tsx:174` | **到不了她 ✓** | 前端**只数条数**，不显示字符串 |
| 14 | `std::fs` / `serde_json` 原文（运行记录写盘） | `write_json` @ `files.rs:433-445`、`store_root` @ `:612-614` | `begin_run`/`save_run` 被静默吞（`store.ts:1149-1152`、`:1235-1237`）；`run_log` 也被吞（`:1243-1246`）；`undo_run` 失败进 `notice`（`:1475`） | **到不了她 ✓** | 吞掉；`undo_run` 那次经 `noticeView` 认不出→整句不显示 |
| 15 | `serde_json::to_string_pretty` 的原文 @ `files.rs:435` | —— | —— | **到不了她 ✓** | 对 `Value` 不会失败；源码里也只有它自己 |

### 2.5 `daemon.rs`

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 16 | `Command::spawn` 失败：`could not start `<spec>`: <io error>` | `spawn_child` @ `daemon.rs:667` | `start_session`/`send_input` → `notice` / `run.error.detail` | **到不了她（主句）✓** | `noticeView` 认 `could not start … serve`（`copy.ts:217`）→ 中文「缺组件」；英文不出现在主句 |
| 17 | 写给守护进程失败：`failed to write to daemon: <io error>` | `send_op` @ `daemon.rs:352-353` | 同上 | **到不了她（主句）✓** | `noticeView` 认不出→不显示；运行中只进折叠详情 |
| 18 | 起读线程失败：`failed to start daemon reader/log reader: <io error>` | `ensure_started` @ `daemon.rs:378,383` | 同上 | **到不了她（主句）✓** | 同上 |
| 19 | `catalog` 的 serde 原文 + **子进程 stderr 原样** | `daemon.rs:332`（`suffix(&stderr)`） | `catalog` 命令 | **到不了她 ✓** | 前端**从不 invoke `catalog`**（全仓库只有类型声明 `tauri.ts:127`，无调用）|
| 20 | 守护进程/`cante-bridge` 的 stderr 逐行 | `stderr_loop` @ `daemon.rs:711-729` → `emitter.log` @ `lib.rs:40` | `cante://log` 事件 | **只进日志 ✓** | 前端**没有** `cante://log` 的监听（`CANTE_LOG` 只在 `tauri.ts:31` 声明，从未 `listen`）|
| 21 | 守护进程 stdout 的非法字节 | `protocol.rs:103-105 from_utf8_lossy` | 事件流 | **到不了她 ✓** | 只用于解析协议帧；坏行丢弃 |

### 2.6 `bridge.rs`（`pi` 协议适配器）

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 22 | `pi` 的 `errorMessage`（外部程序的原文） | `TurnEnd.status.Error.headline` @ `bridge.rs:323,340-343` | `store` @ `store.ts:856-864` | **已分层 ✓** | `notice` 经 `noticeView`（认不出→不显示）；原文只进 `run.error.detail`（折叠「看看细节」）|
| 23 | 起 `pi` 失败：`写给助手失败：<io error>` / 管道拿不到 | `write_pi` @ `bridge.rs:1270-1276`、`ensure_pi` @ `:1207-1209` | bridge 的 `Error` 事件 → `store.ts:838-844` | **到不了她（主句）✓** | `noticeView` 认不出→不显示；事件同时进 `run.error.detail` |
| 24 | 审批扩展文件写不下：`没能准备好审批要用的文件（<path>）：<io error>` | `materialize` @ `bridge.rs:807`（`:823` 同类） | 同上 | **到不了她（主句）✓** | 同上 |
| 25 | bridge 自己写的固定句（缺组件两句 @ `:843-844`、`助手没能启动…` @ `:1386`、`不支持…：<op>` @ `:1160`） | `Error` 事件 | 同上 | **到不了她 ✓** | 本来就是中文；`<op>` 是协议操作名，只在认不出→不显示或折叠详情 |
| 26 | `write_pi_stdin` 的错误（`bridge.rs:1612-1616`） | —— | —— | **到不了她 ✓** | 两个调用点都 `let _ =` 丢掉（`:1453,1577`）|
| 附 | `pi` 的 stderr 逐行转发 | `pi_log` @ `bridge.rs:1605-1609` → bridge 的 stderr | `cante://log` | **只进日志 ✓** | 同第 20 条，无人监听 |

### 2.7 `pdf.rs` / `bin/cante-pdf.rs`

| # | 原话 | 拼进哪里 | 谁消费 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 27 | lopdf：`Document::load` / `extract_text` / `save` 失败原文 | `map_err(|_| broken_with(...))` @ `pdf.rs:353,372,439,459` | `cante-pdf` 的 stderr | **到不了她 ✓** | 丢弃（#279）；`PdfError::Display` 全中文 |
| 28 | `text_layer_risk` 的字体告警 | `pdf.rs:180-182,306-309` | 同上 | **到不了她 ✓** | 全中文（`中文字体/特殊字体/字体`）|
| 29 | `cante-pdf` 的 stderr | `bin/cante-pdf.rs`（`error.to_string()`，但 `PdfError` 已全中文） | **只有助手** | **到不了她 ✓** | GUI **从不执行 `cante-pdf`**：`commands.rs` 只用 `resolve_pdf_bin` 探测位置（`:126-132`），全仓库没有 `Command` 跑它 |

### 2.8 `admin_config.rs`

| # | 原话 | 拼进哪里（`文件:行`） | 到前端哪 | 现在 | 原文去哪 |
| --- | --- | --- | --- | --- | --- |
| 30 | serde：`配置文件读不了：<serde error>` | `admin_config.rs:84,106` | 只 `AdminConfig.present=false` | **到不了她 ✓** | 只 `eprintln`（`:117-120`），界面一句不提 |

> 计数说明：§0 的「31 条」= 表内编号 1–30，`#6` 的 `a`（应用）与 `b`（助手）分开算。
> 已分层 = `#1`、`#6a`、`#7`、`#22`（4）；只是数据 = `#5`、`#9`（2）；
> 间接 = `#6b`（1）；会到她（本轮前）= `#10`（1）；其余 23 条都是「到不了她」。

---

## 3. 本轮唯一改动：`read_result_sheet` 的阻塞任务失败

### 3.1 缺口（改前）

`gui/src-tauri/src/commands.rs`（改前第 382 行）：

```rust
let rows = tauri::async_runtime::spawn_blocking(move || {
    read_sheet_rows(&tool, &path, sheet.as_deref())
})
.await
.map_err(|error| format!("读取表格时出了点问题：{error}"))??;
```

这条 `?` 之后**没有**任何分层：`JoinError` 的 `Display` 是英文
（`task 42 panicked at …`，或运行时关停时的 `task was cancelled`），
它会作为 `read_result_sheet` 的错误原样回到前端，
经 `shareReadFailed`（`copy-share.ts:32`）**拼在中文后面直接显示**：

```
这个表暂时读不出来。你可以先用 Excel 打开它，选中要发的部分自己复制，或者过一会儿再试。
（读取表格时出了点问题：task 42 panicked at src/commands.rs:380:9: index out of bounds）
```

触发条件是**我们自己的代码出岔子**（阻塞任务 panic / 运行时关停），不是她的文件坏——
和 #279/#282 的「她的文件有问题」不是一类，但对她的效果一样：一句她看不懂的英文。

### 3.2 改法（照 #282 的分层模式）

`commands.rs:376-378` 新增：

```rust
pub fn read_task_failed(error: &dyn std::fmt::Display) -> String {
    eprintln!("cante read_result_sheet: 读表的任务没能跑完：{error}");
    SHEET_READ_FAILED_WHY.to_string()
}
```

`:394` 改为 `.map_err(|error| read_task_failed(&error))??`。

- 她看的那句 = `SHEET_READ_FAILED_WHY`（「这个表格没能读出来。」，与
  `read_sheet_rows` 的兜底同一句，所以两种失败在她看来一致）；
- 原文（英文）只进 `eprintln`，给来帮忙的技术同事；
- `pub` 是为了让集成测试钉住这个契约。

### 3.3 配套断言

`gui/src-tauri/tests/result_sheet.rs` 新增
`a_failed_read_task_shows_her_chinese_only`：喂一句真的 `JoinError` 形状的英文原文，
断言她看到的是中文兜底句、且**不含** `panicked/task/index/bounds` 及原文本身。
（不真去制造 panic——那只会在 CI 上制造一个和契约无关的崩溃测试。）

---

## 4. 间接的一条：`cante-sheets write` 的原文（无代码闸门）

`write` 是**助手用的**命令，应用自己不跑它（`read_sheet_rows` 只发 `read`）。
所以它的 stderr（中文那句 + `DETAIL_MARKER` + 原文）唯一的消费者是**助手**：

- 好的一面：#279/#282 让**先出现的是中文那句**、原文在标记之后，助手转述时至少有中文可依；
- 坏的一面：**如果助手把整段 stderr 原样贴回来，原文就跟着到**。
  这不是我们的渲染路径（我们不控制助手怎么说话），**没有任何代码闸门能挡**。

这条如实记在这里：**不能靠本轮的分层解决**，也不能声称「已修」。真要收口，
得靠助手侧的行为约定（例如指令信封里要求「不要转述工具原文」）——那属于另一条工作线，
本轮的边界是不越界改它。

---

## 5. 没核到的（如实写）

1. **真机行为没验** ✗。本轮是**核代码 + 本机测试**：没有在 Windows 上重装产物、
   没有真点「复制成微信能贴的文字」、没有制造一次真 panic。§3 的结论来自
   **代码路径 + 本机集成测试**，不是端到端跑出来的。
2. **`JoinError` 那条的真实发生率没量** ✗。它要求阻塞任务 panic 或运行时关停，
   我**没有**统计过线上是否发生过；只知道路径是通的、现在被堵上了。
3. **助手是否真的会把 `write` 的原文转述给她，没验** ✗（§4）。本轮只核了「消费者是助手」，
   没跑一次真实任务观察助手的措辞。
4. **`#5`（`Data::Error` 单元格内容）没造出真实文件** ✗：`value.to_string()` 给的是
   公式错误值（如 `#DIV/0!`），我**没核**它在微信文本里具体长什么样（是不是也带英文），
   所以只标「是她的内容，不是错误文案」，没有进一步动作。
5. **`cante-pdf` 的实际报错没造出来核** ✗（GUI 不调它，优先级低；但没验就是没验）。
6. **`admin_config` 的坏文件只核了「只 eprintln」** ✗，没在真机上放一份坏
   `~/.cante/admin.json` 看界面（结论是「界面一句都不提」，来自源码 `:117-120`）。

---

## 6. 边界（本轮不做 ✗）

- 不碰 `store.ts`、`ResultCard.tsx`、`ConfirmSheet.tsx`、`tauri.conf.json`、workflows；
- 不碰 `recovery.ts`（另一 agent 在改）；
- **不给 Rust 侧加新闸门**（例如把 `copy-guard` 扩到 `.rs`）——那是 P2 之外的更大动作，
  本轮只交清单 + 最小修复；
- 不为了通过而放松任何既有闸门（copy / typography / tone / platform / a11y / secret-scan）。
