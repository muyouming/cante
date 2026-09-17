# 桥的第一段：`cante-bridge` 用 `pi --mode rpc` 顶替 `cante serve`（issue #103 方案 C）

> 这是 `DECISION-windows-runtime.md` §4「阶段 1」的第一刀，也是 `PROBE-pi-rpc.md` 之后的落地起步。
> 范围刻意压到三条：`StartSession`、`UserInput`（含流式文本与工具）、`Interrupt`。
> 事实与推断分开写：带命令/断言的是**量到的**；标「推断」的是我算的。文末「我没验证什么」请先看。

---

## 0. 结论先行

**这一段能跑到什么程度：真 `pi` 进程 + 假 OpenAI 端点，可以端到端跑完一次「一个提示词 → 流式文本 → 一次工具调用 → 收尾文本 → 完成」；点停止会得到「被中止」而不是「完成」。而且这条路径是通过现有 `daemon.rs` 自己走通的——`CANTE_BIN` 指向桥，Rust 桥与前端一行未改。**

证据（本机 macOS、`pi 0.85.1`、假端点，全部可进 CI，全套 2.7 秒）：

| 测试（`gui/src-tauri/tests/bridge.rs`） | 断言 | 结果 |
| --- | --- | --- |
| `bridge_answers_the_daemon_probe_subcommands` | `--version` 非空、`catalog` 是合法 JSON、`serve_argv("cante-bridge")` 得到 `serve` | 通过（不需要 pi，CI 也跑） |
| `bridge_reports_an_assistant_that_dies_at_startup` | `pi` 一开始就退出（配错服务方就是这样）时，`StartSession` 回一条 `Error`，而不是静默 | 通过（不需要 pi；unix） |
| `bridge_streams_a_turn_from_pi` | `SessionStart` 字段、增量顺序、`AgentMessage`、`TurnEnd{Completed}`、恰好一个 `TurnEnd` | 通过 |
| `bridge_reports_an_interrupted_turn` | `Interrupt` 之后 `TurnEnd{Interrupted}`，且绝不出现 `Completed` | 通过 |
| `the_rust_daemon_drives_the_adapter_without_changes` | 用 `daemon.rs::Daemon`（Tauri 命令真正调用的那一层）驱动桥，收到 `SessionStart` + 完整增量 + `Completed` | 通过 |

没装 `pi` 的机器（CI 就是）：后三条打印 `SKIP ...` 并直接返回，测试仍然绿——**跳过与通过必须能分开看，这里靠 `SKIP` 三个字母和 `--nocapture` 输出**；前两条（探活子命令、助手启动即失败）不需要 pi，真跑。

模型/服务方名字取自 `pi get_state`，`provider.display_name` 拿不到就留空（前端会退回到 `provider.id`）；`skills` 显式给空数组；`title` 为 `null`。**没有编字段。**

---

## 1. 这一段改了什么

| 文件 | 改动 |
| --- | --- |
| `gui/src-tauri/src/bridge.rs`（新） | 纯翻译（`translate`、`SessionInfo` 拼装、时间戳、UI fail-safe）+ `pi` 子进程运行器 |
| `gui/src-tauri/src/bin/cante-bridge.rs`（新） | 只认 `serve` / `--version` / `catalog` 三个子命令的薄壳 |
| `gui/src-tauri/Cargo.toml` | 加一个 `[[bin]]`；**没有加任何依赖** |
| `gui/src-tauri/src/lib.rs` | 加一行 `pub mod bridge;` |
| `gui/src-tauri/tests/bridge.rs`（新） | 自带的假 OpenAI 兼容端点（`std::net`，不用 node）+ 4 条测试 |
| `gui/docs/BRIDGE-spike.md`（新） | 本文 |

`daemon.rs`、`commands.rs`、任何前端文件、`tasks/**`、`gui/probes/**`、`DECISION-windows-runtime.md` 都**一行未动**。假端点自己写而不用 `gui/probes/rpc/fake-openai.mjs`：CI 只装 `bun` 不装 `node`（推断自 `.github/workflows/gui.yml`），复用它会多一条隐式依赖。

---

## 2. 与决策文档 §3 的适配清单逐条对照

图例：**已做** / **部分** / **没做**（本段明确不做，或留到下一步）。

### §3.1 A 类：进程与传输

| 条目 | 状态 | 说明 |
| --- | --- | --- |
| 接受 `serve` / `--version` / `catalog` | **已做** | `--version` 有一行非空；`catalog` 返回 `{"providers":[]}`（前端不调，见 §1.2）；不认识别的子命令就退 2 |
| `pi` 启动即退出要说出来 | **已做** | `SessionStart` 之前就 EOF 的话，桥补一条 `Error`（「助手没能启动起来」）再发 `Goodbye`；配错服务方就是这个形状。有一条 unix 测试 |
| stdin 的 `OpMsg` JSONL / stdout 的 `EventMsg` JSONL，`evt_<ULID>` | **已做** | 复用 `protocol::LineSplitter` 与 `protocol::ulid`，不另写一套帧 |
| `Shutdown` / stdin EOF → 收好子进程、发 `Goodbye`、退 0 | **已做** | EOF 时发 `Goodbye`，关 `pi` 的 stdin，5 秒内不退就 kill（`PI_EXIT_GRACE`） |
| stderr 成为界面的 `cante://log` | **已做** | `pi` 的 stderr 原样转到桥的 stderr，`daemon.rs` 再转成 `cante://log` |
| 退出不留孤儿子进程 | **部分** | `pi` 的 stdin 一关它就退（探针实测退出码 0）；Windows 的 `CREATE_NO_WINDOW` 抄了 `daemon.rs` 一份（它 private）。**没有在 Windows 上验证** |

### §3.1 B 类：op → `pi` 命令

| 我们的 op | 状态 | 说明 |
| --- | --- | --- |
| `StartSession{permission_mode,cwd,model?,provider?}` | **部分** | 起 `pi --mode rpc --no-session`，`model`/`provider` 变成 `--provider/--model`；`cwd` 决定 `pi` 的工作目录；`permission_mode` 只写进 `SessionInfo`，**不影响任何行为**；`effort` 被忽略。产品默认从配置解析 model/provider 这条路**没做**（见 §3.2 第 6 条） |
| `UserInput(text)` | **已做** | 发送 `prompt`；若这一轮还在流式（产品一般不撞上），带上 `streamingBehavior:"steer"`，免得第二条被静默丢掉。同时回一条 `UserInput` 事件（真实守护进程也回，前端的「你」那一行靠它渲染） |
| `Interrupt` | **已做** | 发 `abort`；不等 `abort` 的 response（探针修订 G），`TurnEnd` 由 `agent_settled` 收尾 |
| `ApprovalResponse` | **没做** | 审批闸门不在本段（见 §3.2 第 1 条）。桥不加载审批扩展，所以正常不会有 `TurnPause`；**万一有扩展弹对话框，桥回 `cancelled:true`（fail-safe，等于拒绝）**，只是不让它挂死 |
| 关闭 stdin | **部分** | 关 `pi` stdin 让它收敛；**没有**先补一条 `abort`（推断：EOF 已经足够，未在真机上量过中断进行中的任务会怎样） |
| `Steer`/`SlashCommand`/`Goal`/`Compact`/`ContextReport`/`UpdateSession`/`ResumeSession` | **已做（拒绝）** | 一律回一条 `Error` 事件说明「还不支持」，而不是静默无反应；这些前端都不调 |

### §3.1 C 类：`pi` 事件 → 我们的 `Evt`

| `pi` 事件 | 状态 | 说明 / 与探针修订的对应 |
| --- | --- | --- |
| `agent_start` / `turn_start` → `TurnStart{turn_id}` | **已做** | `turn_id` 自己铸（`turn_<ULID>`）。**新量到一条**：一次提示词里 `pi` 会发**两次** `agent_start`（工具续跑时再来一次）；若照抄「每次都开新轮」，`TurnEnd` 的 `turn_id` 会与界面看到的 `TurnStart` 对不上。现在只有第一发开轮，后续忽略 |
| `message_update.text_delta` → `MessageDelta` | **已做** | 顺序由单线程转发保证，测试断言拼接结果 `"我先看一下，然后用工具。完成了。"` |
| `message_update.thinking_delta` → `ThinkingDelta` | **已做** | |
| `message_end`（assistant）→ `AgentMessage` | **已做** | 只取 `message_end.message`（权威全量，修订：`message_start` 是快照）；`role:"user"` 的回显丢掉，避免和 `UserInput` 重复 |
| `toolcall_start/delta/end` → 可选 `ToolStart` | **已做（择一）** | 不从这里发；产品更信 `tool_execution_*`（决策文档 C 类的备注） |
| `tool_execution_start` → `ToolStart{id,name,args}` | **已做（带保留）** | 探针修订 B：有审批闸门时这条必须缓存到放行后再发，否则审批页还开着进度清单就写「正在运行」。本段没有闸门，所以直接发；**接闸门时必须回来改这里**。工具名直接透传（`pi` 的 `bash`/`read`/`write`/`edit`/`glob`/`grep` 本来就落在 `approval.ts`/`progress.ts` 的小写词表里，未逐张卡核对） |
| `tool_execution_update` → `ToolUpdate{tool_use_id,seq,message}` | **已做** | `pi` 给的是**累计**输出；桥算增量再发（前端是拼接），并有单测钉住「`"a\n"` → `"a\nb\n"` 只发 `"b\n"`」 |
| `tool_execution_end`（`isError`）→ `ToolEnd` | **已做** | `isError` → `Failed`，否则 `Completed`；`Denied`/`Cancelled` 需要闸门，本段到不了。探针修订 F：成败只看 `isError` |
| `extension_ui_request` → `TurnPause{reason:{Approval}}` | **没做** | 本段最大的缺口，见 §3.2 第 1 条 |
| `agent_settled` / `turn_end` + `stopReason` → `TurnEnd` | **已做** | 修订 A：`TurnEnd` **只在 `agent_settled`** 发；`turn_end` 只用来记 `stopReason`，`turn_start` 用来数 `steps`。三种结局：`Completed` / `Interrupted{reason:"user"}`（`stopReason=="aborted"` **或**用户按过停止）/ `Error{headline}` |
| `auto_retry_start/end`、`extension_error` → `Info`/`Error` | **没做** | 错误分类整块留到下一步 |
| `compaction_start/end` → `CompactStart`/`CompactEnd{summary}` | **已做** | 很便宜，顺手做了；**没有用真模型触发过**（假端点不压缩） |
| 进程退出 → `SessionEnd` + `Goodbye` | **部分** | 正常与异常都发 `Goodbye`；`SessionEnd`（会话跨度结束，带 usage）没发——本段 `--no-session`，没有可报的会话跨度 |
| `message_update.usage` / `get_session_stats` → `UsageUpdate` | **没做** | 明确不在本段；前端不读（`grep '"UsageUpdate"' gui/src` 为 0） |
| 拼 `SessionInfo`（`get_state` + `get_available_models`） | **部分** | 只查 `get_state`：`sessionId`、`model.{id,name,input}`、`provider`、`baseUrl`。`input` 含 `image` 才置 `support_vision`，拿不到就**不写这个键**（前端按「看不见图片」读，是安全方向）。`display_name` 留空、`title:null`、`skills:[]`、`subagents` 不写。`get_available_models` 没查 |

### §3.1 D 类：生命周期与探活

| 条目 | 状态 |
| --- | --- |
| `--version` 回一行能显示的 | **已做**（`cante-bridge 0.1.0`） |
| `catalog` 可以回空 | **已做** |
| stdin EOF 时收敛退出 | **已做**，并且 `daemon.rs` 的 `Drop` 就是关 stdin，两者对得上 |

### §3.2 「现在没有对应物」的部分

| # | 条目 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | **审批闸门本身**（`TurnPause` 一批、逐调用问答、批量、四档决定） | **没做** | 本段的全部安全含义只有一条：**意外的对话框一律 `cancelled`**（fail-safe）。这**不是**产品律 2 说的「破坏性动作先问人」——那要一个 `pi` 扩展 + 桥里的闸门，是下一步的主体 |
| 2 | 权限模式与规则（strict/auto/yolo、危险命令识别、会话/永久授权） | **没做** | `permission_mode` 目前只是 `SessionInfo` 上的一个标签 |
| 3 | `turn_id` 与暂停/恢复括号 | **部分** | `turn_id` 已铸、`TurnEnd` 能对上 `TurnStart`；`TurnPause`/`TurnResume` 没有 |
| 4 | `TurnEnd.Error` 的分类（`kind`、`headline`/`details` 分层） | **没做** | 现在 `headline` 就是 `pi` 的 `errorMessage` 原文，`details` 不填。大白话错误表的命中性会变差，必须复核 |
| 5 | `steps` | **已做** | 数 `turn_start`；测试断言一次带工具的回合 `steps >= 2` |
| 6 | 默认模型/服务方的来源（`~/.cante/settings.json`、`admin.json`） | **没做** | 现在 model/provider 只来自 `StartSession` 请求；而前端默认**不传**（`store.ts:493` 只传 `permission_mode`）。也就是说：**真的从界面发起一轮时，桥会用 `pi` 自己的配置**。这是下一段第一个要拍的决定 |
| 7 | 本地离线推理的托管 | **没做** | 「只在本机处理」在 Windows 上仍无落地物 |
| 8 | `SessionInfo.skills` | **已做（显式空）** | `skills: []`，不假装 |
| 9 | Windows 上的 shell 语义（Git Bash vs PowerShell） | **没做** | 未测；卡片信封里「只用在确实装了的工具」这条仍无答案 |

### §3.3 量级

**不修订。** 这一段只做了 C-1 里的三条主链路，没有碰 C-2 的主体（权限引擎）。探针 §4 的第 2/3 条判断（「逐行查表翻译会错」、审批层比一条 `confirm` 大）**在本段被进一步支持**：光是 `agent_start` 重复、`tool_execution_update` 是累计的这两件事，就已经不是查表能翻译对的。

---

## 3. 复现（本机）

前置：`pi` 在 PATH（或 `PI_BIN` 指过去）、Rust 工具链（macOS 上先 `source gui/scripts/toolchain.sh`）。假端点由 `tests/bridge.rs` 自带，**不需要模型端点、不需要密钥**。

```bash
cd gui
source scripts/toolchain.sh
# 本机没有 timeout：用探针目录里的包装脚本给整条命令设上限（AGENTS.md §5）
bash probes/rpc/with-timeout.sh 600 cargo test --manifest-path src-tauri/Cargo.toml --test bridge -- --nocapture
```

没装 `pi` 时会看到 3 条 `SKIP`，其余（探活子命令、助手启动即失败）仍然真跑。

手工用桥顶替守护进程（本机验证过 `Daemon` 那一层）：把 `CANTE_BIN` 指到 `cante-bridge`，并给 `pi` 一份 `PI_CODING_AGENT_DIR`（里面 `models.json` 指向可用端点），再设 `PI_BIN`/`PI_OFFLINE`。`daemon.rs` 会自己追加 `serve`。

---

## 4. 下一步（建议顺序）

1. **默认模型/服务方从哪来**（§3.2 第 6 条）。不解决它，真界面上的一轮会用 `pi` 的配置而不是产品的配置；这决定 `admin.json` 的企业预置还生不生效。
2. **审批闸门接进桥**（§3.2 第 1、2 条）：`pi` 扩展 + `TurnPause`/`TurnResume` + 逐工具四档决定（探针修订 D：从 `ctx.sessionManager.getBranch()` 读整批，一次问完；`extension_ui_response` 单值要我们自己编码）。**接的同时必须改 `ToolStart` 的发送时机**（修订 B）。
3. **错误分类**（§3.2 第 4 条）+ 拿真模型复核 `copy.ts` 的大白话错误表。
4. 用量、压缩、`skills`、会话持久化/恢复（本段明确没做）。
5. Windows/WSL 真机走一遍（`pi` 找不找得到 shell、安装包怎么带 Node）。

---

## 5. 我没验证什么（先看这一节，再决定信到哪一层）

**没量到的：**

- **没有用真模型端点**。全套用 localhost 假端点，没有写任何密钥进仓库。真 provider 在流里返不返 usage、`stopReason` 的真实取值、工具名与提示词行为的差异，**都还没测**。
- **没有跑 Windows / WSL / 安装包**。`CREATE_NO_WINDOW` 抄了一份但没有真机验证；`pi` 在 Windows 上要不要 Git Bash、卡片提示词里的工具还在不在，原样保留（DECISION §7.4）。
- **没有打开窗口**。`the_rust_daemon_drives_the_adapter_without_changes` 走的是 Tauri 命令真正调用的 `Daemon` 那一层，**不是 webview**；「界面上真的显示出来」没验。
- **审批相关的全部安全语义没验**（见 §3.2 第 1、2 条）。桥的 fail-safe 只保证「不挂死」，不保证「问过人」。
- **`AgentMessage` 之外的消息形态没验**：只有文本 + 一次 `bash` 调用。多工具、工具失败（`isError:true`，只有单测）、思考块、`auto_retry`、真实压缩，都没跑。
- **`get_state` 成功但字段缺失的路径没验**：那种情况桥会发 `Info`（「没拿到助手的自述信息」）并给空 `session_id`，只在单测里覆盖了字段拼装，没有真的让 `get_state` 返回缺字段。
- **助手启动即退出那条路径只有 unix 单测**（用一个立刻退出的 shell 脚本），**没有用真实配置错误触发过**。
- **并发/背压没验**：第二条 `UserInput` 走 `steer` 的分支没有实测；stdout 被写满时的行为没有测。
- **`SKIP` 路径只在 macOS 上人为把 `PI_BIN` 指到不存在的路径验证过**，没有在真正的 CI（Linux/Windows，没装 pi）上跑过——那是这次提交后 CI 才会告诉我们的。

**推断（不是量到的）：**

- 「CI 只装 bun 不装 node」——来自 `.github/workflows/gui.yml` 的步骤清单，**没执行过 CI**。
- Windows 上没有 `pi` 时这几条测试会 `SKIP`（按 `binary_answers` 的逻辑推断），**没有 Windows 机器验证**。
- 「关 `pi` 的 stdin 就够它收敛」——探针测过空闲时 EOF 退出码 0；**没有测「正在跑一轮时 EOF」**。

**没做的（原因）：**

- 审批闸门、用量、会话持久化/恢复、skills/subagents、多会话、Windows 打包——任务明确划在本段之外；审批与权限是下一步的主体，不是漏做。
- 没有改 `daemon.rs`/前端/`tasks/**`/`gui/probes/**`/`DECISION-windows-runtime.md`（任务只许改列出的文件）。
