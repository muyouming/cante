# 探针：`pi --mode rpc` 能不能当 cante 的宿主（issue #103 第一步）

> 这是 `DECISION-windows-runtime.md` §4「阶段 0」的实测结果。**不改任何产品代码**，只加
> `gui/probes/rpc/**` 与这份文档。探针本身不需要真模型（模型端点是一个本机假 HTTP 服务），
> 全套 7.2 秒跑完，可以进 CI。
>
> 事实与推断分开写：带命令/原始 JSON 的段落是**量到的**；标「推断」的是我算的。
> 文末有「我没验证什么」——先看那一节再决定信到哪一层。

---

## 0. 结论先行

决策文档 §4 要回答的三个问题，答案都是**能**：

| # | 问题 | 结论 | 一句话证据 |
| --- | --- | --- | --- |
| 1 | 流式文本增量、工具开始/结束、轮次结束能不能按行拿到？ | **能** | 一次 prompt 收到 34 条 JSONL：`text_delta` ×2 → `toolcall_start/end` → `tool_execution_start/update/end` → 第二个 `turn_end` → `agent_settled` |
| 2 | 一个**扩展**能不能在 `tool_call` 钩子里拦住调用，靠 `extension_ui_request → response` 完成一次「先问人」？ | **能** | 拒绝时命令**真的没执行**（标记文件不存在），`tool_execution_end.isError=true`，理由原样回给模型；客户端回 `cancelled:true` 也是拒绝（fail-safe） |
| 3 | `abort` 之后有没有 `stopReason: "aborted"`？ | **能** | `message_end`/`turn_end` 上都是 `"stopReason":"aborted"`，还有 `errorMessage:"Request was aborted"` |

**所以方案 C「根本不行」这个分支没有被证伪；三条路里最难的一条（审批闸门）机制上成立。**
但探针同时量到 **7 处**决策文档 §3.1/§3.2 没写到（或写得含糊）的适配约束，其中 3 处如果不照做，
界面/产品律会出问题——见 §3。§3.3 的人日估计**没有被推翻，也没有被实测**（我们没写适配器）。

---

## 1. 怎么复现

环境（本机实测）：`pi 0.85.1`、`node v22.23.1`、macOS。假端点与 runner 只用 node 标准库。

```bash
cd gui/probes/rpc
# 全套（每条命令都带超时；本机没有 timeout/gtimeout，所以用 with-timeout.sh 包一层）
bash with-timeout.sh 600 bash run.sh
```

产物（**不提交**，`.gitignore` 已排除 `.run/`）：

| 文件 | 是什么 |
| --- | --- |
| `gui/probes/rpc/fake-openai.mjs` | 假 OpenAI 兼容端点（SSE、按脚本回文本 + 工具调用；`scenario=tool/slow/multi`） |
| `gui/probes/rpc/approval-gate.ts` | 探针扩展：`tool_call` 里问人、block；四种模式 `select/confirm/batch/batch2` |
| `gui/probes/rpc/probe.mjs` | runner：起 `pi --mode rpc`，按行记录 stdout，脚本化回答 UI 请求 |
| `gui/probes/rpc/run.sh` | 一键跑 10 个场景，每条都带 60s 超时 |
| `gui/probes/rpc/with-timeout.{sh,py}` | 本机没有 `timeout`，用 python 提供同样语义（超时→124） |
| `.run/<场景>.jsonl` | 原始 stdout（一条一行，未加工） |
| `.run/<场景>.events.txt` | 事件类型序列 |
| `.run/<场景>.ext.log` | 扩展钩子日志（谁在什么时候被拦/放行） |

隔离：探针用 `PI_CODING_AGENT_DIR=<临时目录>` 起 pi，只放一份指向 `http://127.0.0.1:<port>/v1`
的 `models.json`；`PI_OFFLINE=1` 禁掉启动联网。**不用任何真密钥，也不碰 `~/.pi` 的配置。**

耗时（`/usr/bin/time`）：单跑 `stream` **0.83s**，全套 10 个场景 **7.22s**。所以这个探针可以原样进 CI。

---

## 2. 原始证据

### 2.1 流式事件（问题 1）

命令：`bash with-timeout.sh 60 node probe.mjs stream`。假端点第一轮回「文本 + 一次 bash 调用」，
第二轮（请求里出现 `role:"tool"`）回收尾文本。事件序列（原样，`/` 是我对 `message_update` 子类型的缩写）：

```
response/prompt  agent_start  turn_start  message_start  message_end
message_start  message_update/text_start  message_update/text_delta  message_update/text_delta
message_update/toolcall_start  message_update/toolcall_delta  message_update/toolcall_delta
message_update/toolcall_delta  message_update/text_end  message_update/toolcall_end  message_end
tool_execution_start  tool_execution_update  tool_execution_end
message_start  message_end  turn_end
turn_start  message_start  message_update/text_start  message_update/text_delta
message_update/text_delta  message_update/text_end  message_end  turn_end
agent_end  agent_settled
response/get_state  response/get_session_stats
```

关键原始行（都在 `.run/stream.jsonl`，这里只留必要字段）：

```json
{"type":"message_update","usage":{...,"totalTokens":0},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"我先看一下"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_probe_1","toolName":"bash"}}
{"type":"tool_execution_start","toolCallId":"call_probe_1","toolName":"bash","args":{"command":"echo CANTE-RPC-PROBE > \"…/tool-ran.txt\""}}
{"type":"tool_execution_update","toolCallId":"call_probe_1","toolName":"bash","args":{"command":"…"},"partialResult":{"content":[]}}
{"type":"tool_execution_end","toolCallId":"call_probe_1","toolName":"bash","result":{"content":[{"type":"text","text":"(no output)"}]},"isError":false}
{"type":"agent_settled"}
```

收尾那一轮 `turn_end.message`（第二回合）里能读到完整消息与用量：

```json
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"命令跑完了，事情办好了。"}],
 "api":"openai-completions","provider":"probe","model":"probe-model",
 "usage":{"input":100,"output":20,"cacheRead":0,"cacheWrite":0,"totalTokens":120,"cost":{...}},
 "stopReason":"stop","responseId":"chatcmpl-probe"},"toolResults":[]}
```

另外两条对适配层有用的：

- `message_start` 给的是**部分**内容（`"我先看一下"`），`message_end` 给的是**权威全量**
  （文本 + `toolCall` 块都齐）。所以 `AgentMessage` 必须从 `message_end` 取，不能从 `message_start`。
- 一次 `prompt` 里还有一对 **`role:"user"` 的 `message_start/message_end`**（回显用户输入），
  适配器要按 `role` 过滤。
- `get_state` 能拼出 `SessionInfo` 需要的东西（实测，端口是随机的）：

```json
{"model":{"id":"probe-model","provider":"probe","baseUrl":"http://127.0.0.1:64009/v1",
  "input":["text"],"reasoning":false,"contextWindow":32000},
 "thinkingLevel":"off","sessionId":"01a0acec-0fb6-72a3-b446-30610bf34c55","messageCount":4}
```

（`input:["text","image"]` 大概就是 `support_vision`；`--no-session` 时没有 `sessionFile`。推断。）

### 2.2 审批闸门（问题 2，最关键）

扩展（`approval-gate.ts`）在 `tool_call` 里 `await ctx.ui.select("允许执行这条命令吗？", ["允许一次","拒绝"])`，
选「拒绝」就 `return { block: true, reason: "用户拒绝执行这条命令" }`。命令本身会写一个标记文件，
所以「真的拦住了没有」是文件系统级的事实，不是看事件。

**放行**（`approval --decision allow`，`.run/approval-allow-select.jsonl`）：

```json
{"type":"extension_ui_request","id":"9a443a3e-…","method":"select","title":"允许执行这条命令吗？",
 "options":["允许一次","拒绝"],"timeout":120000}
{"type":"tool_execution_end","toolCallId":"call_probe_1","toolName":"bash",
 "result":{"content":[{"type":"text","text":"(no output)"}]},"isError":false}
```

→ 标记文件**存在**（`markerFileExists=true`），扩展日志：`ui.select returned "允许一次"` → `tool_call allowed`。

**拒绝**（`approval --decision deny`，`.run/approval-deny-select.jsonl`）：

```json
{"type":"extension_ui_request","id":"8dabe9dd-…","method":"select","title":"允许执行这条命令吗？",
 "options":["允许一次","拒绝"],"timeout":120000}
{"type":"tool_execution_end","toolCallId":"call_probe_1","toolName":"bash",
 "result":{"content":[{"type":"text","text":"用户拒绝执行这条命令"}],"details":{}},"isError":true}
```

→ 标记文件**不存在**（`markerFileExists=false`）；扩展日志 `ui.select returned "拒绝"` → `tool_call blocked`；
之后助手**没有卡死**，它拿到「用户拒绝执行这条命令」这个工具结果，继续把这一轮收尾
（`stopReason:"stop"`，`lastAssistantText:"命令跑完了，事情办好了。"`）。

**`ctx.ui.confirm`（布尔）同样可用**：`approval --decision deny --ui confirm` 得到
`{"method":"confirm","title":"…","message":"echo CANTE-RPC-PROBE > …"}`，回 `confirmed:false` → 同样拦住。

**客户端「关掉对话框」＝拒绝**（fail-safe，实测）：回 `{"type":"extension_ui_response","id":…,"cancelled":true}`
→ `select` 在扩展里拿到 `undefined` → 走拒绝分支 → `isError:true`、标记文件不存在。
（文档说 dialog 的 `timeout` 到期也得到 `undefined`/`false`，走同一个分支；**超时那条路径我没实跑**，见 §6。）

**一次决策、多个工具（cante 的 `TurnPause{reason:{Approval:{tools:[…]}}}` 形状）**：这是 §3.2 第 1 条
说必须自己拼的部分，我做了对照实验（假端点在同一条 assistant 消息里发 **2 个** bash 调用）：

- 逐调用 + 防抖 80ms（`--ui batch`）：**失败**，两次请求的标题都是「允许执行这 **1** 个操作吗？」。
  扩展日志时间戳证明钩子 2 是在钩子 1 resolve 之后才进来的（顺序 preflight）。
- 从会话里读整批（`--ui batch2`）：**成功**。钩子 1 触发时，`ctx.sessionManager.getBranch()` 的最后一条
  assistant 消息里**已经有两个** `toolCall`：

```
batch2 session-branch batch={"entryId":"d958f9fb","ids":[{"id":"call_probe_1","name":"bash"},{"id":"call_probe_2","name":"bash"}]}
batch2 ui.select batch=2 ids=call_probe_1,call_probe_2 allowed=true
```

  stdout 上只出现**一次** UI 请求：

```json
{"type":"extension_ui_request","id":"ec11e60e-…","method":"select",
 "title":"允许执行这 2 个操作吗？（bash、bash）","options":["允许一次","拒绝"],"timeout":120000}
```

  放行 → 两个工具都跑（两个标记文件都在）；拒绝 → 两个都 `isError:true`、两个标记文件都不在。

- **但逐工具的四档决定（Once/Session/Always/Deny + 拒绝理由）回不来**：`extension_ui_response` 只能
  回 `value`（单值）或 `confirmed`（布尔）或 `cancelled`。要一次问一批、又保留逐工具决定，只有两条路：
  在 `options` 字符串里塞我们自己的编码（例如 `allow:call_1,call_3|deny:call_2`）由扩展解析，
  或者退回逐个问（N 次弹窗）。**这是我们的约定，不是 pi 的能力**——见 §3 修订 D。

### 2.3 中止（问题 3）

命令：`bash with-timeout.sh 60 node probe.mjs abort`。假端点 `scenario=slow` 每 400ms 吐一个字，
runner 收到第一条 `text_delta` 后发 `{"id":"a1","type":"abort"}`。序列：

```
response/prompt  agent_start  turn_start  message_start  message_end
message_start  message_update/text_start  message_update/text_delta  message_update/text_end
message_end  turn_end  agent_end  agent_settled  response/abort
response/get_state  response/get_session_stats
```

`message_end`（`message_start` 是流中快照，`message_end` 是权威）原文：

```json
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"这是"}],
 "api":"openai-completions","provider":"probe","model":"probe-model","usage":{...},
 "stopReason":"aborted","responseId":"chatcmpl-probe","errorMessage":"Request was aborted"}}
```

→ `stopReason:"aborted"`（`turn_end.message` 上同样），能翻成 `TurnEnd.Interrupted`。

---

## 3. 额外量到的：§3.1 / §3.2 需要改的地方

> 编号 A–G 全部是**实测**（命令与文件在上面）。这些不是「顺序细节」，有 3 条照 §3.1 直接翻会出问题。

| # | 决策文档原文 | 实测 | 该怎么办 |
| --- | --- | --- | --- |
| **A** | §3.1 C 类：「`agent_settled` / `turn_end` + `message.stopReason` → `TurnEnd`」 | 一次 `prompt` 产生**两个** `turn_end`（工具调用各占一个 LLM 回合）。`turn_end` 是「一次 assistant 回复」，不是「用户的一轮」 | `TurnEnd` 只在 **`agent_settled`** 发；`turn_end` 用来数 `steps` |
| **B** | §3.1 C 类：「`tool_execution_start` → `ToolStart{id,name,args}`」 | 顺序是 `tool_execution_start` → **`extension_ui_request`** → `tool_execution_update/end`。工具开始事件**早于**审批钩子 | 必须把 `ToolStart` 缓存到闸门放行后再发；否则审批页还开着，进度清单已经写「正在运行」。被拒时发 `Denied` |
| **C** | §3.1 C 类：「`message_update.usage` → `UsageUpdate`」 | 流式期间 `usage` **恒为全 0**（假端点按 OpenAI 规范只在最后一个 chunk 给 usage，`turn_end.message.usage` 才是 `input:100/output:20`） | `UsageUpdate` 从 `message_end.message.usage` 取，别信流中的 |
| **D** | §3.2 第 1 条：「适配器把同批的多个请求攒成一个 `TurnPause`（或者退化成逐个问）」 | 「攒」做不到（防抖对照实验 batch-size 恒为 1）；但**从 `ctx.sessionManager.getBranch()` 读当前 assistant 消息**可以在钩子 1 里拿到全部兄弟调用，一次问完（batch2 实测：1 次 UI 请求、N 个工具） | 把「读会话拿整批」写进设计；逐工具四档决定需要我们自己定一个 `extension_ui_response` 的编码约定 |
| **E** | §3.2 第 1 条末尾：「`extension_ui_response` 只能表达是/否」 | 对；而且 `cancelled:true`（关窗/超时）在扩展里就是 `undefined`/`false` | 默认拒绝（fail-safe）已实测成立，写进契约测试 |
| **F** | §3.1 C 类：「`tool_execution_end`（`isError`）→ `ToolEnd`」 | block 路径**不发** `tool_result` 扩展钩子（allow 时发、deny 时不发） | 成败只看 `tool_execution_end.isError`，别依赖 `tool_result` 事件 |
| **G** | §3.1 B 类：「`Interrupt` → `abort` → 翻成 `TurnEnd{Interrupted}`」 | `response/abort` 在 `agent_settled` **之后**才回来（abort 会等 idle） | 不要等 abort 的 response 才发 `TurnEnd`；`stopReason` 在 `message_end` 上就能拿到 |

还有两条锦上添花的事实：`--no-session` 下无 `sessionFile`；每次运行 pi 的 **stderr 是干净的**
（实测 stderr 只有我们自己假端点的打印），对 `cante://log` 友好；stdin EOF 后 pi 退出码 **0**。

---

## 4. 对决策文档 §3 量级估计的修订

先说清楚：**§3.3 的「2–4 周 / 1.5k–2.5k 行（C-1）、5–9 周（C-2）」这次没有被实测推翻，也没有被实测支持**——
我们没写适配器，探针只证明机制可用。可以被探针替换掉的，是**风险结构**：

1. **最大的「不可行」风险消除了。** 决策文档 §0.4/§3.2 把「审批闸门」标成「方案 C 成败的判据」。
   实测：机制成立（拦住的是真进程，不是状态位），fail-safe 成立，批量问也成立。方案 C 从
   「两周还是不行？」变成「已知要写哪几块」。
2. **但「翻译很便宜」的印象要修正。** §3.1 的 B/C 类表格照抄会在 A/B/C 三处出错（`TurnEnd` 会提前、
   `ToolStart` 会早报、`UsageUpdate` 会一直是 0）。这三处都是**产品能看见**的错，不是内部细节。
   C-1 里「6 个 op + 必须有的事件」这一栏不能按「逐行查表翻译」估。
3. **审批层要写的东西比 §3.2 写的一条「一个 `confirm`」多**：批处理（读会话）、按 `toolCallId` 缓存决定、
   四档语义、拒绝理由、`TurnPause`/`TurnResume` 括号、危险命令识别——D 只解决了「一次问一批」的**机制**，
   **语义**（谁在什么模式下该被问）仍然全是我们的新代码（§3.2 第 2 条不变）。
   **推断**：这一块大致就是 §3.3 里 C-2 的主体，探针没有让它变小。
4. **探针自己的量级**：单次 0.83s、全套 7.2s、零真模型 → 这一条支持 §4「阶段 0 ≤1 天」的设定
   （实际是约 1 小时的跑 + 读文档）。它还顺带产出 10 个可进 CI 的场景，可以直接变成阶段 1 的回归网。
5. **§3.3 的「100–150 行/日含测试」口径这次没被碰到**，不改。

一句话：**§3.3 的数字保留，§3.1 的表格要按 §3 的 A–G 修订后再用它估工。**

---

## 5. 风险

1. **闸门的强度 = 扩展的覆盖率。** 扩展与 pi 同进程、跑在用户全权限下（`pi/docs/security.md` 的
   「No Built-in Sandbox」）。探针只证明「钩子能拦 bash」；一旦模型调 `write`/`edit`/自定义工具/MCP 工具，
   而扩展没盖到，就没有任何东西挡着。**扩展必须拦「所有工具」而不是「危险 bash」**，并且这条要有测试。
2. **依赖一个没有写在稳定契约里的时序保证。** batch2 依赖「`tool_call` 触发时，当前 assistant 消息
   （含全部兄弟 `toolCall`）已经在 `ctx.sessionManager` 里」。文档只承诺到
   「up to date through the current assistant tool-calling message」（`pi/docs/extensions.md:782`），
   没承诺「兄弟调用已在会话里」。**这是 pi 的内部行为，升级可能变**。必须把 batch2 变成一条
   假端点 + RPC 的契约测试钉住，不能靠读一次代码。
3. **逐工具四档决定是我们的编码约定**，扩展与适配器两套代码会漂移（同类风险见 DECISION §5.3）。
4. **探针用的是假端点，不是真模型**：真模型会不会把多个工具放在同一条 assistant 消息、
   真实 provider 在流中返不返回 usage、真实 `stopReason` 取值、以及 `copy.ts` 那张大白话错误表的命中性，
   **都还没测**。错误分类（`TurnEnd.Error.kind`）整个没碰到。
5. **Windows 完全没测**：`pi/docs/windows.md` 说默认要 Git Bash。探针在 macOS 上跑，
   「Windows 上 pi 找得到 shell 吗、卡片提示词里的工具还在不在」这条**原样保留**（DECISION §7.4/§3.2 第 9 条）。
6. **分发/体积**（Node 运行时、签名、SmartScreen）不在本探针范围，DECISION §5.4 不变。

---

## 6. 我没验证什么

- **没测真模型端点**。全套用 localhost 假端点；没有用也没有写任何密钥进仓库。
- **没实测 dialog 的 `timeout` 到期路径**（只测了 `cancelled:true`；文档说两者都得到 `undefined`/`false`，
  扩展里走同一分支，但「没等过 120 秒」这件事如实写在这里）。
- **没测「部分允许、部分拒绝」**（比如 2 个工具里只放行 1 个）：单值回应表达不了这个，
  要用批处理就必须先定编码约定——这本身就是 §3 修订 D 的结论，不是漏测。
- **没测 `strict`/`auto`/`yolo` 三档、规则、会话/永久授权、危险命令识别**。pi 侧为零，
  探针只证明`闸门机制`可用，**不证明权限语义已经写对**。
- **没测压缩（compact）、会话恢复（resume）、错误分类、`steps`、`SessionInfo.skills`、`--version`/`catalog`
  探活**——这些是 C-2 项，本次没做。
- **没测 Windows / WSL / 安装包 / 本地离线推理**，也没测 pi 的许可证（DECISION §7.3）。
- **没写适配器**：所以 §3.3 的人日与行数**没有被实测**，本报告只能说「没有根本性阻碍」。
- **没改任何产品代码**：`DECISION-windows-runtime.md`、`gui/src/**`、`gui/src-tauri/**`、`ROADMAP.md`
  一行未动。

## 7. 本机门禁（与探针无关，但按规矩报）

- `gui/probes/rpc` 全套：10/10 场景跑完，无超时（耗时 7.22s）。
- `bun install`（本工作树原先没装依赖，6 个测试因 `Cannot find package 'solid-js'` 报错 → 装完即消失）。
- `bash gui/scripts/e2e.sh`：**6/6 通过**（含 `bun test src` 565 passed、`tsc --noEmit`、`build:web`、
  fixtures、`cargo test` 且 `-D warnings`）。
