# 真机验收：「真拔网线」那一场（#197 第三条 · wire）

**机器**：Windows 11 Home（win11 测试机）✓　**产物**：注册表里的安装版，再摆到隔离目录
（工作树里直接跑会被祖先 `node_modules` 干扰 ✓，见 `DEVELOPING-WINDOWS-VM.md`）
**真 WebView2** ✓　**跑法**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-offline.ps1 -Scenario wire
```

（用「当前用户 + Interactive + RunLevel **Limited**」的计划任务跑 ✓ —— 提权进程里
WebView2 150+ 会忽略调试端口变量 ✓，脚本自己会检测并**如实退回** ✓）

> 这一场**不是**摆一个假服务方 ✗：它用 Windows 防火墙把这个应用**自己的动手组件**
> （`pi\bun.exe`）到网关的**出站**掐掉 ✓ —— 也就是"真拔网线"那种 ✓。

## 结论先行

1. **现场是真摆上的** ✓（**反向判据** ✓，不是"看起来像"）：

```
加规则前，被掐的那个程序连 <网关地址> 通吗：CONNECTED (exit 0)
加规则后，同一个程序再连一次：             REFUSED ECONNREFUSED (exit 1)
现场已摆上：同一条连接在加规则前通、加规则后被拒/超时。
```

2. **她看到的是"网络问题"** ✓ —— **没有被说成文件问题** ✓（这正是 #197 要钉住的那条 ✓）：

```
这次没能做完
发生了什么: 这件事没有做完。
你可以怎么做: 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
→过一会儿再试：现在连不上帮你处理的服务方，多半是网络断了。
  先用浏览器看看别的网页能不能打开，过几分钟再点这个按钮。
连不上网上的服务，可能是网络断了，或者公司的网络挡住了。
```

3. **文件安全** ✓：输入表 `sha256` 前后一致 = **True** ✓。
4. **可逆** ✓（系统级改动自己收拾干净 ✓）：

```
（提权）删规则：admin=True
DELETED existedBefore=True stillThere=False
删后复查：ABSENT
```

（规则外部复查也已确认不在 ✓）

## 不覆盖 ✗

- 只跑了**一轮**有效 ✓（没有复跑排除偶发 ✗）。
- 只挡了这一个程序到这一个端口的出站 ✓；**真把网线/网卡断开**、公司代理那两种不在这一场 ✗。
- 用的是这台机器的**真网关地址** ✓（不是我们摆的 ✓），所以它同时依赖这台机器的网络环境 ✓。
- `proxy407`、`dead`、`cut` 三场是**别的**报告 ✓，不在这里 ✗。

---

## 原始报告（**脱敏副本**）

> 机器上的那份是**原件** ✓。收进仓库的这份把三样东西换掉了 ✗ —— 仓库是 public 的 ✓，
> 秘密扫描会（也**应该**）判红 ✓：真实家目录 → `<用户名>`、内网网关地址 → `<网关地址>`、
> 临时目录名里的时间戳 → `<时间戳>` ✓。**除此之外一个字节没改** ✓。
> （第一次提交时没脱敏，CI 的 `secret-scan` 当场判红 ✓ —— 闸门工作正常 ✓。）


```text
会话：session=1 elevated=False 有桌面=True

=== 清掉上一轮残留的子进程（否则调试端口被占，会误判成产品坏了）===
应用（原始）：C:\cante-wt\docs\gui\src-tauri\target\debug\cante-gui.exe
  祖先目录有 node_modules：C:\cante-wt\docs\gui（会干扰随包 pi 的模块解析）
应用（隔离副本）：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\cante-gui.exe

=== 现场：wire ===
运行目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>
应用：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\cante-gui.exe
WebDriver 端口：29732
要掐的服务方：<网关地址>:20128（报告里写 <网关地址>）
被掐的程序：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\pi\bun.exe
pi 配置目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\pi-config（wire：沿用这台机器默认服务方的地址与凭据，配置目录是本轮的）
输入：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\job\销售明细.xlsx
输入 sha256（跑之前）：34686856573B7CB875C9698FA12E4B25F798B519BEA6998BDC60AC5AFA4555A8
加规则前，被掐的那个程序连 <网关地址> 通吗：CONNECTED 7 (exit 0)
（提权）加规则：admin=True
ADDED enabled=True dir=Outbound action=Block program=C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\pi\bun.exe port=20128
加规则后，同一个程序再连一次：REFUSED ECONNREFUSED 7 (exit 1)
现场已摆上：同一条连接在加规则前通、加规则后被拒/超时。
已清应用档案：C:\Users\<用户名>\AppData\Local\dev.cante.gui

=== 跑一张卡，直到结局页（成功/失败都算结局，都落盘）===
==> 场景：wire
==> 应用：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\cante-gui.exe
==> pi 配置目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\pi-config（wire：用的是这台机器默认服务方的真地址，出站由防火墙按程序挡住）
==> 停滞后判据：120 秒（产品默认 600；这里压低是为了可观测）
==> 工作目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\job
[phase] tauri-driver 就绪 …
[phase] tauri-driver 就绪 — 449 ms
[phase] 打开 WebDriver 会话（启动应用） …
[phase] 打开 WebDriver 会话（启动应用） — 801 ms
[phase] 首页出现 …
[phase] 首页出现 — 5003 ms
--- 首页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 你好，需要我帮你做什么？
  | 点一张卡片，或者直接在下面说一句话。
  | 我做的结果
  | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  | 打开我做的结果（34 个）
  | 还有别的事？
  | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
  | 看看能做什么（共 33 项）
  | 表格
  | 合并、拆分、汇总、去重
[phase] 点卡片「从大表里挑出想要的行」 …
[phase] 点卡片「从大表里挑出想要的行」 — 36 ms
[phase] 选文件（原生对话框） …
[dialog] accept-file-dialog: 对话框 name='打开' pid=8216
[dialog] accept-file-dialog: 路径已写入（WM_SETTEXT(hwnd=1443310)），class='Edit'
[dialog] accept-file-dialog: 已点「打开」（BM_CLICK(hwnd=1050188)）
[phase] 选文件（原生对话框） — 1212 ms
[phase] 写一句话并生成计划 …
[phase] 写一句话并生成计划 — 103 ms
[phase] 确认页 → 开始 …
--- 确认页（节选）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
[phase] 确认页 → 开始 — 47 ms
[phase] 干活（含审批/提问） …
[phase] 干活（含审批/提问） — 14320 ms
--- 结局页（error-page）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
  | 4
  | 结果
  | 这次没能做完
  | 发生了什么
  | 这件事没有做完。
  | 你可以怎么做
  | 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
  | →过一会儿再试
  | 现在连不上帮你处理的服务方，多半是网络断了。先用浏览器看看别的网页能不能打开，过几分钟再点这个按钮。
  | 复制详情
  | 把下面那段原始说明复制出来，发给懂电脑的同事，让他帮你看看。
  | 连不上网上的服务，可能是网络断了，或者公司的网络挡住了。
  | 先用浏览器看看能不能打开网页；网络正常了，再试一次。
  | 展开技术详情
==> 替她点了：审批 0 次、结构化提问 0 次、追问 0 次
==> 读页面失败次数：0
drive-offline: OK — 到了结局页（error-page），原文已落盘。


输入 sha256（跑之后）：34686856573B7CB875C9698FA12E4B25F798B519BEA6998BDC60AC5AFA4555A8
原文件哈希一致 = True
结局：error-page
（提权）删规则：admin=True
DELETED existedBefore=True stillThere=False
删后复查：admin=True
ABSENT

=== 哈希对照 ===
输入表：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\job\销售明细.xlsx
跑之前 sha256：34686856573B7CB875C9698FA12E4B25F798B519BEA6998BDC60AC5AFA4555A8
跑之后 sha256：34686856573B7CB875C9698FA12E4B25F798B519BEA6998BDC60AC5AFA4555A8
一致 = True

=== wire 那一场的事实（服务方地址写 <网关地址>）===
服务方：<网关地址>（本机日志里是真实值）
被掐的程序：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-wire-<时间戳>\app-root\app\pi\bun.exe
规则名：cante-offline-wire
加规则前的连接：CONNECTED 7 (exit 0)
加规则后的连接：REFUSED ECONNREFUSED 7 (exit 1)
规则加上了 = True
规则删掉了 = True

```

---

## 同一份报告 · `proxy407` 那一场（代理回 407 要登录）

摆一个**回 407（代理要认证）** 的假服务方 ✓ —— 这跟 `wire`（真被挡住 ✓）是**不同**的错法 ✓。

**她看到的（真 WebView2 屏幕原文）**：与 `wire` 那一场**一致** ✓ —— 都是「**网络问题**」✓：

```
这次没能做完
发生了什么: 这件事没有做完。
你可以怎么做: 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
→过一会儿再试：现在连不上帮你处理的服务方，多半是网络断了。
  先用浏览器看看别的网页能不能打开，过几分钟再点这个按钮。
连不上网上的服务，可能是网络断了，或者公司的网络挡住了。
```

**文件安全** ✓：`sha256` 跑前/跑后/盘上三处**完全一致** ✓：

```
跑之前 sha256：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
跑之后 sha256：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
一致 = True
```

**一条值得记的观察** ✓：`407`（要认证 ✓）与 `wire`（连不上 ✓）**两种不同的网错**，给出的动作**是同一个**（「过一会儿再试」✓）——
这对她是对的 ✓（两种她都无法自救 ✓，都是"过一会儿/找网管"✓），但也说明我们**还没**为"要登录/要认证"给出更具体的出路 ✗（例如"找公司网管 ✓"）——**这条没做** ✗。

**这一场不覆盖** ✗：真的企业代理（这台机器上没有 ✓）、证书错误、以及只跑了**一轮**有效 ✓。

---

## 原始报告 · proxy407（脱敏副本）

```text
会话：session=1 elevated=False 有桌面=True

=== 清掉上一轮残留的子进程（否则调试端口被占，会误判成产品坏了）===
应用（原始）：C:\cante-wt\docs\gui\src-tauri\target\debug\cante-gui.exe
  祖先目录有 node_modules：C:\cante-wt\docs\gui（会干扰随包 pi 的模块解析）
应用（隔离副本）：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\app-root\app\cante-gui.exe

=== 现场：proxy407 ===
运行目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>
应用：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\app-root\app\cante-gui.exe
假服务方端口：18093
WebDriver 端口：40606
pi 配置目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\pi-config（baseUrl=http://127.0.0.1:18093/v1）
输入：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\job\销售明细.xlsx
输入 sha256（跑之前）：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
假服务方进程 pid=1016，日志：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\relay-proxy407.log
[relay:proxy407] listening on 18093
端口 18093 有人听 = True（dead 期望 False，其余期望 True）
已清应用档案：C:\Users\<用户名>\AppData\Local\dev.cante.gui

=== 跑一张卡，直到结局页（成功/失败都算结局，都落盘）===
==> 场景：proxy407
==> 应用：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\app-root\app\cante-gui.exe
==> pi 配置目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\pi-config（假服务方在这里面）
==> 停滞后判据：120 秒（产品默认 600；这里压低是为了可观测）
==> 工作目录：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\job
[phase] tauri-driver 就绪 …
[phase] tauri-driver 就绪 — 532 ms
[phase] 打开 WebDriver 会话（启动应用） …
[phase] 打开 WebDriver 会话（启动应用） — 802 ms
[phase] 首页出现 …
[phase] 首页出现 — 5122 ms
--- 首页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 你好，需要我帮你做什么？
  | 点一张卡片，或者直接在下面说一句话。
  | 我做的结果
  | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  | 打开我做的结果（34 个）
  | 还有别的事？
  | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
  | 看看能做什么（共 33 项）
  | 表格
  | 合并、拆分、汇总、去重
[phase] 点卡片「从大表里挑出想要的行」 …
[phase] 点卡片「从大表里挑出想要的行」 — 37 ms
[phase] 选文件（原生对话框） …
[dialog] accept-file-dialog: 对话框 name='打开' pid=8120
[dialog] accept-file-dialog: 路径已写入（WM_SETTEXT(hwnd=5374806)），class='Edit'
[dialog] accept-file-dialog: 已点「打开」（BM_CLICK(hwnd=10487016)）
[phase] 选文件（原生对话框） — 1118 ms
[phase] 写一句话并生成计划 …
[phase] 写一句话并生成计划 — 97 ms
[phase] 确认页 → 开始 …
--- 确认页（节选）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
[phase] 确认页 → 开始 — 50 ms
[phase] 干活（含审批/提问） …
[phase] 干活（含审批/提问） — 14263 ms
--- 结局页（error-page）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
  | 4
  | 结果
  | 这次没能做完
  | 发生了什么
  | 这件事没有做完。
  | 你可以怎么做
  | 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
  | →过一会儿再试
  | 现在连不上帮你处理的服务方，多半是网络断了。先用浏览器看看别的网页能不能打开，过几分钟再点这个按钮。
  | 复制详情
  | 把下面那段原始说明复制出来，发给懂电脑的同事，让他帮你看看。
  | 连不上网上的服务，可能是网络断了，或者公司的网络挡住了。
  | 先用浏览器看看能不能打开网页；网络正常了，再试一次。
  | 展开技术详情
==> 替她点了：审批 0 次、结构化提问 0 次、追问 0 次
==> 读页面失败次数：0
drive-offline: OK — 到了结局页（error-page），原文已落盘。


输入 sha256（跑之后）：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
原文件哈希一致 = True
结局：error-page

=== 哈希对照 ===
输入表：C:\Users\<用户名>\AppData\Local\Temp\cante-offline-proxy407-<时间戳>\job\销售明细.xlsx
跑之前 sha256：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
跑之后 sha256：E4B40A9C0DB31C171394246CD10F53E7708343979031DD98F4C7FE04818996CA
一致 = True

```
