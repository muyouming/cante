# 夹具覆盖面笔记（ResultCard 与 QUOTA 两条）

这份文件只记两件事，供评审和下一轮参考。事实来源都在代码里，行号是写这份笔记时的。

---

## 1. 夹具现在能"做出一个真文件"（`FAKE_CANTE_MAKE_FILE=1`）

**背景**（`gui/WINDOWS-ACCEPTANCE-7.md` §4 已核过的结构性事实）：`fake-cante` 只演协议
事件、不写盘；应用的结果文件来自运行前后的**文件夹快照 diff**（`files.rs` 的
`begin_run` / `snapshot_paths` → `run.ts` 的 `diffSnapshots` / `buildResult`），
所以 diff 恒空 → 跑完一轮的 `ResultCard`（带它全部按钮）在自动化和夹具模式里一直够不到。

**解法**：`fake-cante.ts` 新增环境变量 `FAKE_CANTE_MAKE_FILE=1`。打开时，一轮正常
`UserInput` 会在**这一轮被交代的第一个文件所在的那层文件夹**里真写一个结果文件，
然后照原脚本把这一轮走完；进程退出前把自己造的文件删掉（`Shutdown` 和 `process.on("exit")` 两处）。

- 位置：`【要处理的文件】` 一节里第 1 条路径的 `dirname`（应用快照的就是这层文件夹；
  写到别处 ResultCard 看不到）。自由说一句话、没有选文件的轮次退回系统临时目录。
- 名字：`结果_上个月开销汇总.csv`；同一进程的第 2 轮起加 `-2`、`-3` 后缀，保证新文件是
  **新建**（第一轮的文件在进程活着时还在，重名会被 diff 当成"没变"）。
- 内容：带 UTF-8 BOM 的中文表格（表头 + 3 行：日期 / 事项 / 金额），很小。
- 覆盖登记：`src/fixture-parity.test.ts` 的 `FAKE_CANTE_MAKE_FILE 真的造出一个结果文件，
  并在退出前删掉` 会真的起进程、真的落盘、真的核删除。夹具不写这个文件，这条就红。
- 它**仍然证明不了**：那些字节不是模型产出的、也不是一张真工作簿（应用读表格那一步仍
  会如实说读不出来）；Rust 的快照 / diff 代码没被这里跑到。所以 `CONTRACT.md` 的
  `real-filesystem` 一行照旧留在"只能在真机上验"。

## 2. dom-smoke 这一屏**没进**（超过 10 行，按任务要求停手）

`dom-smoke.sh` 驱动的是 Chrome 里的前端，没有 Tauri 桥，也就跑不到 `fake-cante`。
要让 ResultCard 出现在这一屏，得让现有 `bridge.js` 替身（1）在 `snapshot_paths` 里返回一条
新文件，（2）把 `events_since` / 事件监听真的推成一次 `TurnEnd`，再（3）新写一个会点
「开始 → 停下来」的探针，并在 `serve.py` 里多接一路注入。任何一条都不止 10 行，所以按
任务的硬约束**没有动** `dom-smoke.sh`。**建议下一轮**单独做：先给 `bridge.js` 加一条
只读的"结果文件事实"（`snapshot_paths` 返回一条 `entries`），再补一个只点「停下来」的
探针（`cancelled` 也会进 ResultCard），断言逐字出现「打开文件」「打开所在文件夹」
「复制 结果_….csv 的位置」。

## 3. `FAKE_CANTE_TURN_QUOTA=1` 在真界面上的路径（顺手核，不改码）

结论：它走的是 **`store` 的 reducer → `finishRun("failed")` → `TaskRunner` 的
`step()==="error"` → `ErrorView`**，界面上给的是「服务方忙 / 用完了」那两句话，不是
让她重选文件。逐段：

| 段 | 位置 | 事实 |
| --- | --- | --- |
| 事件进来 | `src/store.ts:846` `case "TurnEnd"` | `readTurnEnd(payload.status)`，status 是 `{ Error: { kind, headline, details } }` |
| 关这一轮 | `src/store.ts:864` | `finishRun("failed", turnFailureText(reason))` |
| 失败原文 | `src/store.ts:1190` `turnFailureText` | `headline` + `details` 拼起来 → 里面就有 `503` 与 `insufficient credits` |
| 记进 error | `src/store.ts:1207` `runError` | `what/how` 是给她的两句中文；原文另存进 `cause`（只用于判断，不上屏） |
| 选屏 | `src/simple/TaskRunner.tsx:191` | `case "failed": return "error"` |
| 出错页 | `src/simple/TaskRunner.tsx:862` | 渲染 `<ErrorView error={run().error} …>` |
| 认原文 | `src/simple/ErrorView.tsx:94` | `causeOf(props.error)` → `actionsFor({...human(), cause})` |
| 分流 | `src/simple/recovery.ts:321` | `SERVICE_BUSY.test(text)`（`recovery.ts:181` 认得 `insufficient credits` 与 `503`） |
| 给的两步 | `src/simple/copy-service.ts:34,38` | 主路「过一会儿再试」；一直这样再「复制详情给管网络的同事」 |

也就是说：夹具吐的那条**真原文**必须原样保留，否则这条分流会掉到 `NETWORK` 或默认分支，
界面上就会变成"先看看网络 / 重新选一次文件"——那是错的出路。`store.test.ts` 已经在
端到端断言这条原文经产品这条路分到 `SERVICE_BUSY`。
