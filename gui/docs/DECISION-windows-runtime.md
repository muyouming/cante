# 决策文档：Windows 上「干活的那一半」怎么办（issue #103）

> 本文只做调研与设计，不改任何产品代码。所有**查到的事实**都带文件与行号；凡是我自己算出来的
> 都明确标成**推断**。文末有「我没能验证的」一节——先看那一节，再决定信到哪一层。

---

## 0. 结论先行

1. **现状不是「功能少一点」，而是「装完什么也干不了」。** 我们在 Windows 上能装上、能渲染（CI 双平台
   已经过了），但产品真正干活的那一半（`cante serve`）**上游只发布 macOS/Linux**。界面上给出的唯一
   出路是一句「干活需要的组件还没装好，请找配置这台电脑的同事或管理员装一下」（`gui/src/simple/copy.ts:97`），
   而**那个组件在 Windows 上不存在**。产品律 1 与产品律 3 同时不成立。

2. **不要指望「上游出个 Windows 构建」当作计划。** 两条硬事实：上游 README 明说 Windows 建议用 WSL
   （`README.md:19`，`docs-site/docs/start/overview.mdx:44`）；**守护进程的源码不在本仓库里**——全仓库只有
   `examples/mini-tui/src/main.rs` 与 `gui/src-tauri/src/main.rs` 两个 `main.rs`，没有根 `Cargo.toml`，
   `crates/` 只有 4 个公开发布的小 crate（+ 一个 1 行的 `cante-acp/src/lib.rs`）。
   也就是说：**这条路既不可控，我们连补丁都做不了，只能等。**

3. **推荐方向：把运行时换掉（方案 C），第一步用 `pi --mode rpc` 做适配器**，理由是「换掉的东西」比想象中
   小得多——简单模式下前端**只用到 6 个协议命令**（下一个数字不是估计，是数出来的，见 §1.2）。协议不变，
   Rust 桥和整个前端一行都不用改（`gui/src-tauri/src/daemon.rs:565` 只是在 `CANTE_BIN` 后面追加 `serve`）。

4. **但真正的风险不在「协议翻译」，在「审批闸门」**：`cante` 的权限系统（strict/auto/yolo + 规则 +
   会话授权 + 危险命令识别 + `TurnPause` 一次暂停审批一批工具）**在 pi 里根本没有对应物**
   （`pi/docs/security.md:31`「No Built-in Sandbox」；`pi/docs/extensions.md:19` 的「Permission gates」
   是**扩展示例**，不是核心）。pi 只能靠一个 `tool_call` 扩展 + `extension_ui_request` 把闸门拼出来
   （`pi/docs/extensions.md:778`、`pi/docs/rpc.md` Extension UI Protocol）。**方案 C 的适配层里，安全关键代码
   要我们自己写——这是这份文档里最该被评审的一段。**

5. **最快的一步（≤1 天，不写产品代码）不是写适配器，而是一个探针**：用 `pi --mode rpc` + 一个假的
   OpenAI 兼容端点，验证三件事——(a) 流式文本与工具执行事件真的按 JSONL 出来；(b) 扩展能在 `tool_call`
   里 block 并靠 `extension_ui_request → response` 完成一次「先问人」；(c) `abort` 之后 `stopReason` 是
   `aborted`（能翻成 `TurnEnd.Interrupted`）。这三条决定方案 C 是「一两周」还是「根本不行」。见 §4。

6. 建议**在 ROADMAP 里先记成「待定」**（已照办），等 §4 的探针结果回来再拍板。

---

## 1. 事实与出处

### 1.1 上游（`cante` / `ante`）的事实

| 事实 | 出处 |
| --- | --- |
| README 顶部警告：**macOS and Linux only**；Windows 建议用 WSL | `README.md:19` |
| 文档站同一句话：Currently only **macOS** and **Linux** are supported | `docs-site/docs/start/overview.mdx:44` |
| 官方安装方式只有一句 shell：`curl -fsSL https://cante.run/install.sh \| bash`（另见 `cante update` 重跑同一个脚本） | `README.md:26`、`docs-site/docs/start/update.mdx:7` |
| 二进制是**单个自包含可执行文件**，`grep`/`git` 内嵌，本地推理由它自己托管的 llama.cpp 提供 | `README.md`（"one ~15MB compressed download… single Rust executable with zero runtime dependencies"、"the heavy parts (Grep, git) are embedded"） |
| `--sock` 走 **Unix domain socket**（`~/.cante/run/serve.sock`），并有独占锁 | `docs-site/docs/usage/serve.mdx`（Unix socket transport） |
| 进程组/生命周期是 **Unix 实现**，非 Unix 只有降级回退 | `crates/exec/README.md:29`（"Process-group behavior is implemented on Unix; non-Unix fallbacks do not provide equivalent lifecycle guarantees"） |
| 公开 crate 里有 28 处 `cfg(unix)`（`setsid`/`setpgid`/`killpg`/`PR_SET_PDEATHSIG`/`libc`） | `grep -rn "cfg(unix)" crates/ --include=*.rs \| wc -l` → 28；`crates/exec/src/process_group.rs`、`crates/exec/src/subprocess.rs` |
| 上游确实动过 Windows，但停在「TUI 渲染」这一层：`Add Windows compatibility`(v0.preview.17)、`Restore Windows WSL skip`(v0.preview.18)、「fullscreen … for Windows consoles and similar」(v0.preview.97) | `CHANGELOG.md:954`、`CHANGELOG.md:946`、`CHANGELOG.md:43` |
| 在线评测（Terminal-Bench）与 release 由上游自己跑 | `README.md`、`.github/workflows/cante-harbor.yml` |

**关于「release 里只有 4 个 target」**：任务背景里给了这句话，但**我这台机器 DNS 解析不了
`cante.run`（`Could not resolve host`），也没法访问 GitHub release**，所以**这一条我没有亲自核到**，
按任务背景采用。仓库内能找到的旁证只有上面那几条（安装器是 bash 脚本、README/文档只承诺两个平台）。

### 1.2 我们实际依赖守护进程的哪一面（这一节全是数出来的）

`gui/CONTRACT.md` 与 `gui/src-tauri/src/daemon.rs` 里的命令面比产品实际用到的**大得多**。

**Rust 桥一共暴露 18 个「要发给守护进程」的命令**（`gui/src-tauri/src/lib.rs:55-88`）：
`health`、`events_since`、`start_session`、`update_session`、`send_input`、`steer`、`shell_input`、
`ambient_phrase`、`ambient_suggestion`、`approve`、`interrupt`、`compact`、`context_report`、`slash`、
`goal`、`catalog`、`set_cwd`、`shutdown`。

**简单模式的前端只会调其中 6 个**（`grep 'invoke("' gui/src/store.ts` + `gui/src/simple/Wizard.tsx:108`）：

| 命令 | 前端调用点 | 翻成的 op |
| --- | --- | --- |
| `health` | `store.ts:479`、`Wizard.tsx:108` | 起进程探活 + `cante --version`（`daemon.rs:391`）/ `cante catalog`（`daemon.rs:324`，前端不调 catalog） |
| `events_since` | `store.ts:432`、`store.ts:464` | 环形缓冲，不发给守护进程 |
| `start_session` | `store.ts:807`（只传 `permission_mode: "Auto"`，见 `store.ts:493`、`store.ts:1043`） | `StartSession` / `ResumeSession`（`daemon.rs:462`） |
| `send_input` | `store.ts:1045`（`mode: "prompt"`） | `UserInput` |
| `approve` | `store.ts:830` | `ApprovalResponse{turn_id, responses[]}` |
| `interrupt` | `store.ts:812`、`store.ts:1141` | `Interrupt` |

其余 12 个（`update_session`/`steer`/`shell_input`/`ambient_*`/`compact`/`context_report`/`slash`/`goal`/
`catalog`/`set_cwd`/`shutdown`）**在生产路径上没有调用者**——ROADMAP 2026-09-16 那条「删掉已删界面的机制」
把它们的前端读法删了，Rust 侧的 handler 还在（死代码，不是契约）。

**事件侧同理。** 前端 reducer 真正处理的是（`gui/src/store.ts:559-800`，与 `CONTRACT.md` 的「Status
transitions」表一一对应）：`SessionStart`、`SessionUpdated`、`TurnStart`、`Thinking`/`ThinkingDelta`、
`AgentMessage`/`MessageDelta`、`ToolStart`/`ToolUpdate`/`ToolEnd`、`Info`/`InfoBlockStart`/`InfoBlockAppend`、
`CompactStart`/`CompactEnd`、`ContextReport`、`TurnPause`、`TurnResume`、`TurnEnd`、`Error`、
`SessionEnd`、`Goodbye`。

**「必须有」与「锦上添花」的分法（我的判断，依据是「有没有生产消费者」）**：

- **必须有（换运行时一个都不能少）**：
  - op：`StartSession`（字段只用到 `permission_mode`、可选 `cwd`；`model`/`provider` 前端不传）、
    `UserInput`、`Interrupt`、`ApprovalResponse{turn_id, responses[{tool_use_id, decision, message?}]}`、
    关闭 stdin（等价 `Shutdown`）。
  - evt：`SessionStart`/`SessionUpdated`（`SessionInfo.session_id/model{id,display_name,support_vision}/
    provider{id,display_name,base_url}/cwd/permission_mode`，`title`/`skills` 可为空）、`TurnStart`、
    `MessageDelta`、`AgentMessage`、`ThinkingDelta`、`ToolStart`、`ToolUpdate`、`ToolEnd`、
    `TurnPause{reason:{Approval:{message, tools[]}}}`、`TurnResume`、`TurnEnd{status, steps}`、
    `Error`、`SessionEnd`/`Goodbye`。
  - 还有 `cante --version`（`health` 的「有没有干活组件」就靠它，`gui/src/simple/Wizard.tsx:87`）。
- **锦上添花（可以先不做）**：`UsageUpdate`（**前端根本不读**，`grep '"UsageUpdate"' gui/src` → 0）、
    `Info`/`InfoBlock*`（守护进程的后台提示，缺了只是少几行信息）、`CompactStart`/`CompactEnd`
    （自动压缩时守护进程自己会发，映射很便宜，但产品不触发 `Compact`）。
- **现在没人用的（不用实现）**：`ContextReport`（只有被删界面调的 op 才会产生）、`SessionUpdated`
  的触发路径（`UpdateSession` 无人调）、`catalog`（`daemon.rs:324` 是唯一读它的人，前端不调）、
   会话恢复（`resume_session_id` 前端不传，`SessionOptions` 只有 `permission_mode`，`store.ts:105-107`）。

**产品侧还有三处「协议之外」的隐含依赖**（换运行时必须逐条对齐，否则承诺落空）：

| 依赖 | 为什么是依赖 | 出处 |
| --- | --- | --- |
| 工具名要落在产品的词表里 | 审批页把工具名翻成人话（`ACTIONS` 表按小写名查）；进度清单按名字分类成读/写/命令 | `gui/src/simple/approval.ts:25-40`（键是 `read`/`write`/`edit`/`bash`/`powershell`…）、`gui/src/simple/progress.ts:176-249`（`IGNORED_TOOLS`/`RUN_TOOLS`/`WRITE_TOOLS`/`READ_TOOLS`） |
| 错误的原文与分类 | 大白话错误靠一张正则表匹配**守护进程与系统实际吐出的英文**，再由 `TurnEnd.Error{headline, details, kind}` 兜底 | `gui/src/simple/copy.ts:169-259`（DICTIONARY）、`gui/src/protocol.ts:82-108`（`readTurnEnd`） |
| 「谁收到了内容」 | 隐私面板要如实写出服务方名字，名字来自 `SessionInfo.provider.display_name` | `gui/src/simple/privacy.ts:9-24`、`gui/src/store.ts:912-919` |

另外：卡片提示词信封（`gui/src/simple/tasks/prompt.ts` 的 `SAFETY_RULES`、`buildPrompt`）是**纯文本，
随 `UserInput` 发出去**，与运行时无关——这部分换宿主不用改。但它明确要求「缺工具先说」「只用在你这台
电脑上确实装了的工具」，**这两条都依赖宿主真的有一个会被审批拦住的 shell/写文件工具**。

### 1.3 三条路各自的事实

#### 路 A：让上游出 Windows 构建

- 守护进程源码不在本仓库（§1.1 第 2 条），我们**做不了**，只能提出请求。
- 从上游自己的文档能看出「加一个 target」不是加一行矩阵：
  - 进程组/超时/清理是 Unix 实现（`crates/exec/README.md:29`，28 处 `cfg(unix)`）；
  - 默认传输包含 Unix domain socket（`docs-site/docs/usage/serve.mdx`）；
  - 本地离线推理是**自己托管并 pin 版本的 llama.cpp**，且按平台/硬件挑产物（macOS 用 Metal；
    Linux 按 CPU/Vulkan/CUDA 分层回退）（`docs-site/docs/local/offline.mdx`，步骤 1）——Windows 意味着
    多一整套产物矩阵与兼容矩阵；
  - 官方支持渠道是 shell 安装器（`README.md:26`）与 `cante update`（`docs-site/docs/start/update.mdx:7`），
    Windows 上要重做安装/自更新/签名。
- **量级（推断）**：不是「一个 release job」，而是「一个新平台的持续维护」——保守按**数周到数月**的上游
  工作估算，且**工期在我们之外**，我们无法承诺、无法插队、无法验收中间态。

#### 路 B：换运行时 = `pi --mode rpc` 适配层

查到的事实（`pi` 本机 0.85.1，文档在 `/Users/muyouming/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/`）：

| 我们需要的东西 | pi 有没有 | 出处 |
| --- | --- | --- |
| JSONL over stdin/stdout，一条一行，命令/事件分离，支持 `id` 关联 | **有** | `rpc.md` §Framing / §Protocol Overview |
| 发一条指令并流式回文本 | **有**：`prompt`；流中是 `message_update.assistantMessageEvent.text_delta` | `rpc.md` §prompt / §message_update |
| 思考流 | **有**：`thinking_delta` | `rpc.md` §message_update |
| 工具开始/进度/结束 | **有**：`tool_execution_start` / `tool_execution_update`（累计结果）/ `tool_execution_end`（`isError`） | `rpc.md` §tool_execution_* |
| 回合边界 | **有**：`turn_start` / `turn_end`，以及更干净的 `agent_settled`（「不会再自动继续」） | `rpc.md` §turn_start / §agent_settled |
| 打断 | **有**：`abort`；消息的 `stopReason` 可为 `"aborted"`/`"error"` | `rpc.md` §abort、`session-format.md:88` |
| 会话持久化 / 恢复 | **有**：session JSONL 文件、`--session-dir`、`get_entries(since)` 当游标 | `rpc.md` §get_entries、`sessions.md` |
| 用量 / 上下文占用 | **有**：`message_update.usage`、`get_session_stats`（tokens、cost、`contextUsage`） | `rpc.md` §message_update / §get_session_stats |
| 压缩 | **有**：`compact`、`compaction_start/end`、自动压缩开关 | `rpc.md` §compact / §compaction_* |
| 重试与错误信息 | **有（形态不同）**：`auto_retry_start/end`、`extension_error`、命令级 `success:false, error` | `rpc.md` §auto_retry_* / §Error Handling |
| **审批闸门（`TurnPause`/`ApprovalResponse`）** | **核心没有**。官方安全文档写明「Pi does not include a built-in sandbox」；「Permission gates (confirm before `rm -rf`)」是**扩展示例**里的东西 | `security.md:31`；`extensions.md:19`、`extensions.md:70-73` |
| 可否自己补出审批 | **可以**：`tool_call` 钩子在工具执行前触发、**can block**，返回 `{block:true, reason}`；`ctx.ui.confirm()` 在 RPC 模式下变成 `extension_ui_request` → 客户端回 `extension_ui_response` | `extensions.md:778-793`、`rpc.md` §Extension UI Protocol |
| 三档权限 / 规则 / 会话授权 / 永久授权 | **没有**，得在扩展里自己实现 | 同上 |
| 模型/服务方配置、自定义 provider、本地 llama.cpp | **有**：`--provider`/`--model`、环境变量与 auth 文件、自定义 provider 扩展（含自定义流式实现）、llama.cpp router | `providers.md`、`custom-provider.md`、`llama-cpp.md` |
| Windows 原生运行 | **有，但需要一个 shell**：默认用 **Git Bash**（其次 PATH 上的 bash），可选 `powershell` 工具 | `windows.md` |
| 分发形态 | **npm 包**（本机安装体积 **155MB**，`engines.node >= 22.19.0`，`bin` 指向 `dist/bundle/cli.js`）；curl 安装器只写了 Linux/macOS；package.json 里有 `build:binary`（`bun build --compile`）脚本 | `package.json`（本机读到）、`index.md:8-16` |

**一句话**：pi 在「LLM + 工具循环 + 会话 + 用量 + 压缩」上几乎是我们的超集，**唯一的结构性缺口就是审批闸门
（以及围绕它的权限语义）**；另外分发形态从「一个自包含 exe」变成「一个 Node 运行时 + 一个 npm 包」。

#### 路 C：换运行时 = 自研宿主（用 `crates/llm` + `crates/exec` 起步）

把这两个 crate 读了一遍，它们**提供的东西比名字听起来少得多**：

- `crates/llm`（905 行）只有 **OpenAI 兼容的 provider 画像与参数映射**（思考方言、system role 策略、
  搜索参数、是否发图）。README 自己写着：「HTTP clients, authentication, catalog storage, and streaming
  stay in the Cante runtime for now.」（`crates/llm/README.md`）
- `crates/exec`（约 1500 行）是**异步进程执行工具**（有界输出、超时、交互 stdin、进程组清理），且非 Unix
  只有降级回退（`crates/exec/README.md:29`）。
- `crates/protocol-shape`（1410 行）是**类型定义**；`crates/cante-sdk` 是**协议客户端**（连的不是我们自己）。

所以「自研宿主」等于**从零写一个 agent harness**：provider HTTP + 流式解析、agent 循环与工具调度、
工具集（read/write/edit/glob/grep/bash + Windows 上的 shell 选择）、权限引擎、会话与持久化、重试与超时、
压缩、skills/子代理/MCP。我们手里只有那 905 行的画像映射和一套 Unix 优先的进程工具。

**量级（推断）**：最低可用的 harness（一个 provider + 6 个工具 + 审批 + 会话）**4k–8k 行**量级，
且每个新 provider 都要自己维护；达到今天 `cante` 的产品手感（错误分类、危险命令识别、重试、
本地 llama 托管）还要更多。**这条路比路 B 大一个数量级**，而且它把「模型兼容」这件长期苦活接回自己身上。

---

## 2. 三条路的对比表

| 维度 | 维持现状（Windows 装完不能干活） | 路 A：上游出 Windows 构建 | 路 B：换运行时（pi RPC 适配） | 路 C：换运行时（自研宿主） | 备选：把 WSL 做成安装步骤 |
| --- | --- | --- | --- | --- | --- |
| 谁来做 | 不做 | 上游（我们只能请求） | 我们自己（一个新模块） | 我们自己（一个 harness） | 我们自己（引导 + 文档） |
| 我们可控吗 | — | **不可控**（源码不在本仓库，无法插队） | **完全可控**，协议不变 | 完全可控 | 可控 |
| 能否在 Windows 原生把活干完 | **不能** | 能（若上游做） | 能 | 能 | 不能（要装 WSL） |
| 前端 / Rust 桥要改吗 | 不改 | 不改 | **不改**（`CANTE_BIN` 命令规格 + 追加 `serve`，`daemon.rs:526,565`） | 不改 | 基本不改 |
| 协议是否仍是上游契约 | 是 | 是 | 是（我们实现它，但要跟两套实现同步） | 是 | 是 |
| 审批（产品律 2 的地基） | 现成（上游做） | 现成 | **要自己写**（权限引擎 + 一个 pi 扩展；核心没有） | 要自己写 | 现成 |
| 「只在本机处理」 | 现成 | 现成 | 要重做（`local` provider + llama.cpp 托管不像上游那样自带） | 要重做 | 现成 |
| 错误的大白话映射 | 现成 | 现成 | 要复核（正则表按上游/系统措辞写的，`copy.ts:169-259`） | 要重写 | 现成 |
| 分发体积 / 依赖 | — | 不变（一个 exe） | **变大**：需带 Node 运行时（本机 pi 安装 155MB） | 不变（Rust） | 不变 |
| 画像机上的体验 | 装完失望 | 好 | 好 | 好 | **差**：要先装 WSL、重启、理解「另一个系统」 |
| 量级（推断） | 0 | 数周–数月（上游），工期不可控 | 第一版 2–4 周；能替换现状 5–9 周（见 §3.3） | 起步 4k–8k 行，明显更久 | 几天（引导 + 文案 + 真机走一遍） |
| 主要代价 | 产品律 1/3 长期不成立 | 等 | 安全关键代码自己写 + 双实现同步 + 体积 | 长期把模型兼容接回自己身上 | 与画像冲突（王姐装不了 WSL） |

---

## 3. 方案 C 的适配清单与量级

假设走「写一个协议适配器，让 `CANTE_BIN` 指向它」这条路（进程 argv 会多一个 `serve`，见 `daemon.rs:565`）。

### 3.1 要处理的每一类转换

**A 类：进程与传输（与运行时无关，纯协议）**

1. 接受 `serve` 参数（以及 `--version`、`catalog` 两个探活/枚举入口，`daemon.rs:391,324`）。
2. stdin 读 `{"op":…,"id":"op_<ULID>"}` 一行一条；stdout 写 `EventMsg{timestamp,id,event,parent}` 一行一条，
   `id` 用 `evt_<ULID>`（`gui/src-tauri/src/protocol.rs:154` 已经有一套 ULID 实现可参照）。
3. `Shutdown` / stdin EOF → 收好子进程、发 `Goodbye`、退出 0。
4. stderr 的行会成为界面上的 `cante://log`（`CONTRACT.md` 的 `cante://log`），别往 stderr 打乱码。
5. 退出时不能留下孤儿子进程（Windows 上尤其要小心——上游为此专门写了 `CREATE_NO_WINDOW`，`daemon.rs:550-556`）。

**B 类：op → pi 命令**

| 我们的 op | pi 的对应 | 备注 |
| --- | --- | --- |
| `StartSession{permission_mode,cwd,model?,provider?}` | `new_session` +（必要时）`set_model` / `set_thinking_level`，cwd 由进程启动参数决定 | 我们的产品默认从 `~/.cante/settings.json` 解析 model/provider（GUI 不传），**适配器要自己决定谁读这份配置** |
| `UserInput(text)` | `prompt`（流中若已有回合，需要 `streamingBehavior`） | 产品一次只跑一件事，一般不会撞上 |
| `Interrupt` | `abort` | 要翻成 `TurnEnd{Interrupted}` |
| `ApprovalResponse{turn_id,responses}` | `extension_ui_response`（回给 `tool_call` 钩子里的 `ctx.ui.confirm`） | **`turn_id` 要在适配器里自己造与维护**（pi 没有这个概念） |
| 关闭 stdin | `abort` + 退出 | — |
| （前端不用的）`Steer`/`SlashCommand`/`Goal`/`Compact`/`ContextReport`/`UpdateSession` | `steer`/`prompt("/…")`/`compact`… | 可以先返回「不支持」的错误，前端不会调 |

**C 类：pi 事件 → 我们的 `Evt`**

| pi 事件 | 我们的 `Evt` | 备注 |
| --- | --- | --- |
| `agent_start` / `turn_start` | `TurnStart{turn_id}` | `turn_id` 我们自己造 |
| `message_update` → `text_delta` | `MessageDelta` | 直接用 |
| `message_update` → `thinking_delta` | `ThinkingDelta` | 直接用 |
| `message_end`（assistant） | `AgentMessage` | 产品只把**完整**消息折进进度清单（`store.ts:626`），所以这里不能省 |
| `message_update` → `toolcall_start/delta/end` | （可选）提前发 `ToolStart` | 产品更信 `tool_execution_*` |
| `tool_execution_start` | `ToolStart{id,name,args}` | **工具名要映射成产品词表**（`approval.ts`、`progress.ts`） |
| `tool_execution_update` | `ToolUpdate{tool_use_id,seq,message}` | pi 给的是**累计**结果，要自己算增量或直接替换展示 |
| `tool_execution_end`（`isError`） | `ToolEnd{tool_use_id,tool_name,status,result_json}` | `isError:true` → `Failed`；被审批拦掉要发 `Denied`（pi 的 block 路径） |
| `tool_call` 钩子请求 `extension_ui_request` | `TurnPause{reason:{Approval:{message,tools[]}}}` | **这是核心缺口**，见 §3.2 |
| `agent_settled` / `turn_end` + `message.stopReason` | `TurnEnd{status:Completed}` / `Interrupted` / `Error{headline,details,kind?}` | `steps` 要自己数（`store.ts:761` 会读） |
| `auto_retry_start/end`、`extension_error` | `Info`（或 `Error`） | 锦上添花，但「大白话错误」会因此更准 |
| `compaction_start/end` | `CompactStart`/`CompactEnd{summary?}` | 便宜，顺手做 |
| 进程退出 | `SessionEnd` + `Goodbye` | 顺序按 `CONTRACT.md` |
| `message_update.usage`、`get_session_stats` | `UsageUpdate`（可选） | 前端不读，做不做都不影响界面 |
| — | `SessionInfo` | 从 `get_state`（sessionId、model）+ `get_available_models`（`input: ["text","image"]` → `support_vision`，`rpc.md` §Model）+ provider 配置来拼 |

**D 类：进程生命周期与探活**

- `--version` 要回一行能显示的东西（Wizard 的「有没有干活组件」只判断它非空，`Wizard.tsx:87`）。
- `catalog` 可以返回 `{"providers":[]}`（前端不调）。
- 被 Rust 桥 `Drop` 掉时（`daemon.rs:401-409`）只是关 stdin：适配器必须**在 stdin EOF 时收敛退出**。

### 3.2 现在**没有对应物**的部分（这是评估的真问题）

1. **审批闸门本身**。`TurnPause` 一次携带**一批**工具（`reason.Approval.tools[]`）加一句 `message`，
   界面上是一次决策、多个工具（`store.ts:815-833` 逐工具发 `responses`）。pi 的 `tool_call` 钩子是
   **逐调用**触发的，`ctx.ui.confirm()` 是**布尔**。要凑出我们的形状，需要：
   - 一个 pi 扩展（TypeScript，随适配器一起分发）负责在 `tool_call` 里拦住并把请求交给适配器；
   - 适配器把同批的多个请求**攒成一个 `TurnPause`**（或者在文案上退化成逐个问——那是产品体验的降级，
     得由产品侧决定）；
   - `extension_ui_response` 只能表达「是/否」，所以 **`Once`/`Session`/`Always`/`Deny` 四档、拒绝时带理由
     （`message`）、以及 `AcceptForSession`/`AcceptAlways` 的语义，全部要在适配器里自己实现**。
2. **权限模式与规则**：`strict`/`auto`/`yolo`（`docs-site/docs/configuration/permission.mdx`）、
   allow/ask/deny 规则、会话授权、`AcceptAlways` 落盘到 settings、以及 auto 模式下「危险 bash 仍然要问」的
   危险命令识别。产品默认用 `Auto`（`store.ts:493`）并把「破坏性动作先问人」当产品律——**这块代码写错
   就等于把产品律 2 弄坏**。pi 侧一点都没有（`security.md:31`）。
3. **`turn_id` 与「暂停/恢复」括号**：pi 没有回合 id，也没有 `TurnResume` 对应事件（我们得自己推断恢复时刻，
   `CONTRACT.md` 的 `TurnResume` 必须自己发）。
4. **`TurnEnd.Error` 的分类**（`kind`：例如 `oauth` 表示登录失效、`headline`/`details` 的分层）：
   上游在守护进程里做了分类；pi 只有错误文本 + 重试事件。大白话错误表的命中性会变差。
5. **`steps`**（界面会读，`store.ts:761`）：要自己数。
6. **默认模型/服务方的来源**：现在是守护进程读 `~/.cante/settings.json` + catalog 决定；`admin.json`
   的 `default_provider`/`default_model` 目前只用于首页显示（`gui/src/simple/admin-config.ts:24-27`、
   `gui/src/simple/Home.tsx:265`）。换成 pi 之后，「企业预置到底生不生效」取决于适配器读不读这些文件。
7. **本地离线推理**：上游自己托管 pin 版本的 llama.cpp（`docs-site/docs/local/offline.mdx`）。pi 能用
   llama.cpp router，但**托管、下载、按硬件挑产物**这件事要我们自己做，否则「只在本机处理」这条最强卖点
   在 Windows 上没有落地物（`gui/ROADMAP.md` §6.5）。
8. **`SessionInfo.skills`**：产品现在不读（`grep '\.skills' gui/src` 只剩 `ContextReport` 里的
   `skills_tokens`），可以恒为空数组——但它写在契约里，要显式决定。
9. **Windows 上的 shell 语义**：pi 默认找 Git Bash（`windows.md`），而卡片提示词的信封要求「只用在你这台
   电脑上确实装了的工具」（`gui/src/simple/tasks/prompt.ts:16-17`）。适配器（或 pi 的 `defaultTools` 配置）
   必须明确 Windows 上用 bash 还是 powershell，而且这个选择要能被现有卡片正确读到。

### 3.3 量级估计与估法

**估法（按同类模块的历史规模折算，不拍脑袋）**：

| 现有模块 | 行数 | 为什么可以当锚点 |
| --- | --- | --- |
| `gui/src-tauri/src/daemon.rs` | 767 | 协议的**一端**（客户端）：起进程、帧、环形缓冲、状态归约 |
| `gui/src-tauri/src/protocol.rs` | 333 | 同一件事的另一半：帧拆分、ULID、状态归约 |
| `gui/src-tauri/src/pdf.rs` | 978（含测试） | 团队「自己写一个新子系统」的真实产出规模 |
| `gui/src-tauri/src/sheets.rs` | 849（含测试） | 同上 |
| `gui/fixtures/fake-cante.ts` | 176 | 协议**服务端**的脚本化下限（无 LLM、无工具、无权限） |

适配器 = 协议服务端（≥ daemon.rs 那一端的量级）+ 两类翻译（B/C）+ **一个权限引擎（pi 侧为零）** + 探活 /
会话元数据拼装。参照 `fixtures/fake-cante.ts:176` 是「什么都不做」的下限，`pdf.rs:978` 是「一个能上生产的
子系统」的量级。

**我的估计（推断，不是查到的事实）**：

| 阶段 | 内容 | 新代码量级 | 人日（1 名熟练工程师，含测试与调试） |
| --- | --- | --- | --- |
| C-1 能跑通一张卡 | 6 个 op + 「必须有」的事件 + 单档审批（全部当 Once）+ `--version` | 1.5k–2.5k 行 | **2–4 周** |
| C-2 能替换现有守护进程 | 加上权限引擎（三档 + 规则 + 会话/永久授权 + 危险命令）、错误分类、`steps`、压缩、配置解析、Windows shell 决策 | 3k–5k 行（不含 pi 扩展本身） | **5–9 周** |
| C-3 产品承诺不打折 | 卡片真机普查 26 张重跑、审批文案、大白话错误、本地推理落地、安装包带 Node | — | **再加 3–6 周** |

（换算口径：按 100–150 行/日含测试；参考本仓库 `pdf.rs` 978 行、`sheets.rs` 849 行这类子系统的既有规模。
这个口径是我的推断，如果评审认为偏乐观/偏悲观，可以只改这一行数字，不影响上面的结论结构。）

---

## 4. 最小验证实验（先做哪一步能最快证伪）

**不要先写适配器。** 先做一个**半天到一天**的探针，它能在 CI 里跑、不需要真模型，回答三个决定性问题：

**阶段 0：探针（≤1 天，不碰产品代码）**

- 造一个**假的 OpenAI 兼容端点**（本仓库已有同性质先例：`gui/fixtures/fake-cante.ts` 是假守护进程，
  这里换成假模型端点，返回一段固定的 SSE 流：一句话 + 一次工具调用）。
- 起 `pi --mode rpc`，把它指向那个假端点（走 pi 的自定义 provider 扩展或兼容端点的环境变量；
  具体哪种形式由探针当场验证），发 `{"type":"prompt",…}`，把 stdout 原样存成 JSONL，断言：
  1. **事件序列**：`agent_start` → `message_update(text_delta)` → `toolcall_*` → `tool_execution_start/update/end`
     → `agent_settled`。→ 决定 C 类翻译能不能成立。
  2. **审批**：加载一个最小的 pi 扩展，在 `tool_call` 里 block 并 `ctx.ui.confirm()`；断言 stdout 上真的出现
     `extension_ui_request`，并且回一条 `extension_ui_response` 之后工具才继续。→ 决定 §3.2 第 1/2 条能不能成立。
  3. **打断**：发 `{"type":"abort"}`，断言随后的消息 `stopReason` 是 `aborted`（能翻成 `TurnEnd.Interrupted`）。
     → 决定「点停止」这条产品行为在 Windows 上还成不成立。
- **失败也可以很有价值**：如果 (2) 不成立，方案 C 就当场被否掉，省下几周。

**阶段 1：最小适配器（1–2 周，1.5k–2.5k 行）**

- 只做 6 个 op 与「必须有」的事件，`CANTE_BIN` 指向它（`daemon.rs:526` 的 `CANTE_BIN` 是命令规格，
  所以可以是 `"node <适配器脚本>"`，Rust 侧会追加 `serve`）。
- **验收标准（可判定）**：
  1. 契约测试：把现有 fixture 测试的驱动方式照搬（`bun test gui/fixtures`）——协议形状、环形缓冲、
     状态归约、断流、超大行，全过。
  2. 一张真卡：`bash gui/scripts/task-sweep.sh excel.merge`（脚本本身就是协议客户端，
     会写 `StartSession`/`UserInput`/`ApprovalResponse`，`gui/scripts/sweep/sweep.py:743-760`；
     `CANTE_BIN` 优先，`sweep.py:950`）。产出核对结果与 macOS 上跑真 `cante` **同一档**。
  3. 三种结局都能在界面上表现出来：成功（`Completed`）、点停止（`Interrupted`）、故意填错密钥（`Error`
     → 结果卡片的「发生了什么 / 你可以怎么做 / 复制详情」）。
  4. 审批四档（Once/Session/Always/Deny）都真的起作用，且 Deny 之后助手会调整做法而不是卡死。
- **决策点**：用阶段 1 的**真实工时 ×2** 外推 C-2，再决定是否继续（不要用 §3.3 的估计代替实测）。

---

## 5. 风险

1. **安全关键代码是我们新写的**（permission engine）。产品律 2「破坏性动作先问人」目前由上游实现，
   换成适配层后由我们负责；一旦语义走偏（比如 `AcceptForSession` 泛化过头、或危险命令识别漏了），
   代价是用户的文件。缓解：把权限引擎做成**纯函数 + 独立单测**（照本仓库 `copy.ts`/`progress.ts`/
   `recovery.ts` 的既有做法），并把「拒绝带理由」纳入契约测试。
2. **回归面比想象大**：卡片提示词是按 cante 的工具集与提示词惯例写的，换宿主后同一张卡的完成路径会变
   （工具名、是否分步、是否先问），26 张卡的真机普查要重跑；`#93` 那类「测了一条产品不会走的路」的坑
   正是这样来的（`gui/ROADMAP.md` §6.7）。缓解：普查脚本已经在，别只跑单测。
3. **两套实现会漂移**：协议仍是上游契约，但我们在自己实现它。上游改 `Op`/`Evt`（协议是版本化的）我们要跟；
   我们也会有一批「pi 没有、只能自己造」的语义（`turn_id`、`TurnEnd.kind`），长期看是负债。
   缓解：把差集写死成一个 `docs/` 里的对照表（本文 §3.2 就是草稿），每次协议变更对着它走。
4. **分发与体积**：从「一个自包含 exe」变成「Node 运行时 + npm 包」（本机 pi 安装 155MB）。安装包已经
   未签名（`docs-site/docs/usage/gui.mdx:107`），再加一个运行时会让体积、SmartScreen 与杀软问题更显眼。
   另外 **pi 的许可证我这次没核到**（见 §7），上线前必须核。
5. **本地/离线这条卖点会被削弱**：上游自带 llama.cpp 托管，pi 只是「能用 router」。要么我们补托管，
   要么「只在本机处理」在 Windows 上没有可点的落地物——后者会让隐私面板变成一句空话（产品律 3）。
6. **组织风险**：如果我们只在 Windows 上换、macOS 继续用 `cante`，那么**每个卡片/提示词改动都要在两种宿主上
   验收**，测试矩阵翻倍；如果两边都换，则等于永久离开上游的进化轨道（Terminal-Bench 迭代、新 provider、
   新工具、离线管理都拿不到）。这个取舍必须在拍板时明说。
7. **上游关系**：路 A 与路 B 不是完全互斥，但走 B 之后，我们提「请出 Windows 构建」的动力会消失；
   如果哪天想回去，代价是重做一遍对齐。反过来，如果只是等 A，那就得接受「Windows 上装完不能干活」继续存在。

---

## 6. 不做它会怎样（现状的代价）

1. **产品律 1 在画像机上直接不成立。** 「把这件事帮我做完」是产品的入口承诺；现状是装完只有
   「干活需要的组件还没装好。请找配置这台电脑的同事或管理员装一下，装好后点「重新检查」」
   （`gui/src/simple/copy.ts:97`）。在 macOS 上这句话是对的（确实可以装），**在 Windows 上它指向一个
   不存在的组件**——这已经不是「能力不够」，是产品在画像机上无法完成任何一件事。
2. **产品律 3 也不成立**：这条错误**没有出路**。`Wizard.tsx:87-93` 把「桥不可用」「组件缺失」「未知」
   分成三类，而我们的情况（平台缺口）会被显示成「组件缺失」，用户唯一的动作是去找一个不存在的东西。
3. **定位冲突被写在明面上**：`docs-site/docs/usage/gui.mdx:6` 与 `gui/ROADMAP.md` 都写「Windows 优先」，
   而 Windows 上的 GUI 确实能装、能渲染（CI 双平台 + `DEVELOPING-WINDOWS.md` 的办法一）。
   「能装」+「干不了活」= **装完失望**，对非 IT 用户是不可恢复的信任损失；ROADMAP 里已经有一条同类
   决定（#75：宁可提前说做不到，也不要让她白等然后失败），这里是它的放大版。
4. **真机证据永远缺一块**：卡片与提示词的每次改动，都只能在 macOS 上验收，而画像机是 Windows
   （`gui/DEVELOPING-WINDOWS.md` 开篇就把这件事写成「我们最大的验证缺口」）。这个缺口不是测试问题，
   是**产品在当前形态下无法在目标平台上被验证**。
5. **诚实边界正在变成口号**：`docs-site/docs/usage/gui.mdx` 的「What it does not do yet」已经承认了
   截图/附件/扫描件的边界，但**没有承认「Windows 上没有干活组件」**这一条最要命的。要么尽快把它写清
   （短期），要么尽快换掉运行时（中期）——**不能继续不写又不换**。

---

## 7. 我没能验证的（以及事实/推断的分界）

**事实（我读到/跑到/数到的）**：§1.1 与 §1.2 的每一行都带文件路径（多数带行号）；`pi --help` 的输出、
`pi` 包的 `package.json`（版本 0.85.1、`engines.node>=22.19.0`、安装体积 155MB）都是本机读到的；
`grep` 出来的调用点、`cfg(unix)` 计数、`crates/*/README.md`、`CHANGELOG.md` 的行号都是命令输出。

**推断（我算的，可能有偏差）**：§1.3 路 A 的「数周到数月」；§3.3 的全部行数与人日；§5 里关于
「两套宿主会翻倍验收成本」「体积会变大到影响 SmartScreen 观感」的判断；§6 里对用户心理后果的描述。
这些都可以被更准的数字替换掉，替换时**不要动** §1 与 §3.1/§3.2 的清单结构。

**没验证到的**：

1. **上游 release 的 target 列表（「只有 4 个 target」）**：本机 DNS 解析失败（`curl: (6) Could not resolve host: cante.run`），
   GitHub 也够不着。**按任务背景采用，未亲自核对。**
2. **`pi --mode rpc` 的真实端到端行为**：本文对 pi 的全部判断来自官方文档与 `pi --help`，
   **我没有真的起过 `pi --mode rpc`**（没有可用的模型端点，也不该在本轮动手）。§4 的探针正是为了补这一条。
3. **pi 的许可证**（`package.json` 里没读到 license 字段含义 / 仓库 LICENSE 未查）——上线前必须核。
4. **Windows 真机上的 pi**：`docs/windows.md` 说默认用 Git Bash；我们的卡片提示词在只装了 PowerShell 的
   机器上会怎样，**无从判断**（需要那台 Windows / RDP，见 `AGENTS.md` §6）。
5. **本仓库能不能构建上游守护进程**：我按「找不到 `main.rs`/根 `Cargo.toml`」推断它不在本仓库；
   没有去核对私有仓库是否存在（够不着网络）。

---

## 8. 进展（2026-09-17 更新）

这一节只记**已经落地或被实测推翻**的事，别把它当计划看。

| 步骤 | 状态 | 证据 / 在哪 |
| --- | --- | --- |
| §4 阶段 0：探针（三个问题：流式事件 / 扩展能否拦住并问人 / `abort`） | **做完了，三条答案都是「能」** | `gui/docs/PROBE-pi-rpc.md`；探针 10/10 场景、7.2 秒、**不需要真模型**，可进 CI |
| §4 阶段 1 第一刀：`StartSession` / `UserInput`（流式文本 + 工具）/ `Interrupt` | **做完了** | `gui/docs/BRIDGE-spike.md`、`gui/src-tauri/src/bridge.rs`、`gui/src-tauri/tests/bridge.rs`（5 条，没装 `pi` 时打印 `SKIP`）。**关键事实**：桥是通过**现有 `daemon.rs` 自己**走通的——`CANTE_BIN=cante-bridge` 即可，Rust 桥与前端**一行未改** |
| §3 最关键的 20%：把审批闸门接进桥（`extension_ui_request` ⇄ 我们的 `TurnPause` / `ApprovalResponse`） | **在做** | 分支 `ws/r19-gate`（本轮） |
| 真机验收（Windows 上装包、看界面） | **做完了两轮**（第一轮验的旧产物、第二轮验修复） | `gui/WINDOWS-ACCEPTANCE-1.md`、`-2.md`、`-3.md`；**当前构建在真 WebView2 里就是中文简单模式**（第一轮那个英文界面是 `gui-v0.1.0-rc1` 旧产物） |
| §3.3 的人日估计（2–4 周 / 5–9 周） | **仍然没有被实测** | 我们还没写适配器到"能用"的程度；目前只能说**没有根本性阻碍**，且第一刀比预想的小 |
| 上游出 Windows 构建 | **维持"不指望"** | 官方 README 明说 Windows 建议 WSL；守护进程源码不在本仓库（全仓库只有两个 `main.rs`、没有根 `Cargo.toml`）——**连补丁都做不了** |

### 这一段暴露出来的新约束（要加进 §3.1 的适配清单）

- **打包辅助程序别用 `externalBin`**（它要求 `<名字>-<target-triple>.exe`，校验发生在 build script 阶段、crate 自己的 `[[bin]]` 还没编出来 → 实测包都出不来）；tauri 会自动把主程序之外的 `[[bin]]` 装到主程序旁边。详见 `gui/WINDOWS-ACCEPTANCE-3.md` 与 #117。
- **npm 版的 `bun` 顶不住**：Rust 里 `Command::new("bun")` 在 Windows 上找不到 npm 的 `.ps1`/`.cmd` 包装，必须装官方 `bun.exe`（这条让 4 个 Rust 测试红过）。
- **路径与换行**：仓库里文本一律 LF（`.gitattributes`），否则 Windows 检出成 CRLF 会让"按行解析"的测试红（真发生过）。

### 现在可以回答"方案 C 到哪一步了"

**能干活（第一刀）+ 正在做会问人（闸门）**。也就是说：**最难的机制问题已经不再是未知数**，剩下的是工作量与打磨（用量、会话持久化、多窗口、Windows 上打包桥本身）。决策该交给产品：是继续投适配器，还是先只把"WSL + 如实告知"做成正式支持。
