# 探针：应用能不能连一台「跑在别处的 `serve`」（ws 传输，issue #130）

> **只做探针，产品代码一行未改。** 新增文件只有 `gui/probes/ws/**` 和本文。
> `daemon.rs`、`commands.rs`、前端、`tasks/**`、`Cargo.toml`、`DECISION-windows-runtime.md` 都未动。
>
> 事实与推断分开写：带命令/原始字节的是**量到的**；标「推断」的是我算的。文末「我没验证什么」先看。

---

## 0. 结论先行

**这条路是通的。** 在 macOS 上真起了一台 `ante serve --ws 127.0.0.1:47821`，用原始 socket（不借任何 websocket 库）
完成 RFC 6455 握手，发**一帧** `StartSession{permission_mode:"auto"}`，收到**一帧** `SessionStart`——
`session_id`、`model`、`permission_mode: "auto"` 都在，`parent` 就是那个 op 的 id。

| # | 问题 | 结论 | 一句话证据 |
| --- | --- | --- | --- |
| 1 | `serve` 支不支持 `--ws`？参数名对不对？ | **支持** | `ante serve --help`：`--ws <ADDR>  Serve the protocol over websocket on the given loopback socket address` |
| 2 | 「一条文本帧 = 一条 op/event」成立吗？ | **成立** | 发出去的帧头 `81 d7`（FIN+text，masked，len=87，payload 正好 87 字节，**没有换行符**）；收到 `81 7e 97 68`（FIN+text，len=38760=payload 长度） |
| 3 | **能不能建会话？**（关键断言） | **能** | 帧里 `event.SessionStart.session_id=ses_…`、`permission_mode="auto"`、`parent=op_…`（与发出的 op id 逐字相同） |
| 4 | 客户端断开后守护进程会死吗？ | **不会** | 断开后同一进程仍在 listen；第二个客户端再连，拿到**另一个** `session_id` |
| 5 | 明文只许 loopback？ | **服务端也挡** | `ante serve --ws 0.0.0.0:47899` → 退出码 1，`websocket listener address must be loopback, got 0.0.0.0:47899` |
| 6 | 这台守护进程校验令牌吗？ | **不校验** | 不带令牌 / 带错的 Bearer / 带非 Bearer 的 `Authorization`，三种都回 `101` |

**对 Windows 的意义（推断）**：WSL 里跑 Linux 版 `serve --ws`，Windows 侧应用连 `ws://127.0.0.1:<port>`——
**不需要 `cante-bridge`、不需要替换运行时**。但这只解决「连得上」，「谁启动/停止守护进程」和
「`C:\` ↔ `/mnt/c/` 的路径空间」两个问题**不会**因此消失，见 §6。

**一句话结论**：机制上成立，值得往下做；但**别把它当成比桥更便宜**——省掉的是协议翻译，欠下的是生命周期与路径。

---

## 1. 怎么复现

```bash
cd gui/probes/ws && bash run.sh          # 全套 ~25 秒（本机实测 22 秒），末行打印汇总
```

| 文件 | 作用 |
| --- | --- |
| `run.sh` | 起 `serve --ws`、跑三段探针（`raw_frames` / `probe_ws` / `token_check`）外加两次 curl 冒烟、收尾杀进程。每条命令都带超时（AGENTS.md §5） |
| `raw_frames.py` | **手写** RFC 6455 握手与帧（不用 websocket 库），把原始字节按帧边界打出来 |
| `probe_ws.py` | 用标准 `websockets` 库：连 → 建会话 → 断开 → 再连 → 再建会话 |
| `token_check.py` | 不带令牌 / 带错令牌 / 非 Bearer，三种握手各拨一次 |
| `with-timeout.{sh,py}` | 本机 macOS 没有 `timeout`，与 `gui/probes/rpc/` 同款 |

装的是 `~/.ante/bin/ante 0.preview.99`（`run.sh` 开头会原样打印）。`CANTE_BIN` 可覆盖。
原始输出在 `.run/`（`.gitignore` 挡着，不进仓库）。

---

## 2. 原始帧证据（全部是线上字节）

### 2.1 握手

```
>>> 握手请求
GET / HTTP/1.1
Host: 127.0.0.1:47821
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: aKBVLiQD79F7O40huzzQxg==
Sec-WebSocket-Version: 13

<<< 握手响应
HTTP/1.1 101 Switching Protocols
connection: Upgrade
upgrade: websocket
sec-websocket-accept: 4G1tQHvWgNrhkeTdaqlBRzwMpJo=
```

`Sec-WebSocket-Accept` 由探针自己按 RFC 6455 §4.2.2 算了一遍校验：**通过**。

### 2.2 一条文本帧 = 一条 op

```
>>> 一帧文本（opcode=0x1，masked），payload 87 字节
    {"op":{"StartSession":{"permission_mode":"auto"}},"id":"op_01M2QAB8MW55GXYMF2Y26WVS4S"}
    帧头前 2 字节=81d7（0x81=FIN+text，0x80|len=masked）
```

`0xd7 = 0x80 | 0x57`，`0x57 = 87` —— 帧头里的长度**就是**这份 JSON 的长度，**它后面没有换行符**。
这正好说明：协议从「JSONL（一行一条）」原样搬成了「文本帧（一帧一条）」，字节内容不变。

### 2.3 一条文本帧 = 一条 event

```
<<< 帧 38764 字节 fin=True opcode=0x1(text) payload=38760 字节
    原始前 16 字节: 817e97687b2274696d657374616d7022
    JSON 解析 OK: id=evt_01M2QAB8N3NCPZFSF0N6AAPG0P parent=op_01M2QAB8MW55GXYMF2Y26WVS4S event=SessionStart
    >>> SessionStart: session_id=ses_01M2QAB8MY3YEKSGFF4J0ZA4SB model={'id': 'ocg/deepseek-flash', 'support_vision': False} permission_mode=auto
    payload: {"timestamp":"2026-09-17T09:14:45.795308Z","id":"evt_…","event":{"SessionStart":{"model":{"id":"ocg/deepseek-flash",…},"provider":{"id":"openai-compatible",…},"session_id":"ses_…","cwd":"/Volumes/…/gui/probes/ws","permission_m
```

`81 7e 97 68` = FIN+text，`0x9768 = 38760` = payload 长度。`parent` 与 §2.2 的 `id` 逐字相同。

紧跟的第二帧是 `ExtensionRefreshed`（38523 字节，全是技能目录），`parent` 还是同一个 op。
**两帧都是 38KB 上下**，都走同一个连接 —— 说明单帧可以很大，没有分片（`fin=True`）。

对话协议形状（`crates/protocol-shape/src/msg.rs`）：`OpMsg{op,id}` / `EventMsg{timestamp,id,event,parent}`。
ws 传输**没有改动这个形状**，只改了外层的封装。

### 2.4 断开后服务仍在（这条是「子进程模型没有的性质」）

```
{"client": "first",  "connected": true, "session_start": true, "session_id": "ses_01M2QADDCG79N7DANZ3BRSKW1S", "permission_mode": "auto", "events": ["SessionStart","ExtensionRefreshed"], "frame_bytes": [38760, 38523], "parent_matches_op": true}
{"client": "second", "connected": true, "session_start": true, "session_id": "ses_01M2QADDWHBPBVQXWTFPHSB7GZ", "permission_mode": "auto", "events": ["SessionStart","ExtensionRefreshed"], "frame_bytes": [38760, 38523], "parent_matches_op": true}
{"verdict": {"session_start_over_ws": true, "server_survived_client_disconnect": true, "each_connect_gets_a_fresh_session": true, "one_text_frame_per_event": true}}
=== 7. 客户端都断开后，守护进程是否还活着 ===
  还活着（ws 是常驻服务，不归客户端所有）
```

stdio 时：Drop 掉 stdin，子进程就该退（`daemon.rs` 的 `Drop` 就是这么写的）。
ws 时：**没有 stdin 可关**，对端是常驻服务，客户端无权也无从停止它。这就是 §6 那个产品决定。

### 2.5 非 loopback 被服务端挡下

```
  0.0.0.0 退出码=1 输出: websocket listener address must be loopback, got 0.0.0.0:47899
```

（同一句话也出现在二进制字符串里：`websocket listener address must be loopback, got `。绑 `192.0.2.1` 同样被拒。）
**但 `0.0.0.0` 不是「拨号」，是「监听」**——上游 SDK 挡的是客户端**拨**非 loopback；两端各挡一半，见 §3。

### 2.6 令牌：这台不校验

```
不带令牌: HTTP/1.1 101 Switching Protocols
带错的 Bearer: HTTP/1.1 101 Switching Protocols
Authorization 但不是 Bearer: HTTP/1.1 101 Switching Protocols
```

这跟上游 main 的 SDK 注释**对不上**，见 §4.4。

### 2.7 curl 能验到什么、验不到什么（Windows 清单要用）

```
--- 不带 Upgrade 头 ---
curl: (52) Empty reply from server
  curl 退出码=52
--- 带 Upgrade 头 ---
curl: (28) Operation timed out after 8005 milliseconds with 0 bytes received
HTTP/1.1 101 Switching Protocols
connection: Upgrade
upgrade: websocket
sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  curl 退出码=28（28=超时，是对的结果）
```

**结论**：`curl` 只能证明「TCP 通 + 握手被接受」（拿到 `101`），拿不到任何事件——它不会说帧。
所以 Windows 侧的清单只能把 curl 当**第一级冒烟**（够用来验 WSL2 的 localhost 转发），
真断言要靠 `raw_frames.py` / `probe_ws.py`。

---

## 3. 上游 SDK 是怎么做的（`AntigmaLabs/ante:main`）

上游把三种传输收在一个 `Endpoint` 后面（`crates/ante-sdk/`）：

| 文件 | 上游行数 | 我们 fork 对应 | 我们 fork 行数 |
| --- | --- | --- | --- |
| `src/endpoint.rs` | 116（其中 37 行测试） | `crates/cante-sdk/src/endpoint.rs` | 103 |
| `src/connect.rs` | 324（其中 92 行测试） | `crates/cante-sdk/src/connect.rs` | 267 |
| `src/connect/ws.rs` | **342（其中 168 行测试）** | **不存在** | — |
| `Cargo.toml` | features `default=["ws"]`、可选 `wss` | 无 ws 依赖 | — |

```rust
// 上游 connect.rs 的分发：一个 match 管三种传输
match endpoint {
    Endpoint::Stdio => connect_stdio(options),
    #[cfg(unix)] Endpoint::Unix(path) => connect_unix(path).await,
    #[cfg(feature = "ws")] Endpoint::Ws(url) => ws::connect(url, options.token).await,
    #[cfg(not(all(unix, feature = "ws")))] other => Err(ConnectError::Unsupported(other)),
}
```

`ws.rs` 是 `tokio-tungstenite`（0.30），两件值得抄的事：

1. **明文只许 loopback，令牌走升级请求**（客户端侧）：
   ```rust
   if uri.scheme_str() == Some("ws") && !is_loopback_host(&uri) {
       return Err(ConnectError::Insecure(endpoint));
   }
   // 令牌不是 endpoint 的一部分：
   request = request.with_header("Authorization", format!("Bearer {token}"));
   ```
   `is_loopback_host` 认 `localhost` 和 `127.0.0.0/8`、`::1`（按地址判，不按字符串）。`wss://` 要显式开 feature，否则 `Unsupported`。
2. **两个泵，一个方向一个**：`pump_ops` 把 `OpMsg` 序列化成 `Message::Text` 一帧发一个；
   `pump_events` 把每个文本帧反序列化成 `EventMsg`。**丢掉全部 `OpSender` 就发 close 帧**——
   这是「客户端走了」的唯一信号（对应 stdio 的「关 stdin」）。

**一个前提要说清**：`serve --ws` 的**服务端源码不在任何公开仓库里**。
我们 fork 和上游公开仓库的 `crates/` 都只有 SDK/protocol/exec/llm，没有主二进制 crate。
（探针开始时这个 worktree 里还能 `git show upstream/main:…`——`ws.rs` 就是这么读到的；
做探针中途这个 remote 在**共享的** `.git` 里消失了（`git remote -v` 只剩 `origin`），
所以我改用 GitHub 的 tree API + `raw.githubusercontent.com` 复核了文件清单与行数：
**上游 `main` 共 264 个条目**，其中只有一个 ws 文件 `crates/ante-sdk/src/connect/ws.rs`。
请在评审时把 §3 的行数当成「从 GitHub 拉到的原文」，不是本地 clone。）
所以「服务端怎么做」这一半，**只有二进制行为证据**（§2.5、§2.6），没有源码可读。

### 3.1 我们现在的处境

- 我们的 fork **已经有** `Endpoint` 枚举（含 `Ws` 变体），`connect()` 对 `Ws` 返回
  `ConnectError::Unsupported`，甚至有一条测试钉着这个现状：
  `ws_endpoints_report_unsupported_until_their_connector_lands`。
- **但桌面应用（`gui/src-tauri`）根本没用 `cante-sdk`**：它有自己的 `daemon.rs`（851 行，
  `std::process` + `std::thread` + `Mutex<Inner>` 的同步实现）。`crates/` 是 fork 过来的另一条线。
- 所以「上游加了 ws 连接器」这件事，**离应用还差一整段**——不管选哪条路，应用侧的活都得自己干。

---

## 4. 两条路：代价与风险

### 4.1 路 A：应用改用上游 `cante-sdk`，三种传输白拿

**要做什么（推断）**：把 `daemon.rs` 的进程/管道层拆掉，换成 `cante_sdk::connect(Endpoint, ConnectOptions)`
拿到的 `Client` + `OpSender` + `EventReceiver`。

**代价**：

- `daemon.rs` 851 行里，约 **370 行是进程/传输**（`Proc`、`ensure_started`、`split_binary`、`serve_argv`、
  `hide_console`、`spawn_child`、`stdout_loop`/`stderr_loop`/`reap`/`finalize_exit`、`run_capture`），
  约 **360 行是产品逻辑**（`EventRing`、`state_payload`、13 个发 op 的方法、6 个 `*_op` 拼装函数）。后者是我们要的，前者才是 SDK 能替的。
- SDK 的 `Client` 是 **async + tokio channel**；我们的 `Daemon` 是**同步线程 + `Mutex<Inner>`**，
  `Emitter` 是同步 trait，直接接 Tauri。换 SDK 等于把 Tauri 侧也拖进 tokio 运行时（现在**完全没有 async**）。
- SDK **不管** `EventRing`、`reduce_state`、`catalog`、`health`、`CANTE_BIN` 命令规格、`hide_console`——
  这些一行都省不掉。
- 新增依赖：`cante-sdk` 会带进 `tokio-tungstenite 0.30` + `futures-util`（开 `wss` 再加 `rustls` + `webpki-roots`）。

**风险：把已经付过学费的坑丢掉。** `gui/src-tauri/tests/` 里 **101 条测试**，其中 **27 条**是传输/进程专属，
全部长在我们的 stdio 实现上：

| 测试文件 | 条数 | 钉住的是什么 |
| --- | --- | --- |
| `binary_spec.rs` | **20** | `CANTE_BIN` 是一段**命令规格**不是路径：`"C:\Program Files\…"` 带空格、`wsl.exe -e …`、单/双引号 shell payload、`serve` 不重复追加、`hide_console`… |
| `reader.rs` | 2 | 子进程关了 stdout 却还活着时读循环怎么收敛 |
| `missing_binary.rs` | 2 | 没有二进制时窗口照样开，`health` 如实说不可用 |
| `soak.rs` | 1 | 大流量 + 多兆字节单行不卡死 |
| `exit_does_not_block.rs` | 1 | 退出不在持锁时做 |
| `integration.rs` | 1 | 真管道端到端 |

**没人保证 SDK 里这些行为等价**——尤其 `CANTE_BIN` 命令规格（那是**为了 Windows/WSL 才发明的**，
上游 SDK 只有 `ConnectOptions.executable: Option<PathBuf>`，一个**路径**，装不下 `wsl.exe -e bash -lc '…'`）。
走这条路，这 27 条要么重写、要么承认退步。

### 4.2 路 B：只在 `daemon.rs` 里加一条 ws 传输（推荐）

**要做什么（推断）**：加一个传输抽象，只替换掉 §4.1 里那 ~370 行中的**发送/接收/生命周期**三段。

| 改动点 | 内容 | 量级（推断） |
| --- | --- | --- |
| `daemon.rs` | `Proc{child, stdin}` → `enum Link{ Child{..}, Ws{..} }`；`send_op` 分支（一帧文本 vs 一行 JSONL）；新增 ws 读线程复用现成的 `handle_stdout_line`；`shutdown`/`Drop` 分支（close 帧 vs 关 stdin）；`ensure_started` 分支（拨号 vs spawn） | +180 ~ 260 行 |
| `daemon.rs`（新入口） | `CANTE_ENDPOINT`（复用上游的字符串形式：`stdio` / `unix:<path>` / `ws://<addr>`，**零新词汇**）；`CANTE_BIN` 与它互斥，谁优先要说清 | +30 ~ 60 行 |
| `commands.rs` | `daemon_capability()` 的「这台电脑有没有干活的组件」多一条分支：**能连上吗**（`CANTE_BIN` 那条是「有没有这个可执行文件」） | +40 ~ 80 行 + 中文文案 |
| `Cargo.toml` | +1 依赖。**建议用阻塞版 `tungstenite`**，而不是 `tokio-tungstenite`——`daemon.rs` 是同步线程模型，加 tokio 只为发帧不划算 | +1 行 |
| 新测试 | 握手、一帧一 op、对端关连接的收敛、非 loopback 拒绝、`CANTE_ENDPOINT` 解析与优先级 | +10 ~ 15 条，~250 行 |

**总量级（推断）：约 250 ~ 400 行、4 ~ 6 个文件。**
比路 A 小一个量级，而且 `EventRing` / `reduce_state` / `catalog` / 那 27 条测试**全部原样保留**。

**顺带**（可选、独立）：把上游 `connect/ws.rs` 的**实现**（174 行 + 5 条测试）cherry-pick 进
`crates/cante-sdk`，顺手删掉那条 `…_until_their_connector_lands` 测试。这对**应用没有影响**
（应用不用 SDK），但它让 fork 和上游的 `cante-sdk` 对齐、并给未来留一条路。

### 4.3 对比

| | 路 A：换上 `cante-sdk` | 路 B：`daemon.rs` 加 ws 传输 |
| --- | --- | --- |
| 改动量级（推断） | ~600 ~ 900 行 / 6 ~ 10 文件 | **~250 ~ 400 行 / 4 ~ 6 文件** |
| 新依赖 | `cante-sdk` + `tokio-tungstenite` + `futures-util`（+`rustls` 若 `wss`）+ **GUI 引入 tokio** | `tungstenite`（阻塞版，1 个） |
| 并发行模型 | 同步 → async（`Emitter`、`Mutex<Inner>` 全要动） | **不变** |
| `CANTE_BIN` 命令规格（20 条测试） | 大概率丢/重写 | **保留** |
| `EventRing`/`reduce_state`/`catalog`/`health` | 要自己搬过去 | **不动** |
| 上游继续演进（新传输） | 白拿 | 自己跟 |
| 最大风险 | 把付过学费的坑再踩一遍，且**不会有人报警** | 我们又维护一份传输实现 |

**我的建议（判断，不是实测）**：**走路 B**，并把「对齐上游 SDK」当成**独立的第二步**（4.2 末尾那条）。
理由：这次要的只是「多一条传输」，而路 A 顺手把生命周期、并发模型、命令规格一起换掉了——
**收益（一条传输）和风险（27 条测试 + 并发模型）不成比例**。

### 4.4 令牌这件事要单独记一笔

上游 `ws.rs` 的文档注释说：*「the bearer token rides the upgrade request」*，
`ConnectOptions` 也有 `token: Option<String>` 字段（注释：*「`ante serve --ws` refuses a peer without it」*）。
**我们装的 `0.preview.99` 不校验**（§2.6，三种情况都给 `101`）。

两个可能：**（a）令牌校验是比这个二进制更新的东西；（b）校验默认关闭、要配置才开。**
**我没能区分**（没有会校验令牌的版本可测）。这会影响路 B 的估计：
如果需要令牌，`CANTE_ENDPOINT` 旁边还得有 `CANTE_TOKEN`（且**不能**写进日志/`health` 明文）。
**这一条必须在动手前问清**，否则可能白写一遍再返工。

---

## 5. 行数估计汇总（一张表）

| 项 | 量到/推断 | 数字 |
| --- | --- | --- |
| 上游 ws 连接器 | 量到 | `connect/ws.rs` 342 行，其中 168 行测试；`crates/ante-sdk/Cargo.toml` 加 `tokio-tungstenite 0.30` + `futures-util` |
| 我们 fork 的 SDK 现状 | 量到 | `endpoint.rs` 103 行、`connect.rs` 267 行、**无 ws.rs** |
| 应用 `daemon.rs` | 量到 | 851 行 = 传输/进程 ~370 + 产品逻辑 ~360 + 类型与注释 |
| 应用传输相关测试 | 量到 | `gui/src-tauri/tests/` 共 101 条，其中 **27 条**是传输/进程专属 |
| 路 B 的工作量 | **推断** | ~250 ~ 400 行、4 ~ 6 文件、+1 依赖、+10 ~ 15 测试 |
| 路 A 的工作量 | **推断** | ~600 ~ 900 行、6 ~ 10 文件、+3 ~ 5 依赖、GUI 引入 tokio |

---

## 6. 需要产品决定的一件事（最难的一块）

**ws 模式下，谁负责启动和停止守护进程？**

stdio 的语义是干净的：**应用 spawn 它，应用拥有它**。关掉 stdin 它就退，
所以「关掉 Cante 就不会有孤儿进程」「`cwd` 就是应用的工作目录」都是自然成立的。
`daemon.rs` 现在整段生命周期（`ensure_started` / `Drop` / `reap` / `finalize_exit`）都建在这个前提上。

ws 的语义是**相反的**（§2.4 已实测）：对端是**别人的常驻服务**，客户端连上、断开，它都活着。
于是有三件事必须有人拍板：

1. **「没在跑」怎么向王姐交代？**（产品律 3：出错能看懂并有出路）
   - (a) 就报离线 + 一句人话 + 「找 IT」——最诚实，也最像「企业预置」的场景；
   - (b) 应用自己去拉起来——那得知道 `wsl.exe -e … serve --ws` 这整条命令行，**又回到了 `CANTE_BIN`**，
         等于 ws 只解决了一半；
   - (c) 两者都做（先探、探不到再拉，拉不起来就说清）。
   **这是产品决定，不是技术决定**——它决定向导/出错界面要写什么中文。
2. **`cwd` 和文件路径。** stdio 时守护进程与界面同机同用户，`cwd` 直接可用（§2.3 里就是探针目录）。
   ws + WSL 时，守护进程在 **WSL 的路径空间**里：王姐在 Windows 上选的 `C:\Users\…\报表.xlsx`，
   在 WSL 里是 `/mnt/c/Users/…/报表.xlsx`。**这条路上真实的成本在这里，不在协议。**
   要么应用做双向翻译，要么限制「只有能映射的路径才允许」，要么把文件访问留给 Windows 侧的自带工具
   （`cante-sheets` / `cante-pdf` 本来就在 Windows 侧，可能是关键抓手）。
   **本探针没测这条，但它比「连不上」更可能让产品出洋相。**
3. **一个守护进程 = 一个会话吗？** 实测「每连一次拿到新 `session_id`」（§2.4），
   但没测**两个客户端同时连同一个守护进程**会不会互相打断（协议里有 `StartSession`「替换任何正在跑的会话」的说法）。
   如果要支持「同时开两个窗口」，这条必须先验。

---

## 7. Windows 上的验证清单（转给那台机器的 agent）

> 本机是 macOS。**下面每一条我都没跑过**，是给 Windows/WSL 那台机器执行的。
> 每条都写清「执行什么 / 期望看到什么 / 看到别的说明什么」。

### 7.1 WSL 侧（Linux，守护进程在这里）

| # | 命令（在 WSL 里） | 期望看到 | 不是这样说明什么 |
| --- | --- | --- | --- |
| 1 | `$HOME/.ante/bin/ante --version` | 打印版本号，退出码 0 | 没有 Linux 版二进制 → 先解决这个，后面都不用做 |
| 2 | `$HOME/.ante/bin/ante serve --help \| grep -- --ws` | `--ws <ADDR>  Serve the protocol over websocket …` | 这个 Linux 版比装的那台旧 → 换成支持 `--ws` 的版本 |
| 3 | `nohup $HOME/.ante/bin/ante serve --ws 127.0.0.1:47821 &` | **没有输出**（实测服务是静默的，stdout/stderr 都是 0 字节） | 有报错就照抄进报告 |
| 4 | `ss -ltnp \| grep 47821` | `LISTEN … 127.0.0.1:47821` | 没 listen → 端口被占或启动失败 |
| 5 | `$HOME/.ante/bin/ante serve --ws 0.0.0.0:47899` | 退出码 1，`websocket listener address must be loopback, got 0.0.0.0:47899` | 若真的绑上了 → **这是个安全发现，立刻停掉并报告** |
| 6 | `cd gui/probes/ws && CANTE_BIN=$HOME/.ante/bin/ante PORT=47821 bash run.sh` | 末行 `raw_frames=0 probe_ws=0 token_check=0` | 把 `.run/run-full.out` 整份贴回报告 |

### 7.2 Windows 侧（应用在这里）—— 先验 WSL2 的 localhost 转发

> 这一段是**整条路的命门**：WSL2 正常会把 WSL 里的 `127.0.0.1:<port>` 转发到 Windows 的 `127.0.0.1:<port>`。

```powershell
# 1) 端口通不通（TCP 层）
Test-NetConnection -ComputerName 127.0.0.1 -Port 47821
#    期望：TcpTestSucceeded : True

# 2) 握手被接受（拿到 101 就说明转发 + 服务都对）
curl.exe -sS -i --max-time 8 `
  -H "Connection: Upgrade" -H "Upgrade: websocket" `
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" `
  http://127.0.0.1:47821/
#    期望：先打印 HTTP/1.1 101 Switching Protocols，然后 curl 报超时（退出码 28）
#    —— 28 是**对的**：握手之后就不是 HTTP 了，curl 不会说帧（本机 macOS 实测同样 28）

# 3) 真断言（curl 做不到，要真 ws 客户端 —— raw_frames.py 只用标准库，不需要装任何东西）
py gui\probes\ws\raw_frames.py 47821 8
#    期望：`Sec-WebSocket-Accept 校验: 通过`，然后 `[=] 收到 2 条文本帧`，其中一条 event=SessionStart

# 3b) 可选：用标准库再验一次「断开后服务仍在」（这条才需要 websockets）
py -m pip install websockets
py gui\probes\ws\probe_ws.py 47821
#    期望：两行 JSON 的 session_id **不同**，末行 verdict 四项全 true
```

| 看到什么 | 说明什么 |
| --- | --- |
| `101` | WSL2 转发到了，服务端也接受了握手 —— **这一步就证明了「Windows 应用连 WSL 里的守护进程」可行** |
| `TcpTestSucceeded: False` / `Connection refused` | WSL2 转发没生效。试 `wsl --shutdown` 重启；或确认是 WSL2 不是 WSL1；或在 `.wslconfig` 里看 networkingMode |
| 拿到 `101` 但 `raw_frames.py` 跑不起来 | Windows 侧 Python 版本太旧（脚本只用了标准库，不需要联网装包），或路径写错 |
| 能建会话但 `cwd` 看着不对 | 见 §6.2（`C:\` ↔ `/mnt/c/`），这是**预期内的**，不是故障 |

### 7.3 还要带回来的两条

1. **从 WSL 里看到的 `cwd` 是什么**：`run.sh` 打印的 `SessionStart.cwd` 会是 WSL 路径（如 `/mnt/c/…`）
   还是别的。这直接决定 §6.2 的成本。
2. **`serve --ws` 在 WSL 里能不能读到 Windows 侧的模型配置**：`~/.ante/settings.json` 是 WSL 自己的家目录，
   和 Windows 侧的不是一份。**这是一个「装完发现没配好」的坑**，值得在清单里让那边看一眼
   （`python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.ante/settings.json')))['model'])"`，
   **不要**把整份 settings 贴回来——里面可能有密钥）。

---

## 8. 我没验证什么

先把「超时」和「确认没有」分开：下面每一条都是**没做**，不是**做了没成**。

**没验（环境/范围所限）**

- **服务端源码**：`serve --ws` 不在我们仓库、也不在上游公开仓库里（§3）。所以服务端的握手细节、
  令牌校验、连接上限、并发语义**都只有二进制行为证据**，没有源码可读。
- **上游 ref 中途消失**：探针开始时 `git show upstream/main:…` 还能用，后来 `upstream` remote 从共享的
  `.git` 里没了（同一个仓库里还有其他 worktree 在跑，可能是别的会话清的）。§3 的行数因此改成
  **从 GitHub 拉原文**重算——**不是**本地 clone 数的。
- **令牌**：装的 `0.preview.99` 不校验，三种情况都给 `101`。上游 main 说会拒无令牌的 peer。
  **我没有在一个会校验的版本上验过**，也无法区分「新版才校验」和「默认关、要配置」。
- **Windows / WSL**：本机是 macOS。§7 的每一条都是**待执行**，我一条都没跑。
  「WSL2 会把 localhost 转发进去」是这条路的**关键假设**，而**它正是我没验的那一步**。
- **一次真正的回合**（`UserInput` → 模型 → 工具 → `TurnEnd`）：没跑。§0 的关键断言是「能建会话」，
  这个不需要模型调用；跑回合要真模型 + 网关，不在本探针范围。
- **`--sock`（unix 域套接字）**：同一批上游 SDK 支持，本探针没测。
- **断线/半开/重连、多客户端并发同一个守护进程、背压**：都没测。
  §6.3 的「两个窗口会不会互相打断」因此**没有答案**。
- **大于 64KB 的帧**（长度前缀的 126/127 分支）与**分片帧**：没构造。实测最大一帧 38760 字节，
  走的是 16 位长度分支；分片（`fin=False`）一个都没见到，所以**我们的读帧逻辑要不要处理分片，没有证据**。
- **`cwd` / 路径空间**：只在 macOS 上看到 `cwd` 是探针进程的目录。`C:\` ↔ `/mnt/c/` 没验（§6.2）。
- **`health` / `catalog` 在 ws 模式下的出路**：没做实验。但我确认了协议里**没有** `Catalog` 或 `Version` 这类 op
  （`Op` 只有 17 个变体，见 `crates/protocol-shape/src/msg.rs`），而 `daemon.rs` 现在靠
  `run_capture(bin, ["catalog"])` 和 `run_capture(bin, ["--version"])` 拿这两样 ——
  **远端守护进程没有「本地可执行文件」可跑**，这是路 B 的一个真实缺口，我在 §4.2 里**没给它估行数**。

**没做（任务边界）**

- **没改任何产品代码**：`daemon.rs` / `commands.rs` / 前端 / `tasks/**` / `Cargo.toml` /
  `DECISION-windows-runtime.md` 一行未动。§4 的行数、§5 的估计全部是**推断**，不是实测。
- **没决定**走哪条路（§4.3 是建议）、**没拍板** §6 的三件事。
- **没跑**路 A 或路 B 的任何一行实现代码。

**跑过但只证明了一件事**

- `curl` 的两种结果（§2.7）只证明「TCP 通 + 握手被接受」；**它拿不到任何事件**，不能当会话可用的证据。
- `token_check.py` 只证明「这个版本不校验」，**不能**推断「别的版本也不校验」。
