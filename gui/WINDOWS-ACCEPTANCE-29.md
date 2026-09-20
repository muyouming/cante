# r19 —— 装机版闭环：下载 release 真产物 → 装上机 → 复跑判据（含「真坏网关」）

- **机器**：Windows 11 家庭版 `10.0.26200` x64，真 WebView2 `153.0.4234.48`，`session=1`（有交互桌面）
- **产物**：GitHub release `gui-v0.2.4` 的 `Cante_0.2.4_x64-setup.exe`
  **37,245,131 字节**（与 release 上的资产逐字节相同 ✓）
  sha256 `e1c65ed42600fae6371a75fe90e9fabcb96e409ba6112b7f1d03cf21ed736251`
- **逐字输出**：`C:\Users\<用户名>\r19-install.txt`（142,894 字节，13 段，原样拼接，没有改写）
- 每条命令都带超时（单条上限 5 分钟）；**没有任何一条触发超时**。

---

## 0. 结论先行

| # | 事项 | 结论 |
| --- | --- | --- |
| 1 | 静默**覆盖装**（不先卸载） | **成功**：退出码 **0**，**7 秒** ✓ |
| 2 | 装完版本 `0.2.4`（两处都看） | **0.2.4** ✓（FileVersion/ProductVersion ×5 + `--version` ×3 + 注册表 `DisplayVersion`）|
| 3 | 装完文件清单 | 顶层 **5 个文件 + `pi\`**，与验收 3 的 5 文件清单一致；装前/装后递归**路径集合逐条相同**（916 = 916）✓ |
| 4 | 判据一：产物闸门 | **OK / 退出码 0** ✓ |
| 5 | 判据二：第一屏（真窗口 UIA） | **10/10** ✓ |
| 6 | 判据三：GBK(936) CSV（#287 固化的脚本） | **10/10，退出码 0** ✓ |
| 7 | 判据四 a：`busy`（我们摆的假服务方 503） | **通过**，退出码 0 ✓ |
| 8 | 判据四 b：`realbusy`（**真服务方上那条真的坏掉的路**） | **通过**，退出码 0 ✓ —— 屏幕原文里是真网关回的 `You have insufficient credits…` 触发的那套中文话 |
| 9 | 没验的 | 见 §4（**与上面分开写** ✗）|

**一句话**：0.2.4 的 release 产物**装得上、装得干净、版本对得上**，而且四条判据（闸门 / 首屏 / GBK /
服务方欠费）在**装出来的那份 exe** 上全部成立；**「真坏网关」不是拿单测冒充的** —— 见 §3.4。

---

## 1. 装机前后时间戳对照

覆盖装：直接跑 `Cante_0.2.4_x64-setup.exe /S`（**没有**先卸载 —— 这正是她拿到新版会走的那条路）。

| 文件 | 装之前（0.2.3） | 大小（装前） | 装之后（0.2.4） | 大小（装后） | 装前 sha256（前 8 位） | 装后 sha256（前 8 位） |
| --- | --- | --- | --- | --- | --- | --- |
| cante-gui.exe | 2026-09-20 02:27:50 | 14,936,064 | **2026-09-21 05:34:26** | 10,440,704 | F6EA4E3A | 352854F5 |
| cante-sheets.exe | 2026-09-20 02:27:50 | 5,345,792 | **2026-09-21 05:33:50** | 2,502,144 | 00A914E8 | 6F129606 |
| cante-pdf.exe | 2026-09-20 02:27:50 | 5,699,584 | **2026-09-21 05:33:50** | 2,173,440 | 7DE10B4C | 42B50455 |
| cante-bridge.exe | 2026-09-20 02:27:50 | 1,428,992 | **2026-09-21 05:33:50** | 735,744 | 31B08C6F | 19A8BB58 |
| uninstall.exe | 2026-09-20 02:28:53 | 84,757 | **2026-09-21 05:46:54** | 84,757 | 03038068 | 361DB5CF |

读法（这几点都要说清，不然时间戳能骗人）：

- 四个自带程序的时间戳是**包内载荷自己的构建时间**（安装器保留它，不改写成安装时刻）；
  `uninstall.exe` 的 **05:46:54** 才是**这次安装当时**写下的（安装器自己生成的那个）。
- 所以「时间戳变成今天」这条成立 ✓；而**真正证明它们被换掉了的是 sha256 与版本号**（两者都变了 ✓）。
- `uninstall.exe` **0.2.3 与 0.2.4 两版同样大（84,757）**，sha256 不同 —— 同尺寸不等于同文件。

版本（两处都核过）：

```
FileVersion / ProductVersion（5 个文件，全部）= 0.2.4
cante-sheets.exe --version → cante-sheets 0.2.4   （退出码 0）
cante-pdf.exe    --version → cante-pdf 0.2.4      （退出码 0）
cante-bridge.exe --version → cante-bridge 0.2.4   （退出码 0）
注册表 HKCU\...\Uninstall\Cante: DisplayVersion 0.2.3 → 0.2.4
```

---

## 2. 装完文件清单

顶层（`Get-ChildItem C:\Users\<用户名>\AppData\Local\Cante`）：

```
735744   0.2.4   2026-09-21 05:33   cante-bridge.exe
10440704 0.2.4   2026-09-21 05:34   cante-gui.exe
2173440  0.2.4   2026-09-21 05:33   cante-pdf.exe
2502144  0.2.4   2026-09-21 05:33   cante-sheets.exe
DIR              2026-09-18 23:14   pi\
84757    0.2.4   2026-09-21 05:46   uninstall.exe
```

- **只有 5 个文件 + `pi\`** ✓（与**验收 3** 记的 5 文件清单一致；`pi\` 是 #150 之后该在的那个执行组件目录）
- **没有 `.d`**、**没有 0 字节文件**、**没有多出来的子目录** ✓（产物闸门逐条打印，见 §3.1）
- `pi\` 里该在的四样都在 ✓：`bun.exe`(83M) / `dist\bundle\cli.js` / `package.json` /
  `THIRD-PARTY-NOTICES.md`，`bun.exe --version` → `1.4.2`
- **装前/装后递归清单路径集合逐条相同**：两边都是 **916 条**，`comm` **两个方向都空**
  → 没有 0.2.3 的残留文件，也没有被新版删掉的东西 ✓
- 一处**只记录、不下结论**的观察：0.2.3 装机版的 exe 明显更大（gui 14.9MB / sheets 5.3MB），
  0.2.4 是 10.4MB / 2.5MB；验收 3 记的 release 形状是 10.3MB / 2.5MB（同一个量级）。
  跨版本大小本来会漂，我**没有**打开 0.2.3 的安装包，所以**不说**「0.2.3 那份是别的来源」✗。

---

## 3. 判据逐字输出 + 结论

### 3.1 判据一：产物闸门（**用产物自己的脚本判产物**）

```
cd /c/cante && bash gui/scripts/verify-bundle.sh --dir "C:/Users/<用户名>/AppData/Local/Cante"

① 四个可执行文件
  ✓ cante-gui（10M）  ✓ cante-sheets（2.4M）  ✓ cante-pdf（2.1M）  ✓ cante-bridge（720K）
② 包里能跑吗
  ✓ cante-sheets --version → cante-sheets 0.2.4
  ✓ cante-pdf    --version → cante-pdf 0.2.4
  ✓ cante-bridge --version → cante-bridge 0.2.4
③ 有没有混进构建垃圾
  ✓ 没有 .d 依赖清单   ✓ 没有 0 字节文件   ✓ 没有多出来的子目录
④ 执行组件（随包发的 pi + bun）
  ✓ pi/bun.exe（83M）✓ pi/dist/bundle/cli.js（4.0K）✓ pi/package.json（8.0K）
  ✓ pi/THIRD-PARTY-NOTICES.md（16K）✓ pi/bun.exe --version → 1.4.2
verify-bundle: OK —— 四个可执行文件都在、都能跑、没有垃圾，执行组件该在的都在 ✓
```

**结论**：退出码 **0 / OK** ✓。

### 3.2 判据二：第一屏（真窗口，UIA 读回真实文字）

```
powershell -File gui\scripts\windows\accept-first-screen.ps1 -Exe "C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe"

[对] WIZARD.progressLabel     进度
[对] WIZARD.stepLabels[0]     欢迎      [对] WIZARD.stepLabels[1]  检查电脑   [对] WIZARD.stepLabels[2]  开始使用
[对] WIZARD.welcomeTitle      欢迎使用 Cante
[对] WIZARD.welcomeBody       我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先检查一下你的电脑，好吗？
[对] WIZARD.welcomeButton     开始检查
[对] COMMON.history/隐私/关于 历史 / 隐私 / 关于
共 10 条，对上 10 条，对不上 0 条。
accept-first-screen: OK
```

**结论**：退出码 **0**，**10/10** ✓（全是中文、零术语）。

### 3.3 判据三：GBK(936) 的 CSV（#287 固化的那条命令，指到装机版 exe）

```
powershell -File gui\scripts\windows\accept-gbk-csv.ps1 -Exe "C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe"

[对] 退出码 = 2                    [对] stdout 是空的（原文只走 stderr）
[对] 没有半成品落盘（那个文件不存在）  [对] stderr 是合法 UTF-8（没有非法序列）
[对] 全篇没有 U+FFFD 替换字符        [对] 全篇没有 ? 问号占位
[对] 说的是「另存为」那一步           [对] 不含 stream/valid/utf-8 这类英文
[对] 路径外只剩 Excel、WPS、.xlsx、.csv，没有别的字母
[对] 不是空白页（不是空话）
通过 10 / 10      accept-gbk-csv: 结论 = 0
```

**结论**：退出码 **0**，**10/10** ✓ —— 这一条也补上了**验收 6** 只能靠时间戳推断的那个缺口
（那台机器上装的 0.2.3 比 #279 的修复还早，所以当时没法验）。

### 3.4 判据四：服务方忙/用完（#286）—— **真坏网关** ✓（不是单测 ✗）

**先说「真」在哪**：不用我们摆的假服务方，而是走**这台机器真正的服务方**，并且默认 model 显式指到
**那条真的是坏的**路。先直接探测网关（原样）：

```
地址：http://<内网地址>:20128/v1（来源 ~/.pi/agent/models.json 的 9router；apiKey 不打印）
--- model=work                → HTTP 503 ---
{"error":{"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue using the service. (reset after 30s)"}}
--- model=ocg/deepseek-flash  → HTTP 200 ---
--- model=ocg/glm-5.2         → HTTP 200 ---
```

也就是说：**网关本身是活的**（别的 model 200），但 `work` 这条**真的欠费停机**（503）——
这就是 #286 当初的现场，现在是**现成的、真的、可复现的**。

然后让**装机版的应用**（隔离副本来自 `C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe`）真的去连它：

```
powershell -File gui\scripts\windows\run-offline.ps1 -Scenario realbusy ^
  -Exe "C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe" ^
  -WorkRoot "C:\cante-verify-17\realbusy" -StallSecs 180 -TimeoutSec 270

pi 配置目录：…（realbusy：沿用这台机器的真地址与真凭据，默认 model = 9router/work）
realbusy 现场：不打防火墙、不起假服务方 —— 让应用真的去连这台机器自己的服务方。
[phase] 干活（含审批/提问） — 15302 ms
--- 结局页（error-page）---
  | 这次没能做完
  | 发生了什么
  | 这件事没有做完。
  | 你可以怎么做
  | 原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。
  | →过一会儿再试
  | 帮你干活的程序现在用不了，多半不是你做错什么。过几分钟再点这个按钮。
  | 复制详情给管网络的同事
  | 一直这样，就把下面这段原文复制出来，发给管网络的同事，请他帮忙看看。
  | 展开技术详情
  | 再试一次
  | 换一个任务

=== busy 那一场的判据（#286：服务方忙/用完，说的是不是人话）===
  [对] 按钮「过一会儿再试」：过一会儿再试
  [对] 那句解释：帮你干活的程序现在用不了，多半不是你做错什么。过几分钟再点这个按钮。
  [对] 按钮「复制详情给管网络的同事」：复制详情给管网络的同事
  [对] 那句解释：一直这样，就把下面这段原文复制出来，发给管网络的同事，请他帮忙看看。
  [对] 没有 insufficient / quota / credits / 503 / 429 / 额度
  → 通过
realbusy 现场反向判据：结局=done 吗？False（期望 False —— 服务方用不了就不该做成一件事）
原文件哈希一致 = True
```

三条硬事实，一条都不靠「单测」：

1. **屏幕上那 4 句话，逐条等于产品源码 `copy-service.ts` 里那 4 句** ✓
   （判据块是**从源码里用正则取字符串**再比 —— 不是手抄，也不是把单测当证据 ✗）。
2. **屏幕上没有英文原文、没有状态码、没有「额度」** ✓（6 个词一个都没出现）。
   而**真网关回的原文确实到了这个进程里** —— 它出现在页面的 DOM 里，只是折在「展开技术详情」后面：
   ```
   outcome-error-page.html:  You have insufficient credits to make this request
   ```
   这一条同时**证明请求真打到了那台真网关**（我们自己摆的中继返回的原文里没有 `You have …` 这个说法）。
3. **没做成事** ✓（结局 = error-page，不是 done）、**原文件 sha256 跑前跑后一致** ✓。

同一套判据在**假服务方**那一场（`busy`，每个请求回 503）也是 **10/10 通过**：

```
[phase] 干活（含审批/提问） — 1041 ms
结局：error-page → 判据 [对]×4 / 没有 insufficient,quota,credits,503,429,额度 → 通过
```

**结论**：两场都是**退出码 0**，装机版的界面在「服务方忙/用完」这一族现场上说的是人话 ✓。

---

## 4. 没验的（与上面分开写 ✗）

1. **端到端「真出一份文件」的那一轮**：**没跑**。`run-accept-drive.ps1` 单卡按 `AGENTS.md` §5 要
   ≥1800 秒，而这一轮每条命令的硬上限是 5 分钟 —— 跑了只能写「超时」，写不出结论。
2. **#286 里「展开技术详情」点开之后给的那段原文**：**没验**（本期只验到「屏幕上那 4 句是对的、
   英文没上屏」；原文确实在 DOM 里，但我没有点开那一层去核对它的排版与完整性）—— 属于 #282 那一层。
3. **`proxy407` 那一场没有重跑**：这一轮发现 `relay.mjs` 里**从来没有** 407 分支（只在
   `run-offline.ps1` 的文档里写着），于是 `-Scenario proxy407` 实际跑的是**正常干活**的假服务方。
   我把分支补回了脚本，但**没有重跑那一场**，验收 15 的 407 结论仍然是当时的证据。
4. **SmartScreen / 「来自互联网」标记**：**没验**。`gh release download` 下来的文件**没有**
   `Zone.Identifier`，所以它**不会**触发 SmartScreen —— 这不等于「浏览器下载也不拦」。
5. **MSI（50MB）与 dmg（6MB）**：**没装**（这一轮装的是 setup.exe）。
6. **卸载是否干净**：**没验**（走的是覆盖装，没卸载）。
7. **`inspect-installer.ps1`（拆开安装包看内部清单）**：**没跑** —— 这台机器**没有 7-Zip**，
   跑了也只会在「列包内文件」那步退 3。
8. **跨版本的她的档案/历史有没有被保留**：**没验，而且这台机器上已经补验不了了** ——
   `accept-first-screen.ps1` 与 `run-offline.ps1` 都会**按既定行为删掉应用档案**
   （`AppData\Local\dev.cante.gui`、`AppData\Roaming\dev.cante.gui`，脚本把它打印在输出里）。
   这是真实改动，不是意外；但要说清：**这一轮之后，那台机器上没有「装之前的档案」可比了**。

---

## 5. 原始输出在哪

- **逐字输出（全部原样拼接）**：`C:\Users\<用户名>\r19-install.txt`（13 段：装前快照 → 安装退出码 →
  装后台面 → 顶层清单 → 916 条递归清单 → 闸门 → 首屏 → GBK → busy → realbusy → 屏幕原文 →
  DOM 里的真网关原文 → 网关直接探测）
- 每场的独立产物目录（含截图 / DOM / 结构化结果 / 报告）：
  `C:\cante-verify-17\realbusy\artifacts\`、`C:\cante-verify-17\busy\artifacts\`、
  `C:\cante-verify-17\17\first-screen\`、`C:\cante-verify-17\17\gbk\`
- 下载下来的真产物本体：`C:\cante-verify-17\17\Cante_0.2.4_x64-setup.exe`
