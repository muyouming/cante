# 真机任务普查

把 `gui/src/simple/tasks/` 里**真实的**提示词发给真实助手跑一遍，看看每张卡到底会
发生什么，并把结论写成 `report.md`。做这件事的原因很直接：20 多张卡里只有「合并
表格」被真机验过，其余的计划、风险提示、产出格式，此前全靠人读。

## 怎么跑

```sh
# 模型端点（缺一个就只输出「本次没真跑」的说明，不会假装通过）
export OPENAI_COMPATIBLE_BASE_URL=…
export OPENAI_COMPATIBLE_API_KEY=…

bash gui/scripts/task-sweep.sh                       # 全部卡
bash gui/scripts/task-sweep.sh excel.merge excel.tidy  # 只跑指定卡
bash gui/scripts/task-sweep.sh pdf                   # 整类：所有 pdf.* 卡
bash gui/scripts/task-sweep.sh --list                # 看有哪些卡（含场景）
bash gui/scripts/task-sweep.sh --timeout 900 pdf.split  # 单卡上限（默认 1800 秒）
SWEEP_TIMEOUT=900 bash gui/scripts/task-sweep.sh pdf.split  # 同上，环境变量写法
bash gui/scripts/task-sweep.sh --work /tmp/cante-sweep excel.diff  # 工作目录换到别处
bash gui/scripts/task-sweep.sh --zip                 # 跑完打一个 zip，方便整包拷回来
```

Windows 上没有 bash，用同一个脚本的 PowerShell 入口（参数与退出码原样转发）：

```powershell
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 --zip
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 --list
powershell -ExecutionPolicy Bypass -File gui\scripts\task-sweep.ps1 excel.diff
```

结果写在 `gui/scripts/sweep/report.md`；中间产物（脏输入、每张卡的副本与产出）
在 `gui/scripts/sweep/work/`，已 gitignore。`work/results.json` 是按卡累加的，
分几次跑（先表格、再 PDF）最后也会拼成一份完整报告。报告开头一节的「这次是怎么
跑的」会写明实际用的工作目录、报告路径、结果包路径与两个超时旋钮——用 `--work`
指到别处时，以报告里写的为准。

## 它到底做了什么

1. **生成脏输入**：`gui/fixtures/sweep/generate.py` 现场造 .xlsx / .docx / .pdf /
   一堆文件，故意的脏——重复行、空单元格、两行表头、列名只差一点点、混排日期、
   隐藏行、合并单元格、带前导 0 的编号、中文文件名、跨月份、重名文件、密码 PDF、
   没有文字层的扫描 PDF。二进制不进仓库，脚本才是可 diff 的源。
2. **用产品自己的函数拼提示词**：`sweep/prompts.ts` 调 `taskById(id).prompt(...)`，
   并用真机同款的 `sheetPromptLine` / `pdfPromptLine` 写能力说明。普查脚本里没有
   第二份提示词——卡片一改，这里立刻跟着改。
3. **驱动真实守护进程**：每张卡一个独立目录，输入是 fixture 的副本；HOME 指向
   隔离目录。审批一律自动同意（只用正确的 `tool_use_id` 字段）；助手中途停下来
   问用户，则记为「停下问问题」，不追问、也不算失败。
4. **读回产出核对**：表格用 `cante-sheets`、PDF 用 `cante-pdf` 读回来；原件被改
   内容或被删，直接判失败。单卡有超时上限，不会挂死。
5. **写报告**：`report.md` 一张卡一行结论（通过 / 停下问问题 / 失败），失败的给出
   可操作证据；`notes.md`（若存在）里的结论会被原样附在证据后面。

## 夹具：缺依赖就**大声失败**（不静默降级）

夹具生成器（`gui/fixtures/sweep/generate.py`）要两个第三方依赖，**缺一个就非零退出**，
不会生成一份“看起来一样”的假夹具：

| 依赖 | 用来生成 | 装它 |
| --- | --- | --- |
| `pypdf` | 加密 PDF（`pdf.merge` 的「加密材料」场景） | `python3 -m pip install pypdf` |
| `Pillow` | 表格照片（`vision.table` 的截图输入） | `python3 -m pip install pillow` |

为什么这么严：以前 `encrypt_pdf()` 在没装 pypdf 时只是 `return False`，那份「加密材料.pdf」
就**根本没加密**——同一个场景在不同机器上不是同一份夹具，看起来却像“产品变好了”
（`gui/SWEEP-0.2.1.md` 就记了这个假象）。现在会让整轮停下并把缺什么写清楚；
报告里也有一节列出**每份夹具是完整还是缺依赖**，以及实际用了哪几个依赖。

只想查依赖不想生成：`python3 gui/fixtures/sweep/generate.py --check-deps`。

## 依赖与降级

* `python3`（**3.10+**）与 `bun` 必须有：提示词一律由 `prompts.ts` 调产品自己的
  任务卡生成，脚本里没有第二份提示词。
* `cante-sheets` / `cante-pdf` 按产品的解析顺序找：环境变量（`CANTE_SHEETS_BIN` /
  `CANTE_PDF_BIN`）→ 安装目录 / 主程序旁边 → `~/.cante/bin`、`~/.ante/bin` →
  本 worktree 的 `target/{debug,release}` → PATH。Windows 上它们是 `.exe`，
  `shutil.which` 会自动补后缀，调用一律用列表参数（安装目录带空格也不会断）。
  `task-sweep.sh` 找不到还会试着自己 `cargo build`；`task-sweep.ps1` 不做这件事
  （Windows 服务器不该要求 Rust 工具链）。再找不到就退回脚本内置的读取方式，
  并在报告里说明——不会假装核对过。真守护进程 `ante` / `cante` 找不到时，报错会
  直接写出该设哪个环境变量、以及已经找过哪些目录。
* 模型端点只从 `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY` 读，
  不写进任何文件。环境变量里像密钥的值在写报告与打包时都会被擦掉（见下）。
* 仓库只读时用 `--work` 指到别处（Windows 上例如 `--work $env:TEMP\cante-sweep`）；
  `--report` 写不进去也会自动落到工作目录，并在报告里写明实际路径。

## 打包拿结果（`--zip`）

`--zip` 把三样东西打成一个包：`report.md`、整个 `work/`（每张卡的输入副本、产出、
`sweep-events.jsonl` 事件日志）、以及应用日志（Windows `%USERPROFILE%\.ante\logs`、
macOS/Linux `~/.ante/logs`，默认只带最近 7 天，`--zip-log-days` 可改）。
默认落在 `gui/scripts/sweep/cante-sweep-<时间>.zip`（不可写时落到工作目录），
控制台会打印完整路径——拷这一个文件回来就够。

密钥与隐私：环境变量里像密钥的值（`*_API_KEY` / `*TOKEN*` / `*SECRET*` …）会从
所有文本文件里擦成 `<已隐藏的密钥>`，命中的二进制文件整个不打包；文本文件里的
用户真实家目录也换成 `<用户>` / `~`；`settings.json` / `catalog.json` / `*.env` /
`*.pem` / `*.key` 从不进包。包内 `ZIP-说明.txt` 会列出洗过与没打包的文件。

## 时间：慢不等于坏（实测数据）

正常一张卡**只要 30–60 秒**。用真实事件日志拆开看，时间几乎全花在模型上：

| 真机运行 | 总时长 | 模型往返 | 工具执行合计 | 模型输出 |
| --- | --- | --- | --- | --- |
| 按人合并 | 48.8s | 8 次 | **3.4s** | 7,299 tokens |
| 找出变化 | 54.6s | 7 次 | **3.8s** | 6,708 tokens |
| 到期提醒 | 56.7s | 8 次 | **14.8s** | 7,645 tokens |
| 发票台账 | 59.6s | 8 次 | **2.8s** | 7,249 tokens |

工具只占 6–25%；剩下是模型在推理型生成（每步动手前先想一遍），7–8 次往返 ×
每步约 5 秒。**所以要调的不是"给工具更多时间"，而是模型与步数。**

因此这里有两个**互相独立**的旋钮（两个脚本、两条路都认）：

- `--timeout`（默认 1800 秒，`SWEEP_TIMEOUT`）：**安全上限**——防止单卡无限跑下去。
  它不是预期耗时；实测最慢的一次（Gemma-4，零工具调用）846 秒，所以上限必须比它大，
  否则会把"慢但在推进"误判成失败（真机上这么误判过一次）。
- `--stall-timeout`（默认 300 秒，`SWEEP_STALL_TIMEOUT`）：**卡住判据**——这么久
  **一个事件都没有**才算卡住。模型在流式输出（每秒好几条 ThinkingDelta），所以零事件
  才是真出事（死循环、网关断线不恢复）。默认 300 秒是为了留够网关"重连 60 秒 × 4 次"
  的自救时间（每次重连都会发一条事件、会重置这个计时）。

报告里"卡住"与"超时到顶"是**两类不同结论**，不要混着看。

**另外：别贪并发。** 同时跑太多模型会被网关断连（事件里是
`Connection interrupted, reconnecting in 60s…`），每一次重连就多等 60 秒——这也是"慢"
的一个常见来源，而且它容易伪装成模型慢。
