# 第五次真机验收：Windows 上**不用 WSL**，让应用真的干成一件活

这一轮验的是里程碑：**同一份应用 + 桥（`cante-bridge`）+ 原生 `pi`，在真 Windows 上跑出真实结果。**

- 验收机器：Windows 11 Home 25H2 / build 26200.9457 / x64（真机）
- 起始提交：`main` = `6e8f615`；工作分支：`ws/win11-bridge-e2e`
- 验收人：跑在那台机器上的 pi（**SSH 会话，没有交互桌面**，限制见最后一节）
- 原始输出：`%TEMP%\cante-acc5\`（文件名与各节一一对应）

---

## 0. 结论先行：**能**

在这台 Windows 上，把两个环境变量指好：

```
CANTE_BIN = C:\Users\<用户名>\…\cante-bridge.exe
PI_BIN    = C:\Users\<用户名>\.bun\bin\pi.exe
```

然后**两条真实任务跑通了**，第二条用的还是**产品自己拼出来的那段指令**：

| | 第 1 次（我写的一句话） | 第 2 次（产品自己的指令） |
| --- | --- | --- |
| 指令来源 | 我手写的三行 | `gui/scripts/sweep/prompts.ts` 调 `taskById("excel.merge").prompt(...)`，2,636 字，**含自带工具的说明**（`cante-sheets` 在 `C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe`） |
| 轮次状态 | `Completed` | `Completed` |
| 耗时 | 32.3 秒 | 48.5 秒 |
| 工具调用 | 9 次（bash ×8、write ×1） | 11 次（bash ×11） |
| 审批 | 9 次全部自动同意 | 7 次全部自动同意 |
| 错误事件 | 0 | 0 |
| 产出 | `结果_合并.xlsx`（5,229 字节） | `结果_合并2.xlsx`（5,794 字节） |
| 原件 | sha256 前后一致 | sha256 前后一致 |

第 2 次的产出用**产品自己的工具**读回来（`cante-sheets.exe read`）：

```
工作表：合并结果
编号,姓名,金额,来自哪张表
A01,张三,1200,一月.xlsx
A02,李四,980,一月.xlsx
A03,王五,1500,一月.xlsx
A04,赵六,1100,二月.xlsx
A05,孙七,760,二月.xlsx
A06,周八,1320,二月.xlsx
```

**而且应用本身也认这条链**：`cante-gui.exe` 带上 `CANTE_BIN` 启动之后，「检查电脑」那一屏
从上一轮的

```
Text | 这台电脑还缺一个必须的组件
```

变成了

```
Text | 检查你的电脑
Text | 已经就绪
Text | 电脑这边都准备好了，可以开始干活。
Button | 下一步
```

也就是「我们的 Windows 版干不了活」这个死结，在**组件这一层**解开了：应用 + 桥 + pi 都在 Windows 上原生跑。

**但有一个前提必须先说清楚**：这条路上 `pi` 必须是 `CreateProcess` 起得来的 **`.exe`**。
npm 在 Windows 上落的是 `pi.cmd` / `pi.ps1`，没有 `pi.exe`（§1.2 的原始输出）——桥用
`Command::new` 起它，实测就是 `program not found`（§1.3）。我用 `bun install -g` 拿到一个
`.exe` 形态的 shim 才走通。**这是环境前提，不是产品已经解决的事**（§6 第 3 条）。

---

## 1. 怎么跑通的（一步一条命令）

### 1.1 桥：编出来、自己起得来

```bash
cd C:\cante\gui\src-tauri
timeout 1800 cargo build --release --bin cante-bridge
```

```
Finished `release` profile [optimized] target(s) in 1m 14s      ← 退出码 0
-rwxr-xr-x  681984  gui/src-tauri/target/release/cante-bridge.exe
```

```
$ cante-bridge.exe --version   →  cante-bridge 0.2.0     exit 0
$ cante-bridge.exe catalog     →  {"providers":[]}       exit 0
```

（对比：第三次验收时安装包里那份是 603,648 字节；这一轮编的是 main 上的新代码，681,984 字节。）

### 1.2 关键一步：`pi` 在 Windows 上是 `.cmd`，桥起不来

```
$ Get-Command pi -All
Name   Source                                            CommandType
pi.ps1 C:\Users\<用户名>\AppData\Roaming\npm\pi.ps1      ExternalScript
pi.cmd C:\Users\<用户名>\AppData\Roaming\npm\pi.cmd      Application
pi     C:\Users\<用户名>\AppData\Roaming\npm\pi          Application
pi.ps1 C:\Users\<用户名>\AppData\Local\hermes\node\pi.ps1 ExternalScript
pi.cmd C:\Users\<用户名>\AppData\Local\hermes\node\pi.cmd Application
pi     C:\Users\<用户名>\AppData\Local\hermes\node\pi     Application
```

**没有 `.exe`**。`gui/docs/BRIDGE-windows.md` §3.1 早就把这条写成「已知边界 + 最大的未知数」，
这一轮实测确认了它：上一轮我用桥跑普查时，事件里就是

```
错误事件：没能把助手启动起来（pi）：program not found
```

拿 `.exe` 的办法（`BRIDGE-windows.md` §3.1 给的另一条路）：

```bash
timeout 900 bun install -g @earendil-works/pi-coding-agent
```

```
installed @earendil-works/pi-coding-agent@0.85.1 with binaries: - pi
126 packages installed [101.57s]
-rwxr-xr-x 8192  C:\Users\<用户名>\.bun\bin\pi.exe      ← 就是这个（bun 的 shim）
```

它真的能用（**原生 Windows、不经过 WSL**）：

```
$ pi.exe --version          →  0.85.1
$ pi.exe -p "只回两个字：收到"  →  收到
```

### 1.3 驱动脚本：按应用那一层发指令

`gui/scripts/windows/bridge-e2e.py`（这一轮新加的取证脚本，只用 Python 标准库）：

- 把桥当守护进程起起来（`cante-bridge.exe serve`），`PI_BIN` 指到 `pi.exe`；
- 按协议发 `StartSession`（**只给 `permission_mode` + `cwd`**，跟简单模式真实路径一致：
  `store.ts` 不传 provider/model）+ 一个真实 `UserInput`；
- 审批一律自动同意（字段名是 `tool_use_id`，**写成 `id` 会反复暂停**）；
- 把**收到的每一条事件**原样写进 JSONL，结尾打一份摘要。

**协议上踩过的两个坑**（都写进脚本注释了）：op 的 `id` 必须是 ULID（否则守护进程只回一句
误导性的语法错误）；`TurnEnd` 是**带负载的对象**（`{"status": "Completed", "steps": 8, …}`），
不是字符串。

---

## 2. 真实任务与产出

工作目录 `C:\bridge-e2e`，输入是我用**产品自己的工具**造的两张小表：

```
$ cante-sheets.exe write 一月.xlsx 一月.csv --sheet 一月     → exit 0（5,616 字节）
$ cante-sheets.exe write 二月.xlsx 二月.csv --sheet 二月     → exit 0（5,617 字节）

跑之前 sha256：
fb82d0692e7b4975de77f926df5a9dd335e6545bc95cc888ea2a7a1fad97457e  一月.xlsx
55a312e81abfdecabacdab419d18e6b0a32e2e282e102d61b53e4afb7e698e55  二月.xlsx
```

第 2 次（产品指令）跑完之后：

```
跑之后 sha256：与上面两个值**逐字符一致** → 两个原文件一个字节都没动
产出：结果_合并2.xlsx  5,794 字节（工作表「合并结果」，表头一行 + 6 行数据 + 「来自哪张表」列）
```

产出不是「有几个字节就算数」——用产品自己的工具读回来核对过（见 §0），
而且助手自己也报了逐项核对（行数、重复行 0 条、列对齐、类型、原文件未动），
与 `cante-sheets read` 的结果相符。

两次跑都没有留下中间脚本（第一次那位助手自己把 `_merge_tmp.py` 删了），
工作目录里现在只有输入、`prompt*`、`plan.json` 和产出。

---

## 3. 原始事件片段（第 2 次，`evidence/06-events-run2.jsonl`）

事件类型的全量计数：

```json
{"SessionStart":1,"UserInput":1,"TurnStart":1,"ThinkingDelta":1039,"MessageDelta":706,
 "AgentMessage":5,"TurnPause":7,"TurnResume":7,"ToolStart":11,"ToolUpdate":18,"ToolEnd":11,"TurnEnd":1}
```

片段（只截断、不改写；网关地址已擦掉）：

```
SessionStart: {"cwd": "C:\\bridge-e2e", "model": {"display_name": "ocg/deepseek-flash",
  "id": "ocg/deepseek-flash", "support_vision": false}, "permission_mode": "Auto",
  "provider": {"base_url": "<网关地址已擦掉>", "display_name": "", "id": "9router"},
  "session_id": "01a0ae4a-116b-…"

MessageDelta: "我先"      MessageDelta: "说明"        ← 流式（不是最后一次性冒出来）

AgentMessage: "我先说明打算怎么做，然后再动手。\n\n**我的计划：**\n1. 按顺序打开 `一月.xlsx`、
  `二月.xlsx`，各自把第一行当列名…（与卡片的四步计划一致）"

AgentMessage: "工具可用，两个 xlsx 都在。现在看每张表的结构。"      ← 它读到了自带工具的说明

ToolStart: {"args": {"command": "ls -la /c/bridge-e2e/ 2>/dev/null || ls -la \"C:/bridge-e2e/\""},
  "id": "call_00_HgNz397jMmKmZQv18AdW3652", "name": "bash"}
ToolStart: {"args": {"command": "\"C:/Users/<用户名>/AppData/Local/Cante/cante-sheets.exe\" --help 2>&1 | head -50"},
  "id": "call_01_xfLaMqbqm3KP0vHfUH6J0230", "name": "bash"}     ← 真的去调产品自带的工具

ToolEnd: {"result_json": {"content": [{"text": "不认识的用法：--help\n用法：\n  cante-sheets sheets <文件>\n
  cante-sheets read <文件> [--sheet <表名>]\n  cante-sheets write <结果.xlsx> <数据.csv> …"}]},
  "status": "Completed", "tool_name": "bash"}

TurnPause: {"reason": {"Approval": {"message": "", "tools": [{"args": {"command": "ls -la /c/bridge-e2e/ …
  "id": "call_00_HgNz397jMmKmZQv18AdW3652", "name": "bash"}, {…}]}}}      ← 一次能问一批

TurnEnd: {"status": "Completed", "steps": 8, "turn_id": "turn_01M2Q4M6VG9V62VYMJ6TW40VHC"}
```

**收尾也干净**：两次跑完之后 `Get-CimInstance Win32_Process` 里**没有**残留的 `pi.exe` /
`cante-bridge.exe`（**确认没有**）。`BRIDGE-windows.md` §3.3 把「关 stdin → pi 自己退」列为
Windows 上未验证的一条，这次至少证明**不留孤儿**；但**分不出**是 pi 自己退的还是桥的 5 秒宽限
之后 `kill` 的（桥没把这件事打出来）。

---

## 4. 用了哪个模型 / 谁在处理

- 模型：**`ocg/deepseek-flash`**（来自 `SessionStart.model.id`），服务方 id **`9router`**。
- 网关地址被我从这份报告里擦掉了；凭据没有出现在任何一行输出里，也没有落盘。
- **重要的一条（产品红线相关）**：简单模式**不传** provider/model，所以桥这条路上模型与凭据
  由 `pi` 自己的配置（`%USERPROFILE%\.pi\agent\` 下的 `models.json` / `auth.json` 与环境变量）决定。
  也就是说：**界面上写的「谁来处理这件事」，和真正把内容发出去的那个配置，不是同一处**。
  `BRIDGE-windows.md` §7.2 已经把这条列为「要让桥成为正规路径必须解决的三件事」之一，
  这次的真机跑把它从「理论问题」变成了「当场可见」：**我这一轮没有在界面上看到任何一处
  说明它会把内容发给谁。**

（另外记一笔本机噪音：pi 子进程的 stderr 里有 3 行 `cante-bridge: ignoring a fire-and-forget
UI request` 和 1 行 `[remote-pi] relay connect failed: … 530`。前者是桥对 UI 类请求的既定行为，
后者是本机 `REMOTE_PI_*` 环境导致的，与本轮无关，不影响结果。）

---

## 5. 应用本身（第 6 步）：做到了哪一步

做了：把 `CANTE_BIN` / `PI_BIN` 设好，从同一个 PowerShell 启动装好的 `cante-gui.exe`
（顺手删掉 WebView2 档案，让向导重新出现），用 UI Automation 读窗口文字。

**结果**：向导第 2 屏从「缺一个必须的组件」变成了 **「已经就绪 / 电脑这边都准备好了，可以开始干活。」**
（原文见 §0，证据 `evidence/07-gui-with-bridge.txt`）。

没做到：**在应用里点完一张卡**。简单模式选文件走的是**原生文件对话框**，SSH 会话没有交互桌面，
点不动（这是第三次验收就写明的限制）。所以「应用里的会话真的跑起来、真的产出文件」这一条，
这一轮只有**组件探测**那一半的证据，另一半靠的是 §1–§3 直接驱动桥的证据。

---

## 6. 我没能验证什么

**这一节和上面的结论一样重要。**

1. **应用窗口里的整条链路**：点卡片 → 原生文件对话框选文件 → 确认页 → 会话流式输出 → 审批页
   → 结果落在原文件旁边。要真桌面（RDP）。我验的是「组件探测就绪」+「桥这一层能真跑」。
2. **窗口观感 / 控制台黑窗**：SSH 会话看不到画面。`CREATE_NO_WINDOW` 在这条路上是否真的不闪，
   **没有验证**（第三、四次验收也没验到）。
3. **`pi` 从哪来这件事，产品还没答案**：这一轮我是用 `bun install -g` 在**这台机器**上拿到的
   `pi.exe`。用户机器上没有这一步。要么随包带一个 `CreateProcess` 起得来的 `.exe`，
   要么在桥里明确包一层 `cmd.exe`（并解决进程树收尾），要么换宿主分发方式 ——
   这几条都在 `BRIDGE-windows.md` §7.1，本轮**没有动产品代码**。
4. **凭据/隐私的账**：见 §4。界面上没有一处说明「内容发给谁」。
5. **审批语义与 `cante` 是否一致**：闸门现在拦的是所有工具调用（我这边是 7 次全自动同意），
   没有 `strict`/`auto`/`yolo` 三档、没有危险命令识别、没有持久授权。
6. **`pi` 能不能访问局域网网关之外的场景**（无网/企业预置/只许本机）没有验证。
7. **收尾的因果**：见 §3 最后一段（不留孤儿已确认；是 pi 自己退的还是被 kill 的，没验证）。
8. **macOS / Linux 侧**：本轮全部是 Windows 结论。
9. **「超时」与「确认没有」分开写**：本轮所有长命令都设了超时
   （`cargo build` 1800s、`bun install -g` 900s、`prompts.ts` 300s、两次驱动各 1800s），
   **一次都没有超时**；"没有残留进程"、"原文件 sha256 一致"是**查过/比对过才写的**。

---

## 附：这一轮动过的东西

| 文件 | 动作 |
| --- | --- |
| `gui/WINDOWS-ACCEPTANCE-5.md` | 新增（本文件） |
| `gui/scripts/windows/bridge-e2e.py` | 新增：驱动桥的取证脚本（只用标准库，协议要点写在注释里） |

**没有改任何产品代码**（`gui/src/**`、`gui/src-tauri/**`、`AGENTS.md` 一个字节没动）。
机器上的额外东西（都在仓库外）：`C:\Users\<用户名>\.bun\bin\pi.exe`（bun 全局装的 pi shim）、
工作目录 `C:\bridge-e2e`。

原始输出（`%TEMP%\cante-acc5\`）：

```
01-pi-print.txt              pi.exe -p "只回两个字：收到" → 收到
02-run1.txt / 02-events.jsonl      第 1 次（我写的三行指令）
03-prompt-json.json          产品指令生成（prompts.ts 的输出，2,636 字）
04-run1-output.xlsx          第 1 次的产出
05-sha-before-run2.txt       第 2 次跑之前的原件 sha256
06-run2-product-prompt.txt / 06-events-run2.jsonl   第 2 次（产品指令）
07-gui-with-bridge.txt       应用带 CANTE_BIN 启动后的窗口文字（「已经就绪」）
08-event-fragments.txt       事件片段（已擦掉网关地址）
```
