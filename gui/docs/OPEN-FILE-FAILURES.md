# 结果卡上「打开文件 / 打开所在文件夹」：打不开时到底是哪一种

这份文档回答一个问题（`AGENTS.md` §3.6 的判据）：**她点了「打开文件」，打不开的时候，
屏幕上那句话说的是真的吗？能不能分清是哪一种打不开？**

先核事实，再（只在事实清楚时）改话。核不出来的部分写在最后一节，不猜。

---

## 一、这条路上真实发生的动作

| 她点的按钮 | 前端 | Rust command | 交给谁去做 |
| --- | --- | --- | --- |
| 打开文件 | `store.ts:1108` `invoke("open_path")` | `files.rs:607` `open_path` | `tauri_plugin_opener::open_path` → `open` crate 的 `open::that_detached` |
| 打开所在文件夹 | `store.ts:1122` `invoke("reveal_path")` | `files.rs:619` `reveal_path` | `tauri_plugin_opener::reveal_item_in_dir` |

**只有她点的时候才去打开**（核过，不是自动的）：三个界面上的「打开」都挂在 `onClick` 上，
没有任何地方在渲染或核对阶段去开文件。

- `ResultCard.tsx:571`（打开文件）/ `:578`（打开所在文件夹）——结果卡片上每一份文件那一行；
- `ResultsPanel.tsx:158` / `:166`——「我做的结果」面板；
- `History.tsx:184` / `:192`——历史。

失败**只会**发生在这一次点击上（`store.ts:1105-1128` 的 `openPath` / `revealPath`）。

---

## 二、失败时返回什么（原文形状）

`open_path` 只有两种失败（`files.rs:607-615`）：

| 情况 | 返回的字符串 | 依据 |
| --- | --- | --- |
| 文件不在（先查 `Path::exists()`） | `这个文件找不到了：<文件位置>` | `files.rs:608-610` |
| 系统打不开（交给系统之后） | `打不开 <文件位置>：<系统原话>` | `files.rs:611-613` |

`reveal_path` 只有一种（`files.rs:619-627`）。注意它**先兜底**：文件不在时，改成去开它
**所在的文件夹**（`folder_of`，`files.rs:620-623`），所以「找不到文件」通常**不会**让
「打开所在文件夹」失败。

| 情况 | 返回的字符串 | 依据 |
| --- | --- | --- |
| 系统打不开文件夹 | `打不开文件夹：<系统原话>` | `files.rs:624` |

**`<系统原话>` 是什么形状**：底层是 `open` crate。Windows 上 `tauri-plugin-opener` 打开了
`open` 的 `shellexecute-on-windows` 特性（该 crate 的 `Cargo.toml`），于是 `that_detached`
走 `ShellExecuteExW`，失败时返回 `io::Error::last_os_error()`。Rust 打印 OS 错误时**总会**
带上 `(os error N)`，N 是 Windows 的错误码——**这一串与系统语言无关，是可靠的特征**：

- 没有关联程序（没装 Excel/WPS 且没有别的默认程序）：`ERROR_NO_ASSOCIATION = 1155`；
- 没权限：`ERROR_ACCESS_DENIED = 5`；
- 文件被别的程序占用：`ERROR_SHARING_VIOLATION = 32` / `ERROR_LOCK_VIOLATION = 33`。

macOS 上是另一支：`open::that` 走 `/usr/bin/open`，失败给的是
`Launcher "…" failed with ExitStatus(…)`（**没有 `os error N`**，见 `open-5.4.4/src/lib.rs`
的 `into_result`）。

---

## 三、这些失败今天屏幕上会说什么

⚠️ **关键事实：今天一句都不会说。** `store.openPath` 把话写进了 `store.notice()`（`store.ts:1111`），
但 `noticeView`（`copy-notice.ts:87`）**不认**这两个开头，而每一处 `<Notice>` 都按类别过滤：

| 显示 `store.notice()` 的地方 | 只认哪几类 | 依据 |
| --- | --- | --- |
| 结果卡片 | 撤销（`UNDO_KINDS`） | `ResultCard.tsx:826` |
| 选文件那一步 | 选文件（`PICK_KINDS`） | `TaskRunner.tsx:571` |
| 出错页 | 出错（`ERROR_KINDS`） | `ErrorView.tsx:197` |

「打开文件 / 打开所在文件夹」两类**没有任何出口**——她点了、打不开，**画面一句话都不变**。
（这本身就是产品律第 3 条「出错能看懂并有出路」的缺口。）

**如果**有人把它接到 `explainError`（`copy.ts:405`）上，按现有正则命中的是：

| 失败 | 命中的规则（`copy.ts`） | 会说的话 | 这句话对不对 |
| --- | --- | --- | --- |
| 文件找不到，名字带 `.xlsx`/`.csv` | 表格规则 `copy.ts:307-309`（在「找不到」规则 `:258-260` **前面**） | 「这张表格打不开，可能格式不对，或者内容已经损坏。」 | ✗ 错：文件是**不见了**，不是坏了 |
| 文件找不到，名字没有常见后缀 | 「找不到」规则 `copy.ts:258-260` | 「电脑上找不到这个文件，它可能被移走、改名或者删掉了。」 | ✓ 对 |
| 没装 Excel/WPS（`os error 1155`） | 表格规则 `copy.ts:307-309` | 同上「格式不对 / 已损坏」 | ✗ 错：是这台电脑**没有能打开它的程序** |
| 没权限（`os error 5`） | 没权限规则 `copy.ts:253-255` | 「电脑不让修改这个文件。」 | ~ 大致对，但把「打开」说成了「修改」 |
| 被占用（`os error 32`） | 占用规则 `copy.ts:263-265` | 「这个文件正被别的程序占用着，现在改不了。」 | ~ 方向对，同样是「打开」被说成「改」 |
| 认不出来的系统原话 | 兜底 `copy.ts:436` | 「出了点问题，这次没能完成。」 | ~ 没说错，但没给出路 |

**结论：「找不到」这一种被说成了「格式不对/损坏」**——出路完全不同（去找回文件 vs 换一份文件），
而这两种她分不出来。这是要改的那一处。

---

## 四、核不出来的两种失败（不猜）

任务里列了四种打不开，其中两种**没法从这条命令上分辨**，如实记下：

| 情况 | 为什么核不出来 |
| --- | --- |
| **③ 文件坏了**（后缀是 `.xlsx`，其实不是） | `open_path` 只是**把文件交给系统**去开，它自己**不解析内容**（`files.rs:607-613`）。装了 Excel 的电脑上，坏文件也会被 Excel「打开」（Excel 自己弹修复框），`open_path` 返回**成功**。所以「坏了」在**打开这一步**根本不会报错——它是任务执行时（openpyxl 那一步）的失败，走的是另一条路。**在真 Windows 上没验过**（本机无桌面、无守护进程）。 |
| **④ 那其实是个文件夹**（有人把目录名写成 `.xlsx`） | `open_path` 的前置检查是 `Path::exists()`（`files.rs:608`），文件夹也算「在」；接着 `open` crate 的 Windows 分支**认得出是目录**，会去开 Explorer（`open-5.4.4/src/windows.rs` 的 `that_detached` 里 `is_dir` 那一段），通常**成功**。所以「是个文件夹」在**打开这一步**多半也不报错。真正被说错的是**结果核对**那一行：`file_facts` 把文件夹标成 `readable:false`（`files.rs:510-540`），于是 `copy-results.ts:87` 说「这个文件还在，但现在打不开；可能被别的程序占着」——对文件夹是**误导**。**真 Windows 上没验过。** |

另：**Windows 上没装 Excel/WPS 时**、**中文 Windows 上 OS 原话是否被本地化**，都只在
`open` crate 的源码上核过，**没有真机证据**（本机 macOS、无 `open_path` 真机走查）。

---

## 五、这次改了什么（只在事实清楚的前提下）

- 新增 `copy-results.ts` 的 `OPEN_FAILED` 与 `openFailureView()`：把她点「打开文件/
  打开所在文件夹」失败时那句原话，分成**五种不同说法**（找不到 / 这台电脑没有能打开它的程序 /
  别的程序正开着 / 电脑不让打开 / 认不出来退回通用出口），每一种都给**具体的下一步**。
- `ResultCard.tsx` 接线**一处**（结果卡片上那一段）：上面本来就没有出口，现在有出口了。
  「结果卡片」是她点这两个按钮的地方，所以先说在这一屏。
- 断言在 `gui/src/simple/open-file.test.ts`。

**没做**（超出本轮、要真机）：

- 没改 `files.rs` 的任何行为；
- 没修**结果核对**把文件夹说成「被别的程序占着」（`copy-results.ts:87`）——那是另一个 bug，
  要真机确认后再改；
- `ResultsPanel` / `History` 两处「打开」失败仍然没有出口（本轮只允许动结果卡片那一处）。
