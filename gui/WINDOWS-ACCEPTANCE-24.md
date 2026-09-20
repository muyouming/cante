# 第二十四次真机验收：结果面板的标题结构 —— **重建后复验 #247 的待办** ✓

**机器**：Windows 11 Home（win11 测试机）✓　**真 WebView2** ✓
**探针**：`gui\scripts\windows\a11y\probe-result-headings.ps1` ✓（#247 进仓库的那一支 ✓）
**这一轮的意义**：`-23.md` 那一轮量的是 02:27 的旧构建、结论作废 ✗。这一轮**先把产物重新编出来、核过它真的含 #239 的文案**，再量同一组判据 ✓。

---

## 0. 结论先行：三条判据全过 ✓

用 47 行可复现夹具（`seed-result-rows.ps1`）量的：

| # | 判据 | 数字 | 结果 |
| --- | --- | --- | --- |
| ① | 每份结果是**标题元素**（`HeadingLevel` 有值） | **47 / 47** | 每一份都有标题（L3，名字＝文件名）✓ |
| ② | 每个 `<ul>` 的**可访问名字** | **1 / 1**，名字＝`一共 47 份结果` | 合规 ✓ |
| ③ | 确认页那一屏的标题（对照组） | 6 条（L1/L2/L3） | 这一场正常走到 ✓ |

**比例**：① 47/47 ✓　② 1/1 ✓。**列表名字**：`一共 47 份结果` ✓（`RESULTS.list.ariaLabel` 那条文案，逐字对上）。

---

## 1. 【关键】任务给的第 3 步闸门**是无效的** —— 先说清，别拿它下结论 ✗

任务第 3 步要我拿 `Select-String` 去 **`cante-gui.exe` 的字节**里找 `一共` / `份结果`，
不命中就停、写「重建产物里仍无 #239 文案」✗。

我按原样跑了，两条都 `NO HIT` ✓ —— 但**这个"不命中"不能推出"产物里没有 #239 文案"** ✗：

- **Tauri 把前端资源 `brotli` 压缩后才 `include_bytes!` 进 exe**（release 用 quality=9；
  见 `tauri-codegen` 的 `embedded_assets.rs`）。所以**任何**嵌了前端的 exe，里面**永远没有明文界面文案** ✗。
- **反证（一眼可判）**：那台机器上**已知正常的装机版** exe（`<用户目录>\AppData\Local\Cante\cante-gui.exe`，
  02:27 那一份）同样两条都 `NO HIT` ✓。若"不命中"就代表"没有"，那连线上版本也成了"没有" —— 显然不成立 ✗。
- 界面的**真载体是 `gui/dist/assets/*.js`** ✓，不是 exe 的明文。

**所以我用能判的方法核了产物** ✓：
1. 查 `dist`：`一共` 命中 10 次、`份结果` 命中 2 次 ✓（`index-DpD2H4pf.js`）；
2. 把 exe 里**内嵌的那份压缩资源解压**出来，逐字命中 #239 文案 ✓：
   `list:{ariaLabel:e=>\`一共 ${e} 份结果\`}` ✓（压缩 97,901 B → 明文 282,271 B）。

→ **产物确实含 #239** ✓。我**没有**按"不命中就到此为止"停在错误结论上 ✗，而是先确认了产物，
再往下跑探针 ✓。（这正是 `AGENTS.md` §3.6 / `-23.md` §3 那条：先说清"我看的是它真的产出的那个东西吗"。）

---

## 2. 被测产物（我自己核过 ✓）

| 事实 | 值 |
| --- | --- |
| 工作树 / 分支 | `C:\cante-wt\docs` / `pool/win-headings` |
| 合并 | 先 `git fetch origin main`；落后若干，`git merge origin/main` 追平（本轮追到 `e6cfe09`，含 #239–#258 ✓） |
| 前端 | `bun run build:web` → `dist`（含 #239 文案 ✓） |
| 后端 | **`bunx tauri build --no-bundle`**（产品真正那条路 ✓） |
| exe 时间 | **2026-09-20 13:54:11** ✓ |
| exe 大小 | 10,374,656 B |
| exe sha256 | `462e9ef13c3d1aee61c0fc802cbfb6b661cd439b8570153e9aad6a62bf799271` |
| 构建模式 | tauri crate `dev=false` ✓（即启用了 `custom-protocol`，前端**真的**编进去了 ✓） |
| 自证 | exe 里逐字节含**压缩后**的资源（4/4 匹配 ✓） |

**一处关键订正**：任务第 2 步写的是 `cargo build --release`。我照跑了 —— **它 0.35 秒就结束，
什么都没重编** ✓，而且**它本来就不是产品的构建方式** ✗：不带 `custom-protocol` feature 时，
Tauri 编成 **dev 模式**（去连 `http://localhost:1420`），**前端根本不进 exe** ✗。
产品/CI 走的是 `tauri build`（`gui-release.yml`、`gui.yml` 都是）。**要量真产物，必须走 `tauri build`** ✓。
（这一条我在 13:26 那个 release exe 上验证过：它的 `out\` 里**没有** `tauri-codegen-assets`，exe 里含 `localhost:1420` ✗。）

跑法（都带超时 ✓）：

```powershell
# 前端
bun run build:web
# 后端（产品那条路）
Start-Job { bunx tauri build --no-bundle } | Wait-Job -Timeout 1200   # 实测 ~49 秒
# 夹具（真 xlsx + runs.json；用完 restore）
powershell -File gui\scripts\windows\seed-result-rows.ps1 -Mode seed -Rows 47 -WorkDir <目录>
# 探针（超时 420 秒）
powershell -File gui\scripts\windows\a11y\probe-result-headings.ps1 -Exe <新编的 exe> -OutDir <目录>
# 清痕
powershell -File gui\scripts\windows\seed-result-rows.ps1 -Mode restore -WorkDir <目录>
```

---

## 3. 探针原始数字（真机 UIA 树 ✓，不是读源码 ✗）

```json
{ "rows": 47, "withHeading": 47, "lists": 1, "ulNamed": 1 }
```

节点计数：`List = 1`、`ListItem = 47`、有标题级别的节点 = 57（= 1 组名 + 47 文件名 + 别的屏）。
标题级别分布：`L1:1`、`L2:8`、`L3:48`（48 = 组名「今天做的」1 条 + 每份结果 1 条 ✓）。

**①** 47 份结果，每一份第一个标题后代都是 `L3`，名字＝`结果_挑出华东区-<n>.xlsx` ✓
（列表名字对得上、顺序从新到旧 ✓）。
**②** 唯一的 `<ul>` 名字 = `一共 47 份结果` ✓，合规 1/1 ✓。
**③** 确认页 6 条标题：`L1/L2「把这段时间做的事写成一份总结」`、`L3「它打算这样做 / 这个任务可能不准的地方 / 要处理的文件（0 个） / 会影响什么」` ✓。

产物：`result-headings.json`（结构化）✓、`result-headings.txt`（人看）✓。探针自身 `exit 0` ✓。

---

## 4. 没验到的（如实 ✗）

- **只跑了一场、一个夹具规模**（47 行）✓ —— 不是多种数量/多种分组的矩阵 ✗。
- **分组视图只覆盖到一个组**（夹具都新鲜 → 只有「今天做的」）✗：
  **分组那个 `<ul>` 的"每组几份"名字**只在这一组上量过 ✓；**搜索/扁平那条 `<ul>`**（`shown().length`）
  这一场**没走到** ✗（没输入搜索词）。两者代码不同分支（`ResultsPanel.tsx:412` vs `:425`）。
- **只读 UIA 树** ✓，**没做 ETW / Narrator 实际朗读** ✗ —— 按 `VERIFICATION-MAP.md` 那张表，
  "读屏真念出来的 `SpokenText`"是**更强的一类**证据 ✓，本轮没用它复核 ✗。
- **没截图** ✗；**显示缩放**不是 100% 的情形**没验** ✗。
- **装机/打包形态没验** ✗：本轮量的是 `target\release\cante-gui.exe` 构建输出 ✓，
  **不是**安装包落地的那个文件 ✗（安装包链路由打包验收负责）。

---

## 5. 痕迹清理 ✓

夹具已 `-Mode restore`：铺进去的 `runs.json` 已删（跑之前本来就没有）✓，
配置目录 `file-safety\` 已空 ✓，无残留 `cante-gui` / `msedgewebview2` 进程 ✓。

---

## 6. 范围外的观察（没动它）

工作树里出现了一个**未跟踪**文件 `gui\scripts\windows\verify-modern-build.ps1`
（时间戳 13:51，**不是我建的** ✗）。它自己讲的是同一件事（"别拿 exe 字节查界面文案"）✓，
和我在 §1 得到的结论一致 ✓。**它不在本轮任务范围**，我一律**没改、没提交** ✗。
