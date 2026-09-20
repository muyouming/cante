# 结果文件找不到了：能不能把「文件没了」和「整个盘不在」分开？

起点：第 14 批机会点（`gui/OPPORTUNITIES-8.md`）。
她的文件常常在**自己的 U 盘 / 移动硬盘**上。她把盘拔了（或以为插着），屏幕上却说
「它可能**被移动或删掉了**」——一个字都没提盘。她会去重选一份本来好好的文件，
甚至以为是自己弄丢了。

这份文档只回答一个问题：**本机能不看出「盘拔了」和「文件被删了」的区别？**
结论和证据都在下面；**Windows 侧没核出来，如实写「没核出来」，不猜**。

---

## 1. 生产路径上真正做判断的那几处（先核事实）

`gui/src-tauri/src/files.rs` 里走「路径存在性」的地方，**全部只读一个 bit**：

| 位置 | 判据 | 现在会对「盘不在」说什么 |
| --- | --- | --- |
| `open_path`（第 607 行） | `if !Path::new(&path).exists()` → `Err("这个文件找不到了：{path}")` | 同一句「找不到了」 |
| `reveal_path`（第 619 行） | `target.exists()` 为假就退到 `folder_of(&path)` 再开文件夹 | 打开文件夹会失败（盘都没有） |
| `fact_for`（第 510 行） | `fs::metadata(path)`：`Ok` 是目录 / `Ok` 是文件（再看 `File::open`）/ `Err` → `exists: false` | 同一句「不在了」 |
| `scan_roots`（第 194 行） | `fs::read_dir` 失败就 `continue`（这一层看不到） | 快照少一片，**判别不出原因** |
| `roots_of`（第 152 行） | 只用 `is_dir()` / `parent()` 定位监视目录 | 盘不在时算不出根 |

`exists: false` 之后，前端 `gui/src/simple/results.ts` 的 `presenceOf()` 把它翻成
`missing`，由 `gui/src/simple/copy-results.ts` 说成「被移动或删掉了」。
**这一条链上没有第二个信号**——这就是怀疑成立的地方。

## 2. macOS 上真的做了实验（假现场）

用一个临时 dmg 当「U 盘」，放一个文件，分别造出**五种现场**，再用 `files.rs`
同款的调用去看：`Path::exists()`、`fs::symlink_metadata()`、`fs::metadata()`、
`fs::File::open()`，外加两个「往上找」的信号——**直接父目录**是否还在、**卷的挂载根**
（`/Volumes/<名>`）是否还在。

复现：

```bash
hdiutil create -size 10m -fs HFS+ -volname r14vol -quiet /tmp/r14-exp/test.dmg
hdiutil attach /tmp/r14-exp/test.dmg                 # 挂上
mkdir -p /Volumes/r14vol/子文件夹 && echo hi > /Volumes/r14vol/子文件夹/报告.xlsx
# 五个现场各探一次；拔盘用 hdiutil detach /Volumes/r14vol
```

`fs::metadata` / `Path::exists` / `File::open` 在五种现场下**一模一样**（「在」或
「不在」），差别只在两个「往上找」的信号：

| # | 现场 | `Path::exists()` | `metadata` 错误码 | 直接父目录 | **卷挂载根** |
| --- | --- | --- | --- | --- | --- |
| 1 | 盘插着，文件在 | `true` | `Ok` | `true` | `true` |
| 2 | 盘插着，**文件被删** | `false` | `NotFound(2)` | `true` | **`true`** |
| 3 | 盘插着，**整个文件夹被删** | `false` | `NotFound(2)` | `false` | **`true`** |
| 4 | **盘拔了**（卷卸载） | `false` | `NotFound(2)` | `false` | **`false`** |
| 5 | 内置盘，文件被删 | `false` | `NotFound(2)` | `true` | `true`（根 `/`） |

（Python `os.path.exists` 交叉核对，给出一致结论：卸载后 `/Volumes/r14vol` 本身也
`exists=False`、`stat` 也是 `ENOENT(2)`。）

## 3. 结论表：情形 → 现在会说什么 → 证据 → 能不能分开

| 情形 | 现在会说什么 | 我的实验证据 | 用**今天这个 bit** 能分开？ | 用**卷挂载根**能分开？ |
| --- | --- | --- | --- | --- |
| 盘插着，文件在 | 「现在还在，能打开。」 | 现场 1 | — | — |
| 盘插着，文件被删 | 「可能被移动或删掉了」 | 现场 2 | — | 参照 |
| 盘插着，整个文件夹被删 | 「可能被移动或删掉了」 | 现场 3 | — | 与 2 同（根在） |
| **盘拔了** | 「可能被移动或删掉了」 | 现场 4 | ✗ 和 2/3 完全一样 | ✓ 根**不在** |
| 内置盘，文件被删 | 「可能被移动或删掉了」 | 现场 5 | — | 根 `/` 永远在 |

**判据（本轮结论，分两层说清）**：

1. **用 `files.rs` 今天读的那一个 bit：分不开。** 拔盘（4）、删文件（2）、删文件夹（3）
   三种情形下 `Path::exists()` 与 `metadata` 错误码**完全相同**（`false` + `NotFound(2)`）。
2. **直接父目录这个信号：不可用**（会撒谎）。它能把 2 和 4 分开，但**分不开 3 和 4**
   ——「整个文件夹被删」（3）的父目录也是 `false`，用它会把它**误报**成「盘拔了」。
3. **卷挂载根这个信号：macOS 上真的能分开**（4 是 `false`，2/3/5 都是 `true`）。

## 4. Windows 侧：**没核出来**（不猜）

以下**都没有实测**，因此本轮的改动**不依赖**任何 Windows 专有行为：

- 拔掉一个盘符（U 盘）后，`fs::metadata("E:\\...")` 返回的是
  `ERROR_PATH_NOT_FOUND(3)` 还是 `ERROR_FILE_NOT_FOUND(2)`；
- 「盘符不存在」与「盘符在、文件被删」在 Windows 上能不能分开；
- Windows 上「设备未就绪」（`ERROR_NOT_READY(21)`）会不会出现在拔盘路径上。

**为什么没核**：本会话在 macOS 上，没有那台 Windows 测试机（AGENTS §6：Windows 原生
跑不了真实任务）。这条由集成者在 Windows 上另跑，**不要**把这里的 macOS 结论
当成 Windows 的结论。**产品以 Windows 为先**，所以「事实清楚」这一步在 Windows 上
**还没有**满足。

## 5. 因此本轮怎么改（分不开 → 别把话说死）

判据 §3 第 1 层是「分不开」，而第 3 层那个能分开的信号**只在 macOS 上核过、
Windows 未核**；加上消费这个判定的前端文件（`results.ts` / `verify.ts`）**不在本轮
可改范围内**（硬约束只给了 `copy-results.ts`），所以按**分不开分支**办：

- 把「它可能被移动或删掉了」这句**扩成包含**「也可能在一个现在没接上的盘上」；
- 给**两步出路**：把那个盘插回来再点一次 / 打开所在文件夹找一找、回首页重新选一次文件；
- 认不出时（`unknown`）照旧退回**通用出口**，不假装知道是哪种；
- **不**新增「盘不在」的自动判定——因为要么它得靠会误报的父目录信号（§3.2），
  要么得引入平台专有逻辑且 Windows 没核（§3.3 / §4）。

**没做的**（及原因）：

- **没改 `files.rs` 的行为**。任务书说「只在 A 证明必须时」——A 的结论是
  「今天这个 bit 分不开」，而「能分开」的那条路（卷挂载根）横跨平台、Windows 未核，
  所以数据层**不该**动。
- **没加第三种 `presence`**。那要动 `results.ts` / `verify.ts`（本轮范围外）。
  **留给下一轮的判据已经清楚**：若集成者在 Windows 上核出「盘符消失」可与
  「文件被删」分开，就把它做进 `FileFact` → `results.ts` 的第五种 `presence`，
  文案位（`copy-results.ts`）已经准备好一个干净的行为锚点。
- **没核 Windows**（见 §4）。
