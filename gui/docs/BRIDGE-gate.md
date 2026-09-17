# 桥的审批闸门：`TurnPause` / `ApprovalResponse` 落到 `pi` 上（issue #103 方案 C）

> 这是 `BRIDGE-spike.md` 的下一段（它的 §4 第 2 条），也是 `PROBE-pi-rpc.md` 之后
> 把「先问人」接进产品协议的一刀。范围：`pi` 扩展 + `bridge.rs` 的闸门翻译。
> **权限语义（谁该被问）不在这里**，见 §5。
>
> 事实与推断分开写：带命令/断言的是**量到的**；文末「我没验证什么」请先看。

---

## 0. 结论先行

**探针 §2.2 那句「拒绝时命令真的不会执行」现在在产品的协议形状里成立了，而且一次能问一批。**

| 问题 | 结论 | 一句话证据 |
| --- | --- | --- |
| 前端那张 `ApprovalSheet` 在桥这条路上能不能工作？ | **能** | `bridge_pauses_a_call_and_a_denial_stops_it`：`TurnPause{reason.Approval.tools[{id,name,args}]}` 里的 `id` 就是 pi 的 `toolCallId`；回 `Deny` 后**标记文件不存在**，回 `Accept` 后**存在** |
| 同一轮的多个调用能不能合成**一条** `TurnPause`？ | **能** | `bridge_asks_once_for_a_batch_of_calls`：一条 assistant 消息里两个 bash → 全程**只有 1 条** `TurnPause`、里面 2 个工具 |
| 「部分允许、部分拒绝」能不能表达？ | **能**（靠我们自己的编码） | `bridge_can_allow_one_call_and_deny_its_sibling`：同一批里 1 个 `Accept`、1 个 `Deny` → 一个标记文件在、另一个不在 |
| 等待批准期间能不能中止？ | **能** | `bridge_can_interrupt_while_waiting_for_approval`：`TurnEnd{Interrupted}`，且什么都没跑 |
| 审批页开着时进度清单会不会已经写「正在运行」？ | **不会**（探针修订 B 已处理） | 单测 `an_allowed_call_releases_its_held_tool_start` + 集成断言「决定之前没有 `ToolStart`」 |
| `AcceptAlways`（以后都允许）能记住吗？ | **能记到本次运行结束**，不落盘 | `bridge_remembers_allow_always_for_the_session`：第一批选 Always，第二批同一工具名**不再弹**、直接跑；语义口径由 `plan_gate` 的单测钉住 |

一次工具调用的完整事件顺序（本机实测，与探针一致）：

```
… AgentMessage → TurnPause → [客户端回 ApprovalResponse] → TurnResume →
ToolStart → ToolUpdate… → ToolEnd → … → TurnEnd
```

---

## 1. 改了什么

| 文件 | 改动 |
| --- | --- |
| `gui/src-tauri/bridge-extension/index.ts`（新） | pi 扩展：在 `tool_call` 里**先拦**；从 `ctx.sessionManager.getBranch()` 读整批；用一次 `ctx.ui.select` 把「想做什么」交给桥；按桥的回答放行或 `{block:true}` |
| `gui/src-tauri/src/bridge.rs` | 把扩展的对话框翻成 `TurnPause`；把 `ApprovalResponse` 翻回扩展的回答；**缓存 `ToolStart` 到决定之后**；被拒时补 `ToolEnd{Denied}`；`Interrupt` 在暂停期间也能收场 |
| `gui/src-tauri/tests/bridge.rs` | 假端点加 `gate`（1 个调用）与 `gate2`（同一条消息 2 个调用）两个场景；驱动桥的机器人会应答 `ApprovalResponse`；新增 6 条闸门测试 |
| `gui/docs/BRIDGE-gate.md`（新） | 本文 |

`daemon.rs`、`commands.rs`、前端、`tasks/**`、`gui/probes/**`、`DECISION-windows-runtime.md`、
`BRIDGE-spike.md` 都**一行未动**；`Cargo.toml` 也没动（没有新依赖，扩展源码用
`include_str!` 编进二进制，启动时按内容哈希写到临时目录，再用 `pi -e <文件>` 加载）。

**为什么用 `select` 的 `options` 传批数据、用 `value` 回决定**：pi 的对话框协议里
`select` 的 `options` 是给用户看的选项、`value` 本应是选项之一，但 `rpc-mode`
对 `value` **不做校验**（`"value" in r ? r.value : undefined`，`pi 0.85.1`）。
于是桥可以把「逐个调用放行/拒绝」编码成一个字符串回来 —— 这是**我们和桥的约定**，
不是 pi 的能力。约定版本号写在两边的 `cante-gate:v1` 上；谁改了格式而没改另一边，
`gate_tools_only_accepts_the_marked_payload` 会红。**这依赖一个没有写进稳定契约的
细节**（见 §5 的风险 1），所以它有一条契约测试钉着。

---

## 2. 与探针 §3 的 7 条约束逐条对照

图例：**本段解决** / **本段加固** / **仍然缺**。

| # | 约束（探针 §3） | 状态 | 说明 |
| --- | --- | --- | --- |
| **A** | `TurnEnd` 只在 `agent_settled` 发；`turn_end` 只数 `steps` | **本段加固** | 原样保留。**新量到一条**：在「等待批准」时中止，pi 回的是 `stopReason:"error"` + `errorMessage:"This operation was aborted"`，**不是** 流式中止时的 `"aborted"`。若照直翻译，用户按「停止」会看到一条错误。现在 `requested_abort` 优先于 `stopReason`（单测 `a_requested_stop_beats_an_abort_error`） |
| **B** | `tool_execution_start` 早于审批钩子 → `ToolStart` 必须缓存到放行后 | **本段解决** | `TurnState` 把每个 `ToolStart` 先扣住；放行才发；被拒时发 `ToolStart` + `ToolEnd{Denied}`。**兜底**：如果 update/end 先到（说明这条调用没经过闸门），扣住的那条立即补发；turn 结束还没决定就补 `ToolEnd{Cancelled}` —— 任何情况下都不会留下一行永远「正在运行」 |
| **C** | `message_update.usage` 恒为 0，`UsageUpdate` 要从 `message_end` 取 | **仍然缺** | 本段没做 `UsageUpdate`（前端不读，与 spike 相同） |
| **D** | 「攒批」做不到；但可以在钩子 1 里从 `ctx.sessionManager.getBranch()` 读整批 | **本段解决** | 扩展就是这么做的；`bridge_asks_once_for_a_batch_of_calls` 把「一条 assistant 消息 2 个调用 → 1 条 `TurnPause`」钉成回归网（探针 §5 风险 2 要求的那条契约测试） |
| **E** | `extension_ui_response` 只能表达是/否；`cancelled`/超时 = 默认拒绝 | **本段解决（换了个做法）** | 见 §3：单值回应确实表达不了逐工具决定，**所以逐工具决定由我们自己编码在 `value` 里**。读不懂、`cancelled`、没答 → 全拒（fail-safe） |
| **F** | block 路径不发 `tool_result` 钩子；成败只看 `tool_execution_end.isError` | **本段确认** | 被拒调用的 `tool_execution_end.isError=true` 被桥**丢掉**（已经发过 `Denied`），不会出现两条 `ToolEnd`。单测 `a_denied_call_is_closed_without_running_and_its_result_is_swallowed` |
| **G** | `abort` 的 response 在 `agent_settled` 之后才回；不要等它才发 `TurnEnd` | **本段加固** | 原样保留。**新量到一条**：`ctx.ui.select` 不带 `signal`、不带 `timeout` 时，`abort` **不会**让对话框返回（钩子一直 await，preflight 不结束，回合卡死）。现在两层兜底：扩展把 `ctx.signal` 传进去，桥在 `Interrupt` 时再补一条 `cancelled:true` |

另外两条探针 §5 的风险，本段的处理：

- **风险 1「闸门的强度 = 扩展的覆盖率」**：扩展**不按工具名过滤**，`tool_call` 一视
  同仁地拦（不是只拦 bash）。这条给的是「所有调用都进钩子」；**哪一种该问** 是权限
  策略，本段没有（§5）。
- **风险 2「依赖 pi 内部行为」**：批处理依赖「钩子触发时兄弟调用已在会话里」。
  已变成一条假端点 + 真 pi 的契约测试（`bridge_asks_once_for_a_batch_of_calls`），
  pi 升级后行为一变就红，而不是靠读一次代码。

---

## 3. 「部分允许、部分拒绝」——解决了，以及代价

`PROBE-pi-rpc.md` §6 写的是「单值回应表达不了这个」。**它是对的，但那只限制了
「用 pi 的原生语义」**：`extension_ui_response` 一次只带一个 `value`。我们不在
原生语义里说话，而是：

```
请求（扩展 → 桥）  options = ["cante-gate:v1", {"v":1,"tools":[{id,name,args}…]}]
回答（桥 → 扩展）  value   = {"v":1,"allow":[id…],"deny":[id…],"reason":"…"}
```

扩展按 `allow` 集合放行，其余（包括读不懂的回答）一律 `block`。
`allow` 里出现不在这批里的 id 会被丢掉，免得一个编码错误把别的调用捎带放行。

实测：`bridge_can_allow_one_call_and_deny_its_sibling` 里同一批两个 bash，
一个 `Accept`、一个 `Deny` → `gate-ran-1.txt` 在、`gate-ran-2.txt` 不在，
`ToolEnd` 一个 `Completed` 一个 `Denied`。

**代价（要写清楚）**：这依赖「pi 不校验 `value ∈ options`」。`pi 0.85.1` 实测如此
（假端点 + 真 pi，本文件 §6 可复现），但这是 pi 的内部实现，不是契约。升级 pi 后
如果它开始校验，桥会被"回答被拒"，闸门退化成全拒 —— 安全方向，但用户会发现
「允许了却不执行」。这条只能靠升级时重跑本文件 §6 来发现。

**前端那一侧的现状（诚实说）**：协议现在支持逐工具决定，但 `ApprovalSheet.tsx`
的三个按钮是**整批同一个决定**（`answer(decision)` 给每个工具同一个值）。所以
「部分允许」今天只有在协议/桥这一层成立、有测试；界面上还点不出来。要真用上，
前端得改成逐工具选择 —— 那不在本任务范围内。

---

## 4. `AcceptAlways` / `AcceptForSession`：桥这一层能做到什么

先说结论：**`AcceptAlways` 在桥这一层不落盘，只记到本次运行结束**。它和
`AcceptForSession` 现在的行为**完全相同**：把「工具名」记进桥的内存，本次运行内
同一工具名不再问。下次启动应用会重新问。

- **为什么只能到这一步**：协议里 `AcceptAlways` 的语义是「落盘一条 allow 规则到
  settings，以后会话自动放行」（`crates/protocol-shape/src/msg.rs:304`）。
  这条规则长什么样（工具名？命令前缀？危险命令识别？）属于权限引擎，本段没有
  （§5），而且**上游 cante 的实现不在这个仓库里**，我们看不到它的规则语义。
  与其猜一个，不如把做不到的部分说清楚。
- **记住的粒度是工具名**：选了「以后都允许」的一个 `bash` 调用之后，本次运行里
  **后续每一个 bash 都不再问**，包括另一个危险命令。这是「工具名」这个粒度固有的
  代价，也是今天最容易被骂的一点；等规则引擎上来后应该改成「带参数的规则」。
  单测 `only_tools_the_user_allowed_for_this_session_skip_the_question` 与
  `a_plan_denies_anything_the_window_did_not_answer_for` 钉住这个语义。
- **`Accept` / `Deny`**：只作用于这一次调用，已实测。
- **`Deny`**：命令真的不执行（文件系统事实），并且理由（如果客户端给了 `message`）
  会回给模型；没给就用「用户拒绝了这个操作」。

---

## 5. 仍然缺的：权限策略（这是产品律 2 的主体）

本段交的是**机制**：所有工具调用都会经过钩子、会问、拒绝真的拦住。
**「哪一种调用应该问」这件事仍然没有实现**，而它才是
`DECISION-windows-runtime.md` §3.2 第 2 条说的那个大块：

- 现在**每一个**工具调用都会弹审批页 —— 包括读文件、找文件、查内容。机制上是
  fail-safe（问多了不会弄坏东西），但作为产品是不可用的。**这是下一段的第一件事。**
- `strict` / `auto` / `yolo` 三档、危险命令识别、`AcceptAlways` 落盘、企业预置
  都还没接（`permission_mode` 目前仍然只是 `SessionInfo` 上的标签）。
- `TurnEnd.Error` 的分类、用量、会话持久化/恢复照旧没做（与 spike 相同）。

---

## 6. 怎么复现（本机）

前置：`pi` 在 PATH（或 `PI_BIN` 指过去）、Rust 工具链（macOS 上先
`source gui/scripts/toolchain.sh`）。假端点由 `tests/bridge.rs` 自带，
**不需要模型端点、不需要密钥**。

```bash
cd gui
source scripts/toolchain.sh
# 本机没有 timeout：用探针目录里的包装脚本给整条命令设上限（AGENTS.md §5）
bash probes/rpc/with-timeout.sh 1200 cargo test \
  --manifest-path src-tauri/Cargo.toml --test bridge -- --nocapture --test-threads=1
```

本机（macOS、`pi 0.85.1`）结果：**11/11 通过，30.9 秒**；`bridge.rs` 的单元测试
**23/23**。没装 `pi` 的机器（CI 就是）：6 条闸门测试与其余需要 `pi` 的会打印
`SKIP`，探活子命令与「助手启动即死」两条仍然真跑 —— **跳过与通过分开看**。

闸门测试各自的断言（都进 CI）：

| 测试 | 断言的是哪件事实 |
| --- | --- |
| `bridge_pauses_a_call_and_a_denial_stops_it` | `TurnPause` 的 `tool_use_id` = 真 `toolCallId`；决定前没有 `ToolStart`；`Deny` → 标记文件不存在、`ToolEnd{Denied}`、turn 仍然 `Completed` |
| `bridge_runs_an_accepted_call` | `Accept` → 标记文件存在、`ToolEnd{Completed}` |
| `bridge_asks_once_for_a_batch_of_calls` | 同一条 assistant 消息两个调用 → 全程 1 条 `TurnPause`、2 个工具、两个都跑 |
| `bridge_can_allow_one_call_and_deny_its_sibling` | 同批 1 允许 1 拒绝 → 一个标记文件在、另一个不在 |
| `bridge_can_interrupt_while_waiting_for_approval` | 暂停期间 `Interrupt` → `TurnEnd{Interrupted}`、什么都没跑 |
| `bridge_remembers_allow_always_for_the_session` | 同一次运行内第二批不再问；标记文件被删掉后又能重建（证明真跑了） |

---

## 7. 我没验证什么

**没量到的（按重要程度）：**

- **审批页真的显示出来没有**：所有测试都停在桥的 stdout 这一层，**没有打开 webview**
  （和 `BRIDGE-spike.md` 一样）。`ApprovalSheet` 收到 `TurnPause` 会长什么样、
  「允许/不允许/以后都允许」点下去前端会发出什么，**没在真界面上验过**。
- **真模型**：全套仍用 localhost 假端点。真模型会不会把多个工具放在同一条 assistant
  消息、会不会调用 `read`/`write`/`edit`，**都没测**。扩展不按工具名过滤，所以
  `read`/`write` 也会进钩子；但**只有 bash 这条路径端到端跑过**。
- **`AcceptAlways` 的持久化**：没做（§4）。settings 文件一行未动。本次运行内的
  记忆有端到端（`bridge_remembers_allow_always_for_the_session`），**跨启动不复现**
  这件事只能靠读代码确认，没有重启两次应用的验证。
- **Windows / WSL / 安装包**：一行没测。临时目录写扩展文件这条路在 macOS 上通；
  Windows 上 `-e C:\...` 作为一个参数传给 `Command::args` 是唯一的信心来源
  （推断，**没有真机**）。
- **临时文件的清理**：按内容哈希命名、**从不删除**（下次复用）。多用户 Linux 上
  `/tmp` 是共享的：如果有人预先把同名文件换成别的内容，桥会覆盖它（rename 原子），
  但「检查内容」与「pi 读取」之间仍有极小窗口。**没有做敌手测试**。
- **`message` 字段**：`TurnPause.reason.Approval.message` 目前发空串
  （`ApprovalSheet` 自己会用工具条数说「它想先做 N 件事」）。**没有在界面上比对过**
  「有没有 message」的观感差别。
- **多个闸门同时开着**：桥只保留**一个** `PendingGate`。这依赖 pi「兄弟调用顺序
  preflight、下一批要等上一批执行完」这条实测行为（探针 §3 D）。**并行 preflight
  跨消息**没有测，也没有防御。
- **`timeout` 路径**：扩展故意不给对话框设 timeout（怕把「她还在想」当成「她说不」）。
  所以「到点自动拒绝」这条在本段的路由上**到不了**；探针也说过没测过。

**推断（不是量到的）：**

- 「CI 不装 pi，所以闸门测试会 SKIP」——按现有 `binary_answers` 逻辑推断，
  和前一段相同，**没有在真 CI 上肉眼确认过**。
- 扩展把 `ctx.signal` 传给 `select` 能让 abort 解除对话框：是本段加的，但
  **单独验证不了**——`bridge_can_interrupt_while_waiting_for_approval` 同时有桥那条
  `cancelled:true` 兜底，分不清是哪一层起的作用。两条都留着。

**没做的（原因）：**

- 权限策略、危险命令识别、四档里的持久化语义、`TurnEnd` 错误分类、用量、会话
  持久化/恢复、Windows 打包 —— 任务明确划在本段之外（其中权限策略是下一段的主体，
  不是漏做）。
- 没有改 `daemon.rs`/`commands.rs`/前端/`tasks/**`/`gui/probes/**`/
  `DECISION-windows-runtime.md`/`BRIDGE-spike.md`（任务只许改列出的文件）。
