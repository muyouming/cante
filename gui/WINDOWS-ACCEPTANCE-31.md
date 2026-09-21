# 验收 31 —— 每周普查失败时留下一份看得懂的报告（不再写只有 5 字节的空文件）

- **机器**：Windows 11 家庭版 `10.0.26200` x64，Windows PowerShell **5.1**.26100.9444（真机，SSH 会话）
- **WSL**：`Ubuntu-24.04`（本单开场时刚复活，版本 2）；`wsl -l -v` 输出见 §6
- **验的产物**：`gui/scripts/windows/weekly-sweep.ps1`，sha256 `D06F317918A01602506BCBA4781470F0D89BC44182D505BB8D42D79A9FFC63B8`
  （真机上那份与提交里这一份逐字节相同——先 `scp` 上去再算的 sha256）
- **只在真机上改的临时东西**：为跑通“成功回归”，在 WSL 里装了 bun、`pypdf`、`Pillow`，并在
  `~/cante-bin/ante` 放了一个**临时替身**。替身跑完全部撤掉（见 §6、§7），现在机器上说真话：
  下一次普查会写一份「WSL 里没有守护进程（ante）」。

## 1. 问题（为什么开这一单）

成功才有报告；失败只留下一个空文件。历史里就是这样：

```
2026-09-20T15:48:34  退出码=1  5 字节  C:\cante-sweep\report-20260920.md
2026-09-21T07:35:05  退出码=2  5 字节  C:\cante-sweep\report-20260921.md
2026-09-21T07:52:37  退出码=2  5 字节  C:\cante-sweep\report-20260921.md
```

5 字节 = `EF BB BF 0D 0A`（BOM + 换行），正文一个字都没有。日志里其实写着真因
（`task-sweep: 需要 bun（用来调用产品自己的提示词函数）`），**但报告本体是空的**——
两周后没人点进去看的人（三个月后的我们）根本不知道上周发生了什么。9/20 那次靠乱码猜（#300 修的），
9/21 这次直接空了 —— 同一个错犯两次。

**开工时** `report-20260921.md` 读到的就是 5 字节；它对应的 `history.log` 最后一行是
`07:52:37 退出码=2 5 字节`，日志最后一行是上面那句「需要 bun」。

> 一个插曲，如实写：我上机后，一个**此前就排好队的一次性计划任务**（`CanteSweep4` 的 action，
> `Last Run Time 08:12:06`）用**旧**脚本重跑了一次，把我最早读到的那份 5 字节覆盖成了 1339 字节。
> 我没能在它之前先备份（这是我顺序上的错）。所以 §5.0 里我用**提交前的脚本**重新造了一份同样的
> 5 字节产物当代替证据；旧脚本与新脚本的差别只在失败后怎么写报告，产物形状一模一样。

## 2. 改了什么（只在 `weekly-sweep.ps1`，不动 `task-sweep` 本体）

| # | 改动 | 为什么 |
| --- | --- | --- |
| 1 | 新增 `Write-FailureReport`：任何失败路径都写「**发生了什么 / 你能怎么做 / 复制这段给技术同事**」三段 | 产品律 3：出错能看懂并有出路。这份周报就是我们自己的出口 |
| 2 | 新增 `Get-ReportBody` + 收尾兜底：报告正文为空就把失败节写进去 | 「报告永远非空」这条判据写成代码，不靠人记得 |
| 3 | 新增 2.5 步探针：`command -v bun`（并真跑一次 `bun --version`，防 dangling 软链）、
`test -x "$HOME/cante-bin/ante"` | 把「缺 bun」「缺守护进程」在跑 `task-sweep` 前就分清；两条都在**交互会话**里探
（WSL 发行版按 Windows 用户注册，SYSTEM 会拿到 `WSL_E_LOCAL_SYSTEM_NOT_SUPPORTED`） |
| 4 | 5.5 步按探针 / 退出码 / 报告是否为空四分类，各写各的「你能怎么做」 | 「WSL 起不来」「缺 bun」「缺守护进程」「task-sweep 自己退」四类的出路不一样，不能糊成一团 |
| 5 | `Invoke-WslCapture` 改用 .NET `System.Diagnostics.Process`（原来 `Start-Process -PassThru` 不加 `-Wait`，
PS 5.1 下 **`ExitCode` 拿不到**：真机实测 `$p.ExitCode` 是空的、`[int]` 是 0；见 §5.8） | 既要**可靠退出码**，又要从 `BaseStream` 拿**原始字节**保住 #300 那条「按字节认 UTF-16LE / UTF-8」 |
| 6 | 每条外部命令带超时（默认 120 秒）；超时单独标 `TimedOut`，报告里写「**超时：N 秒没跑完**」 | AGENTS.md §5：**超时和「确认没有」必须分开写** |
| 7 | 「复制这段给技术同事」上限 60 行（头 15 + 尾 45，中间标省略行数）；完整输出在日志里 | 报告是给人看的；全量普查的原始输出有几十 KB，不能整个倒进报告 |
| 8 | 探针参数一律走 `-e bash -s`（脚本从 stdin 喂），并让 `-Distro` 也作用到探针 | PS 5.1 对原生程序带空格/换行的参数会吃引号（实测把 `if ... fi` 拆成语法错）；
`-d` 指到不存在的发行版时，现在会走到「WSL 起不来」并给出可读中文错误 |

**没改**：`task-sweep.sh`、`gui/scripts/sweep/`、任何产品代码、任何 Rust。只改了这一个 `.ps1`。

## 3. 四类失败怎么分的（判据都用各步自己的探针 / 退出码）

| 类别 | 判据（真机探针 / 退出码） | 本脚本退出码 | 「你能怎么做」指向 |
| --- | --- | --- | --- |
| 1) WSL 起不来 | 最上面那条 `wsl.exe <distro> -e bash -s`（读回原文；`wsl -l -v` 一起贴进报告） | `3`（沿用旧行为） | `wsl --install` → 重启 → `wsl-ante-setup.ps1`；给了 `-Distro` 时另提示核对发行版名 |
| 2) WSL 里缺 bun | `command -v bun && bun --version`（两条都过才算有） | `2` | 用 `bun-linux-x64.zip` + `python3` 解压到 `~/.bun/bin/bun`（WSL 没有 unzip） |
| 3) WSL 里缺守护进程 | `test -x "$HOME/cante-bin/ante"`（脚本用的就是这条路径） | `2` | 跑 `wsl-ante-setup.ps1` 装回 `~/cante-bin` |
| 4) task-sweep 自己退非 0 | 前三样都有，且 `task-sweep` 退出码非 0、**报告正文为空** | 原样透传 `task-sweep` 的退出码 | 看日志最后几行（原始输出也贴在报告里） |

另外两条「不是失败」的分支：模型端点（`models.json`）没配 → 写一份「没找到模型端点」报告并退 2；
报告正文为空是最后一道兜底（产品律 3）。**成功时什么都不做**：`sweep.py` 写出来的报告原样保留。

## 4. 现场怎么造的（每次只动一样，跑完立刻还原）

- **缺 bun**：`mv ~/.bun/bin/bun ~/.bun/bin/bun.r20hidden; rm -f /usr/local/bin/bun`；
  探针读到 `BUN-BROKEN`。跑完 `mv` 回去 + 重建 `/usr/local/bin/bun` 软链。
- **缺守护进程**：`mv ~/cante-bin/ante ~/cante-bin/ante.r20hidden`；跑完 `mv` 回去。
- **task-sweep 自己退非 0**：不动环境，用一张认不出的卡 `-Cards does.not.exist.card`。
- **WSL 起不来**：不动 WSL，用不存在的发行版 `-Distro Ubuntu-24.04-DoesNotExist`（真 `wsl.exe` 报错）。
- **成功回归**：干净工作目录 + `-Cards files.rename`。

## 5. 现场证据（逐字）

### 5.0 复现旧行为：5 字节

用提交前的 `weekly-sweep.ps1`（`git show HEAD:...`）在 bun 缺失时跑：

```
[r20-1-OLD-nobun] exit=2 report=5 bytes head=[EF BB BF 0D 0A]
```

产物逐字十六进制（BOM + CRLF，正文为空）：

```
00000000: efbb bf0d 0a                             .....
```

### 5.1 失败一：WSL 里没有 bun（新脚本，同样缺 bun）

`[r20-2-NEW-nobun] exit=2 report=1318 bytes`，报告全文：

````
# 每周普查没跑成：WSL 里没有 bun

生成时间：2026-09-21 08:24

## 发生了什么

WSL 起来了，但里面没有 bun。普查第一步就要用它（调产品自己的提示词函数），所以 task-sweep 当场就退了（本次退出码 2）。
**这既不是产品的结论，也不是某张卡的结果。** 报告本体因此本来是空的，现在把真因写在这里。

**这一份不是产品的结论，也不是某张卡跑输了的证据** —— 普查根本没跑起来（或在第一步就停了）。

## 你能怎么做

1. 在 WSL 里装 bun。注意：WSL 里通常没有 unzip，官方那条 `curl bun.sh/install | bash` 会报 `unzip is required`；照 `gui/WINDOWS-ACCEPTANCE-4.md` 的办法，下 `bun-linux-x64.zip` 再用 `python3` 解压到 `$HOME/.bun/bin/bun`。
2. 确认装好了：`wsl.exe -e bash -lc 'export PATH=$HOME/.bun/bin:$PATH; bun --version'` 能打印版本号。
3. 再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1`，这次应该能出真正的报告。

## 复制这段给技术同事（这次真正发出去的输出，原样）

```
bun 探针（退出码 0）：
CANTE_BUN_MISSING

ante 探针（退出码 0）：
CANTE_ANTE_OK

--- task-sweep 这次的输出 ---
task-sweep: 需要 bun（用来调用产品自己的提示词函数）
```
````

（`task-sweep: 需要 bun…` 就是 9/21 那份 5 字节报告只敢写进日志、不敢写进报告的同一句真因。）

### 5.2 失败二：WSL 里没有守护进程（ante）

`[r20-3-NEW-noante] exit=2 report=2474 bytes`，报告全文：

````
# 每周普查没跑成：WSL 里没有守护进程（ante）

生成时间：2026-09-21 08:24

## 发生了什么

WSL 和 bun 都在，但 $HOME/cante-bin/ante 不在（或者不是可执行文件）。
普查要驱动真守护进程，没有它一张卡也跑不了（本次 task-sweep 退出码 1）。

**这一份不是产品的结论，也不是某张卡跑输了的证据** —— 普查根本没跑起来（或在第一步就停了）。

## 你能怎么做

1. 在 Windows 上跑 `gui\scripts\windows\wsl-ante-setup.ps1`，把守护进程装回 WSL 的 `$HOME/cante-bin`；
2. 确认装好了：`wsl.exe -e ~/cante-bin/ante --version` 能打印版本号；
3. 再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1`。

## 复制这段给技术同事（这次真正发出去的输出，原样）

```
bun 探针（退出码 0）：
CANTE_BUN_OK
1.4.2

ante 探针（退出码 0）：
CANTE_ANTE_MISSING

--- task-sweep 这次的输出 ---
工作目录：/mnt/c/cante-sweep/wsl-work
守护进程：/root/cante-bin/ante serve
==> files.rename
Traceback (most recent call last):
  File "/mnt/c/cante/gui/scripts/sweep/sweep.py", line 2173, in main
    result = runner.run_card(prep, prompts)
  File "/mnt/c/cante/gui/scripts/sweep/sweep.py", line 945, in run_card
    record = self._drive(prompts[prep["prompts_key"]]["prompt"], run_dir, prep["home"], prep["inputs"])
  File "/mnt/c/cante/gui/scripts/sweep/sweep.py", line 1045, in _drive
    process = subprocess.Popen(
        command,
    ...<10 lines>...
        **TEXT_KWARGS,
    )
  File "/usr/lib/python3.14/subprocess.py", line 1039, in __init__
    self._execute_child(args, executable, preexec_fn, close_fds,
    ~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        pass_fds, cwd, env,
                        ^^^^^^^^^^^^^^^^^^^
    ...<5 lines>...
                        gid, gids, uid, umask,
                        ^^^^^^^^^^^^^^^^^^^^^^
                        start_new_session, process_group)
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/usr/lib/python3.14/subprocess.py", line 1990, in _execute_child
    raise child_exception_type(errno_num, err_msg, err_filename)
FileNotFoundError: [Errno 2] No such file or directory: '/root/cante-bin/ante'
    失败：普查脚本自己出错：[Errno 2] No such file or directory: '/root/cante-bin/ante'
有 1 张卡失败：files.rename

报告写到：/mnt/c/cante-sweep/report-20260921.md
```
````

### 5.3 失败三：task-sweep 自己退非 0（没写出报告）

`[r20-4-NEW-nonzero] exit=2 report=1157 bytes`，报告全文：

````
# 每周普查没跑成：task-sweep 自己退了非 0（退出码 2），而且没写出报告

生成时间：2026-09-21 08:24

## 发生了什么

WSL、bun、$HOME/cante-bin/ante 都在，但 task-sweep 这次退出码是 2，而且报告本体是空的。
日志（含原始输出）在：C:\cante-sweep\logs\sweep-20260921.log

**这一份不是产品的结论，也不是某张卡跑输了的证据** —— 普查根本没跑起来（或在第一步就停了）。

## 你能怎么做

1. 打开日志 `C:\cante-sweep\logs\sweep-20260921.log` 看最后几行（原始输出也已经贴在下面）；
2. 常见原因：模型端点连不上（网关或密钥）、参数里的卡名认不出、夹具生成缺依赖（pypdf / Pillow）；
3. 修好上面那条，再跑一次 `gui\scripts\windows\weekly-sweep.ps1`。

## 复制这段给技术同事（这次真正发出去的输出，原样）

```
bun 探针（退出码 0）：
CANTE_BUN_OK
1.4.2

ante 探针（退出码 0）：
CANTE_ANTE_OK

--- task-sweep 这次的输出 ---
认不出这些卡：does.not.exist.card（用 --list 看有哪些卡，或给整类前缀如 pdf / excel）
```
````

### 5.4 失败四：WSL 起不来（用不存在的发行版模拟）

`[r20-6-NEW-baddistro] exit=3 report=1393 bytes`，报告全文：

````
# 每周普查没跑成：这台机器上的 WSL 现在用不了

生成时间：2026-09-21 08:24

## 发生了什么

普查要驱动真守护进程，而守护进程只有 Linux/macOS 构建，所以它只能跑在 WSL 里。
这一次连 WSL 都没起来 —— 是环境缺了东西，不是某张卡的结果。
（本次明确指定了发行版 "Ubuntu-24.04-DoesNotExist"；名字拼错也会走到这里，wsl -l -v 的输出见下。）

**这一份不是产品的结论，也不是某张卡跑输了的证据** —— 普查根本没跑起来（或在第一步就停了）。

## 你能怎么做

1. 以管理员身份开一个 PowerShell，跑 `wsl --install`（或先 `wsl --list --verbose` 看现状）；
2. 装完**重启**这台机器；
3. 按 `gui/scripts/windows/wsl-ante-setup.ps1` 把守护进程装回 WSL 里；
4. 再手动跑一次 `gui\scripts\windows\weekly-sweep.ps1` 确认能出报告。
5. 如果这一步是因为 -Distro 写了不存在的名字：用 `wsl -l -v` 里真正的名字重跑，或者干脆去掉 -Distro 用默认发行版。

## 复制这段给技术同事（这次真正发出去的输出，原样）

```
WSL 探针（退出码 -1）：
不存在具有所提供名称的分发。
错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND

wsl -l -v（退出码 0）：
NAME            STATE           VERSION
* Ubuntu-24.04    Running         2
```
````

> 注意这一段是 `wsl.exe` 自己的报错：原字节是 **UTF-16LE**。修前按 GBK 解就是乱码（#300 的现场），
> 现在走 `Read-WslBytes` 按字节认编码，是可读中文。

### 5.5 成功回归：报告正常、退出码 0

干净工作目录 + `-Cards files.rename`，`[r20-5-NEW-success] exit=0 report=9264 bytes`。
这份报告是 `sweep.py` 自己写的（**没有**被失败节覆盖，BOM 是它自己的无 BOM UTF-8），
开头与卡片表逐字：

```
# 真机任务普查报告

生成时间：2026-09-21 00:24 UTC
...
一共跑了 1 张卡：通过 1，超时但有产出 0，停下问问题 0，失败 0。
| files.rename | 通过 | 1（通过） | 单次样本 | 0 秒 | 1 | 结果_上个月开销汇总.csv |
```

### 5.6 前后状态（逐字）

同一次会话里，动之前 / 动之后：

```
BEFORE bun : -rwxr-xr-x 1 root root 79500640 Sep 21 08:08 /root/.bun/bin/bun
             lrwxrwxrwx 1 root root       18 Sep 21 08:24 /usr/local/bin/bun -> /root/.bun/bin/bun
BEFORE ante: -rwxr-xr-x 1 root root      345 Sep 21 08:12 /root/cante-bin/ante

HIDDEN bun : BUN-BROKEN
RESTORED bun: lrwxrwxrwx 1 root root 18 Sep 21 08:24 /usr/local/bin/bun -> /root/.bun/bin/bun
             1.4.2

HIDDEN ante: total 4
             -rwxr-xr-x 1 root root 345 Sep 21 08:12 ante.r20hidden
RESTORED ante: -rwxr-xr-x 1 root root 345 Sep 21 08:12 /root/cante-bin/ante

FINAL STATE:
-rwxr-xr-x 1 root root 79500640 Sep 21 08:08 /root/.bun/bin/bun
-rwxr-xr-x 1 root root      345 Sep 21 08:12 /root/cante-bin/ante
lrwxrwxrwx 1 root root       18 Sep 21 08:24 /usr/local/bin/bun -> /root/.bun/bin/bun
1.4.2
```

（`ante` 那一行是 §4 里那个**临时替身**。全部跑完后替身已删，见 §6；`bun` 是我为跑通而装的，
留着——它是真的工具，不是替身。）

### 5.7 超时与「确认没有」分开

抽 `Invoke-WslCapture` 单独验，喂一条 `sleep 30` 的命令、上限 4 秒：

```
timeout-test: TimedOut=[True] ExitCode=[-1] Text=[started]
```

即：**到点就杀、标 TimedOut**，报告里会写「超时：120 秒没跑完（这是『没等到结果』，不等于 WSL 里没有 bun）」，
而不是写成「没有 bun」。（上面 §3 的 B/ante 探针分支都有这条超时文案。）

### 5.8 `ExitCode` 那个 PS 5.1 坑（改法的根据）

真机实测（同一台机器、同一个 `wsl.exe -s` 脚本 `exit 7`）：

```
A: Start-Process -PassThru + WaitForExit(ms) → waited=True HasExited=True ExitCode=[]   （空！）
B: [int]$p.ExitCode                          → 0                                        （也不对）
D: Start-Process -Wait                        → ExitCode=[7]                            （对，但没法设超时）
F: .NET System.Diagnostics.Process            → exited=True ExitCode=[7] out=[hi]        （对，且有超时）
```

所以第 5 条改动用 F 那条路——既能设超时、退出码可靠，又能从 `BaseStream` 拿原始字节。

### 5.9 原始输出上限

抽 `Write-FailureReport` 喂 200 行原始输出，产物共 83 行且含「中间省略」标记：

```
total-lines=83
has-marker=True
```

## 6. 还原 / 现在机器上是什么

- 跑完后删掉了临时替身 `~/cante-bin/ante`（**不能留**：留着的话，以后每次周报都会拿
  `fake-cante` 的结果冒充真机结果，比空报告更坏）：

  ```
  BEFORE cleanup: -rwxr-xr-x 1 root root 345 ... /root/cante-bin/ante
  AFTER cleanup : total 8   （~/cante-bin 空了）
  ```

- 没有 `.r20hidden` 之类的残留（`ls` 已确认 `No such file or directory`）。
- **留下的（都是我装上去的、诚实的工具，不是替身）**：WSL 里的原生 `bun 1.4.2`（`~/.bun/bin/bun`
  与 `/usr/local/bin/bun` 软链）、`pypdf 6.19.0`、`Pillow 12.3.0`（夹具生成要）。
- 机器现在的真实状态：**缺真守护进程**。所以我又手跑了一次（`-Cards files.rename`）让盘上的报告
  反映现实：`[r20-7-FINAL] exit=2 report=2474 bytes` —— 即下次谁点开都会看到
  「WSL 里没有守护进程（ante）」这篇，而不是空白。

## 7. 没验的（跟上面分开写）

1. **「WSL 真的整个不在」那条路**：没验（这台机器 WSL 是活的，我不能为了验它把它拆了）。
   §5.4 验的是「指定了一个不存在的发行版」——`wsl.exe` 真报错、报告真分类，但**不等于**「WSL 组件被禁用」
   那个 9/20 的现场。#300 当时验过那一屏（UTF-16LE 的安装提示）；本单没有重复验。
2. **真 `ante` 跑真模型**：没验。这台机器现在**下不到** Linux 版 `ante` ——
   `cante.run` 与 `download.cante.run` 都是 `NXDOMAIN`（本机与 WSL 里都试过）。§5.5 的成功回归
   用的是仓库自带的协议替身 `gui/fixtures/fake-cante.ts`（`sweep.py` 明确支持它当 `CANTE_BIN`）+
   `FAKE_CANTE_MAKE_FILE=1`，卡 `files.rename` 真通过、报告真由 `sweep.py` 写出、退出码 0。
   **它证明的是「改完之后正常那条路没被弄坏」，不是「真模型/真守护进程能跑」**。
3. **网关真的连不上**（网络层）：没验。§5.3 的「task-sweep 自己退非 0」是用一张认不出的卡触发的
   （同样是「退出码非 0 且没写报告」这个形状），不是真拔网/真坏网关。真坏网关的现场见
   `run-offline.ps1`（另一套），不在这条路上。
4. **计划任务 `CanteWeeklySweep` 本身没触发**：跑的是等价的手工调用（照 #300 的写法）。
5. **`-Distro` 指向一个存在但不健康的发行版**：未单独造。
6. **退出码 `3` 沿用旧行为**（WSL 起不来 → 3）。按仓库 Windows 验收脚本的
   `0/2/3`（通过/环境/产品）约定，环境问题本该是 2；这里没改，免得动到计划任务已有的预期。
   如果要统一，请单开一单。

## 8. 原始输出在哪

- 变更文件：`gui/scripts/windows/weekly-sweep.ps1`
- 真机产物：`C:\r20-sweepfix\` 下的 `r20-1-OLD-nobun.md`（5 字节）、`r20-2-NEW-nobun.md`、
  `r20-3-NEW-noante.md`、`r20-4-NEW-nonzero.md`、`r20-5-NEW-success.md`、`r20-6-NEW-baddistro.md`，
  以及每次的 `*.stdout.txt`；`C:\cante-sweep\report-20260921.md` 是最后一次跑的实时报告。
- 报告里**没有**真实家目录、内网 IP、密钥：正文里出现的路径只有 `C:\cante-sweep`、`C:\cante`、
  `/root`、`/mnt/c/...` 这类固定位置（已逐份 grep 过 `C:\Users` / `192.168` / `sk-` / `apiKey` 值）。
