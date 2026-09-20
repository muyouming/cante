# Windows 验收 25：**#268 的构建标记在 Windows 产物里真的在**，以及「两份同名的 cante-gui.exe」

日期：2026-09-20　机器：那台 Windows 11 验收机（工作树 `C:\<工作树>\docs`）。
这一轮是**机械核查**（不需要模型判断 ✓）—— 命令与原始输出如下，逐条可复跑。

---

## 1. 这一轮要回答的问题

`#268` 让应用**自己报出它是哪一份**（关于页 + 一个带标记的机器串 `CANTE-BUILD|时间|版本`）。
本机（macOS）只能验到"串拼得出来、解得回去" ✓。**这一轮要回答的是**：
在 **Windows 上真编出来的产物**里，那个标记**真的在不在**？

## 2. 做了什么（一次跑完，日志落在 `C:\Users\<用户名>\r13-report.txt`）

1. `git fetch origin main` + `git merge origin/main --no-edit` → 到 `0ce67d9`（含 #267/#268 ✓）；
2. `bun run build:web`；
3. 在 `gui\dist\assets\*.js` 里找 `CANTE-BUILD|` 标记；
4. 把**两份都叫 `cante-gui.exe`** 的东西的时间都打出来。

## 3. 原始结果

```
--- build web ---
built in 1.84s

--- build stamp in dist ---
  index-7rn4ZlyB.js : CANTE-BUILD|2026-09-20 16:43|0.2.3"}function qu(

--- the two artifacts that both answer to cante-gui.exe ---
  C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe                time=09/20/2026 02:27:50
  C:\<工作树>\docs\gui\src-tauri\target\release\cante-gui.exe     time=09/20/2026 16:11:44
```

## 4. 结论（这一轮真验到的）

1. **`#268` 在 Windows 上成立** ✓：Windows 编出来的前端资源里**确实**有
   `CANTE-BUILD|2026-09-20 16:43|0.2.3` ✓ —— 时间与版本都对得上 ✓。
   这正是那个串存在的意义：**产物自己会说是哪一份** ✓。
2. **那两份同名的 exe 相差 13 小时 44 分** ✓（装机版 `02:27:50` vs 刚编的 `16:11:44`）✓ ——
   这就是「拿装着的那个做验收，量到的是旧界面」✗ 的现场。
   有了第 1 条，这种事**下次能一眼看出来** ✓（不必再靠文件时间猜 ✓）。

## 5. 没验 / 没做到的（如实写）

- **`cargo test --release` 在这台机器上超时**（限 1800 秒，`TIMEOUT cargo test`）✗。
  这一条我**不敢写成"通过"** ✗ —— 是"没等到结果"✓，而且很可能是**测试目标要从头编一遍**
  （这一轮之前只编过 `--release` 的 bin，没编过 test profile ✓）。
  **下次要跑的话**：给它 **3600 秒**，或者先单独 `cargo build --release --tests` 预热一次再跑。
- **没有**在 Windows 上真点开关于页看那两句话 ✗（要交互桌面+RDP ✓，本轮没做 ✓）。
  所以「关于页显示得对不对」**只有 macOS/dom-smoke 那侧的覆盖** ✓，Windows 侧**没验** ✗。
- **没有**重装/覆盖安装那台机器上 `02:27` 的旧版 ✗ —— 因此"装机版与新建版混在一起"这个坑
  **仍然存在** ✓（只是现在**能看出来**了 ✓）。
- 没有跑任何真实任务（这一轮是产物核查 ✓，不是任务验收 ✓）。
