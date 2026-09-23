# 验收 32 —— WSL 入口自己写 resolv.conf（不赌持久化），并把 DNS 失败的出路说准

- **机器**：Windows 11 家庭版 `10.0.26200` x64，Windows PowerShell **5.1**.26100.9444（真机，SSH 会话）
- **WSL**：`Ubuntu-24.04`（版本 2），默认用户 **root**，`HOME=/root`
- **验的产物**（真机上与提交里这两份逐字节相同 —— 先 `scp` 上去再算 sha256）：
  - `gui/scripts/windows/wsl-ante-setup.ps1`，sha256 `3777938C6EAB344AD50C0F5947F98B6AF52238A6F62A8ADB962B7A9905BA4477`
  - `gui/scripts/windows/weekly-sweep.ps1`，sha256 `AEC02564AB2BC05FCCFECF8C2F450DED0EA6552BFE0A6061E1DD893E0B74ABAE`
- **没碰**：产品代码、Rust、前端、`task-sweep.sh`、`gui/scripts/sweep/`。只改上面两个 `.ps1`，外加这份记录。

## 0. 结论一句话

**「入口自己写 resolv.conf」已落地并在真机上跑通（setup 5/5、真守护进程、单卡真跑通过）；
但我要先纠正上一轮的一个前提：「手动写死 resolv.conf 当场 DNS_OK」是假的，`cante.run` 在任何
DNS 下都是 NXDOMAIN（它是个**占位域名**）——所以「DNS 修好 ⇒ 下载就能成」这条推理不成立。**

## 1. 先纠正前提：那个 `DNS_OK` 是管道退出码换来的假阳性

issue #303 的最后一条评论里，真根源被写成「WSL NAT 默认 DNS 是死的 systemd 存根」，证据是
手动写死 `/etc/resolv.conf` 后「当场 DNS_OK」。我照着现场脚本 `C:\Users\<用户名>\dnsfix.sh`
的那一行在真机上复跑：

```bash
getent hosts cante.run | head -1 && echo DNS_OK || echo DNS_DEAD
```

逐字结果：

```
DNS_OK
--- 真实退出码 ---
getent rc=2
```

**`getent` 明明退 2（没解析出来），还是打印了 `DNS_OK`** —— 管道把 `getent` 的退出码换成了
`head` 的 0 ✓。所以那条「DNS_OK」不是证据。这一条判断错误值得写下来：**管道会吃掉退出码，
判断「通不通」必须看退出码本身**（我们脚本里一律 `getent ... >/dev/null 2>&1` 再看 `$?`）。

`cante.run` 到底能不能解析 —— 换了好几个解析器都试了：

| 在哪 | 命令 | 结果 |
| --- | --- | --- |
| 本机 macOS | `host cante.run` / `dig @8.8.8.8` | `NXDOMAIN` / `status: NXDOMAIN` |
| 公共 DNS | `dig @1.1.1.1` / `@114.114.114.114` / `@223.5.5.5` | 全是 `NXDOMAIN` |
| 那台 Windows 的 DNS | `Resolve-DnsName cante.run` | `HOST_RESOLVE_FAILED: cante.run : DNS 名称不存在。` |
| WSL 里 | `getent hosts cante.run` | 退出码 2 |
| 局域网 DNS `192.168.x.x` | `dig @192.168.x.x cante.run` | `NXDOMAIN` |

**`.run` 顶级域里这个域名根本没注册**（NXDOMAIN 是 TLD 的权威回答，不是被墙/超时）。
上一单（验收 31 §7.2）已经记过 `cante.run` 与 `download.cante.run` 都是 `NXDOMAIN` —— 这份
记录把「为什么手动写 DNS 也救不了它」补上了。

**同时实测：这台机器的 WSL 存根并不是死的** —— 真域名它解析得好好的：

```
--- getent example.com ---
2606:4700:10::6814:179a example.com
--- getent download.ante.run ---
34.54.98.161    download.ante.run
```

所以：**DNS 这一层在这次现场不是下载失败的根因**（根因是那个域名不存在）。那为什么还要做这个
改动？因为**实例重启真的会把 resolv.conf 打回**（§4.5 有逐字证据），入口自写是便宜且正确的
健壮性动作；而且它让我们能把报错**从「检查网络」改成说得准的那句**（§4.1）。

## 2. 改了什么（只在两个 `.ps1` 里）

| # | 改动 | 为什么 |
| --- | --- | --- |
| 1 | `wsl-ante-setup.ps1` 新增 **2.5/5**：`rm -f /etc/resolv.conf; printf 'nameserver 223.5.5.5\nnameserver 1.1.1.1\n' > /etc/resolv.conf`，紧跟一条 `getent hosts cante.run` 探针 | 不赌 `/etc/wsl.conf` 持久化（那条路真机上没调通 ✗）；每次进来先自己写一遍，比持久化还稳 |
| 2 | `weekly-sweep.ps1` 在 WSL 活体探针之后、`bun` / `ante` 探针之前，也加同一段自写 + 探针 | 同上；普查是每周被计划任务拉起的，它自己写才不会看运气 |
| 3 | 探针**分两层**：解析不了下载域名时，再试 `example.com` / `www.baidu.com` | 把两种失败分开：**只有这个名字解析不了** = 下载源/域名问题；**别的域名也不行** = 这台机器真没网 |
| 4 | `wsl-ante-setup.ps1` 的下载失败报错：不再说「确认网络能访问 cante.run」，改成先报 DNS 那层的实测结论 + 下一步该看什么 | 产品律 3「出错能看懂并有出路」：出路要指对，别让人去查一个没坏的东西 |
| 5 | 两条脚本的 `Invoke-WslCapture` 换成 .NET `Process`（`wsl-ante-setup.ps1` 原来是 `Start-Process -Wait`，**设不了超时**）；每条外部命令都带上限，超时单独标 `TimedOut` | AGENTS.md §5：可能变慢的命令必须有超时，且**「超时」与「确认没有」分开写**。DNS 探针 180 秒，下载 1800 秒 |
| 6 | `ante --version` / `--help` 改走带超时的捕获再回显 | 原来 `& wsl.exe ...` 无上限；现在 120 秒上限，超时单独报 |
| 7 | 网关主机也掩码：IPv4 只留前两段（`192.168.x.x`） | 这段输出常被贴进验收报告；把内网 IP 整个写出去等于带出内网拓扑 |

**关于「不改 weekly-sweep 的退出码」**：DNS 不通时普查**照跑**（只把探针结果记进报告的
「原始输出」）。理由是这台机器上守护进程走的是 **IP 形式**的网关（不需要 DNS），把一次本来能
跑完的普查按 DNS 按死不划算。这一条是**有意的取舍**，不是漏掉。

## 3. 真机怎么复现

```powershell
# 从提交里取那两个文件，放到真机上（我这轮放在 C:\r21-dnsfix\scripts\）
scp gui/scripts/windows/wsl-ante-setup.ps1  <win>:C:/r21-dnsfix/scripts/
scp gui/scripts/windows/weekly-sweep.ps1    <win>:C:/r21-dnsfix/scripts/

# PS AST 语法解析（两个都 OK）
[System.Management.Automation.Language.Parser]::ParseFile("C:\r21-dnsfix\scripts\wsl-ante-setup.ps1",[ref]$t,[ref]$e)

# 1) 跑 setup（真机；本单全程用 -Version 0.2.2，理由见 §4.2）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\r21-dnsfix\scripts\wsl-ante-setup.ps1 -Version 0.2.2

# 2) 单卡真跑（走 weekly 那条路，它自己会写 resolv.conf + 配网关）
powershell -NoProfile -ExecutionPolicy Bypass -File C:\r21-dnsfix\scripts\weekly-sweep.ps1 -Cards excel.diff -TimeoutSeconds 900 -OutDir C:\r21-dnsfix\sweep
```

## 4. 真机结果

### 4.1 setup：DNS 那一步逐字 + 5/5

（完整输出留在 `C:\r21-dnsfix\`；下面是逐字摘录）

```
==> 2.5/5 修 WSL 的 DNS（入口自己写 /etc/resolv.conf，不赌持久化）
      CANTE_DNS_WRITTEN
      CANTE_DNS_FIRST:nameserver 223.5.5.5
      CANTE_DNS_UNRESOLVED:cante.run
      CANTE_DNS_FALLBACK_OK:example.com
  [!]  DNS 现在是通的（example.com 这类名字能解析），但下载域名 cante.run 解析不了——这是这个名字/下载源的问题，不是 WSL 没网。
```

```
==> 3/5 准备安装目录：/root/cante-bin（版本 0.2.2）
  [ok] 二进制：/root/cante-bin/ante
  [ok] STATE:ALREADY:ante 0.2.2

==> 4/5 自检（都在 WSL 里跑）
  [ok] 用这个二进制：/root/cante-bin/ante
  $ wsl.exe  -e /root/cante-bin/ante --version
      ante 0.2.2
  [ok] ante --version 正常
  [ok] ante --help 正常

==> 4.5/5 把网关配进 WSL（没有它守护进程起来也用不了）
  [ok] 网关来源：C:\Users\<用户名>\.pi\agent\models.json（服务方 9router）
  [ok] 已写入 WSL 的 ~/.ante/cante-gateway.env（权限 600；主机 192.168.x.x，密钥 35 位）

==> 5/5 该给应用设的 CANTE_BIN
    wsl.exe -e /root/cante-bin/ante serve
[完成] WSL 里的守护进程就绪。
```

**`ante --version` 逐字**：

```
ante 0.2.2
```

退出码 **0**（`[remote exit code = 0]`）。**5/5 成功** ✓ —— 但请连着 §4.2 一起读：这一跑走的是
「已装好」那条路（`STATE:ALREADY`），**不是**从 `cante.run` 真下载 100MB+。

### 4.1.1 没有守护进程时，下载失败的报错（升级后的那一句）

把 `~/cante-bin/ante` 临时挪开（跑完 `mv` 回去了，见 §6），再跑一次：

```
==> 3/5 准备安装目录：/root/cante-bin（版本 0.preview.99）
  正在下载并解包（从 cante.run/install.sh；大版本要几分钟，这一条最多等 30 分钟）…
      STATE:DOWNLOADING:0.preview.99
      FAILED:download
      curl: (6) Could not resolve host: cante.run

[失败] 下载失败。脚本开头已经在 WSL 里自己写过 /etc/resolv.conf（223.5.5.5 / 1.1.1.1），而且当时别的域名能解析（只是 cante.run 这个名字解析不了）。所以先别怀疑 WSL 的 DNS：手动跑一次 wsl.exe -e bash -lc 'curl -fsSv https://cante.run/install.sh -o /dev/null'，看 curl 报的是名字解析不了（域名/下载源的问题），还是连上了但 HTTP 报错（版本号不存在 / 服务器问题）。
```

退出码 **1**。**这就是「出路指对」的那一条**：旧文案让人去「确认网络能访问 cante.run」，
新文案直接说「DNS 那层我刚测过、是通的，问题在这个域名本身」。

### 4.2 诚实边界：为了拿到真守护进程，我用了上游宿主（提交里没改下载地址）

`cante.run` 是**占位域名**（§1），所以从它下载**永远**不会成功 —— 这不是 DNS 能修的。为了拿到
**真**守护进程把 #303 的「单卡实跑」做实，我在 WSL 里用**同一个 install.sh 的真实宿主**装了一份
**真 Linux `ante`**：

```
[INFO] Platform detected: linux-x86_64
[INFO] Expected size: 14.7 MiB (15414611 bytes)
[INFO] SHA256 verification passed
[INFO] Installing ante to /root/cante-bin (atomic replace)...
[INFO] Verification: ante 0.2.2
```

- 装完 `/root/cante-bin/ante` = 36846352 字节、`ante 0.2.2`；**这台机器现在有真守护进程了** ✓
  （这正是 #303 最后一条要的「把 ante 真装进 root 家」）。
- **提交里的脚本一个字都没改下载地址** —— 验证时用的是上游宿主，仓库里保留占位域名 `cante.run`
  不动（改域名/改仓库品牌不是这一单的事 ✗）。
- 所以 §4.1 的 5/5 是「二进制已在，跳过下载」+「其余四步全跑」；**「从 `cante.run` 下载 100MB+」
  这一条我没法验**（原因如上，不是超时）。

### 4.3 单卡真跑：`excel.diff` 通过（走 weekly 那条路）

> 任务里写的 `sheet.sum` 在普查卡表里**不存在**（`sweep.py` 里 38 个 id 没有它）。我用了最接近的
> 表格卡 **`excel.diff`**（对比两张表），它同时是历史报告里出现过的卡。

```
==> WSL DNS：域名解析是通的，但下载域名 cante.run 这个名字解析不了（下载源/域名问题，不是没网）
==> 每周普查开始：2026-09-21T10:47:18
==> 模型端点已就绪（值不打印；服务方：9router）
==> 在 WSL 里跑普查（报告：C:\r21-dnsfix\sweep\report-20260921.md）
工作目录：/mnt/c/r21-dnsfix/sweep/wsl-work
守护进程：/root/cante-bin/ante serve
==> excel.diff
    通过：产出 对照数据.csv、结果_对比.xlsx；csv 按文本读回 16 行; cante-sheets 读回 20 行；表：对照

报告写到：/mnt/c/r21-dnsfix/sweep/report-20260921.md
==> 结束：2026-09-21T10:48:18；退出码 0；报告 C:\r21-dnsfix\sweep\report-20260921.md
```

- **真守护进程 + 真模型端点 + 真卡 + 真产出**（`对照数据.csv` / `结果_对比.xlsx`，
  并且是**产品自己的 `cante-sheets.exe`** 读回来的：csv 16 行 / sheets 20 行 ✓）。
- **60 秒**跑完（10:47:18 → 10:48:18），退出码 **0** —— 远在 15 分钟以内 ✓（没有到顶）。
- 报告里模型名是 `ocg/deepseek-flash`（不含密钥值）。
- **`启动即失败` 消失了** ✓：这条正是 #303 要的那个实锤。

### 4.4 DNS 证据也进了失败报告

再临时挪开守护进程、跑一次 weekly（这次一定失败），失败报告的「原始输出」一节里能看到 DNS 探针：

```
21:DNS 探针（退出码 0）：
22-CANTE_DNS_WRITTEN
23-CANTE_DNS_FIRST:nameserver 223.5.5.5
24-CANTE_DNS_UNRESOLVED:cante.run
```

（报告同时写了「WSL 里没有守护进程」这一类，退出码 2 —— 分类没被这步弄坏 ✓。）

### 4.5 为什么「不赌持久化」是对的：实例重启真的会打回

```
== 1) 手写 resolv.conf 后 ==
nameserver 223.5.5.5
nameserver 1.1.1.1
== 2) wsl --shutdown ==
== 3) 实例重启后 ==
# This file was automatically generated by WSL. To stop automatic generation of this file, add the following entry to /etc/wsl.conf:
# [network]
# generateResolvConf = false
nameserver 10.255.255.254
```

手写的两行**被自动生成的存根覆盖回去了** ✓ —— 所以入口每次都写是对的；持久化（`/etc/wsl.conf`）
这条路按任务要求**没去动** ✗。

## 5. 没验的（跟上面分开写）

1. **从 `cante.run` 下载 100MB+**：没有验，也没法验 —— `cante.run` 在所有 DNS 下都是 NXDOMAIN
   （**不是超时、不是被墙**，是域名不存在）。这一条要等下载源本身能通。
2. **「WSL DNS 写了还是不通 = 这台机器真没网」那条分支**：只走了**代码路径**，没造真实现场
   （这台机器有网，我不能为了验它把网拔了）。判据是探针文本里出现
   `CANTE_DNS_FALLBACK_OK` 与否，静态可读（§2 #3）。
3. **`-CheckOnly` 时 DNS 不通**：没单独造现场；代码里这条分支只是打印 `[!]` 提示、不 `Fail`。
4. **1800 秒下载超时 / 180 秒 DNS 探针超时**：没造到超时现场（每一步都在秒级返回）。
   超时与「确认没有」在代码里是分开的两个字段 ✓，但**「真等到 30 分钟」我没试过** ✗。
5. **计划任务 `CanteWeeklySweep` 本身**：没触发它；跑的是等价的手工调用（沿用 #300/#31 的写法）。
6. **真机推分支/开 PR 的凭据问题**：这一单的 commit/push 在本机做（不在那台 Windows 上），
   所以没撞上 AGENTS.md §6.5 那个 workflow scope 的坑。

## 6. 原始输出、清理与收敛

- 真机留档（`C:\r21-dnsfix\`）：两个脚本 + `sweep\report-20260921.md`（这次单卡的报告）+
  `sweep\logs\sweep-20260921.log` + `sweep\history.log` + 两个垫片。
- **清掉的临时产物**：普查工作目录 `C:\r21-dnsfix\sweep\wsl-work`（撤掉了，里面全是这一次的夹具与
  产出）、临时隐藏用的 `ante.r21hidden`（`mv` 回去了，`/root/cante-bin` 现在只有 `ante` 一个文件）、
  验证脚本 `C:\r21-dnsfix\sweep2`（失败报告那次，整目录删掉）。
- **留下的（都是有意留的，不是残留）**：WSL 里的**真** `ante 0.2.2`（`/root/cante-bin/ante`，
  #303 要的就是它）+ `~/.ante/cante-gateway.env`（setup 的产物，权限 600）。
- **密钥/内网收敛**：日志与这份文档里**没有**密钥值、没有内网 IP 全值（网关主机只写
  `192.168.x.x`）、没有真实家目录（统一写 `C:\Users\<用户名>`）。在 `C:\r21-dnsfix\` 里按
  `192.168.\d+\.\d+` / `10.\d+\.\d+\.\d+` / `sk-[A-Za-z0-9_-]{12,}` + 控制台编码重定向自查过一遍，
  只命中 `10.255.255.254`（WSL 的 NAT 存根常量，写死在注释里，不是现场地址）。
- 本机 `bash gui/scripts/secret-scan.sh` ✓：`691 个会被提交的文件，没有密钥、内网地址或本机家目录字面量`。
