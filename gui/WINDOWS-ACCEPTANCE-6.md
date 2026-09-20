# Windows 验收 6：新产物里两处「英文泄漏修复」真的在（GBK 的 CSV / 缺 sheet XML 的坏 xlsx）

日期：2026-09-21 凌晨　机器：那台 Windows 11 验收机（工作树 `C:\cante`，系统代码页 **936**）。
产物：`gui\src-tauri\target\release\` 下 **00:45 的 `cante-sheets.exe`** 与 **00:51 的 `cante-gui.exe`**
（先核过时间戳，**没有重新编译** ✓）。
原始输出：`C:\Users\<用户名>\r16-cli.txt`（逐字，家目录已收敛成 `<用户名>`，其余原样）；
原始件（那两段 stderr 的字节）在 `%TEMP%\cante-r16-cli\`。

**两条结论都只对上面这份新编产物成立** —— 为什么：见 §0。

---

## 0. 版本对照（各一行，取自 r16-cli.txt 开头）

| | 文件 | 文件/产品版本 | 时间戳 | 字节 |
| --- | --- | --- | --- | --- |
| **新编** | `C:\cante\gui\src-tauri\target\release\cante-sheets.exe` | 0.2.3 / 0.2.3 | **2026-09-21 00:45:14.620 +08:00** | 2480640 |
| **新编** | `C:\cante\gui\src-tauri\target\release\cante-gui.exe` | 0.2.3 / 0.2.3 | **2026-09-21 00:51:41.359 +08:00** | 10405376 |
| 装机 | `C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe` | 0.2.3 / 0.2.3 | **2026-09-20 02:27:50.000 +08:00** | 5345792 |
| 装机 | `C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe` | 0.2.3 / 0.2.3 | **2026-09-20 02:27:50.000 +08:00** | 14936064 |

两个 `cante-sheets.exe` 自报的版本都是 `cante-sheets 0.2.3`（退出码 0，都在 txt 里）。

**结论（对着上面两行时间戳）**：装机版是 **09-20 02:27** 那一版，比 #279（提交 09-20 20:40 +0800）
和 #282（提交 09-20 23:58 +0800）**都早**，体积也和新编的不同 → 它**不可能**含这两处修复。
编号相同（0.2.3）看不出新旧，**只有时间戳分得开** ✓。
**没验**：拿装机版跑同样的两个输入（本轮只要版本/时间戳各一行）→ 见 §3。

---

## 1. ① GBK(936) 的 CSV —— **通过（机检 9 / 9）**

**输入证据**（txt 第 12–16 行）：

```
字节数：75　头 16 字节：D0 D5 C3 FB 2C BD F0 B6 EE 2C C8 D5 C6 DA 0D 0A
同一串字节按 UTF-8 读：读不下来（→ 确实是「不是 UTF-8」的那一类）
按代码页 936 读：姓名,金额,日期
李四,1200.5,2026-01-05
王五,340,2026-01-06
合计,,1540.5
```
`D0 D5 C3 FB` = 「姓名」的 GBK 编码 ✓ —— 被拒收的**确实是** GBK 那份表（不是别的坏东西）。

**命令与进程事实**（同一份 txt）：

```
"C:\cante\gui\src-tauri\target\release\cante-sheets.exe" write "…\gbk-result.xlsx" "…\gbk-input.csv"
--- 退出码：2 ---
--- 结果文件是否落盘：不在 ---
--- stdout（0 字节，逐字） ---
--- stderr（417 字节，逐字） ---
```

**她看到的那段，逐字**（stderr 全文，一个字没改）：

```
这份表打不开：C:\Users\<用户名>\AppData\Local\Temp\cante-r16-cli\gbk-input.csv。它存的方式和平时的不一样（微信导出来的、旧一点儿的 Excel 存的表常常这样），也可能是文件坏了。请用 Excel 或 WPS 打开这份表，点「另存为」选 Excel 文件（.xlsx），再把新文件交给我；要是连它也打不开，那就是文件坏了，请让对方重新发一份。
```

**逐条判据**（机检直接读上面那段**原始字节**，不看源码）：

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 退出 2 | ✓ | `--- 退出码：2 ---` |
| 逐字全中文 | ✓ | 合法 UTF-8 ✓、无 U+FFFD ✓、无 `?` ✓；路径之外只剩 `["Excel","WPS","xlsx"]` ✓ |
| 含「另存为」那一步 | ✓ | 原文里「点「另存为」选 Excel 文件（.xlsx）」 |
| **不含** `stream` | ✓ | 不含 `stream`/`valid`/`utf-8`/`os error` ✓（这就是 #279 要灭掉的那句英文） |
| 没写出半成品 | ✓ | `结果文件是否落盘：不在`；stdout 0 字节 |

机检汇总：`→ 通过 9 / 9`（txt 末段）。

---

## 2. ② 缺 sheet XML 的坏 xlsx —— **通过（机检 9 / 9）**

**输入证据**（txt 第 31–37 行）：zip 里**只有四个条目**，`xl/worksheets/sheet1.xml` **不在**：

```
压缩包里 4 个条目：
  _rels/.rels
  [Content_Types].xml
  xl/workbook.xml
  xl/_rels/workbook.xml.rels
xl/worksheets/sheet1.xml 在不在：不在 ← 这就是它坏的地方
```
（`xl/workbook.xml` 里的表名就是「**数据**」，`workbook.xml.rels` 指向 `worksheets/sheet1.xml` —— 和 #282 单测里造的是同一种坏文件。）

**命令与进程事实**：

```
"C:\cante\gui\src-tauri\target\release\cante-sheets.exe" read "…\broken-missing-sheet.xlsx"
--- 退出码：2 ---
--- stdout（0 字节，逐字） ---
--- stderr（365 字节，逐字） ---
```

**stderr 逐字（三行，一行不多）**：

```
这个文件像是坏了，读不开：C:\Users\<用户名>\AppData\Local\Temp\cante-r16-cli\broken-missing-sheet.xlsx（读「数据」这张表的时候出了点问题）
—— 以下是给技术同事看的原文 ——
C:\Users\<用户名>\AppData\Local\Temp\cante-r16-cli\broken-missing-sheet.xlsx（读「数据」这张表）：Xlsx error: Worksheet '数据' not found
```

**逐条判据**：

| 判据 | 结果 | 证据 |
| --- | --- | --- |
| 退出 2 | ✓ | `--- 退出码：2 ---` |
| 「出了点问题」那句**无英文** | ✓ | 分隔行**之前**那段 `一个英文单词都没有` ✓（机检把路径剔掉后扫的拉丁字母） |
| 出现分隔行「—— 以下是给技术同事看的原文 ——」 | ✓ | 第 2 行，且**只出现一次** ✓ |
| 分隔行**之后**有原文 | ✓ | 第 3 行非空，且含 `Xlsx error` / `Worksheet` / `not found` ✓ |
| stdout 干净 | ✓ | 0 字节（原文只走 stderr，不混进数据里）✓ |

机检汇总：`→ 通过 9 / 9`（txt 末段）。她看的那句与给技术同事的那段，机检也照原文打出来了。

---

## 3. 没做的 / 不确定（和上面分开写）

1. **没验装机版**（`AppData\Local\Cante\`）跑这两个输入 —— 本轮只要求「时间戳/版本各列一行」✓。
   所以「装机版里这两处缺口还在不在」**本轮没有实测证据**，只有时间戳推断（§0）。
2. **#282 的界面那一半没验** ✗：我验的是**命令行壳**的 stderr 分了段；
   「应用端只把标记之前那段端给她」（`commands.rs` 的 `split_sheet_stderr`）这一步
   要**真窗口**才看得到，SSH 会话里没有桌面 → 要 RDP（AGENTS §6）。
3. 没验 GBK 的 **xlsx**、UTF-16 的 CSV、WPS 自己的格式（#279 那句中文是共用的，但没实测）。
4. 没跑 `cargo test` / `e2e.sh`（CI 的活，AGENTS §3.5）；没重新编译。
5. `r16-cli.txt` 里家目录已收敛成 `<用户名>`，**其余逐字原样**；原始件在 `%TEMP%\cante-r16-cli\`。
6. 上一轮我多做的 PR **#287**（把 ① 固化成脚本 + 验证地图补一行）还开着 —— 要关一句话的事。
