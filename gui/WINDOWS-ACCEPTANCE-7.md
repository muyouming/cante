# Windows 验收 7：「复制位置」只在跑完一轮的卡片上——她的结果面板里反而没有

**一句话结论**：夹具模式**在 Windows 上起来了**（第一次 ✓）；但 #283 的「复制位置」按钮
**不在「我做的结果」历史面板上**，它只在**跑完一轮之后的 ResultCard** 上，而夹具不会产出结果文件
→ **本轮没能在真窗口 + 真剪贴板上验到 #283** ✓（不是"没问题"，是**没验到** ✗）。

---

## 1. 产物（先核时间戳 ✓，没有重新 build ✓）

| 项 | 值 |
| --- | --- |
| 文件 | `C:\cante\gui\src-tauri\target\release\cante-gui.exe` |
| LastWriteTime | **2026-09-21 00:51:41**（与"00:51"一致 ✓） |
| 大小 | 10405376 |
| sha256 | `F51A4954BCA52E9F913CF15141CFA1B7BCD758BD97706C7D7EFD54F689B866E5` |

`cante-sheets.exe / cante-bridge.exe / cante-pdf.exe` 同在 `target\release\`（00:45），用于铺夹具结果行 ✓。

---

## 2. 做到了哪一步（时间线）

| 步 | 做了什么 | 结果 |
| --- | --- | --- |
| 1 | `dump-window-text.ps1 -ForceAccessibility`，`CANTE_BIN="…\bun.exe C:\cante\gui\fixtures\fake-cante.ts"`，`FAKE_CANTE_SEED=1` | **窗口起来了** ✓ MainWindowTitle=`Cante`，UIA 读到 **87 个元素** |
| 2 | `seed-result-rows.ps1 -Mode seed -Rows 3`（应用自带 `cante-sheets` 造 3 份真 xlsx，写 `runs.json`） | 首页出现 **「打开我做的结果（3 个）」** ✓ |
| 3 | `r16-copy.ps1`：抢前台 → Invoke 打开结果面板 → 找「复制 … 的位置」 | 面板**打开了**（出现「回到首页」✓），但**没有「复制位置」按钮** ✗ → `exit 3` |
| 4 | 还原 `runs.json`（`seed-result-rows.ps1 -Mode restore`） | `RESTORE OK` ✓（没留假记录） |

**夹具在 Windows 起得来**（此前没人试过）：`bun.exe` 实际在
`C:\Users\<用户名>\AppData\Local\Microsoft\WinGet\Links\bun.exe`（不是任务里写的 `tools\bun\`）✓，
`CANTE_BIN` 用 `"<bun> <script>"` 一段命令的写法即可 ✓。

---

## 3. 逐字输出（全文见 `C:\Users\<用户名>\r16-ui.txt`）

界面文本逐字存于 **`C:\Users\<用户名>\r16-ui.txt`**（含首页 + 结果面板两段）。关键两段照抄：

### 3.1 首页（有 3 条结果）
```
  Text | 我做的结果
  Text | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  Button | 打开我做的结果（3 个）
```

### 3.2 「我做的结果」面板里的按钮（逐字，全部）
```
  回到首页
  一次复制成微信能贴的文字
  打开 结果_挑出华东区-1.xlsx
  打开 结果_挑出华东区-1.xlsx 所在的文件夹
  打开 结果_挑出华东区-2.xlsx
  打开 结果_挑出华东区-2.xlsx 所在的文件夹
  打开 结果_挑出华东区-3.xlsx
  打开 结果_挑出华东区-3.xlsx 所在的文件夹
```
→ 每行只有 **「打开文件 / 打开所在文件夹」** 两个按钮，**没有** `复制 结果_….xlsx 的位置`。

`r16-copy.ps1` 退出码 = **3**，打印：
```
=== 第 2 步：找「复制位置」按钮 ===
结果面板里没有「复制 ... 的位置」按钮
```

---

## 4. 结论（只指向上面贴出的输出）

1. **#283「复制位置」在真机上没验到** —— 因为它在历史面板里**不存在**（§3.2），而它在另一屏
   （跑完一轮的 ResultCard）上，夹具到不了那里。
2. **不是夹具起不来**：夹具模式在 Windows 上**成功起来了**（§2 第 1 步），能 dump 到首页与结果面板。
3. **为什么 ResultCard 到不了（代码事实）**：
   - 历史面板是 `gui/src/simple/ResultsPanel.tsx`，源码里 `copyLocation` 出现 **0 次**；
   - 按钮在 `gui/src/simple/ResultCard.tsx`（`aria-label={ariaCopyLocation(...)}`），由
     `TaskRunner.tsx` 在**跑完一轮后**渲染；
   - 结果文件来自**跑前/跑后快照 diff**（`store.ts` `beginSnapshot`/`finishRun`），且要求
     `run.files` 非空；夹具 `fake-cante.ts` **不写盘** → 快照 diff 为空 → 不会出现带结果文件的 ResultCard。
4. 上一轮那条**真剪贴板**判据（`Get-Clipboard` 看反斜杠完整路径）**本轮没执行** —— 没有可点的按钮，
   不能拿别的复制（如「一次复制成微信能贴的文字」）顶替 ✗。

---

## 5. 没验的（分开写）

- **#283 的复制动作本身**（点了以后 `Get-Clipboard` 的内容：首=盘符、尾=扩展名、反斜杠）：**没验** ✗。
  原因见 §4。现有单测 `gui/src/simple/path-for-her.test.ts` 覆盖 `pathForClipboard` 的转换逻辑，
  但那是**在隔离环境渲染 HTML**，**不是**真窗口 + 真剪贴板 ✗。
- **跑完一轮后 ResultCard 上的按钮**：**没验** ✗（需要真跑一轮出结果，夹具做不到；本轮没接模型/WSL）。
- 显示缩放 ≠ 100%、鼠标体感：**没验** ✗（不在这条范围内）。

---

## 6. 顺手记下的观察（**不是判决**，供集成者判断）

她回来找结果时，最常走的是首页「我做的结果」面板；而 #283 的「复制位置」**只加在了跑完当屏的
ResultCard 上**，历史面板的每一行**没有**这个按钮。这会让"上次那张表在哪"这件事，
一旦离开结果当屏就还是没法一键复制。**我没有改任何代码** —— 只把这个界面事实原样报上来。

---

## 7. 机器状态（没留痕）

- `runs.json`：**已还原**成跑之前那份（`seed-result-rows: RESTORE OK` ✓；`grep seedrun` = 0）。
- 残留的 `cante-gui/cante-bridge` 进程：**已杀**（现在 `Get-Process cante-gui` 无输出 ✓）。
- `C:\Users\<用户名>\r16-seed\`（3 份 xlsx + input.csv）留着，方便下一轮继续用；清掉即可。
- 全程**没有 `cargo build`**、**没有改仓库任何文件** ✓。

## 8. 时限

- 单条命令都在 3 分钟内返回（dump/seed/copy 各一次，超时设 150–170s ✓）。
- 本条结论（夹具起来了、但 #283 够不到）**是逐字输出支撑的**，没有"应该没问题"。
