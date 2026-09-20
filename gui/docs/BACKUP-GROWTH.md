# 备份会不会把她的磁盘吃满：核清事实、定策略、留一个她看得懂的口子

问题来自 `gui/OPPORTUNITIES-9.md` 的 P1：每次运行都在应用私有目录里留一份原件备份，
**跨次没有任何清理**，运行记录只留最近 200 条却**不删目录**。于是「第 201 次之后每次
运行都留下一个再也没人引用、也永远不会被删的目录」。

这篇只写**核出来的事实**（每条给依据，含真跑的输出），不写我们希望它怎么做。核不出来
的，单列一节写「没核出来 + 为什么」。策略部分说清选了哪一条、为什么、以及它怎么同时
守住「她随时能撤销」和「不该无限占她的空间」。

相关：撤销的边界见 `gui/docs/UNDO-BOUNDS.md`（那份记的是「撤销今天怎么做的」，本篇
记的是「备份占的空间怎么长大、怎么收」）。

---

## A. 先核：今天到底会不会真的积累

### A1. 记录被挤掉之后，它的 `runs/<编号>/` 目录还在不在？——**在** ✓（真跑证据）

**不是读代码看出来的，是跑出来的。** 新增两个 Rust 测试（`gui/src-tauri/tests/files.rs`）：

* `truncation_drops_the_record_but_leaves_its_backup_directory_behind`：用真正落盘的
  `write_runs` 走一遍 `upsert_run` 内部那一行 `runs.truncate(MAX_RUNS)`。被挤掉的
  `run-000` 从 `runs.json` 里消失了，**可它指的 `runs/run-000/before/000000` 还在磁盘上**
  ——没人引用、也没人去删。
* `upsert_run_cleans_the_directory_of_a_record_that_fell_off_the_cap`：端到端做满
  200 条记录 + 200 个目录，再存第 201 条；最旧那条记录被挤掉，它的目录必须被清掉
  （这条同时是 D 组断言的证据之一）。

真跑输出（`cd gui/src-tauri && cargo test --test files`）：

```
running 25 tests
test truncation_drops_the_record_but_leaves_its_backup_directory_behind ... ok
test upsert_run_cleans_the_directory_of_a_record_that_fell_off_the_cap ... ok
...
test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

**结论**：P1 描述的那条积累路径**成立** ✓。记录与目录的寿命是解耦的，越过 `MAX_RUNS`
（`files.rs` 的 `MAX_RUNS = 200`）之后，目录就是我这次要收的「孤儿」。

### A2. `unbacked` 的文件会不会建目录？——**会** ✓（读代码）

`backup_files`（`gui/src-tauri/src/files.rs:295`）第一件事就是
`fs::create_dir_all(backup_dir)`（`:302`），**无条件**执行，跟有没有文件被跳过无关。
超限的文件只是被 push 进 `unbacked`（`:311`）、不进备份映射，但 `before/` 目录照样建好。
`begin_run`（`:631`）还会往 `run_dir` 写一份 `before.json`。

**结论**：哪怕一次运行里**一个文件都没备份成**（全都是 `unbacked`），这次运行**照样**
在 `runs/<编号>/` 底下留下 `before/` 空目录 + `before.json` ✓。所以孤儿目录的**数量**
跟运行次数一一对应，不跟「真的备份了几个文件」挂钩。

### A3. 重装 / 升级 / 重启会不会清？——**都不会** ✓（读代码）

* **重启**：`store_root`（`files.rs:611`）落在 `app_config_dir()/file-safety`，重启后
  目录还在；运行记录也是启动时从磁盘重读（`store.ts` 的 `refreshRuns`）。**不清** ✓。
* **升级**：`file-safety` 是应用配置目录，升级包不碰它。`tauri.conf.json` 里没有
  `deleteAppDataOnUninstall` 之类的声明（已核），NSIS 的 `installMode` 是 `currentUser`
  ——升级是就地覆盖，**不清** ✓。
* **卸载**：全文件 `remove_dir_all` 出现过的地方，全都是**测试夹具**或**某个临时工作
  目录**（`pdf.rs:497`、`sheets.rs:545`、`commands.rs:552`、`admin_config.rs:161`、
  `program.rs:366` 的 `struct ...(TempDir)` Drop，以及 `bridge.rs` 的两处测试），
  **没有一处**碰 `file-safety`。也就是说：**连卸载都不会清** ✓（`file-safety` 会作为
  残留留在她的用户目录里）。
* **有没有启动时清扫**：`grep` 全 `gui/src-tauri/src/`，除我这次新加的
  `cleanup_orphan_runs` 外，`cleanup`/`prune`/`remove_dir` 一个都没有。**没有** ✗。

**这条 A3 我按任务要求「读代码」核**：我没有真的卸载再重装一遍（那要真机 + 打包，
见末尾「没做的事」）。所以这里写的是**代码事实**，不是**真机事实** —— 两者要分开。

### A4. 本机现在实际占多少？——**4.0K / 0 个 run 目录** ✓

本机 `~/Library/Application Support/dev.cante.gui/file-safety`（不用真路径写法，见
secret-scan）」的原始输出：

```console
$ du -sh "$HOME/Library/Application Support/dev.cante.gui"
8.0K	/Users/<用户名>/Library/Application Support/dev.cante.gui
$ du -sh "$HOME/Library/Application Support/dev.cante.gui/file-safety"
4.0K	/Users/<用户名>/Library/Application Support/dev.cante.gui/file-safety
$ find "$HOME/Library/Application Support/dev.cante.gui/file-safety/runs" -mindepth 1 | wc -l
       0
$ python3 -c "import json;print(len(json.load(...runs.json)))"
1
```

**结论**：本机是**干净机器** —— `file-safety` 总共 4KB、`runs/` 底下 **0 个目录**，
`runs.json` 里 1 条记录。这跟 P1 说的「不是已经出事，是随着她用会慢慢积累」一致 ✓。

### A5. 外推：10 次/周 × 平均 5MB，一年会长到哪？

**这是估算，不是实测**（假设写在这里，方便被推翻）：

| 假设 | 值 | 来源 |
| --- | --- | --- |
| 每份备份平均大小 | 5 MB | **假设**（取她常见的一组 Excel/Word 估算，非实测） |
| 每周运行次数 | 10 | **假设**（她的月度重复活 + 零散事） |
| 单次硬上限 | 256 MB（≤2000 文件、单文件 ≤32MB） | `files.rs:78-80` |

* **不清理**：10 × 5MB = 50MB/周 ≈ **2.6GB/年**，逐年线性增长，**没有上界** ✗。
* **清理到 200 份**：稳态 ≈ 200 × 5MB = **1GB**，之后不再长 ✓（我的策略就是这条）。
* **理论上界**（每次都用满 256MB，且不清理）：仍没有上界；清理到 200 份后理论上界是
  200 × 256MB = **51.2GB** —— 这才是「能把 C 盘吃满」的量级，也是为什么哪怕平均下来
  只有 GB 级，也值得收。

按 10 次/周算，200 条记录 ≈ 20 周 ≈ **4.6 个月**的留档。

---

## B. 保留策略：怎么同时守住「她随时能撤销」和「别无限占空间」

两件互相拉扯的事，先摆清：

* ① **她随时能撤销**：撤销要**两份**东西一起才成立 —— `runs/<编号>/before/`（备份）和
  运行记录里的 `created/modified/deleted`（见 `UNDO-BOUNDS.md` §2.1）。**缺一不可。**
* ② **不该无限占她的空间**：上面 A5 算过，不清就是 2.6GB/年、没有上界。

### 候选策略与代价

| 策略 | 怎么做 | 代价 / 风险 |
| --- | --- | --- |
| 按**时间**（保留 30 天） | 删掉 30 天前的 `runs/<编号>/` | 违背 ①：30 天前那次如果记录还在，她**本来能撤**，却被我们删了备份 → 撤销开始失败 ✗ |
| 按**总量**（超过 N GB 删最旧） | 到顶就删最旧，直到降下来 | 同样违背 ①（可能删掉还有记录的备份）；且「N GB」对她/我们都没有清晰含义 |
| 按**份数**（只留最近 N 次） | 独立于记录数，多留也删 | 与「记录只留 200 条」**不同步**：可能出现「备份留着、记录没了」——正是 A1 那条死重 ✗ |
| **只清孤儿**（所选） | 只删**没有任何运行记录指向**的 `runs/<编号>/` | 不碰任何能撤销的一次；把「记录没了」的那份死重收掉 ✓ |

### 选：**只清孤儿**

**为什么**：`UNDO-BOUNDS.md` §3 已经立过一个事实 —— **记录一旦不在，撤销就什么也做不了**
（`undo_run` 读不到 `created/modified/deleted`，回 `{restored:[], failed:[]}`，界面会用
`UNDO_NOTHING_WHAT` 如实说「没有留下记录」）。也就是说，一个「没有记录指向」的备份目录
**本来就已经撤不回来了**，它是**纯死重**。删掉它：

* **不损害 ①**：凡是**记录还在**的那几次，目录**一个都不动**（这是 D 组最要紧的回归断言）✓；
* **收掉 ②**：孤儿随每次 `save_run` 被扫掉，目录数量被 `MAX_RUNS` 同步夹住 ✓；
* **对齐两件事的寿命**：记录能留多久，备份就留多久 —— 不再出现「备份留着、记录没了」。

**她 3 个月前的那件事，还能撤吗？** —— **看记录在不在，而记录就是那条 200 的上限。**

* 按 10 次/周，3 个月 ≈ 13 周 ≈ 130 次运行 < 200 → **记录还在 → 仍可撤销** ✓。
* 但她要是跑得更勤（比如每周 >15 次），3 个月就能超过 200 条 → 那次记录已被挤掉 →
  **撤不回来**（届时界面如实说「没有留下记录」，不再谎称成功）✗。

**这条边界必须写清**：撤销**不是**「无限期」的，它受「最近 200 次」夹着 —— `UNDO-BOUNDS.md`
已经写了这一条，本篇只是补上「为什么 200 是对的、以及备份跟它同步」。选**只清孤儿**，
不会让这条边界变差（它本来就在），只会**不再额外**留下没人认领的目录。

### 留一个「她看得懂」的口子（二选一）——选**清理时留下她能看到的一句**

任务要求二选一。**我选「清理时的一句话」，不选「动手前说这次占多少」**，理由是能不能落地：

* 「动手前说占多少」要么改 `format-check.ts` 的 `pickStepLine`——而它被
  `format-check.test.ts` **逐字钉住**（`pickStepLine({kind:"ok"}, …) === null`，非 ok
  分支等值断言），改它会动一个**不在允许清单**里的测试；要么加一条新的预检文案，
  但两个消费端（`TaskRunner.tsx`、`ConfirmSheet.tsx`）都**冻结**、进不去。**落不了地。**
* 「清理时的一句话」能落在**已有的出口**上：`copy-notice.ts` 的
  `NOTICE.undoNothingHow` 本就是她**最可能撞上清理**的那一屏（撤销时发现记录没了）
  里说的 `how`。原来那句话写的是「备份**可能还在**这台电脑的私有目录里……让他看看
  有没有备份」——**清理一上线，这句话就变成了骗她去找一个已经被清掉的东西**（正是
  #256 修的那类「说了不做」）。所以我把它改成与做法一致的实话。

改后的那一句（`gui/src/simple/copy-notice.ts`）：

> 你可以打开「我做的结果」，看一眼这次做出来的文件还在不在、是不是你要的。
> 这台电脑只留最近这些次的备份，更早的会清掉、腾出地方。想变回动手前的样子，
> 可以请懂电脑的同事来帮忙。

**它说清了**：备份只留最近这些次、更早的会清掉（她看得懂「会清掉、腾出地方」）；
**没有**再让她去找已经不存在的东西。

**绝不悄悄删**：清理掉的**只是她没记录、已经撤不回来的死重**；她**能撤销的每一次，
一个文件都不动**。这句话就是那条「她能看到的一句」。

**诚实标注这道口子的边界**（不夸大）：这一句**不是**在清理**发生的那一刻**弹出来的，
而是她**下次真的去找那份旧备份**（点撤销、结果发现记录没了）时，读到的那一句。

为什么做不到「清理那一刻弹一句」：**允许改的文件里没有任何一个渲染口子能显示一条
新句子**——`store.notice()` 的三个渲染端（`ResultCard.tsx` / `TaskRunner.tsx` /
`ErrorView.tsx`）都**冻结**，各自只认自己那一类（`UNDO_KINDS` / `PICK_KINDS` /
`ERROR_KINDS`），新加一类没人显示；清理发生在 Rust 的 `save_run` 里，它也没法去写
`store.notice()`（那是前端、且冻结）。所以我把「她能看到的那一句」放在了**她唯一会
因为清理而受影响的那一屏**上，并让它说的实话和实际做法一致。

要真正做到「清理那一刻说一句」，需要动 `store.ts` 或某个渲染组件 —— 那**不在**本次
任务允许改的文件清单里，**我没做**。

---

## C / D. 实现了什么、断言在哪

**改动**（详见提交信息）：

* `gui/src-tauri/src/files.rs`：新增纯函数 `cleanup_orphan_runs(root, keep)`；**唯一**
  调用点在 `upsert_run` 里（记录落盘之后调用一次）。没有改 `begin_run` / `undo_files`
  的语义。
* `gui/src-tauri/tests/files.rs`：A1 的真跑测试 + D 组的四条断言。
* `gui/src/simple/copy-notice.ts`：清理时那一句（上面 B 的「口子」）。
* 本文件。

**四条断言（都在 `cargo test --test files` 里，真跑）**：

| 断言 | 测试 |
| --- | --- |
| 孤儿目录会被清掉 | `cleanup_removes_only_directories_no_run_record_points_to`、`upsert_run_cleans_the_directory_of_a_record_that_fell_off_the_cap` |
| **有记录指向的目录，一个都不动**（最要紧的回归） | `cleanup_never_touches_a_directory_a_record_still_points_to` |
| 正在做备份的那次绝不清理 | `cleanup_keeps_the_run_whose_backup_is_still_being_written` |
| 只删我们的备份、绝不碰原件 | `cleanup_deletes_only_our_backup_directories_and_never_an_original` |

外加 `cleanup_is_a_noop_without_a_runs_directory`（没有 `runs/` 时什么都不做、也不
凭空建目录）。

「动手前的那句空间提示」**没做**（原因见 B）—— 所以「它出现在动手前」这条断言**不适用**。

---

## 没做的事 / 没验的地方（如实写）

* **没在真机上验**（Windows 或 macOS 打包产物）。本篇和这次改动全都是**本机**的
  `cargo test` + `bun test` 结果；「真机上装、跑、升级、卸载后目录怎样」**没验** ✗。
  Rust 行为改动一律标「未真机验」。
* **A3 是代码事实，不是真机事实**：我没真的卸载再重装一遍（要真机 + 打包）。写的是
  「代码里没有任何一处会清 `file-safety`」，不是「我卸载过、看它没清」。
* **A5 是估算**：5MB/次、10 次/周都是**假设**，列在表里。我没有她真实的运行统计。
* **「她看不看得懂那句话」没验**：`copy-notice.ts` 那句要真人能懂才算数。本机能证的
  只有几道闸门（黑名单词 / 字号 / 可读性 / 语气）没被这句话弄红 —— **不等于**她看懂了。
* **P2（`runs.json.tmp` 固定临时名）不在本次范围**：那要另外一种核对（并发发生率），
  也不是这次允许改的文件。留原样。
