# 第 15 批 · Windows 侧机械核查之二：CSV / 中文 / 长路径 的真机行为

- 机器：真 Windows（主机 `<验收机>`，MINGW64_NT-10.0-26200）
- 系统：Windows 10.0.26200.9457，PowerShell 5.1.26100.9444
- 系统代码页：ACP = OEM = **936（gb2312）**，区域 zh-CN
- 文件系统长路径开关：**LongPathsEnabled = 1**
- 工具：`C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe`（版本 **0.2.3**，5 345 792 字节）
- 原始输出：同目录 `r15-csv.txt`（含每条命令的完整 stdout / stderr / 退出码）
- 本报告用 `<用户名>` 代替真实家目录。

**没有改任何产品代码、没有提交任何东西、没有跑真实任务（没打模型）。**

---

## 一个必须先说的结论（改变了本轮的做法）

任务书写的是"让工具**读**一个 CSV"。真机核下来：**`cante-sheets read` / `sheets` 根本不接受 `.csv`**，
只接受 `xls / xla / xlsx / xlsm / xlam / xlsb / ods`。CSV 在这个工具的契约里只有两个位置：

- **`write` 的输入**：把一份 CSV 变成一张 `.xlsx`；
- **`read` 的输出**：把 xlsx 打印成 CSV（stdout，不带 BOM）。

这跟产品真实路径一致：`gui/src/simple/capabilities.ts` 给助手的指令是
"写结果：**先把内容存成 CSV**，再运行 `cante-sheets write 结果.xlsx 数据.csv`"。
所以我这轮把"读 CSV"改成走**真实那条路**：CSV →（`write`）→ xlsx →（`read`）→ 中文回读，
这样才是在核"微信导出/别人发来的 CSV 到底会不会坏"。

来源证据：`gui/src-tauri/src/sheets.rs:29` `SUPPORTED_EXTENSIONS`；
`gui/src-tauri/src/bin/cante-sheets.rs`。

---

## 第 1 步：工具在不在、怎么探询用法

工具在（主程序旁边，和另外三个 exe 一起）。**没有 `--help`**：`--help` / `-h` / `version` 都报
"不认识的用法"并退出 2。**有 `--version`**。用法靠**无参数运行**或**任何错误**时打印到 stderr。

`cante-sheets.exe --version` → 退出 **0**，stdout：
```
cante-sheets 0.2.3
```

`cante-sheets.exe --help` → 退出 **2**，stdout 空，stderr（367 字节，UTF-8）：
```
不认识的用法：--help
用法：
  cante-sheets sheets <文件>
  cante-sheets read <文件> [--sheet <表名>]
  cante-sheets write <结果.xlsx> <数据.csv> [--sheet <表名>]

注意：write 只在 <结果.xlsx> 还不存在时新建它；已经有同名文件就报错退出（2），
不会覆盖。请换一个新文件名再试。
cante-sheets --version
```

命令行界面：
| 命令 | 作用 | 退出码 |
| --- | --- | --- |
| `--version` | 打印版本 | 0 |
| `sheets <文件>` | stdout 列出所有表名，每行一个 | 0 / 2 |
| `read <文件> [--sheet <表名>]` | 把一张表打印成 CSV（stdout，无 BOM） | 0 / 2 |
| `write <结果.xlsx> <数据.csv> [--sheet <表名>]` | 用 UTF-8 CSV 新建一张 xlsx | 0 / 2 |
| 无参数 / 未知参数 | 打印用法 | 2 |

约定：**成功 0，任何失败 2；错误只走 stderr，stdout 只放数据。**

---

## 六项逐条结果表

| # | 项 | 命令（`cante-sheets.exe …`） | 退出码 | stdout 摘要 | stderr 摘要 | 结论 |
| - | -- | --- | --- | --- | --- | --- |
| 1 | 工具可用性 / 探询参数 | `--version`；`--help`；无参数 | `0`；`2`；`2` | `cante-sheets 0.2.3`；空；空 | 空；用法；用法 | 工具可用；**无 `--help`**，用 `--version` 探版本、无参数探用法 |
| 2 | **中文路径 + 中文内容** | `write "C:\Users\<用户名>\Desktop\新建文件夹\汇总结果.xlsx" "…\销售数据.csv"` 再 `read` 同一个 xlsx | `0` / `0` | read 回读：`姓名,部门,销售额,月份` / `张三,销售部,12500.5,2026年9月` / … | 空 | **通过**。盘符/目录/文件名/列名/值全中文，写入与回读都正确、无乱码 |
| 3 | 带空格与括号的路径 | `write "…\Desktop\a b (1)\结果 表(1).xlsx" "…\Desktop\a b (1)\表 (草稿).csv"`；`read`；`sheets` | `0` / `0` / `0` | read 正确；sheets 输出 `Sheet1` | 空 | **通过**。空格、园括号、中文、`()` 混用都正常 |
| 4 | UTF-8 BOM / 无 BOM / GBK / UTF-16 | `write` 分别喂 UTF-8(带BOM)、UTF-8(无BOM)、GBK(936)、UTF-16LE 的同内容 CSV | `0` / `0` / **`2`** / **`2`** | 前两者回读中文正确 | GBK 与 UTF-16：`读不了这个文件：<路径>（stream did not contain valid UTF-8）` | **BOM 无 BOM 都通过**（BOM 被正确剥离，不污染表头）；**GBK/UTF-16 直接失败**，且报错**漏出英文技术话** |
| 5 | 长路径 > 260 字符 | `write`/`read` 一个 **333 字符**、含 5 层中文目录的路径 | `0` / `0` | read 正确回读中文 | 空 | **通过**（本机 `LongPathsEnabled=1`）。参见下方"没核到的"一条 |
| 6 | 边界与错误信息 | 覆盖保护 / 坏文件 / 表名不匹配 / 写不进去的目录 / 表名 31 vs 32 字 / 输出扩展名 | 见下 | — | 全中文（除 GBK 那条） | 覆盖保护与错误话术基本都是**给用户看得懂的中文**；发现 1 处英文泄漏、1 处输出扩展名不校验 |

---

## 各条明细（关键证据）

### 2. 中文路径
目录 `C:\Users\<用户名>\Desktop\新建文件夹\`，文件 `销售数据 2026年9月.csv`（带 BOM）。
内容含中文列名与中文值：

```
姓名,部门,销售额,月份
张三,销售部,12500.5,2026年9月
李四,财务部,9800,2026年9月
王五,行政部,15000.75,2026年10月
```

- `write` 到同目录 `汇总结果.xlsx` → 退出 **0**，stderr 空。
- `read 汇总结果.xlsx` → 退出 **0**，stdout 原样回来（上面四行，一字不差）。
- 回读的**第一个字节不是 BOM**（hexdump 起头 `e5a7 93` = "姓"），说明工具自己剥掉了输入 BOM，
  表头没变成 `﻿姓名`。

### 3. 空格与括号
`C:\Users\<用户名>\Desktop\a b (1)\`，输入 `表 (草稿).csv`，输出 `结果 表(1).xlsx`。
`write` / `read` / `sheets` 三次都退出 0；`sheets` 输出 `Sheet1`（因为 `write` 没给 `--sheet`）。
回读中文正确。

### 4. 编码（重点）
四种同内容 CSV，分别用 Bash `printf` 与 **PowerShell `Set-Content -Encoding`** 各造了一遍
（两种造法结论一致）：

| 编码 | 造法 | `write` 退出码 | 结果 |
| --- | --- | --- | --- |
| UTF-8 **带 BOM** | `Set-Content -Encoding UTF8`（PS5.1 默认带 BOM） | **0** | 回读中文正确 |
| UTF-8 **无 BOM** | Bash `printf` | **0** | 回读中文正确 |
| **GBK / 936** | `Set-Content -Encoding Default`（本机 Default=gb2312） | **2** | 不生成 xlsx；报错见下 |
| **UTF-16LE** | `Set-Content -Encoding Unicode` | **2** | 同上 |

GBK / UTF-16 的完整错误（stderr）：
```
读不了这个文件：<路径>（stream did not contain valid UTF-8）
```

`-Encoding UTF8`（PS 5.1）= 带 BOM 的 UTF-8，能过；`-Encoding Default` = 本机 GBK，过不了。
**这就是王姐最可能踩的一脚**：微信/旧 Excel 导出的 CSV 常常是 GBK，工具会拒收。
拒绝本身是**正确的**（不猜编码、不乱码入库），**但括号里的原因漏了英文**
（`stream did not contain valid UTF-8`）——违反"零术语、全中文"的产品律。
中文前半句"读不了这个文件"是好的，缺的是**告诉她怎么办**（例如"这份表是别的编码存的，
请用 Excel 打开后"另存为"再选 UTF-8"）。

### 5. 长路径
构造：`Desktop\长路径测试\<40字中文>\…×5`，**总长 333 字符（>260）**。
- 先确认系统开关：`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`。
- `write` 长路径下 `长路径结果.xlsx` → 退出 **0**；`read` 回读 → 退出 **0**，中文正确。

> 注意：这里"能过"是在 **LongPathsEnabled=1** 的机器上。开关若为 0，行为大概率不同
> —— 这条我**没核**（见下）。

### 6. 边界与错误信息
| 情形 | 命令 | 退出码 | stderr（完整中文） |
| --- | --- | --- | --- |
| 覆盖保护 | `write 汇总结果.xlsx 销售数据.csv`（输出已存在） | **2** | `这个文件已经在了，我不敢覆盖它：<路径>。换一个文件名再试，或者先把旧文件改名。` |
| 坏 xlsx | `read broken.xlsx`（内容 `not an xlsx`） | **2** | `这个文件像是坏了，读不开：<路径>` |
| 表名不匹配 | `read 汇总结果.xlsx --sheet 不存在的表` | **2** | `这个文件像是坏了，读不开：<路径>（里面没有叫「不存在的表」的表，现有表：销售）` |
| 写进不存在的目录 | `write <不存在的目录>\x.xlsx …` | **2** | `写不进去：<路径>（写不进去：系统找不到指定的路径。 (os error 3)）` |
| 表名恰 31 字 | `write … --sheet <31字>` | **0** | 空 |
| 表名恰 32 字 | `write … --sheet <32字>` | **2** | `这个表名用不了：「…」。表名不能是空的、不能超过 31 个字，也不能带 \ / ? * [ ] : 这些符号。换一个表名再试。` |
| 输出扩展名是 `.csv` | `write out.csv in.csv` | **0** | 空 |

两点值得记：

1. **覆盖保护有效**（`AlreadyExists`）：第二次写同名文件被拒、退出 2、**没有覆盖原文件**
   （文件 mtime 未变）。符合"结果永不覆盖原文件"的产品律。
2. **`write` 不校验输出扩展名**：`write out.csv in.csv` 退出 **0**，但落盘的是一个
   **真正的 xlsx**（magic `50 4B 03 04` = `PK`，`file` 认成 "Microsoft Excel 2007+"），
   只是名字叫 `.csv`。紧接着 `read out.csv` 又因扩展名不在白名单而退出 2
   （`这个格式我读不了`）。即：**工具会产出一个自己都读不回去的"假 .csv"**。
   产品指令里写死了"结果一律 .xlsx"，所以正常路径碰不到；但这是可被助手误用的一脚。
3. 表名 31/32 字边界与源码一致（`sheets.rs` 里 `BadSheetName` 的文案是"不能超过 31 个字"），
   真机验证通过。

### 附：CSV 引号往返（顺带核的）
输入字段含逗号与双引号：`张三,"销售部, 华东区",1200` 与 `李四,"他说""很好""",980`。
`write` → `read` 往返后**一字不差**（引号规则正确，含逗号/引号的格子没被拆错）。

---

## 没核到的（如实写）

- **长路径在 `LongPathsEnabled=0` 的机器上会怎样**：本机开关是 1，我没有去改这个系统开关
  （属于改机器全局状态，越界了），所以"关掉会怎样"**没核**。
- **read/sheets 对 `.et/.ett/.wps/.dps/.pages/.numbers` 的具体文案**：源码里有专门的
  `WpsFormat` 分支，但我没有造出这些文件，**没在真机上触发过**。
- **`.xls`（老 Excel）/ `.ods`**：白名单里有，但我只找到并用了 `.xlsx`，**没核**老格式回读。
- **只核了 `cante-sheets`**，没核 `cante-pdf` / `cante-bridge`（不属本轮范围）。
- **没有走 GUI**：这轮是直接调用 exe 的命令行壳；"界面上复制成微信能贴的文字"那条 UI 路径
  **没核**（SSH/非交互会话里看不到窗口，见 AGENTS.md §6）。

---

## 清理与现场

- **清掉了**（都是我造的，全在 `Desktop`）：`Desktop\新建文件夹\`、`Desktop\a b (1)\`、
  `Desktop\长路径测试\`（含 5 层中文子目录）。
- **没动** `Desktop` 上任何我没造过的东西（`Cante.lnk`、`Cante路径验收\`、`结果_工作总结*.docx` 等）。
- 工作目录 `C:\Users\<用户名>\r15\` 保留作证据（含各编码 fixtures、`psenc\`）；
  若不需要可整目录删掉，里面全是我造的。
- 仓库：`git status` 只有两个**本来就存在**的未跟踪文件（`TASK.md`、
  `gui/scripts/windows/accept-paths.ps1`，非本轮产生），**没有改任何产品文件**。

## 给产品的一句话

CSV 的中文往返**是好的**（BOM/无 BOM、中文目录、中文名、空格括号、长路径全过）；
唯一真问题在 **GBK/UTF-16 的报错漏英文**——拒收是对的，但请把括号里的
`stream did not contain valid UTF-8` 换成一句中文的"怎么办"。
