# 第十九次真机验收：真 Windows 上的键盘可达性与读屏（UIAutomation）

> 这一条补的是**真机 + 真 UIA** 的空白：键盘可达性此前只在**无头浏览器**里验过
> （`gui/src/simple/focus-guard.test.ts` + `gui/scripts/dom-smoke.sh` 的 focus-guard 那一步）。
> 那两样能证明「接线写对了」，但**证明不了**真 WebView2 里 UIA 树长什么样：Tab 在真窗口里
> 到底怎么走、每个可点元素在 UIA 里有没有可念的名字、按钮的**真实像素高度**够不够 44。
>
> - **验收对象**：**当前 `main`（`2c8d753`）自己构建的应用**（`bunx tauri build --debug --no-bundle`，
>   前端 `dist` 与 UIA 相关代码都来自这个提交）。**不是**装好的那份 —— 已安装的 `0.2.3` 早于
>   `main` 的 `ConfirmSheet`（`main` 多了「不用这个 / 加回来」两个带 `aria-label` 的按钮），
>   而本轮判据正是要覆盖确认页。
> - **验收机器**：Windows 11（`10.0.26200`）x64；WebView2 `153.0.4234.46`；
>   msedgedriver `153.0.4234.46`；屏幕 `1280x800`；DPI `96`（缩放 = 1）
> - **验收人**：跑在那台机器上的 pi —— **不提权的交互会话**（`session=1 elevated=False 有桌面=True`）
> - **起始提交**：`2c8d753`（origin/main）；**工作分支**：`pool/win-a11y2`
> - 所有长命令都带超时；「超时」与「确认没有」分开写

---

## 0. 结论先行

1. **`home` / `confirm` / `results` 三场是在当前 main（`2c8d753`）的构建上跑的，判据全绿** ✓。
   `approval` 那一场是在**上一个提交 `6856d7d` 的构建**上跑的 —— 该场的**相关源码与
   `2c8d753` 逐字节相同**（`ApprovalSheet.tsx` / `copy.ts` / `FocusLayer.tsx` 的 blob hash 两边一致，
   见 §7），所以结论对当前 main 同样成立，但**产出坐标来自旧构建**，如实标注为 `advisory`。
2. **每个可聚焦的控件都有可念的名字** ✓：Tab 真到得了的控件，`Name` 都非空。
3. **Tab 不跳、不重复、不卡** ✓：四场都「盲按一圈回到起点」，一个循环内元素各不相同。
   - `home` **42 步**；`confirm` **5 步**；`approval` **4 步**；`results` **93 步**。
4. **44px 判据** ✓：Tab 真到得了的**按钮**逻辑高都 ≥ 44（`home` 41、`confirm` 4、`approval` 4、`results` 92）。
   物理像素 ÷ 缩放（`DPI/96`）= 逻辑像素；本机缩放 = 1，两套数相同（脚本都打印）。
5. **审批卡与确认页：Esc 都关不掉** ✓（MUST-ANSWER，有意设计，见 §4），**Tab 能在里面走满一圈** ✓。
   对照组：结果面板**应该**能被 Esc 关掉 —— 实测确实关掉了 ✓。
6. **一条真发现**（不在四条判据里，单列）✗：结果面板 **92 个可 Tab 按钮只有 4 个不同名字**，
   47 行按钮名字**全一样**，读屏分不清是哪一份结果。见 §3。
7. **一条「看起来像产品坏了、其实是测试污染」的现场**：某次按 Esc 关掉面板后焦点**逃进
   Windows 资源管理器**，被误判成 5 个按钮不足 44px。真因与原始输出见 §3.3（这条**不是产品问题**，
   但它正说明「真机验收必须先证你看的是谁」）。
8. **没验成的**：见 §6（最重要：**没有读屏软件**，只验了 UIA 的 `Name`，**没验**「她听不听得懂」）。

---

## 1. 怎么验的（可重复）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y-uia.ps1 -Scenario home
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y-uia.ps1 -Scenario confirm
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y-uia.ps1 -Scenario results
powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\a11y-uia.ps1 -Scenario approval -Exe "<隔离目录>\cante-gui.exe"
```

退出码照 `run-accept-drive.ps1` 那套：**0** = 判据都满足；**2** = 环境问题；**3** = 产品问题。

**为什么自己启动应用、不复用 `run-accept-drive.ps1`**：msedgedriver 启动应用时会用它的值覆盖
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`（实测：那样启动的 `msedgewebview2.exe` 命令行里没有
`force-renderer-accessibility`），于是 UIA 只能看到 3 个壳元素、读不到 DOM。这条限制
`read-confirm-visible.ps1` 的文件头早写过，这里沿用同一条路。

**键盘是真按的**：用 `keybd_event` 发 Tab / Esc，每一步用 `AutomationElement.FocusedElement`
读回焦点落在谁身上。**不在 DOM 里模拟**（那验的不是 WebView2 真收不接受按键）。

**44px 怎么算**：UIA 的 `BoundingRectangle` 是**物理像素**（屏幕坐标）；判据讲的是逻辑像素，
所以 `逻辑高 = 物理高 ÷ (DPI/96)`。本机 `DPI=96`、缩放 = 1.0，因此两套数值相同；
脚本两个都打印（如 `h=52逻辑(52物理)`），在别的缩放上也能复核。

**元素身份**：判「有没有重复/卡住」需要判断「是不是同一个元素」。**只按名字判是错的** ——
结果面板 47 行的按钮名字**完全相同**（§3），只按名字会把「不同行」误判成「卡住了」✗（实测踩到）。
所以身份用 **类型 + 名字 + 矩形**（拿不到矩形时退回运行时 id）。

---

## 2. 四个场景各自的原始 UIA 输出

> 每行格式：**名字 / 类型 / 物理矩形 / 逻辑高 / 可聚焦 / 在屏上**。
> 完整清单：`elements-<场景>.json`（全树里有名字/可聚焦的）、`visited-<场景>.json`（**Tab 真走过的**）。

### 2.1 home（首页）—— 41 个按钮，Tab 42 步一圈

运行输入（原样）：

```
会话：session=1 elevated=False 有桌面=True
应用：<仓库>\gui\src-tauri\target\debug\cante-gui.exe
窗口句柄=3474648 DPI=96 缩放=1（物理像素 ÷ 缩放 = 逻辑像素）
窗口客户区（屏幕坐标）=[92,32,1272,792]
```

元素清单（前 8 行，共 107 行；`elements-home.json`）：

```
  | Cante / Pane / [86,32,1266,792] / h=760逻辑(760物理) / focusable=False / offscreen=False
  | Cante - Web 内容 / Pane / [86,32,1266,792] / h=760逻辑(760物理) / focusable=False / offscreen=False
  | Cante / Document / [86,32,1266,792] / h=760逻辑(760物理) / focusable=True / offscreen=False / id=RootWebArea
  | Cante / Text / [106,45,167,70] / h=25逻辑(25物理) / focusable=False / offscreen=False
  | 历史 / Button / [1070,36,1126,80] / h=44逻辑(44物理) / focusable=True / offscreen=False
  | 隐私 / Button / [1130,36,1186,80] / h=44逻辑(44物理) / focusable=True / offscreen=False
  | 关于 / Button / [1190,36,1246,80] / h=44逻辑(44物理) / focusable=True / offscreen=False
  | 你好，需要我帮你做什么？ / Text / [287,92,1055,125] / h=33逻辑(33物理) / focusable=False / offscreen=False
```

Tab 真到得了的元素（末 6 行，共 41 个按钮；`visited-home.json`）：

```
  | 查一件事并整理成一页。帮我查一下现在出差住宿费报销的标准，整理成一页，每条都写上是从哪查到的 / Button / h=122 / offscreen=False
  | 看看设了什么 / Button / h=44 / offscreen=False
  | 直接说一句话 / Edit / h=52 / offscreen=False
  | 开始处理 / Button / h=52 / offscreen=False
  | 不知道该怎么说？点这里看三句例子 / Button / h=44 / offscreen=False
  | 历史 / Button / h=44 / offscreen=False
```

Tab 走一圈（头 4 步 + 收口）：

```
    Tab 1 -> Button「隐私」
    Tab 2 -> Button「关于」
    Tab 3 -> Button「打开我做的结果（47 个）」
    Tab 4 -> Button「看看能做什么（共 33 项）」
    ...
    Tab 第 42 步回到起点：Button「历史」
```

**那条无名元素是什么（如实说清）**：

```
  （另注：1 个可聚焦的**非控件**（容器/宿主）没有名字，不计入上条判据：
     · Pane（如 WebView2 的宿主 Pane）
     实测盲按 Tab 一圈，焦点从来没落到它们上 —— 读屏也不该念容器。）
```

它是 **WebView2 的宿主容器**（浏览器那一层），UIA 报 `IsKeyboardFocusable=True` 但**没有名字、
也量不到矩形**。它是**容器不是控件**，读屏本来就不该念它；实测**盲按 Tab 一圈，焦点从来没有
落到它上**。所以判据只对**控件类型**（Button / Edit / CheckBox …）下，这一类单独列为事实，不混进去充数。

### 2.2 confirm（确认页）—— Tab 真到得了的 5 个

走到确认页用一张**文字卡**（`needs:"text"`，第一屏就是「说一句话」，不选文件、不弹原生对话框）。
静态清单里可聚焦的（含 `task-instruction` 输入框）：

```
  | 取消 / Button / [745,707,827,759] / h=52逻辑(52物理) / focusable=True / offscreen=False
  | 开始 / Button / [839,707,935,759] / h=52逻辑(52物理) / focusable=True / offscreen=False
```

Tab 真到得了的 5 个（`visited-confirm.json`）：

```
  | 开始 / Button / h=52 / offscreen=False
  | 看看上次为什么没成 / Button / h=44 / offscreen=False
  | 我同意直接改原来的文件（不推荐） 默认是不勾选的：结果会另存为新文件，原件一个字都不会变。 / CheckBox / h=20 / offscreen=False
  | 先给我看一眼 / Button / h=52 / offscreen=False
  | 取消 / Button / h=52 / offscreen=False
```

Tab 一圈 **5 步**回到起点：

```
    Tab 第 5 步回到起点：Button「取消」
```

### 2.3 approval（审批卡）—— Tab 真到得了的 4 个

**⚠️ 这一场跑在**上一个提交 `6856d7d` 的构建**上**（原因见 §7：相关源码 `2c8d753` 与 `6856d7d`
逐字节相同，但构建产物来自旧提交）。审批卡要**真的开跑**才会出现：点**文件卡** →
「选择文件」（原生对话框交给 `accept-file-dialog.ps1` 填）→ 下一步 → 写一句 → 生成计划 →
确认页点「开始」→ 等审批卡。用文件卡而不用文字卡，是因为**文字卡一次工具调用都不用就写完了**
（实测跑完是 `done`、根本不弹审批 ✗）。

```
  | 允许这次 / Button / h=53 / offscreen=False
  | 以后都允许 / Button / h=53 / offscreen=False
  | 详情（给技术同事看） / Button / h=45 / offscreen=False
  | 不允许 / Button / h=53 / offscreen=False
```

Tab 一圈 **4 步**回到起点：

```
    Tab 1 -> Button「允许这次」
    Tab 2 -> Button「以后都允许」
    Tab 3 -> Button「详情（给技术同事看）」
    Tab 第 4 步回到起点：Button「不允许」
```

### 2.4 results（「我做的结果」面板）—— Tab 真到得了的 92 个

静态清单 584 行（`elements-results.json`），其中 Tab 真到得了的 93 个（`visited-results.json`）：

```
  | 搜索做过的结果文件 / Edit / [.. ] / h=53逻辑 / focusable=True / offscreen=False
  | 回到首页 / Button / [1084,52,1182,96] / h=44逻辑(44物理) / focusable=True / offscreen=False
  | 打开这个结果文件 / Button / [310,866,414,915] / h=49逻辑(49物理) / focusable=True / offscreen=True
  | 打开这个结果文件所在的文件夹 / Button / [426,866,580,915] / h=49逻辑(49物理) / focusable=True / offscreen=True
  ...
```

Tab 一圈 **93 步**回到起点：

```
    Tab 第 93 步回到起点：Edit「搜索做过的结果文件」
```

> 静态清单里这些按钮很多标着 `offscreen=True` —— 面板比窗口高，未滚动到的行在快照里在屏外；
> 而 **Tab 走到它们时浏览器会把它们滚到眼前**，所以 `visited-*.json` 里是 `offscreen=False`。
> 这正是「44px 判据要对 Tab 真走过的元素判、而不是对静态快照判」的原因（§7 坑 4）。

---

## 3. 那条真发现（本轮最重要的产出）

### 3.1 事实：92 个可 Tab 按钮，只有 4 个不同的名字

把 `visited-results.json` 里 Tab 真走过的 93 个元素按名字归类（原始输出）：

```
visited total: 93   distinct names: 4
  47 × 打开这个结果文件所在的文件夹
  44 × 打开这个结果文件
  1 × 回到首页
  1 × 搜索做过的结果文件
```

Tab 走起来长这样（逐字，前 8 步）：

```
    Tab 1 -> Button「打开这个结果文件」
    Tab 2 -> Button「打开这个结果文件所在的文件夹」
    Tab 3 -> Button「打开这个结果文件」
    Tab 4 -> Button「打开这个结果文件所在的文件夹」
    Tab 5 -> Button「打开这个结果文件」
    Tab 6 -> Button「打开这个结果文件所在的文件夹」
    Tab 7 -> Button「打开这个结果文件」
    Tab 8 -> Button「打开这个结果文件所在的文件夹」
    ...
    Tab 第 93 步回到起点：Edit「搜索做过的结果文件」
```

面板里一共 **47 行**结果文件，每行两个按钮，**名字都一样**。

### 3.2 为什么这是问题，以及修法在哪

`ResultsPanel.tsx` 里每一行的两个按钮用的是**同一份常量** `aria-label`：

```
aria-label={RESULTS.actions.ariaOpen}        // "打开这个结果文件"
aria-label={RESULTS.actions.ariaOpenFolder}  // "打开这个结果文件所在的文件夹"
```

**没有带上文件名**。读屏用户 Tab 到第 30 行时，听到的还是「打开这个结果文件」——
**分不清是哪一份结果**。同一个仓库里已经有**正确做法**可以照抄：确认页上「不用这个 /
加回来」两个按钮的 `aria-label` 就带上了文件名（`CONFIRM_FILES.removeLabel(fileName(path))`
→「不用这个：<文件名>」，`copy-files.ts`）。

- **它不是本轮四条判据的一部分**（判据只要求 `Name` 非空，这条**满足** ✓），
  所以我没把它算作「不符合」，而是单列出来。
- **按任务边界我没有改 `src/**`** —— 这是要产品拍板的小改：把 `ariaLabel` 变成
  `(name) => \`打开这个结果文件：${name}\`` 这种形式，两处调用点带上文件名。

### 3.3 一条「看起来像产品坏了、其实是测试污染」的现场（原始输出）

第一版 `results` 跑出来是**红的**（当时应用构建 = `6856d7d`），原始输出（逐字，来自当轮运行）：

```
  ✗ ListItem「结果_挑出华东区.xlsx」 h=24
  ✗ SplitButton「名称」 h=27
  ✗ Button「添加新标签页」 h=24
  ✗ Button「上移到“accept-normal”(Alt + 向上键)」 h=32
  ✗ Button「刷新“job”(F5)」 h=32
    ...
  === 判据汇总 ===
  ✓ [results] focusable-have-names
  ✗ [results] tab-loops —— 按了 40 步没回到起点
  ✗ [results] tab-not-stuck —— 有 2 次停在同一个元素上
  ✗ [results] tab-reachable-buttons-44px —— 5 个 < 44；0 个量不到
  ✓ [results] esc-closes
```

**那条「可 Tab 元素」清单里混进了资源管理器的东西**（逐字）：

```
  | 结果_挑出华东区.xlsx / ListItem / h=24 / offscreen=False
  | 名称 / SplitButton / h=27 / offscreen=False
  | 详细信息 / RadioButton / h=26 / offscreen=False
  | job / TabItem / h=32 / offscreen=False
  | 添加新标签页 / Button / h=24 / offscreen=False
  | 上移到“accept-normal”(Alt + 向上键) / Button / h=32 / offscreen=False
  | 刷新“job”(F5) / Button / h=32 / offscreen=False
  | 地址栏 / Edit / h=32 / offscreen=False
  | (无名) / Pane / h=760 / offscreen=False
  | 选择文件 / Button / h=48 / offscreen=False
  | 你要做什么 / Edit / h=90 / offscreen=False
  | Cante / Document / h=760 / offscreen=False
  | 停下来 / Button / h=44 / offscreen=False
  | 历史 / Button / h=44 / offscreen=False
```

**真因（可核对）**：那台机器的桌面上**残留着几个文件资源管理器窗口**（是本轮更早的
「打开所在文件夹」验收留下的，用 `Shell.Application` 数得到 3 个），盲按 Tab 时焦点
被它们**抢过去**，于是「Tab 顺序」看起来乱了、那 5 个「不足 44px 的按钮」其实是**资源管理器的
按钮**。

**为什么这条必须写进报告**：它**不是产品问题**，但它正说明 AGENTS.md §3.6 那句话 ——
**说「已经验证」之前，先问一句「我看的，是它真的产出的那个东西吗？」**。
当时我看到 5 个红，第一反应是「产品的 44px 判据有问题」，差一点就写进报告 ✗。
修法落在脚本里（三条，见 §7 坑 2/3/6）：按键前把应用拉到前台、判「焦点还在不在我们这边」、
关掉残留窗口。

---

## 4. 审批卡与确认页：Esc **必须不能**关掉它们；Tab 不能死循环

### 4.1 为什么这是设计而不是漏做

`FocusLayer.tsx` 的文件头把原因写死了：确认页与审批卡是**破坏性动作之前唯一的门**。
Esc 是个「随手按」的键，按下去东西就消失，她就没法确认那件事到底开始了没有 ——
那正是审批卡出现之前「窗口像卡死了」的老毛病。而**安全答案就在屏幕上**
（确认页的「取消」、审批卡的「不允许」），打开时**焦点就落在它上面**：按一下回车和按
一下 Esc 一样省事，区别只在于她看清了那是「取消」。

### 4.2 实测（真键盘 + UIA，逐字）

```
=== 确认页：Esc **必须不能**关掉它 ===
  ✓ 按 Esc 之后确认页还在（MUST-ANSWER，符合设计）。焦点=Button「取消」

=== 审批卡：Esc **必须不能**关掉它 ===
  ✓ 按 Esc 之后审批卡还在（MUST-ANSWER，符合设计）。焦点=Button「不允许」

=== 对照组：这个面板**应该**能被 Esc 关掉（它给了 onEscape）===
  ✓ 按 Esc 之后面板关掉了（与确认页/审批卡形成对照）。
```

Tab 在里面各走满一圈、回到起点、**不进死循环**：

```
    [confirm]  Tab 第 5 步回到起点：Button「取消」
    [approval] Tab 第 4 步回到起点：Button「不允许」
    [results]  Tab 第 93 步回到起点：Edit「搜索做过的结果文件」
```

三条一起看才完整：**该关的关得掉，不该关的关不掉**。只验一边说明不了问题。

---

## 5. 判据汇总（18 条，全部满足）

| 场景 | 可聚焦控件都有名字 | Tab 一圈回到起点 | 没有卡住 | 按钮逻辑高 ≥ 44 | 其它 |
| --- | --- | --- | --- | --- | --- |
| home | ✓（41 按钮） | ✓（42 步） | ✓ | ✓（41 个） | — |
| confirm | ✓（4 按钮） | ✓（5 步） | ✓ | ✓（4 个） | Esc 关不掉 ✓ |
| approval ⚠️旧构建 | ✓（4 按钮） | ✓（4 步） | ✓ | ✓（4 个） | Esc 关不掉 ✓ |
| results | ✓（92 按钮） | ✓（93 步） | ✓ | ✓（92 个） | Esc 关得掉 ✓（对照） |

---

## 6. 我没能验证什么（如实列，不写成「通过」）

1. **没有读屏软件 → 「她听不听得懂」这一层没验** ✗ —— **本轮最大的边界**。
   我验的是 **UIA 的 `Name` 属性非空**（「读屏**拿得到**一个名字」），**不是**
   「Narrator / NVDA 念出来是**一句她听得懂的中文**」。名字的**措辞、顺序、啰嗦程度**、
   以及念出来的节奏，都要真人戴耳机听才算验过。本轮**没装读屏软件、也没人听过** ——
   所以 §0 第 2 条只能说「每个控件有名字」，**不能说**「读屏好用」。
2. **确认页那个复选框的「真实可点区域」量不到** ✗ —— UIA 给的是那个原生
   `input[type=checkbox]` 自己的框（**20×20**），而它外面还包着一层更大的 `<label>`；
   那一层在 UIA 里**不单独成节点**（它的文字变成了控件的 `Name`）。所以「她真实能点到的
   区域到底多大」从 UIA 这一层**量不到**。源码上它的 `<label>` 没有 `min-h-[44px]`
   （只有 `py-3` + 一行小字），所以**很可能**明显小于 44；但**没有实测到**，
   因此**不写成「不符合」**，只写「量不到」。要真验它，得用**鼠标**点它边缘
   （例如离中心 ±15px 处）看还灵不灵 —— 本轮**没做**。
3. **`approval` 那一场跑在旧构建（`6856d7d`）上** ✗ —— 相关源码与 `2c8d753` 逐字节相同
   （§7 有 hash），所以结论对当前 main 成立；但产出坐标来自旧构建，标为 `advisory`。
4. **没有验 `Shift+Tab` 逆序走一圈** ✗ —— 脚本的 `Press-Tab` 支持 Shift，但四个场景
   跑的都是**正向 Tab**。`focus-guard.test.ts` 里正向/逆向都有单测覆盖接线，
   可真机上的**逆向一圈**这一轮**没跑**。
5. **没有验读屏的「朗读顺序」与实时区域** ✗ —— 面板上 `role="status"` 的搜索命中数、
   进度文案这类**动态更新**会不会被念出来，UIA 的静态快照看不出来，要真读屏软件。
6. **只有 WebView2 这一种宿主** ✗ —— 结论只对 WebView2 成立。换宿主（例如 macOS 的
   WKWebView）UIA 树可能完全不同，**没验**。
7. **每场只跑了一遍** ✗ —— `home` / `confirm` / `results` 各 1 轮有效（在当前 main 上）；
   `approval` 1 轮有效（在旧构建上）。要达到「各跑 3 次结论一致」的硬度，得再跑。
8. **没有验「面板里的行滚动到可见」这条交互** ✗ —— 我验的是 Tab 走到哪、量到多高；
   没有验「她按住 Tab 快速连按 50 次」这种压力下的表现。

---

## 7. 踩过的坑（都是「看起来像产品坏了、其实是工具/环境」）

这几条对下一个人最重要 —— 不写下来，下一个人会得出**反向结论**：

1. **从工作树跑构建产物时，执行组件起不来**：应用报「助手没能启动起来，它一开始就退出了」，
   真因是随包的 pi bundle 里有外部依赖 `@earendil-works/chord/context`，靠 `node_modules`
   解析，而**工作树的祖先目录里有 `gui/node_modules`**。**修法**：把应用（含 `pi\`）复制到
   一个没有 `node_modules` 祖先的目录再跑。这是**开发工作树独有的坑**，不是产品缺陷。
   `approval` 那一场就是这么跑的。
2. **桌面残留的资源管理器窗口会抢走焦点**：盲按 Tab 时焦点跑到别的程序里，于是「Tab 顺序」
   看起来乱了、还量到一堆别人家的按钮（§3.3）。**修法**：按键前把应用拉到前台；
   拿不到前台就把这一轮标成**环境问题**，不拿污染过的读数下结论。
3. **比窗口句柄 / 比进程号都判不出「焦点还在不在我们这边」**：
   - Tauri 的 `MainWindowHandle` 与 UIA 最顶层元素的 `NativeWindowHandle` **不是同一个数**；
   - WebView2 的 DOM 跑在**另一个进程**（`msedgewebview2.exe`），进程号也不一样。
   **修法**：从焦点元素往上走到根，和我们的 root 元素 `Equals` 比。
4. **静态快照里 `IsOffscreen=True` 的控件，可能正是 Tab 真到得了的那个**：确认页比窗口高，
   那个复选框在快照里 `offscreen=True`、矩形 `∞`；先扫一遍再按「不在屏上就跳过」会把它
   **默默漏掉** ✗。**修法**：44px 判据改成对 **Tab 真走过的元素**判，而不是对静态快照判。
5. **一次假绿**：某次跑没走到确认页，但因为「没下过任何判据」，最后打了 `OK` ✗。
   **修法**：环境原因停下时记一条 `reached-screen` 的失败，并把**环境问题优先于产品问题**。
6. **一次假红**：就是 §3.3 那条 —— 第一次 `results` 的 5 个「不足 44px」是资源管理器的按钮。
   根因是坑 2。修掉之后同一场是 92 个按钮全部 ≥ 44。
7. **`approval` 那一场为什么在旧构建上**：本轮开工时 `origin/main` 还是 `6856d7d`，
   后来推进到 `2c8d753`；我重新构建并重跑了 `home`/`confirm`/`results`，但**没有**重跑
   `approval`（要真开跑、要填原生对话框，一轮最久）。查过 hash：`approval` 依赖的三个源文件
   两边一致，所以结论可迁移；产出仍标 `advisory`。
   - `ApprovalSheet.tsx`：`6856d7d` 与 `2c8d753` 都是 `5ead9e8035a6afc1d686e30b3442d855aa6ef97c`
   - `FocusLayer.tsx` / `copy.ts`：两边 `git diff --numstat` 都是 0 增 0 删

---

## 8. 交付物

| 文件 | 作用 |
| --- | --- |
| `gui/scripts/windows/a11y-uia.ps1` | **一条命令跑一个场景**（`-Scenario home\|confirm\|approval\|results`）：自己启动应用、用真键盘走 Tab/Esc、用 UIA 读回焦点与矩形、下判据（退出码 0/2/3） |

复用的（本轮没改）：`accept-file-dialog.ps1`（填原生对话框，`approval` 用）、
构建链 `bun scripts/stage-executor.ts` + `bunx tauri build --debug --no-bundle`。

每个场景的原始输出落在 `-WorkDir` 下：`report-<场景>.txt`（全文）、
`elements-<场景>.json`（全树里有名字/可聚焦的）、`visited-<场景>.json`（Tab 真走过的）。

**建议的下一步**（按任务边界我没有动 `src/**`）：

1. 把「结果面板 47 行按钮同名」按 §3.2 改掉（照确认页 `CONFIRM_FILES.removeLabel` 的写法）。
2. 装一个读屏软件（Narrator 或 NVDA），把「念出来是什么」这一层补上 —— 这是本轮最大的缺口。
3. 补一轮 `Shift+Tab` 逆序走一圈，以及确认页复选框的**鼠标边缘点击**。

---

## 9. 这台机器上留下的原始输出

```
<隔离目录>\home\       report-home.txt  elements-home.json  visited-home.json
<隔离目录>\confirm\    report-confirm.txt  elements-confirm.json  visited-confirm.json
<隔离目录>\results\    report-results.txt  elements-results.json  visited-results.json
<隔离目录>\approval\   report-approval.txt（旧构建 6856d7d）
<隔离目录>\app\        跑 approval 那一场用的隔离副本（含 pi\）
```

（报告里不写真实家目录与内网地址 —— 用 `<仓库>` / `<隔离目录>` 代替，见
`gui/scripts/secret-scan.sh` 的判据。）
