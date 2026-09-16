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
bash gui/scripts/task-sweep.sh --list                # 看有哪些卡（含场景）
TIMEOUT=900 bash gui/scripts/task-sweep.sh pdf.split  # 单卡上限，默认 600 秒
```

结果写在 `gui/scripts/sweep/report.md`；中间产物（脏输入、每张卡的副本与产出）
在 `gui/scripts/sweep/work/`，已 gitignore。`work/results.json` 是按卡累加的，
分几次跑（先表格、再 PDF）最后也会拼成一份完整报告。

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

## 依赖与降级

* `python3`、`bun` 必须有。
* `cante-sheets` / `cante-pdf` 按产品的解析顺序找：环境变量 → 本 worktree 的
  `target/{debug,release}` → `~/.cante/bin` → PATH；找不到会试着自己 `cargo build`。
  再找不到就退回脚本内置的读取方式，并在报告里说明——不会假装核对过。
* 模型端点只从 `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY` 读，
  不写进任何文件。

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

因此这里有两个**互相独立**的旋钮：

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
