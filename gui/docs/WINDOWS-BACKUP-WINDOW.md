# Windows 验收机上「备份会积累」这件事：**目前没有样本**，以及一个要紧的数字

第 15 批 P1 的下半段（Windows 侧）。这一轮是**只读核查** ✓：
没删任何文件、没改产品代码、没提交别的东西、**没跑真实任务**（跑了会产生新备份、污染证据 ✓）。

- 机器：那台 Windows 验收机
- 原始输出：验收机上 `r15-backup.txt`（未概括）
- 复核方式：**两遍独立检查**（PowerShell `Get-ChildItem -Recurse -Force` 与 `cmd /c dir /a /s`），结果一致 ✓

---

## 1. 先说路径是怎么确定的（不是猜的）

`store_root`（`files.rs:553`）取 `app_config_dir()` 再拼 `file-safety`；
`tauri.conf.json` 的 `identifier` 是 `dev.cante.gui` → Windows 上是 `%APPDATA%\<identifier>`。
在 `AppData\Roaming` 与 `AppData\Local` 下（含 hidden）搜到三个候选，**只有一个是 store**：

| 路径 | 状态 |
| --- | --- |
| `…\AppData\Roaming\dev.cante.gui` | **这就是 store_root**（含 `file-safety`） |
| `…\AppData\Local\dev.cante.gui` | 只有 `EBWebView`（WebView2 缓存，不是 store） |
| `…\AppData\Local\Cante` | 安装目录 |

**store_root = `…\AppData\Roaming\dev.cante.gui\file-safety`**

## 2. 实测到的：**空壳，没有任何 run**

| 指标 | 实测 |
| --- | --- |
| `file-safety` 总大小 | **0 字节**（0 个文件） |
| `runs.json` 条数 | **文件不存在**（按 0 条） |
| `runs` 子目录个数 | **目录不存在**（按 0 个） |

那层目录是 `create_dir_all` 建出来的空壳（应用启动读历史时就会建），**里面从没写过任何 run**。

## 3. 这一对数字说明什么（以及**不**说明什么）

- **没有观察到孤儿目录** ✓ —— 因为 `runs` 与 `runs.json` 都不存在，
  根本不存在"目录数 > 条数"这种情形。
- 但**不等于"机制不存在"** ✗ —— 它说明的是：**这台机器上从没跑过真实任务**
  （真实任务都跑在 WSL 里、用的是 **Linux 侧**的 store ✓）。
  跨次积累要有 ≥1 次真实运行才谈得上，**这里无法观察** ✗。
- 全盘搜 `runs.json` / `before.json` / 名为 `before` 的目录：**命中 0** ✓；
  全用户目录下**只有**这一个 `file-safety` ✓。

**没有样本 ≠ 最大为 0** ✓ —— 这两件事分开写，不许混 ✗。

## 4. 顺带带回的一个要紧数字（**与本轮问题相关**）

- `Get-PSDrive C`：**Used 77.1 GB / Free 11.66 GB**。

这台验收机的 C 盘**可用只剩约 11.66 GB** ✗ —— 而"备份跨次不清理"的策略**正是要在这种机器上生效** ✓。
换句话说：**这台机器是观察这个问题最合适的地方，但它又是最不能拿来跑大量真实任务的地方** ✗。
（这一条只作事实记录 ✓，没有据此改任何东西 ✓。）

## 5. 安装目录（顺带核实，非本轮问题）

安装目录 `…\AppData\Local\Cante\`：**894 个文件 / ≈125.15 MB**。
其中最大的单件是内置运行时 `pi\bun.exe`（≈82 MB）—— **属预期内容，不是遗留垃圾** ✓。
WebView2 缓存（`…\Local\dev.cante.gui\EBWebView\`）：278 项 / 210 文件 / **≈4.81 MB**，非 store 内容 ✓。

## 6. 没核到的（如实写）

- **没有样本** ✗：`runs\` 不存在 → run 目录大小分布、"目录数 vs 条数"的实际关系**都没观察到**；
- **没跑真实任务** ✗（有意为之：跑了就会**产生**新备份、污染证据 ✓）；
- **没验**真 U 盘之类的场景（与本轮无关）；
- 只有**这一台**机器、这一个时刻的快照 ✓（不是随时间变化的观察 ✗）。
