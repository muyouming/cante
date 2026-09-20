# 第 15 批 · Windows 侧机械核查之四：她点「打开所在文件夹」会看到什么

机器：Windows 11 家庭版 build 10.0.26200（`LongPathsEnabled=1`，PowerShell 5.1）
家目录：一律写作 `<家目录>`（= `C:\Users\<用户名>`）
原始输出：`<家目录>\r15-reveal.txt`（含全部命令原文与逐条 stdout/stderr）
只读核查：**未改产品代码、未提交、未跑真实任务（没打模型）**。

---

## 结论摘要（先给答案）

- 「打开所在文件夹」**不拼任何命令行、也不启动 `explorer.exe`**。它走的是 **进程内 COM**
  （`SHOpenFolderAndSelectItems`）。所以「explorer 退出码陷阱」**打不到产品**（但第 4 步仍按要求实测了）。
- 「打开文件」同样**不拼命令行**，走 **`ShellExecuteExW`**（`open` crate 的 `shellexecute-on-windows` 分支）。
- 真机上中文目录、空格括号、399 字符长路径**都能正确打开并选中**。
- 她看到的是一串 **正斜杠的完整路径**（`位置：C:/Users/.../某个文件夹`），**没有任何「复制路径」按钮**。
- 文件/父目录真的不在时，**不弹窗**，只给一句提示：「打不开它所在的文件夹。」（符合产品律 3）。
- **没核到的**：本机没有可移动盘/U 盘（D/E/F 全是光驱），U 盘情形**没核**。

---

## 第 1 步：代码里这个动作怎么实现的（文件:行）

### 1.1 前端按钮 → 后端命令

| 环节 | 文件:行 | 内容 |
| --- | --- | --- |
| 「打开文件」按钮 | `gui/src/simple/ResultCard.tsx:492` | `onClick={() => void props.store.openPath(file.path)}` |
| 「打开所在文件夹」按钮 | `gui/src/simple/ResultCard.tsx:499` | `onClick={() => void props.store.revealPath(file.path)}` |
| 失败核对里的同名按钮 | `gui/src/simple/ResultCard.tsx:394` | `void props.store.revealPath(target)` |
| 历史 / 结果面板 | `gui/src/simple/History.tsx:184,192`、`ResultsPanel.tsx:212,220` | 同上 |
| store | `gui/src/store.ts:1079` | `openPath()` → `await invokeOp("open_path", { path })` |
| store | `gui/src/store.ts:1089` | `revealPath()` → `await invokeOp("reveal_path", { path })` |

命令注册：`gui/src-tauri/src/lib.rs:83`（`files::open_path`）、`lib.rs:84`（`files::reveal_path`）；插件初始化 `lib.rs:50` `.plugin(tauri_plugin_opener::init())`。

### 1.2 后端 Rust（`gui/src-tauri/src/files.rs`）

**`open_path`（`files.rs:607`）** —— 先查存在性，再交给 `open` crate：

```rust
pub async fn open_path(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    if !Path::new(&path).exists() {
        return Err(format!("这个文件找不到了：{path}"));
    }
    app.opener()
        .open_path(path.clone(), None::<&str>)          // files.rs:612
        .map_err(|error| format!("打不开 {path}：{error}"))?;
    Ok(json!({ "ok": true }))
}
```

**`reveal_path`（`files.rs:619`）** —— 文件在就用文件本身，不在就退到它的**父目录**（`folder_of`，`files.rs:339`）：

```rust
pub async fn reveal_path(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let target = Path::new(&path);
    let target = if target.exists() { target.to_path_buf() } else { PathBuf::from(folder_of(&path)) };
    app.opener()
        .reveal_item_in_dir(&target)                     // files.rs:623
        .map_err(|error| format!("打不开文件夹：{error}"))?;
    Ok(json!({ "ok": true }))
}
```

### 1.3 它到底调了什么系统命令？——**没有命令行字符串**

版本：`tauri-plugin-opener 2.5.5`（`Cargo.toml:22`，`Cargo.lock` 锁 2.5.5）、`open 5.4.4`。二者都是 **Rust 直接调 Win32**，不 spawn 子进程：

- **reveal（`reveal_item_in_dir.rs`）**：
  1. `canonicalize(path)` → `absolute_and_check_exists`（`GetFullPathNameW` + **存在性检查**，不存在返回 `Err`）；
  2. `CoInitialize` → `ILCreateFromPathW(parent)` + `ILCreateFromPathW(target)`；
  3. `SHOpenFolderAndSelectItems(parent_pidl, [target_pidl], 0)`；
  4. 只有该调用返回 `ERROR_FILE_NOT_FOUND` 时才**降级**用 `ShellExecuteExW(lpVerb="explore"/NULL, lpFile=parent)`。
  → 等价命令行大意是 `explorer.exe /select,<路径>`，但**产品并没有拼这个字符串**，是 COM 等价调用。

- **open（`open-5.4.4/src/windows.rs: that_detached`）**：本项目 `tauri-plugin-opener` 对 `open` 启用了 `features = ["shellexecute-on-windows"]`（插件 `Cargo.toml`），因此走 `ShellExecuteExW(lpFile=路径, lpVerb=NULL, nShow=SW_SHOWNORMAL)`。
  → **不走** `powershell.exe -Command Invoke-Item`，也**不走** `explorer.exe`（那两条是未启用该 feature 时的备用分支）。

> 也就是说：**没有「拼字符串」的拼法可照抄**——这是好消息（没有引号/注入/`/select,` 被当成选项的风险）。真机上第 2 步我用 P/Invoke **逐字复刻**了这两个 API（不是调 `explorer.exe`）。

---

## 第 2 步：真机逐条执行结果

复刻方法：PowerShell `Add-Type` P/Invoke `ILCreateFromPathW` / `SHOpenFolderAndSelectItems`（reveal）与 `ShellExecuteExW`（open），
**与第 1 步的 API 一一对应**；每次前后用 `Shell.Application` 数 Explorer 窗口，跑完关掉本次新开的窗口。

| # | 情形 | 路径 | 结果 | 退出/返回 | 新窗口 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 普通英文 | `<家目录>\Desktop\r15-fixtures\a.txt` | **OK** | `SHOpenFolderAndSelectItems=0x00000000` | 1 | 打开父目录并选中 |
| B | **中文目录+中文文件名** | `...\新建文件夹\结果 表(1).xlsx` | **OK** | `0x00000000` | 1 | 打开「新建文件夹」 |
| C | **空格与括号** | `...\my folder (copy)\report final (2).txt` | **OK** | `0x00000000` | 1 | URL 里看到 `my%20folder%20(copy)` |
| D | **超长路径（399 字符）** | `...\longdir1xxx...\longfile.txt` | **OK** | `0x00000000` | 1 | 窗口开了；地址栏显示 8.3 短名 `R15-FI~1/LONGDI~1/...` |
| E | **已在别的程序打开的文件** | `a.txt`（记事本占用中） | **OK** | `0x00000000` | 1 | 记事本照常运行，文件内容 `r15 reveal test` 未被改动 |
| F1 | **文件丢了、文件夹还在** | `...\新建文件夹\没有这个文件 表(9).xlsx` | **OK（退到父目录）** | `0x00000000` | 1 | 打开 `r15-fixtures`（`folder_of` 兜底生效） |
| F2 | **整个父文件夹都不在** | `...\r15-NOPE-父不存在\x.txt` | **产品报错** | 插件 `Err(NotFound)` | 0 | 不弹窗，前端给「打不开它所在的文件夹。」 |
| F3 | **未挂载盘符** | `Z:\some\file.txt` | **产品报错** | `Err(NotFound)` | 0 | 同上，不弹窗 |
| G | **打开文件（open，非 reveal）** | `a.txt` | **OK** | `ShellExecuteExW=1` | 0 | 启动了记事本（PID 新起），窗口标题 `a.txt - Notepad` |
| H | **打开文件：.xlsx** | `结果 表(1).xlsx` | **OK（系统层）** | `ShellExecuteExW=1` | 0 | 本机没装 Office/WPS，弹出**「打开方式」选择框**（`OpenWith.exe`）——不是产品出错，是系统没有默认程序 |
| I | **打开文件：不存在的路径** | `...\没有这个文件 表(9).xlsx` | **产品拦下** | 未调系统 | 0 | `open_path` 先 `exists()` 判否 → 报「这个文件找不到了」 |

**补充：控制台命令行的对应写法**（供对照，非产品路径）
`SHOpenFolderAndSelectItems(parent,[child])` ≈ `explorer.exe /select,"<完整路径>"`；
`ShellExecuteExW(lpFile=path)` ≈ `start "" "<完整路径>"`。

**没核到的**：**U 盘/可移动盘**——`[IO.DriveInfo]::GetDrives()` 只列出 `C:`（Fixed）与 `D:/E:/F:`（全部 `CDRom`，光驱），**没有可移动盘可用，此情形没核**。

---

## 第 3 步：她看到的那串路径能不能用

**原文（逐字，来自真机结果卡的 UI 文本 dump）**，`< >` 处用占位：

```
结果_挑出华东区.xlsx
位置：C:/Users/<用户名>/cante-accept-work
新增 · 5.5 KB
打开文件
打开所在文件夹
```

中文+空格路径那一轮的原文（`gui\src\simple\ResultCard.tsx:484-485` 渲染 `位置：{folderName(file.path)}`）：

```
位置：C:/Users/<用户名>/Desktop/Cante路径验收/2026年报销/job
```

对照源码 `ResultCard.tsx:481-485`：上面一行是**文件名**（`fileName`），下面「位置：」那行是**所在文件夹**（`folderName`）。
两者都是**完整路径的相应部分**，来自 `run.ts:141/146` 的 `fileName`/`folderName`。

**判断**：
- 是**完整路径**（不只是文件名）——包含了从盘符起的全路径。
- 分隔符是 **正斜杠 `/`**（Rust 侧 `display()` 在 `files.rs:415-417` 把 `\` 换成 `/`），所以**不是** Windows 习惯的反斜杠；念给别人听时是「C 冒号 斜杠 Users 斜杠 ……」。
- **超长**：路径很长（中文+空格那一轮 50+ 字符），且外层 `<p>` 带 `truncate`（`ResultCard.tsx:484`），
  **界面上会被截断**，完整值只在鼠标悬停的 `title` 里——**她很难照着念**。
- **没有任何「复制路径」按钮**（全仓库搜 `clipboard`/`复制` 命中里没有复制路径的功能）。唯一相关的复制是「复制成微信能贴的文字」，复制的是**内容摘要**，不是路径。

> 一句话：**路径能用（点按钮就开），但「念给别人听」不好用**——太长、正斜杠、且被界面截断、不能一键复制。

---

## 第 4 步：`explorer.exe` 的退出码陷阱（实测）

用 `Start-Process explorer.exe -PassThru -Wait` 取真实退出码，每种跑 2–3 次：

| 目标 | 是否真的开了窗口 | `ExitCode` |
| --- | --- | --- |
| 存在的文件夹 | 是 | **1, 1, 1** |
| 存在的文件 | 是 | **1, 1** |
| 不存在的路径 | **否** | **1, 1, 1** |
| 不存在的盘符 `Q:` | 否 | **1, 1** |
| 非法字符路径 | 否 | **1, 1** |
| `/select,` 存在的文件 | 是 | **1, 1, 1** |
| `/select,` 不存在的文件 | 否 | **1, 1, 1** |
| `/n,` 存在的文件夹 | 是 | **1, 1, 1** |

对照 `cmd.exe /c` 里的 `%ERRORLEVEL%`：

| 写法 | 成功 | 失败 |
| --- | --- | --- |
| `explorer.exe "<路径>" & echo %ERRORLEVEL%` | **0** | **0** |
| `start "" explorer.exe "<路径>" & echo %ERRORLEVEL%` | **0** | **0** |

**结论**：
- 直接 `Start-Process ... -Wait` 看 `ExitCode`：**成功与失败都可能是 `1`**——退出码不可用来判成败。
- 在 `cmd` 里看 `%ERRORLEVEL%`：**成功与失败都是 `0`**——同样不可用。
- **所以「靠 explorer 退出码判成败」一定判错**（大概率把失败也当成功；在 `-Wait` 场景甚至会「把成功当失败」）。
- **但对本产品无影响**：产品压根不启动 `explorer.exe`，用的是 COM 返回值（`SHOpenFolderAndSelectItems` 的 `HRESULT`、`ShellExecuteExW` 的布尔），这才是可靠的判据。

---

## 收尾（改了什么 / 测试结果 / 真机结果 / 没做的事）

- **改了什么**：无。只写了临时核查脚本与两份产物（`<家目录>\r15-reveal.md`、`<家目录>\r15-reveal.txt`）及若干 `r15-*.ps1`/`r15-*.txt` 中间文件。**未改产品代码、未提交、未跑真实任务。**
- **测试结果**：全部为真机手工执行（第 2、4 步），命令与 stdout/stderr 已入 `r15-reveal.txt`。
- **真机结果**：见上表；中文/空格/括号/长路径/已打开文件均成功；缺失路径不弹窗、给提示。
- **没做的事及原因**：
  1. **U 盘/可移动盘情形没核**——本机无可移动盘（D/E/F 为光驱）。
  2. **没在 GUI 里点按钮**——为避免跑真实任务，第 3 步用的是**真机历史上真实结果卡**的 UI 文本 dump（含中文+空格路径），不是现造。
  3. **「打开文件」对 .xlsx 的最终观感没核全**——本机无 Office/WPS，弹的是系统「打开方式」框；装了办公软件后的行为未核。
- **清理**：本次所有新开的 Explorer 窗口与记事本进程均已关闭；`OpenWith`（09:51）为核查前既有进程，未动。
