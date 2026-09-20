# 验收 30 —— 每周普查报告的「原始输出」不再乱码（wsl.exe 是 UTF-16LE，按字节解码）

- **机器**：Windows 11 家庭版 `10.0.26200` x64，Windows PowerShell **5.1**.26100.9444（真机，SSH 会话）
- **现场**：这台机器 WSL 整个被卸了 —— `wsl --status` **退出 50**，`wsl.exe -e …` 只回一屏
  **UTF-16LE** 安装提示。每周普查必然走到这条路，所以报告里那段「原始输出」一直是垃圾。

## 改了什么（3 处捕获点，同一套做法）

| # | 文件 | 捕获点 |
| --- | --- | --- |
| 1 | `gui/scripts/windows/weekly-sweep.ps1` | 探「WSL 能不能用」那一条（**报告里的乱码就出在这**） |
| 2 | `gui/scripts/windows/wsl-ante-setup.ps1` | `Invoke-WslScript`（所有 bash 片段的捕获都走它） |
| 3 | `gui/scripts/windows/collect-environment.ps1` | `wsl -l -v` 那条发行版列表 |

做法（PS 5.1 兼容，真机 parse 过）：`Start-Process -RedirectStandardOutput/-Error 到临时文件`
（PowerShell 不经手解码），再按**实际字节**认编码 —— 有 UTF-16 BOM、或字节里含 NUL → UTF-16LE；
否则 UTF-8。**空文件**（失败路径）和**可执行文件不存在**都返回空串/错误串，不炸。

**没改**：`weekly-sweep.ps1` 里跑普查主体那处（`-e bash -lc <多行脚本>`）。它拿的是 WSL 子进程的
**UTF-8**；而带空格/换行的 `-lc` 参数会被 `Start-Process -ArgumentList` 拆坏。能走到那里，说明探针
已确认 WSL 可用。脚本里写了注释；这条限制也列在下面「没验的」。

## 修前 → 修后（报告里「原始输出」那一节，逐字）

修前（`report-20260920.md`，842 字节，含 **35 个 NUL** 与若干控制字节；下面把控制字节显示成 `<XX>`）：

```
*g�[ň<02>�(u�N Linux �v Windows P[�|�~<02>0�S<1A>�ǏЏL� <1C> wsl.exe --install<1D>  ۏL��[ň<02>0<0A>
```

修后（`report-20260921.md`，866 字节，**0 个 NUL**）：

```
未安装适用于 Linux 的 Windows 子系统。可通过运行 “wsl.exe --install” 进行安装。
有关详细信息，请访问 https://aka.ms/wslinstall
```

## 怎么验的

1. **语法**：把三个改过的 `.ps1` 拷到真机，用 PowerShell 的 AST 解析器 `ParseFile` 逐个过，三个都 `PARSE-OK`。
2. **`weekly-sweep.ps1` 本体**：真机跑（`Start-Job` + `Wait-Job -Timeout 300`）→ 退出码 **3**（WSL 不可用）；
   报告 `C:\cante-sweep\report-20260921.md`，上面那段就是它写的。**没有触发超时**。
3. **另两处各跑一次**：`collect-environment.ps1` 退出 0，WSL 一节现在读作「未安装适用于 Linux 的
   Windows 子系统。…」；`wsl-ante-setup.ps1 -CheckOnly` 退出 1（如期停在步骤 2），那屏捕获也已是可读中文。
   （输出经 `cmd` 重定向落盘再取回，避免嵌套捕获二次编码把中文弄花。）
4. **解码函数两个分支**（用 AST 从仓库文件里取出真实函数定义再调用，不改文件）：
   UTF-16LE（真 `wsl.exe`）✓、UTF-8（一个输出中文的子进程）✓、空输出 ✓、可执行文件不存在走 catch ✓、
   stdin 喂脚本原样送达 ✓。
5. **历史不丢**：`report-20260920.md` 跑前备份为 `report-20260920.md.bak-r18`；备份与原件、与本地副本
   sha256 三方一致（`a6383d19…`）。

## 没验的（与上面分开写）

- **WSL 健康时**那条路：没验（任务明说不许装 WSL）。探针在 WSL 正常时会拿到 UTF-8 的 `cante-wsl-ok`，
  逻辑上走 UTF-8 分支（该分支已用等价子进程单独验过）；`wsl-ante-setup.ps1` 的完整装机流程也没跑（停在步骤 2）。
- `weekly-sweep.ps1` 普查主体那处（见上「没改」）：若有天 `-d` 指了不存在的发行版，`wsl.exe` 自己的报错仍可能花屏。
- 计划任务 `CanteWeeklySweep` 本身没触发 —— 跑的是**等价的手工调用**。

## 原始输出在哪

- 修后报告：`C:\cante-sweep\report-20260921.md`；备份：`C:\cante-sweep\report-20260920.md.bak-r18`
- 真机抓的原文：`C:\r18-wslfix\` 下的 `collect-env.raw.txt`、`wsl-setup.raw.txt`、`syntax-check` / `test-*` 输出
