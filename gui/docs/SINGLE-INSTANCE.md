# 双击两次不该开出两个 Cante —— 两个实例**真的**会互相干扰吗

问题：她双击两次（或双击图标又点任务栏），开出**两个窗口**，各持自己的守护进程。
这篇先回答「**两个实例真的会互相干扰吗**」（A），再写「因此做了什么」（B），
最后写「哪些只能是真机验、哪些没核出来」（C）。每一行结论都给出**依据（文件:行）**；
核不出来的单独列一节，不写成「应该没问题」✓。

**结论先放前面：会，而且其中一条正落在产品律 2「别弄坏我的东西」上。**
两个实例共用同一份 `file-safety/` 存储，而所有写入都是「整份读 → 改 → 整份写」，
没有锁；运行记录会互相盖掉，撤销还会去动另一个窗口刚做出来的文件。**这不是理论风险**：
`gui/src-tauri/src/files.rs` 里没有一处文件锁（全仓 grep `flock`/`lock_file`/`O_EXCL`
在 `files.rs` 上零命中），`write_json` 只是「写临时文件再改名」，防的是写坏，**不防两个进程
的丢失更新**。所以这轮**改了**（加 `tauri-plugin-single-instance`），不是只交文档。

---

## A. 干扰点逐条核

| 干扰点 | 会不会真发生 | 依据（文件:行） |
| --- | --- | --- |
| **1. 两个进程同时写同一份 `runs.json`** | **会**。`upsert_run` 是「读整份 → 改 → 整份写」：`read_runs` 取全量、插入、`write_runs` 覆盖整个文件。A、B 各自读到 `[r1]` 后各写一次，**后写的把先写的记录整条盖掉**（丢失更新）。没有任何锁，`write_json` 的「临时文件 + rename」只保证单个文件不会写坏，**不保证两次读改写互斥**。**还多一层**：那个临时文件名是**固定**的 `runs.json.tmp`（不是每进程一份），两个进程会去 `create`/`rename` **同一个中间文件** —— 轻则互相 rename 掉、`copy` 回退到不存在的临时文件报错，重则把对方写到一半的内容 rename 成正式文件 | `files.rs:475-479`（`upsert_run` 读-改-写）、`:458`（`read_runs`）、`:465`（`write_runs`）、`:431-448`（`write_json`；`:436` 的 `with_extension("json.tmp")` 是**固定**临时名）、`:444-447`（rename 失败→copy 回退）；前端写入点 `store.ts:1234`（`save_run`） |
| **2. 运行编号（`runs/<编号>/`）撞车** | **窄，但真实**。编号是 `run_<毫秒base36>_<进程内自增base36>`，自增从 0 起、**每个进程各有一份**（`let idCounter = 0`）。两个实例的**第一件活**只要落在**同一毫秒**，编号就完全相同 → 两者的 `runs/<编号>/before/` 指向同一个目录，后者 `begin_run` 会**覆盖前者的备份**。不是主要危害，但值得点名 | `run.ts:386`（`let idCounter = 0`）、`:389-392`（`newRunId`）、`store.ts:1262`（起一件活时 `newRunId()`）；目录：`files.rs:633`（`begin_run` 的 `runs/<id>`）、`:644`（写 `before.json`）、`:419`（`sanitize_id`，不改唯一性） |
| **3. 在 A 窗口点撤销，会不会动 B 窗口刚做出的东西** | **会 —— 这条最关键**。撤销依据的是**文件系统前后快照的差**，不是「谁做的」：`undo_run` 按记录里的 `created` 把文件**移出用户的文件夹**。A、B 若先后对同一个文件夹跑活，B 的「之后快照」会把 **A 刚做出的文件**也记成 `created`（对 B 而言它确实是在自己窗口期内出现的）。于是**在 B 点撤销 = 删掉 A 的结果**，而 A 的记录仍列着那个文件、还提供「撤销」，一点就报「已经不在这里了」。这正是产品律 2 要挡的事 | `run.ts:102-119`（`diffSnapshots`：纯按路径/大小/mtime/行数判，**不带归属**）、`:93-95`（`changed`）；`store.ts:1411-1418`（`snapshot_paths` + `diffSnapshots` 之后存进 `run.undo`）、`:1234`（`save_run` 落到各自的记录）；执行端 `files.rs:692-724`（`undo_run`）、`:350-402`（`undo_files`：对 `created` 逐个 `rename`/`copy` 移走，`:363-373`） |
| **4. 两个守护进程同时读同一个 workspace** | **会**。每个实例在 `setup` 里各建一个 `Daemon`，各自 `spawn_child`；工作目录取 `current_dir()`，**简单界面从来不调 `set_cwd`**（`src/tauri.ts:128` 只有类型声明，全仓没有调用点）→ 两个守护进程的 cwd 相同，可能同时读/写同一个文件夹。产品规矩是「结果另存为新文件」，所以更可能是**两份结果互相看不见或互相覆盖同名新文件**，而不是改坏原件 | `daemon.rs:132-134`（`new` 取 `current_dir`）、`:653-661`（`spawn_child` 用 `command.current_dir(cwd)`）；契约 `CONTRACT.md`「`set_cwd` — directory the daemon is spawned in」；`gui/src/tauri.ts:128`（仅类型，无调用） |
| 5. `runs.json` 的 200 条上限各截各的 | **会，但属上面第 1 条的后果**。两个进程各自 `truncate(200)`，谁最后写谁的截断生效——被挤掉的记录可能「其实另一进程还有」，而撤销恰恰依赖记录在不在 | `files.rs:81`（`MAX_RUNS`）、`:478`；前端 `store.ts:261`（`MAX_HISTORY_RUNS = 200`） |

### A 的小结

- **第 1、3 条是硬干扰**（丢记录 / 撤销误伤别的窗口的成果），都源于「两个进程共享一份存储、且没有任何跨进程互斥」。
- **第 4 条**影响面取决于两个守护进程是否被指到同一文件夹，但**简单界面没有 `set_cwd` 调用**，所以默认 cwd 相同、风险真实存在。
- **第 2 条**概率低，但一旦触发会覆盖备份（备份是撤销的最后依据，被覆盖等于撤不回来）。

---

## B. 因此改了什么

加 **`tauri-plugin-single-instance = "2"`**（与仓库里另外三个 tauri 插件同为 `"2"`，实测解析到 **2.4.5**），
第二次启动**不新开窗口、不启动第二个守护进程**，而是**把已有窗口激活**：

- `gui/src-tauri/Cargo.toml`：只加这一个依赖（`tauri-plugin-single-instance = "2"`）。
- `gui/src-tauri/src/lib.rs`：
  - 注册插件，回调只调 `surface_existing_window`（**没有** `WebviewWindowBuilder`、**没有** `Daemon::new`）；
  - `surface_existing_window` 选中 `main` 窗口（找不到就退回任一已开窗口，**绝不新建**），
    按 **`unminimize` → `show` → `set_focus`** 三步恢复（最小化时先 `show` 不会生效，必须先还原）；
  - 把「选哪个窗口」抽成**纯函数** `window_to_surface(&[&str]) -> Option<&str>`，
    把恢复动作抽成**常量** `ACTIVATE_EXISTING_WINDOW: [WindowActivation; 3]`，两者都能在无窗口环境下断言。

**为什么这样就满足了「不启动第二个守护进程」**：Tauri 的构建顺序是
`Builder::build` → `initialize_plugins`（跑每个插件的 setup）→ 创建窗口 → 跑应用自己的 `.setup`
（`Daemon` 在这里才被 `manage`）。插件在**自己的 setup 里**发现已有实例就 `std::process::exit(0)`，
所以第二个进程**在窗口创建之前、在 `Daemon` 存在之前就退出了**，压根走不到 `Daemon::new`。

### 断言：`gui/src-tauri/tests/single_instance.rs`（新建，**选了这个文件**）

选了**新建**文件而不是塞进现有测试，因为这组断言是一个独立主题（「一个应用一个实例」），
和 `binary_spec.rs`（argv）、`integration.rs`（驱动夹具）都不同轴。

| 断言 | 覆盖到什么 | 怎么保证它不是空断言 |
| --- | --- | --- |
| `a_second_launch_picks_the_main_window` / `..._falls_back_to_an_open_window` | 「已有窗口被激活」的**选择**部分：永远选 `main`，其次任一已开窗口 | 纯函数直接喂标签 |
| `a_second_launch_never_invents_a_window_to_open` | **第二次启动不开新窗口**：无窗口时返回 `None`（不是「新建一个」），且返回值必属于已开窗口集合 | 喂空集合 + 「返回值必在集合内」 |
| `activation_brings_the_window_back_and_never_creates_one` | 激活动作是 `unminimize → show → focus`，且枚举里**没有** create 这种步骤 | 等值断言恢复顺序 |
| `the_second_launch_callback_never_creates_a_window_or_daemon` | **不新开窗口**的接线层：回调体里没有 `WebviewWindowBuilder`/`Daemon::new` | 变异测试（见下）能红 |
| `the_daemon_is_created_once_and_only_in_setup` | **不启动第二个守护进程**：`Daemon::new` 全仓只出现一次，且在 `.setup` 内（插件 setup 先于它） | 变异测试能红 |
| `the_daemon_has_a_single_spawn_site` | spawn 闸门：`spawn_child(` 只有「一处定义 + 一处调用」，且 `ensure_started` 保留 `inner.proc.is_some()` 早退 | 变异测试能红 |
| `several_commands_start_exactly_one_daemon` | **真跑** `Daemon`：连发 3 条命令，启动的守护进程数必须恰好为 **1**（替身进程每次启动往计数文件写一行，行数就是进程数） | **变异测试实测**：删掉 `ensure_started` 的早退守卫后，这条报 `found 3 daemons started`（见下）✗ |

**「测试能红」是实测的，不是声称的** —— 逐个变异、逐个看到红：

| 变异 | 期望红的断言 | 实测 |
| --- | --- | --- |
| 在 `ensure_started` 里再加一次 `spawn_child(...)` | `the_daemon_has_a_single_spawn_site` | 红 ✓ |
| 回调里加一句 `WebviewWindowBuilder::new(...)` | `the_second_launch_callback_never_creates_a_window_or_daemon` | 红 ✓ |
| 再插一处 `Daemon::new` | `the_daemon_is_created_once_and_only_in_setup` | 红 ✓ |
| 删掉 `ensure_started` 的 `if inner.proc.is_some() { return }` | `several_commands_start_exactly_one_daemon`（报 `found 3`） | 红 ✓ |

（变异只在本机临时改、跑完即 `git checkout` 还原，未提交。）

---

## C. 没核出来的 / 只能是真机验的

- **真机双击**：在真实 Windows/macOS 桌面上「双击两次图标」「图标 + 任务栏」各一次，看是否只留一个窗口、
  第二次有没有把已有窗口**真的带到前台**（尤其 Windows 的 `AllowSetForegroundWindow` 语义、
  以及最小化时是否还原）——**本机无头环境做不到**，由你另跑。上面所有断言都**不覆盖**「窗口真的出现在眼前」。
- **插件用的跨进程原语本身**（macOS 的 Unix socket、Windows 的命名互斥量、Linux 的 D-Bus）在真机上的行为，
  **没核**。只从源码核到**一处已知限制**：Linux 上拦截**依赖可用的 session D-Bus**。
  第二个实例是靠「D-Bus 名字已被占用」(`zbus::Error::NameTaken`) 才退出的；**其他**错误（包括
  「没有 session bus」）落进 `_ => {}` 分支，**静默按普通方式启动** —— 也就是说那种环境下**不会**拦第二个实例。
  另有一条**从源码看出的风险、但没复现**：`Builder::session().unwrap()` 在完全没有 session bus 时会
  **panic**（不是被拦住，而是起不来）；本机（macOS）跑不到这条路径。依据：
  `tauri-plugin-single-instance-2.4.5/src/platform_impl/linux.rs:56-89`。
- **`set_cwd` 是否该在简单界面被调用**：本轮只核出「现在没人调」，**没有**决定要不要加。两个守护进程
  cwd 相同这件事，加单实例后就只剩**一个**守护进程，风险随之消失；但「简单界面默认在哪个目录跑活」
  本身是另一个问题，不在本轮范围 ✗。
- **第 2 条（编号同一毫秒撞车）**：加单实例后不再可能（只有一个进程），所以**没有**为它单独写修复；
  这篇只是把它记下来（它是「为什么必须单实例」的一条论据，不是要单独修的东西）。
- **`undo_run` 的「无记录却报成功」**（记录被 200 条挤掉那条边界）：**不在本轮范围**，
  已在 `gui/docs/UNDO-BOUNDS.md` 第 3 节单独记录；本轮不碰 `store.ts`。

---

## D. 这轮怎么核的（可复核）

- 通读 `gui/src-tauri/src/files.rs`（`store_root`/`begin_run`/`undo_run`/`upsert_run`/`write_json`）、
  `gui/src-tauri/src/daemon.rs`（`ensure_started`/`spawn_child`）、`gui/src/store.ts`（`finishRun`/`persistRun`/`undoRun`）、
  `gui/src/simple/run.ts`（`newRunId`/`diffSnapshots`）；
- 全仓 grep 确认 `files.rs` 上**没有** `flock`/`lock_file`/`O_EXCL` 之类的跨进程互斥；
- 确认简单界面**没有任何 `set_cwd` 调用**（只有 `src/tauri.ts` 的类型声明）；
- `bash gui/scripts/e2e.sh` 全绿（含 `cargo test` 的 `-D warnings`）；
- 新增 `tests/single_instance.rs` 全绿，并逐条**变异**验证它真的会红（见 B 表）。

**这篇文档不覆盖**：真机（Windows）双击行为、窗口激活的观感、以及插件在各平台上的实际拦截效果。 ✗
