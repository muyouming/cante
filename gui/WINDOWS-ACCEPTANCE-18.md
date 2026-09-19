# 第十八次真机验收：真 Windows 上的「显示缩放」——能改的与改不了的，以及当前缩放下量到了什么

> #197 第一条（缩放）此前只在 macOS 无头 Chrome 上用 CDP 指标覆盖量过
> （`gui/scripts/zoom/driver.py`），那份文档**自己写明不覆盖真实 Windows 缩放** ✗。
> 这一轮来补真机证据，结果**分成两半**：
>
> 1. **这台机器改不了缩放** ✗ —— 显示适配器不支持（下面 §2 有原始 rc），
>    所以我**没有**改任何注册表、没有重启会话，**如实写"验不了"** ✓；
> 2. **在当前缩放（100%）下量到的数字是有效的证据** ✓ —— 而且我用**窗口尺寸**复现了
>    125% 在这块 1280x800 屏上会得到的**逻辑视口**（1024x608），把"版面会不会被挤坏"
>    这个问题回答了（§4）。**这一条不等于真机 125% 缩放**，是它的**等价视口**，别读混。
>
> - **验收对象**：`main` = `6856d7d`；应用是**当前 main 现构建并静默安装**的那一份
> - **验收机器**：Windows 11 家庭版 / `10.0.26200` / x64；WebView2 `153.0.4234.46`；
>   物理屏 **1280x800**（工作区 1280x752，任务栏 48px）；显示适配器
>   `Microsoft 基本显示适配器`（`10.0.26100.1`，**没有真显卡驱动**）
> - **工作分支**：`pool/win-scale`；**报告文件名**：`-18`（`-16`/`-17` 已被合并进 main）
> - **安全第一**：只碰 DisplayConfig 这一条官方路径；跑完**没有留下**任何防火墙规则、
>   没有改注册表、缩放仍是 96 DPI（§5 有复核输出）
> - 长命令都带超时；**"超时"与"确认没有"分开写**

---

## 0. 结论先行

| 要做的 | 结果 |
| --- | --- |
| 1. 读当前缩放并记下来 | ✅ 读到：**96 DPI = 100%**（`GetDpiForSystem` 与 `GetDeviceCaps(LOGPIXELSX)` 都是 96；注册表 `Win8DpiScaling=0`，`LogPixels` 未设） |
| 2. 改成 125% | ✗ **改不了**（`DisplayConfigGetDeviceInfo`/`SetDeviceInfo` 都返回 **rc=87 ERROR_INVALID_PARAMETER**）。**如实写"验不了"**，没做任何别的尝试 |
| 3. 125% 下跑一轮量版面 | ⚠️ **用等价视口做到**（1024x608）：一行命令跑通、结果页文字**没有被横向裁掉**、按钮**都点得到**（要滚动） |
| 4. 还原缩放并确认 | ✅ 复核：LOGPIXELSX 仍 96、屏幕仍 1280x800、无残留规则 |
| 5. 报告 | 本文件 |

**一句话**：**这台机器的缩放改不了（虚拟显示适配器不支持），所以"真机 125% 渲染色"这条我验不了 ✗**；
但**当前缩放下的量测是真的** ✓，而且把 125% 会得到的**视口**拿来量了 ——
**结果页在这个视口下没有横向溢出，也没有被裁的文字，按钮滚动之后都能点到**。

---

## 1. 当前缩放：**96 DPI = 100%**（原始输出）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\scale-probe.ps1 -Mode read
```

```
GetDpiForSystem = 96
LOGPIXELSX       = 96  （96 = 100%，120 = 125%，144 = 150%）
主屏物理尺寸   = 1280x800
注册表 LogPixels      = （没设过就是空）
注册表 Win8DpiScaling = 0

=== DisplayConfig 活动路径（1 条）===
  sourceId=0  targetId=0  outputTech=4294967295  targetAvailable=1
=== 每个 source 的缩放档位 ===
  sourceId=0  读缩放失败 rc=87（87 = ERROR_INVALID_PARAMETER：这个适配器/输出不支持按 source 调缩放）
scale: READ OK（但**没有任何 source 支持读缩放** —— 见上面的 rc）
```

**两条读法都对得上**：`GetDpiForSystem()`（系统级）与 `GetDeviceCaps(LOGPIXELSX)`（GDI 级）
都给 **96**，所以"100%"不是猜的。注册表里 `LogPixels` **根本没设过**、
`Win8DpiScaling=0`（= 每个显示器用自己的缩放），这两项都与他处一致。
工作区 1280x752、任务栏 48px，也是实测。

---

## 2. 为什么改不了 125%：**适配器不支持**（rc=87）

Windows 设置里那个缩放滑块走的是 **DisplayConfig** 的
`DISPLAYCONFIG_DEVICE_INFO_SET_SOURCE_DPI_SCALE`。这台机器上**读和写都失败**：

```
=== GET（DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_DPI_SCALE = 18）===
  sourceId=0  rc=87   minRel=0 curRel=0 maxRel=0

=== SET（SET_SOURCE_DPI_SCALE = 19）原始尝试 ===
raw SET sourceId=0 scaleRel=0   ->  rc=87  (ERROR_INVALID_PARAMETER: 不支持)
raw SET sourceId=0 scaleRel=1   ->  rc=87  (ERROR_INVALID_PARAMETER: 不支持)
raw SET sourceId=0 scaleRel=-1  ->  rc=87  (ERROR_INVALID_PARAMETER: 不支持)
```

**rc=87 = ERROR_INVALID_PARAMETER**，对这三个档位都一样 —— 说明**不是"档位写错了"，
而是这个适配器/输出根本不支持按 source 调缩放**。

**根因（这台机器的既有事实，不是这一轮才坏的）**：

```
GPU     = Microsoft 基本显示适配器   （驱动 10.0.26100.1）
PnP     = Intel(R) Iris(R) Xe Graphics  → 状态 Unknown（问题码 43）
          Microsoft 基本显示适配器        → 状态 OK
target  = \\?\DISPLAY#Default_Monitor#...＃（合成监视器，没有 EDID）
```

这是台 **QEMU/KVM 虚拟机**，用的是**微软基本显示适配器**（没有厂商驱动），
输出是个合成的 `Default_Monitor`。这类适配器**不实现** DisplayConfig 的 DPI 缩放接口，
所以 87 是"如实地说做不到"，**不是我们调错了参数**。
（这也与 `gui/WINDOWS-ACCEPTANCE-*` 里记过的"这台机器没有 GPU 驱动、WebView2 走软件渲染"一致。）

**我做了什么 / 没做什么（安全边界）**：
- ✅ 只调 DisplayConfig 的 GET/SET；
- ✗ **没有**改 `HKCU\Control Panel\Desktop` 的 `LogPixels`；
- ✗ **没有**重启会话、没有改分辨率/刷新率；
- ✗ 失败后**没有**换别的手段硬试（照任务要求）。

**踩坑记录（留给下一个写这段的人）**：设备信息类型常量是 **18/19**（GET/SET_SOURCE_DPI_SCALE），
**不是 14/15** —— 写错会得到 rc=31（GEN_FAILURE），很容易误判成"不支持"。另外
**PowerShell 取嵌套值类型字段是复制**（`$g.header.size = …` 改的是副本），
必须在 C# 里把整个结构立好再传，否则 size=0、照样 rc=31。这两条我在 `scale-probe.ps1` 里都写了注释。

---

## 3. 125% 在这块屏上意味着什么（算术，不是猜测）

物理屏 1280x800、缩放 S ⇒ **逻辑屏 = 1280/S × 800/S**：

| 缩放 | 逻辑屏 | 减去任务栏(48px) | Tauri 默认窗口 1180x760 logical 放得下吗 |
| --- | --- | --- | --- |
| **100%（当前）** | 1280x800 | 1280x752 | **放得下**（1180x760，高刚好） |
| **125%** | 1024x640 | **1024x608** | **放不下 → 宽高都被夹到 1024x608** |
| 150% | 853x533 | 853x506 | 放不下 → 夹到 853x506 |

所以 **125% 在这台机器上的"客户区"就是 1024x608**。
下面 §4 就是把窗口客户区**设成这个尺寸**来量的 —— 量与真机 125% 的差别见 §6 第 1 条。

---

## 4. 在 100% 与 125% 等效视口下量到的版面（原始数字）

**怎么量的**：`gui/scripts/windows/measure-scale-viewport.ps1`（本轮新增）自己启动应用、
用 UI Automation 走到结果页、把客户区设成目标尺寸，然后记下**每个有名字元素的
`BoundingRectangle`**（位置/宽高/是否屏外/是否落在客户区内）。
`Scale=1.0`（本机就是 100%），所以**逻辑像素 = 物理像素**，报告里两列都给了。

### 4.1 一行命令跑通（两次）

```powershell
# 默认路径（注册表里的安装位置）
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\run-accept-drive.ps1
```

```
[phase] tauri-driver 就绪 — 447 ms
[phase] 打开 WebDriver 会话（启动应用） — 750 ms
[phase] 首页出现 — 114 ms
[phase] 点卡片「从大表里挑出想要的行」 — 57 ms
[phase] 选文件（原生对话框） — 1178 ms
[phase] 写一句话并生成计划 — 97 ms
[phase] 确认页 → 开始 — 51 ms
[phase] 干活（含审批/提问） — 20648 ms
  | 做好了
accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。
```

**原文件没被改动** ✓：这一轮输入表 sha256 记录值 `2F879BDA…26DBB`，跑完实测**同值**。
（我自己那份基线输入表 `BB6EC8DB…8585E` 从头到尾也没变过。）

### 4.2 结果页元素：横向溢出、文字裁切、按钮可达

| 问题 | 100%（客户区 1180x760） | 125% 等效视口（1024x608） |
| --- | --- | --- |
| **① 文字有没有被横向裁掉/挤出视口** | **没有** —— 横向溢出元素 **0 个** | **没有** —— 横向溢出元素 **0 个** |
| **② 按钮还点得到吗** | 点得到（见下） | **点得到**（滚动后真的 invoke 成功） |
| **③ 底部输入区占多少** | 输入框 `586x96` → 占视口高 **12.6%** | `586x96` → 占视口高 **15.8%** |
| **④ 关键元素实际高度** | 标题「做好了」32px；按钮 46/48/52px | 标题 32px；按钮 46/48/52px（**与视口无关**） |

**关键文案两条视口都找得到**（UIA 按名字找得到 = 它真的渲染出来了）：
`做好了` / `打开文件` / `打开所在文件夹` / `想打印出来：先点「打开文件」…Ctrl+P` /
`以后也能在首页的「我做的结果」里找到它。` ✓（125% 视口那次文件名那一条是 `-新` 变体，
不是丢失 —— 见 §4.4。）

### 4.3 按钮可达性：滚 N 格之后进视口、并且**真的点得到**

UIA 树里"能按名字找到"**不等于**"在视口里、点得到"（元素可能是屏外的）。
所以这里做的是：逐格发**真滚轮事件**，记目标按钮的 y，等它整块落进窗口，然后**真 invoke 一下**。

| 视口 | 目标按钮 | 滚动前 y | **进入视口时的格数** | 结果 |
| --- | --- | --- | --- | --- |
| 100%（1180x760） | 打开文件 | y=1114（屏外） | **滚 6 格** | invoke **成功** ✓ |
| 125% 等效（1024x608） | 打开文件 | y=1190（屏外） | **滚 8 格** | invoke **成功** ✓ |

**逐格实测输出（125% 等效视口）**：

```
=== 逐格下滚，看「打开文件」什么时候进视口（客户区 1024x608）===
  滚 0 格：y=1190 h=48 屏外=True 在窗口内=False
  滚 5 格：y=715  h=48 屏外=True 在窗口内=False
  滚 8 格：y=465  h=48 屏外=False 在窗口内=True
  → 滚 8 格后它在视口里：invoke 成功
```

**「再跑一次」「知道了」在 125% 视口下**同样可达：滚动后 y=470、h=52、
`屏外=False 在窗口内=True`，真 invoke **成功** ✓（`scroll-reach-scale.ps1` 那次的输出）。

### 4.4 一个要说清的细节：文件名不是"丢了"，是换了名字

125% 视口那次，逐条找 `结果_挑出华东区.xlsx` 结果是 ✗ —— 但看屏幕原文，
它写的是 **`结果_挑出华东区-新.xlsx`**（输入表旁边已有同名文件，产品按规矩自动加了后缀）。
所以**不是**文字被裁掉，是我那条断言**钉死了文件名**。报告里两边都留着，不美化。

---

## 5. 还原复核 & 安全（跑完没留下任何东西）

**缩放本来就没改成功**，所以"还原"是把当前值再确认一遍（脚本的 `-Mode restore` 也跑过，幂等）：

```
=== SAFETY: scaling unchanged? ===
LOGPIXELSX = 96
GetDpiForSystem = 96
Screen = 1280x800
--- 无残留防火墙规则 ---
cante-offline rules = 0
```

- ✅ 缩放仍是 **96 DPI / 100%**；屏幕仍 **1280x800**；
- ✅ **没有**残留的 `cante-offline*` 防火墙规则（上一轮那条教训：清理要复核，这里查过是 0）；
- ✅ **没有**改过注册表的 `LogPixels` / `Win8DpiScaling`；
- ✅ **没有**重启过会话（`GetDpiForSystem` 前后都是 96 也侧证了这点）。

---

## 6. 我没能验证什么（如实列，不写成"通过"）

1. **真机 125% 的渲染色，验不了** ✗ —— 这是本轮最重要的一条"没验到"。
   原因：**这台机器的显示适配器不支持按 source 调缩放**（§2 的 rc=87，GET/SET 都失败），
   **安全第一**所以我没有改注册表 `LogPixels`、没重启会话去硬凑。
   **因此**：字体在 125% 下的**真实渲染**（字形替换、行高四舍五入、ClearType 效果）
   **一条都没验到** ✗。§4 量的是**等价 CSS 视口**，不是缩放渲染本身。
2. **"物理像素高度"这一列**：本机缩放 = 1.0，所以逻辑像素 = 物理像素，
   那张表里的"物理h"列**等于**逻辑高度 ✓。**在真 125% 的机器上**这一列应该是
   `逻辑高 × 1.25`（`measure-scale-viewport.ps1` 的 `-Scale` 参数就是给那种机器留的），
   **但那种数字这台机器给不出** ✗。
3. **面板（我做的结果）在 125% 视口下没单独量** ✗ —— 本轮量的是**结果页**；
   面板那次只做了可滚动性试探（元素 464 个、多数在折叠之下），**没有逐条量矩形**。
4. **没验 150%** ✗ —— 只算了算术（853x506），没量。
5. **一行命令的前三次跑是失败的** ✗ —— 现象是结果页出现「后台干活的程序意外退出了」。
   **真因**：我那几次**被超时/中断杀掉**，留下了一个坏掉的**应用档案**
   （`%LOCALAPPDATA%\dev.cante.gui`）；**清掉档案后同一份应用立刻跑通**（§4.1）。
   所以这是**残留状态**问题，**不是**产品缺陷 —— 但值得记一笔：
   **验收跑挂之后，下一轮要先清档案**，否则会把它误读成产品问题。
6. **报告里没写"别的机器也这样"** —— 结论**只来自这一台**（1280x800、无显卡驱动、100% 缩放）。

---

## 7. 交付物

| 文件 | 作用 |
| --- | --- |
| `gui/scripts/windows/scale-probe.ps1` | **新增**：读/设/还原显示缩放，只走 DisplayConfig；set 前落盘原值、restore 幂等 |
| `gui/scripts/windows/measure-scale-viewport.ps1` | **新增**：在指定**客户区尺寸**下用 UIA 量结果页每个元素的矩形/屏外/在视口内 |
| `gui/scripts/windows/scroll-reach-scale.ps1` | **新增**：逐格发真滚轮事件，找出按钮**第几格进视口**，并在那时**真 invoke 一下**（§4.3 的证据就是它跑出来的） |
| 本报告 | `gui/WINDOWS-ACCEPTANCE-18.md` |

**没有改 `src/**`**（硬要求）；两个都是**新增脚本**。`scale-probe.ps1` 与
`measure-scale-viewport.ps1` 都是 **UTF-8 with BOM**（仓库的 `script-encoding.test.ts` 闸门扫过 ✓）。

**给下一个接手的人（如果哪天在**有真显卡驱动**的机器上跑这一条）**：

```powershell
# 1) 读当前值（先读再改）
powershell -File gui\scripts\windows\scale-probe.ps1 -Mode read -StateFile "$env:TEMP\scale.json"
# 2) 改 125%（原值自动落盘）
powershell -File gui\scripts\windows\scale-probe.ps1 -Mode set -ScalePercent 125 -StateFile "$env:TEMP\scale.json"
# 3) 在 125% 下量（-Scale 1.25 让"物理像素"列算对）
powershell -File gui\scripts\windows\measure-scale-viewport.ps1 -OutDir <目录> -Scale 1.25 `
  -InputFile <输入.xlsx> -DialogHelper gui\scripts\windows\accept-file-dialog.ps1
# 4) 务必还原 + 复核
powershell -File gui\scripts\windows\scale-probe.ps1 -Mode restore -StateFile "$env:TEMP\scale.json"
```
