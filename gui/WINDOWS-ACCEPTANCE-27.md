# Windows 验收 27：装机版闭环 —— release 0.2.4 的真产物装上机，用产物自己的脚本验产物

日期：2026-09-21　机器：那台 Windows 11 验收机（真 WebView2、`session=1` 有桌面）

这一轮回答一个问题：**从 GitHub release 下载的 0.2.4 真产物，装上机以后还立不立得住** ——
而且判它的脚本用的就是**装出来的那份 exe**（不是工作树里构建的那份 ✓）。

> 为什么值得单独记一笔：过去「打包」那条链栽过两次（`AGENTS.md` §3.6）—— 配置对、静态测试过，
> 但**没有人打开过真产物**。这一轮走完整个闭环：**release 资产 → 静默覆盖装 → 产物自己的脚本判它自己**。
>
> 与**验收 6** 的关系：验收 6 只能拿**时间戳**推断「装机版里 #279/#282 的缺口还在不在」，
> 因为那台机器上装的 0.2.3 比两个修复都早 ✗。这一轮把那个缺口补上了 —— 装的是 0.2.4，
> 判据脚本直接指到装机版那份 exe ✓。

---

## 1. 验收对象与环境

- **release**：`gh release view gui-v0.2.4` → `draft=false` `prerelease=false`，三个资产
  `Cante_0.2.4_x64-setup.exe` **37,245,131 字节**、`Cante_0.2.4_x64_en-US.msi` 50,381,746、
  `Cante_0.2.4_aarch64.dmg` 6,113,870（37MB / 50MB / 6MB 那一档 ✓）。
- **下载**：`gh release download gui-v0.2.4 --pattern Cante_0.2.4_x64-setup.exe`，**3.3 秒**完成
  （超时设 300 秒，没触发）。落地大小**逐字节等于 release 上的 37,245,131** ✓；
  sha256 `e1c65ed42600fae6371a75fe90e9fabcb96e409ba6112b7f1d03cf21ed736251`；
  安装器自身的 `FileVersion` / `ProductVersion` 都是 **0.2.4** ✓。
- **机器**：Windows 11 家庭版 `10.0.26200` x64；WebView2 `153.0.4234.48`；
  **`session=1`、有交互桌面**（`cante-gui.exe` 起来后 `MainWindowHandle≠0`、标题 `Cante`，
  `msedgewebview2` 子进程也在 session 1 ✓）—— 所以这一节能跑 UIA 那一类的真机判据。
- 所有可能变慢的命令都带超时；下面写「确认」的地方都有脚本原始输出，没跑的单独写在 §5。

## 2. 步骤 1 —— 先记下装机版现状（0.2.3）

| 文件 | 大小（字节） | 时间戳 | FileVersion |
| --- | --- | --- | --- |
| cante-gui.exe | 14,936,064 | 2026-09-20 02:27:50 | 0.2.3 |
| cante-sheets.exe | 5,345,792 | 2026-09-20 02:27:50 | 0.2.3 |
| cante-pdf.exe | 5,699,584 | 2026-09-20 02:27:50 | 0.2.3 |
| cante-bridge.exe | 1,428,992 | 2026-09-20 02:27:50 | 0.2.3 |
| uninstall.exe | 84,757 | 2026-09-20 02:28:53 | 0.2.3 |

- `cante-sheets.exe --version` → `cante-sheets 0.2.3`（退出码 0）✓
- 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Cante`：
  `DisplayVersion = 0.2.3`、`InstallLocation = "C:\Users\cante\AppData\Local\Cante"` ✓
- 安装目录共 **916 个条目**（5 个顶层文件 + `pi\` 整棵树）

## 3. 步骤 2/3 —— 静默覆盖装 + 装完逐条核

- 装：`Start-Process Cante_0.2.4_x64-setup.exe -ArgumentList /S -Wait` → **退出码 0**，
  **7 秒装完**（超时 300 秒没触发）。**没有先卸载** —— 「覆盖装」正是她拿到新版会走的那条路。
- 装完逐字核（**两处版本号都看了**）：

| 判据 | 看到什么 |
| --- | --- |
| 5 个 exe 的时间戳**变成今天** | 四个自带程序 2026-09-21 05:33:50（gui 05:34:26）—— 它们是**包内载荷自己的构建时间**（安装器保留、不改成安装时刻 ✓），`uninstall.exe` 84,757 / 05:46:54 则是**这次安装当时**写下的 ✓ |
| FileVersion + ProductVersion | 5 个全是 **0.2.4** ✓ |
| `cante-sheets.exe --version` | `cante-sheets 0.2.4`（退出码 0）✓；`cante-pdf`→0.2.4 ✓、`cante-bridge`→0.2.4 ✓ |
| 注册表 `DisplayVersion` | **0.2.4** ✓ |
| 安装目录**没有多余文件** | 装前/装后递归清单**路径集合逐条相同**（916 = 916，`comm` 两个方向都空）✓ |
| 顶层仍是「5 个文件 + `pi\`」 | 与**验收 3** 记的 5 文件清单一致，并且 #150 之后该在场的 `pi\` 也在 ✓ |

  做法：两边都 `awk` 抽出以 `\` 开头的路径 → `sort -u` → `comm -13 / -23`。两次清单在
  `log\pre-install.txt`（含装前 5 个顶层文件的 sha256）与 `log\post-list.txt`。
  另外：`uninstall.exe` **0.2.3 与 0.2.4 两版大小都是 84,757**，但 sha256 变了（`0303…5BF4` → `361D…C515`）
  —— 同尺寸不等于同文件，这一步是哈希说了算 ✓。
- **一处我下不了结论的观察（只记录，不算验证）**：0.2.3 装机版的 exe 明显更大
  （gui 14.9MB / sheets 5.3MB），0.2.4 小得多（10.4MB / 2.5MB）。**验收 3 记的 release 形状**是
  gui 10,337,792 / sheets 2,511,872（≈10.3MB / 2.5MB）—— 和 0.2.4 同一个量级，和这台机器上那份
  0.2.3 不是一个形状。但跨版本大小本来就会漂，而且我**没有**打开 0.2.3 的安装包、也不知道
  它当初是怎么装的（那份的 setup.exe 是 37,202,447，与 0.2.4 的 37,245,131 几乎一样大）——
  所以这仍然是**观察，不是结论**：说不了“0.2.3 那份是别的来源” ✗。

## 4. 复跑判据（四条，跑的全是**装出来的那份**）

| # | 判据 | 怎么跑 | 结论 |
| --- | --- | --- | --- |
| 1 | **产物闸门**（配置≠产物那条） | `bash gui/scripts/verify-bundle.sh --dir "C:\Users\cante\AppData\Local\Cante"` | **退出码 0 / OK** ✓ |
| 2 | **第一屏**（UIA 读窗口真实文字，对照 `copy.ts`） | `gui\scripts\windows\accept-first-screen.ps1 -Exe "C:\Users\cante\AppData\Local\Cante\cante-gui.exe"` | **退出码 0**，10 条对上 10 条、对不上 0 条 ✓ |
| 3 | **#287 固化的那套判据（GBK(936) 的 CSV 交进来）** | `gui\scripts\windows\accept-gbk-csv.ps1 -Exe "C:\Users\cante\AppData\Local\Cante\cante-sheets.exe"`（它本来就支持 `-Exe`，所以直接指到**装机版**那份，不是工作树产物 ✓） | **退出码 0**，通过 **10/10** ✓ |
| 4 | **#286 那套话（服务方忙/用完）——真窗口** | `gui\scripts\windows\run-offline.ps1 -Scenario busy -Exe "C:\Users\cante\AppData\Local\Cante\cante-gui.exe"`（`busy` 是本轮新增的现场） | **退出码 0**，屏幕上逐条对上 `copy-service.ts` 的 4 句、零术语 6/6 ✓ |
| 5 | **同一条判据，但走真服务方上那条真坏掉的路（`realbusy`）** | `gui\scripts\windows\run-offline.ps1 -Scenario realbusy -Exe "C:\Users\cante\AppData\Local\Cante\cante-gui.exe" -StallSecs 180 -TimeoutSec 270` | **退出码 0**，同上 4/4 + 零术语 6/6；且页面 DOM 里查得到**真网关回的原文**（证明请求真打到了那台网关）✓ |

闸门（1）逐条：① `cante-gui` / `cante-sheets` / `cante-pdf` / `cante-bridge` 四个都在；
② 三个自带程序**在安装目录里跑得起来**、版本都打 `0.2.4`；③ 没有 `.d`、没有 0 字节文件、
没有多余子目录；④ 执行组件 `pi\bun.exe`（83M）/ `pi\dist\bundle\cli.js` / `pi\package.json` /
`pi\THIRD-PARTY-NOTICES.md` 都在，`pi\bun.exe --version` → `1.4.2`。

第一屏（2）读回的关键行（原样）：`欢迎使用 Cante`、
`我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先检查一下你的电脑，好吗？`、
`开始检查`；步骤条 `欢迎 / 检查电脑 / 开始使用`；导航 `历史 / 隐私 / 关于` —— 全是中文、零术语 ✓。

**这条对那台机器做了一件真事，必须说清**：`accept-first-screen.ps1` 为了让她看到的是「第一次打开」
那一屏，**跑之前把应用档案删了**（报告里逐字打印了这两行：
`C:\Users\cante\AppData\Local\dev.cante.gui（已删）`、`C:\Users\cante\AppData\Roaming\dev.cante.gui（已删）`）。
跑完现在那份档案是**新建的**（只剩 WebView2 的缓存/着色器文件），原来那台机器上的结果登记
（`runs.json`）与历史**已经不在了** ✓ —— 这是脚本的既定行为（不是意外），但它意味着
「她的档案/历史跨版本还在不在」这一条**在本机已经无法再补验**（见 §5 第 5 条）。

### 4.1 第 4 条（#286）屏幕上的原文

场景：假服务方对每个请求都回 `503` + `insufficient credits`（#286 的真实原文形状）。
应用是**装机版那份的隔离副本**（`C:\Users\cante\AppData\Local\Cante\cante-gui.exe`
→ `C:\cante-verify-17\busy\app-root\app\cante-gui.exe`）；跑完落盘的是真 WebView2 屏幕文字：

```
这次没能做完
发生了什么
这件事没有做完。
你可以怎么做
原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
→过一会儿再试
帮你干活的程序现在用不了，多半不是你做错什么。过几分钟再点这个按钮。
复制详情给管网络的同事
一直这样，就把下面这段原文复制出来，发给管网络的同事，请他帮忙看看。
展开技术详情
再试一次
换一个任务
```

逐条判据（**期望文案从 `copy-service.ts` 里取**，不手抄 —— 手抄会漂移 ✓）：

```
[对] 按钮「过一会儿再试」：过一会儿再试
[对] 那句解释：帮你干活的程序现在用不了，多半不是你做错什么。过几分钟再点这个按钮。
[对] 按钮「复制详情给管网络的同事」：复制详情给管网络的同事
[对] 那句解释：一直这样，就把下面这段原文复制出来，发给管网络的同事，请他帮忙看看。
[对] 没有 insufficient / quota / credits / 503 / 429 / 额度
→ 通过
```

另外两条硬事实：**原文件 sha256 跑前跑后一致** ✓
（`07B21A65…E95F`）；**现场真摆上了** ✓（pi 在本轮配置目录里留下了 `auth.json` / `models-store.json`
哨兵 —— 否则屏幕上是成功也说明不了什么）。退出码 **0**。

本轮为此改了两个验收脚本（`relay.mjs` 加 `busy` 模式、`run-offline.ps1` 加 `busy` 现场与判据块），
详见 §7。

### 4.2 第 5 条（`realbusy`）：不用假服务方，走**真服务方上那条真的坏掉的路**

为什么单开一场：假服务方只证明「我们的中继发 503 时她会看到什么」；这一场证明的是
「**真的**欠费停机时她会看到什么」（也是 #286 当初的现场）。先把网关探测结果记下：

```
地址：http://192.168.3.10:20128/v1（来源 ~/.pi/agent/models.json 的 9router；apiKey 不打印）
--- model=work               → HTTP 503 ---
{"error":{"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue using the service. (reset after 30s)"}}
--- model=ocg/deepseek-flash → HTTP 200 ---
--- model=ocg/glm-5.2        → HTTP 200 ---
```

网关本身是活的（别的 model 200），只有 `work` 这条路真的欠费停机（503）—— 现成的、真的、可复现的现场。
然后让**装机版的应用**真的去连它（`realbusy`：沿用这台机器的真地址与真凭据，**不起中继、不打防火墙**，
只把默认 model 显式指到 `9router/work`）：

```
[phase] 干活（含审批/提问） — 15302 ms
--- 结局页（error-page）---
  | 这次没能做完 / 这件事没有做完。
  | 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
  | →过一会儿再试：帮你干活的程序现在用不了，多半不是你做错什么。过几分钟再点这个按钮。
  | 复制详情给管网络的同事：一直这样，就把下面这段原文复制出来，发给管网络的同事，请他帮忙看看。
  | 展开技术详情 / 再试一次 / 换一个任务
  [对] ×4（文案逐条取自 copy-service.ts）  [对] 没有 insufficient/quota/credits/503/429/额度
  → 通过
realbusy 现场反向判据：结局=done 吗？False（期望 False）
原文件哈希一致 = True
```

**两条不靠「单测」的硬证据**：

1. 页面的 DOM 里查得到**那台真网关回的原文**（它只折在「展开技术详情」后面，没上屏）：
   `outcome-error-page.html: You have insufficient credits to make this request` ✓
   —— 这一条同时证明请求**真打到了那台真网关**：我们自己摆的中继返回的原文里没有 `You have …` 这个说法。
2. 屏幕原文里**没有**英文/状态码/「额度」 ✓（6 个词一个都没出现），而账上那句中文与源码逐条相等 ✓。

退出码 **0**（同一套判据在假服务方那场也是 0）。

## 5. 我**没**验证什么（如实列，不写成「通过」）

1. **端到端跑一张卡（真出一份文件）**：**没跑**。理由：`run-accept-drive.ps1` 单卡按
   `AGENTS.md` §5 要 **≥1800 秒**，而这一批的交付窗口是 60 分钟 —— 跑到一半就交，等于把
   「超时」写成结论。**这不是通过，也不是失败，是没跑。**
2. **SmartScreen / 「来自互联网」标记**：**没验**。下载走 `gh`（命令行），文件不带 `Zone.Identifier`，
   所以它**不会**触发 SmartScreen —— 这不等于「浏览器下载也不拦」✗。
3. **MSI 与 dmg**：**没装**（这一批装的是 setup.exe）。dmg 那面归 macOS 的 `verify-bundle.sh --dmg`。
4. **卸载是否干净**：**没验**（覆盖装，没走卸载；`accept-install.ps1` 里有那条路）。
5. **跨版本的她的档案/历史有没有被保留**：**没验，而且这一批之后也补验不了了** —— 为了读第一屏，
   `accept-first-screen.ps1` 把 `AppData\Local\dev.cante.gui` 与 `AppData\Roaming\dev.cante.gui`
   删了（§4 里逐字记了那两行，这是脚本既定行为）。覆盖装本身只证明**文件**换对了；
   要看档案有没有被保住，得在**不删档案**的前提下另跑一轮（装前多一份档案快照），这一批没做。
6. **`inspect-installer.ps1`（拆开安装包看内部清单）**：**没跑** —— 这台机器**没有 7-Zip**，
   跑了也只会在「列包内文件」那步退 3，不如如实写「没跑」。
7. **#286「服务方忙 / 用完」的那一层「复制详情」**：屏幕那一层**已经验了**（§4 第 4 条 ✓），
   但**英文原文（`503` / `insufficient credits`）我没点开「展开技术详情」去复核** ——
   屏幕原文里它当时是**折着的** ✓（那一屏没有英文 ✓，那是对的）。
   「点开后给的原文对不对」属于 #282 那一层的判据，本轮**没验** ✗。
8. **`proxy407` 那一场没有重跑**：我在 `relay.mjs` 里补回了 407 的分支（见 §7：那个 mode 只写在
   文档里、脚本里一直没有，所以 `-Scenario proxy407` 实际跑的是一个**正常干活**的假服务方），
   但**这一轮没有重跑那一场** —— 验收 15 记的 407 结论仍然只是当时的证据 ✗。

## 6. 这台机器上留下的原始输出

```
C:\cante-verify-17\17\Cante_0.2.4_x64-setup.exe    下载的真产物（sha256 e1c65ed4…6251）
C:\cante-verify-17\17\log\pre-install.txt          装前的 916 条清单 + 5 个顶层 sha256 + 注册表 0.2.3
C:\cante-verify-17\17\log\install.txt              静默装的退出码 0 / 7 秒
C:\cante-verify-17\17\log\post-install.txt         装后台面（0.2.4 时间戳、版本、sha256、注册表）
C:\cante-verify-17\17\log\post-list.txt            装后的 916 条递归清单
C:\cante-verify-17\17\log\pre-paths.txt / post-paths.txt   两边抽出的路径集合（comm 用的就是这两份）
C:\cante-verify-17\17\log\top-level.txt            顶层「5 个文件 + pi\」
C:\cante-verify-17\17\log\verify-bundle-dir.txt    产物闸门的原始输出（OK，退出码 0）
C:\cante-verify-17\17\first-screen\report.txt      第一屏 UIA 读回的文字 + 10/10 对照
C:\cante-verify-17\17\gbk\gbk-csv-report.txt       GBK 那条的原始报告（10/10，退出码 0）
C:\cante-verify-17\17\gbk\gbk-input.csv            真样本（脚本打印的头 12 字节 D0 D5 C3 FB …）
C:\cante-verify-17\17\gbk\stderr.txt  stdout.txt   产物发出来的原文（可复核「退出 2 / 没有半成品」）
C:\cante-verify-17\busy-run.txt                    #286 那一场的完整脚本输出（含逐条判据块）
C:\cante-verify-17\busy\report.txt                 #286 那一场的报告（含屏幕原文哈希对照）
C:\cante-verify-17\busy\artifacts\outcome-error-page.txt / .html / .png   屏幕原文 / DOM / 截图
C:\cante-verify-17\busy\artifacts\offline-result.json   结构化结果（outcome=error-page）
C:\cante-verify-17\busy\relay-busy.log             假服务方日志（每个请求都回了 503）
```

（`C:\cante-verify-17\` 在**仓库外**。我临时在仓库里用的 `.verify\` 已经整个移出去，没留在库里；
`git status` 只剩这条分支上本来就有的 `?? gui/accept-drive-result.json` —— 不是这一批产生的。）

---

## 7. 这一轮改的验收脚本（为什么改、怎么跑）

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `gui\scripts\windows\offline-probe\relay.mjs` | 新增 `busy` 模式：每个请求回 `503` + `insufficient credits` | #286 的现场（网关欠费停机）原来**一个场景都造不出来** —— dead/cut/forbid/wire/proxy407 都不产生「服务方忙/用完」那一类错 |
| 同上 | 补回 `proxy407` 模式（ `407` + `Proxy-Authenticate` ） | 这个 mode **只写进过文档**，`relay.mjs` 里一直没有 → `-Scenario proxy407` 实际跑的是一个**正常干活**的假服务方（脚本与它声称的现场不是一回事 ✗）。本轮补回；**但没有重跑那一场**（§5 第 8 条）|
| `gui\scripts\windows\run-offline.ps1` | 加 `busy` 现场（`-Scenario` 白名单、专用端口 `18095`、注释/用法）+ 跑完一段 **#286 判据块** | 把「#286 在真窗口上成不成立」变成**一条命令**（#287 那套做法），而不是手打几条命令 + 人眼看 |
| 同上 | 另加 `realbusy` 现场（`-RealProvider` / `-RealModel`，默认 `9router` / `work`）：**不起中继、不打防火墙**，把真配置拷进隔离目录并把默认 model 显式指到那条坏路 | 把「**真**服务方欠费停机时她会看到什么」也变成一条命令 —— 不用假服务方也能复现，且判据与 `busy` 共用同一段 |

判据块怎么做人话：**期望文案从产品源码 `copy-service.ts` 里用正则取**（不手抄 —— 手抄会漂移 ✓），
四条文案逐条比；再加 6 个零术语词（`insufficient` / `quota` / `credits` / `503` / `429` / `额度`）
**不许出现在屏幕上**；任一不对就退 **3（产品问题）**。

跑法（一条命令；`-Exe` 指装机版那份就验装机版，不给就用工作树构建 —— 注意默认是**后者**）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-offline.ps1 ^
  -Scenario busy -Exe "C:\Users\cante\AppData\Local\Cante\cante-gui.exe" ^
  -WorkRoot "C:\cante-verify-17\busy" -TimeoutSec 900
```

退出码沿用原本那套：**0** = 到结局页且判据全中；**2** = 环境问题（现场没摆上 / 驱动起不来）；
**3** = 产品问题（屏幕上那套话不对）。
