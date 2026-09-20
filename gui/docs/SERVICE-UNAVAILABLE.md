# 服务方「没钱了 / 太忙了」：先把今天的分流核清楚，再加一类

起点：第 16 批机会点（`gui/OPPORTUNITIES-10.md` 的 P1 第一节）。这不是推理出来的
——**2026-09 派活的网关真的欠费停机了**，真实原文（下面一律照抄，不美化）：

```
503: {"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue  (reset after 15s)"}
```

王姐会遇到同一族：公司网关这个月用量用完、服务方限流、服务方自己抽风几分钟。
这份文档只回答三件事：**今天这些原文会落到哪一类**、**新加的那一类边界在哪**、
**哪些是我没验的**。

---

## 1. 出错分流现在有哪些类（`gui/src/simple/recovery.ts`，按判断顺序抄）

`actionsFor()` 从上往下取**第一条命中**的规则。原文里的下表是**逐条对今天那句
真原文**判的结果（不是推理：把原文喂进 `actionsFor` 跑出来的）。

| # | 规则 | 认什么（原文） | 今天那句命中吗 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `BRIDGE` | `desktop bridge unavailable` / `not running inside tauri` | 否 | 原文里没有这些词 |
| 2 | `ASSISTANT_MISSING` | `动手的组件` | 否 | 这是桥给自己发的**中文**原话，原文是英文 |
| 3 | `DAEMON_MISSING` | `could not start … serve` / `command not found` / 不是内部或外部命令 | 否 | 同上 |
| 4 | `UNSURE` | `我拿不准` / `需要你确认` | 否 | 中文，且没有「拿不准」这类话 |
| 5 | `NOT_FOUND` | `ENOENT` / `no such file` / 找不到文件 | 否 | 原文没有文件路径，也没说找不到 |
| 6 | `BUSY` | `EBUSY` / `file is locked` / 另一个程序正在使用 | 否 | 原文没有占用类字样 |
| 7 | `LOCK_FILE` | `~$` | 否 | 没有临时锁文件记号 |
| 8 | `PERMISSION` | `permission denied` / 拒绝访问 | 否 | 原文没有权限字样 |
| 9 | `SPACE` | `ENOSPC` / 磁盘空间不足 | 否 | 原文没有空间字样 |
| 10 | `IMAGE` | `image` / `.png` / `ocr` / 图片 | 否 | 原文没有图片字样（`request` 不匹配） |
| 11 | `STALLED_MARKER` | `连不上帮你处理的服务方` | 否 | 那是桥在**长时间没消息**时报的中文原话 |
| 12 | `PROXY_BLOCK` | `(?<![\w.\/-])407(?![\w.])` / `proxy authentication` / `corporate proxy` | 否 | 原文里的 `[400]` 是 **400**，不是 407；也没有 proxy 字样 |
| 13 | **`NETWORK`** | `ECONNREFUSED` / `连接被拒绝` / **`\b50[234]\b`** / `rate limit` / `quota` | **是（就是它）** | 原文开头的 **`503`** 命中 `\b50[234]\b`（5 前是行首、3 后是 `:`，都算词边界） |
| 14 | `AUTH` | `api[-_ ]?key` / `unauthorized` / **`\b40[13]\b`** | 否 | **`40[13]` 只抓 401/403，抓不到 402**；原文里的 `[400]` 也不在里面 |
| 15 | `FORMAT` | `.xlsx` / `openpyxl` / `文件已损坏` | 否 | 原文没有文件后缀（`request` 不是） |

### 1.1 今天那句真正落到的两类（核过，不是猜）

**（a）带 `503` 的原文 → `NETWORK`（第 13 条）**。出路是 `RECOVERY.retryLater`：

- 按钮：**「过一会儿再试」**；
- 为什么是它：**「现在连不上帮你处理的服务方，多半是网络断了。先用浏览器看看别的
  网页能不能打开，过几分钟再点这个按钮。」**

→ 这条比她拿到「重新选文件」强，但仍然**把她引去查自己的网络** ✗。服务方欠费停机
时她查不出任何问题，白折腾；而且「多半是网络断了」和「服务方用完了」是两件事。

**（b）不带 `503`/`rate limit`/`quota`/`502`/`bad gateway` 的说法 → 兜底
（`generic()`）**。这正是问题最重的一格：

- 「你可以怎么做」是通用的 **「点「重试」再试一次；如果还是不行，点「换个方法」……」**；
- 行动列表是 **「再试一次」/「重新选一次文件」/「复制详情」** —— 其中
  **「重新选一次文件」把锅甩给了她的文件** ✗，而服务方有没有钱和她的文件毫无关系。

哪些说法今天会掉进这一格（逐条跑过）：`insufficient credits`（**去掉 `503`
前缀就是它**）、`429 Too Many Requests`、`HTTP 429`、`too many requests`、
`usage limit`、`insufficient balance`、`service unavailable`（不带 502/503 数字）、
`overloaded`、`402 Payment Required`、`用量用完了`。

> 为什么 `429` 会掉到兜底：`NETWORK` 只认字面 `rate limit`，**不认数字 429**；
> `50[234]` 又不含 429。所以同族的数字错误被切成了两半。

### 1.2 复现方法

```bash
cd gui
cat > probe-recovery.ts <<'EOF'
import { actionsFor } from "./src/simple/recovery.ts";
const raw = '503: {"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue  (reset after 15s)"}';
for (const text of [raw, "insufficient credits", "429 Too Many Requests", "402 Payment Required", "503 Service Unavailable"]) {
  const a = actionsFor({ what: "这件事没有做完。", how: "原来的文件都还在。", detail: text, cause: text });
  console.log(text.slice(0, 40), "=>", a.map((x) => `${x.kind}:${x.label}`).join(" | "));
}
EOF
bun probe-recovery.ts
rm probe-recovery.ts
```

（脚本要放在 `gui/` 里跑：`bun /tmp/xxx.ts` 会把里面的相对 import 解析到 `/tmp`，报
「Cannot find module」。上面这条命令就是修掉那个坑之后的版本。）

---

## 2. 新加的一类：「服务方忙 / 这个月用完了」

### 2.1 为什么和断网分开（出路不同）

| | 断网（`NETWORK`） | 服务方忙/用完了（新 `SERVICE_BUSY`） |
| --- | --- | --- |
| 她能自己修吗 | **能**：先看 wifi / 别的网页能不能打开 | **不能** |
| 该给她的下一步 | 先确认网络，再重试 | **等一会儿**；一直这样，**告诉管网络的同事** |
| 这类原文里她真正的错 | 没有 | 没有 |

### 2.2 边界：401/403 归 AUTH，402/429/502/503/504 归服务方

| 原文特征 | 归哪一类 | 出路 | 为什么 |
| --- | --- | --- | --- |
| `401` / `403` / `unauthorized` / `api key` / `密钥` | `AUTH` | 「复制详情给同事」：「这台电脑的账号还没弄好，你自己改不了」 | 这是**这台电脑没配好**，找配置电脑的人 |
| `402` / `429` / `502` / `503` / `504` | **新 `SERVICE_BUSY`** | 「过一会儿再试」+「复制详情给管网络的同事」 | 服务方收不了这一单；`40[13]` 本来就抓不到 402，正好分干净 |
| `400` | 不判 | 退回通用出口 | 「这次请求本身有问题」，不该硬猜成服务方 |
| `insufficient (credits\|quota\|balance\|funds)` / `quota exceeded` / `usage limit` / `rate limit` / `too many requests` / `service unavailable` / `bad gateway` / `overloaded` / 用量用完 / 余额不足 | **新 `SERVICE_BUSY`** | 同上 | 网关真的回过 / 常见 HTTP 语义 |

**顺序，不是改别人的正则 ✗。** 新类放在 `NETWORK` **前面**、`PROXY_BLOCK` **后面**：

- 放前面：`503`、`rate limit`、`quota` 在 `NETWORK` 里也有（第 13 条），两者都命中时
  必须让更具体的新类赢；
- 放 `PROXY_BLOCK` 后面：`502 … corporate proxy` 这种既要认证又被说成服务方时，
  「公司挡住」更具体；
- **不动 `NETWORK` 里那几串** ✗：删掉它们会让既有断言（普通断网仍是「过一会儿再试」）
  回归。

数字用和 `PROXY_BLOCK` 里 407 相同的判据：**前后不许紧贴字母 / 点 / 斜杠**——
所以 `报表429.xlsx`、`report-429.xlsx` 不会被当成状态码（`429` 后紧跟 `.` 就不算）。
没头没尾的 `HTTP 418` 认不出来，**老老实实退回通用出口**，不硬猜。

### 2.3 她看到的话（`gui/src/simple/copy-service.ts`）

单独一个 copy 模块（照 `copy-daemon.ts` 的先例），三句话是一个完整的故事，
必须放在一起校对：

1. **发生了什么**：「帮你干活的程序现在用不了，多半不是你做错什么。」
2. **你能做什么**：「过几分钟再试一次。」——按钮 **「过一会儿再试」**；
3. **一直这样**：按钮 **「复制详情给管网络的同事」**：「一直这样，就把下面这段原文
   复制出来，发给管网络的同事，请他帮忙看看。」

**零术语**：界面上不出现 `429` / `503` / `quota` / 额度 这类词（`copy-guard` 扫不到
数字和英文，这一条靠产品律 3 自己守住）。**技术原文照旧留在「复制详情」里**
（#282 的分层：她看中文那句，技术同事拿原文）。

---

## 3. 夹具能演这一出（关键回归）

- `gui/fixtures/fake-cante.ts` 加了 `FAKE_CANTE_TURN_QUOTA=1`：跑一半吐**今天那条
  真原文**（`Error` 事件），随后用非 `Completed` 的 `TurnEnd` 收尾——和既有的
  `FAKE_CANTE_TURN_ERROR=1` 同形。**原文一个字不改**，因为分流正是从
  `insufficient credits` 与 `503` 上认出来的；美化过就不再能证明任何事。
- `gui/fixtures/fake-cante.test.ts` 本轮**没动**（任务白名单里没有它）；真原文一字不改这件事由 `store.test.ts` 那条端到端用例盯住（`cause` 里必须同时有 `insufficient credits` 与 `503`）。
- `gui/CONTRACT.md` 的「夹具能演出的状态」清单从三个补到四个（事件名不变，所以
  `fixture-parity.test.ts` 的 `fixture-performed` 围栏块不用改，改的是文案清单本身）。
- **走产品那条真路**（§3.6 的判据）：`store.test.ts` 把夹具喂进真的 store，断言
  失败记录 `run.error.cause` 里是那条原文（给她看的 `what` 仍是平实中文，不含
  `credits` / `503`），再拿 `causeOf` + `actionsFor` 断言分流到「过一会儿再试」，
  不是「重新选一次文件」。

断言（`gui/src/simple/recovery-service.test.ts`）：

- 今天那句真原文 → 新类（`RECOVERY.serviceWait`），**不是网络、不是认证、不是兜底**；
- 同族 16 串都落到新类；她的话里**没有**「选文件 / 重新选 / 换个方法 / 文件有问题」；
- `401` / `403` 仍是 AUTH（「复制详情给同事」），**一条不回归**；
- 普通断网（`ECONNREFUSED` / `Connection error.` / 网络断了 / `ETIMEDOUT`）仍是
  `RECOVERY.retryLater`，不冒出服务方专用的「管网络的同事」；
- `HTTP 418` → 通用出口；`报表429.xlsx` / `report-429.xlsx` 不被当成状态码。

---

## 4. 我没验的（如实写）

- **真拔网线没做**：`ECONNREFUSED` / `Connection error.` 那几条是既有真机结论，
  本轮只重跑它们的单元断言，没有重新拔线。
- **真实网关这次没再打**：本轮的证据是**故意造出来的夹具**（脚本替身，不是真守护
  进程）+ `actionsFor` 的单元断言；「真网关回 503 时端到端长什么样」只能在有可用
  额度的机器上验。
- **Windows 真机没做**：这是纯前端分流 + 文案，不碰 Rust / 打包；Windows 上的产物级
  验证见 `gui/VERIFICATION-MAP.md`（本轮没有新增脚本，所以没往表里加行）。
- `explainError`（出错页「发生了什么」那句）**故意没动**：`403`-类错误的既有断言
  `noticeView("rate limited") === null` 把「英文状态不端给她」钉住了，本轮让服务方
  的整段话走在**出路（`why`）**里（和 `PROXY_BLOCK` 的 `askAdmin` 同一个做法），
  没有去改那条既有断言。
