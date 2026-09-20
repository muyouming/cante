# 拔盘之后说"找不到"：Windows 上到底能不能分辨「文件被删」与「整个盘不在了」

回答的是产品里那一句人话的依据（第 14 批机会点 P1）。**这一份是 Windows 侧的一手实测**，
不是推测；原始输出（未概括）在验收机上 `r14-filecheck.txt`（12,401 字节，5 段探测的完整 stdout）。

- 机器：那台 Windows 11 验收机（Home，OS 10.0.26200）
- Shell：Windows PowerShell 5.1.26100.9444（.NET Framework 4.x）
- 方法：`subst X: C:\<临时目录>` 造一个盘符 → 写 `X:\probe.txt` → `subst X: /D` 模拟拔盘；
  三种情形 + 一个参考各跑同一组探测。

---

## 一、四种情形对照

| 情形 | `Test-Path` | `File.Exists` | `Get-Item` 报错类型 | `FullyQualifiedErrorId` | 内层异常 HResult |
| --- | --- | --- | --- | --- | --- |
| ① 盘在、文件在 | **True** | **True** | 无 | — | — |
| ② 盘在、文件被删 | **False** | **False** | `ItemNotFoundException` | `PathNotFound` | `0x80070002` FileNotFound |
| ③ **盘没了** | **False** | **False** | **`DriveNotFoundException`** | **`DriveNotFound`** | **`0x80070003`** DirectoryNotFound |
| ④ 参考：C 盘上不存在的文件 | **False** | **False** | `ItemNotFoundException` | `PathNotFound` | `0x80070002` |

盘根本身：

| 查询 | 盘在 | 盘没了 |
| --- | --- | --- |
| `Test-Path X:\` | True | **False** |
| `Get-Item X:\` | OK | 抛 `DriveNotFoundException` |
| `[IO.DriveInfo]::GetDrives()` 里有 X: | 有 | **没有** |
| `[IO.DriveInfo]('X').DriveType / IsReady` | `Fixed` / `True` | `NoRootDirectory` / **`False`** |

## 二、两个陷阱（**都必须避开**）

1. **外层的 `HResult` 两种情形完全一样**（都是 `0x80131501`）—— 那是 PowerShell 包装异常的通用码，
   **不能用它区分** ✗。要区分必须看**内层** .NET 异常（`0x80070002` vs `0x80070003`）。
2. **`0x80070003` 不能单独证明「盘没了」** ✗ —— 实测边界：**盘在、但路径中间那层目录不存在**
   （`X:\nosuchdir\probe.txt`）**也**回 `0x80070003`。只凭这一个码，
   会把「盘在、子目录没了」误判成「盘没了」✗。

## 三、结论：能分开，但**必须先查盘根本身**

1. `Test-Path` / `File.Exists` 在「文件被删」与「盘没了」两种情形下**都回 False** —— 本身**无区分力** ✗。
2. 正确判据是**先查盘根**：
   - 盘根不存在（`Test-Path X:\` 为假 / `DriveInfo.IsReady` 为假）→ 判「**整个盘不在**」；
   - 盘根在、目标文件不存在 → 才谈「**文件被删**」。
3. 拿得到内层 .NET 异常时可以用它做旁证，但**不能只靠它**（见陷阱 2）。

> **给产品的一句话依据**：「文件被删」和「盘被拔」在 Windows 上都表现为"找不到"，
> 系统只在内层异常类型上给了线索，而且其中一个线索还会被"目录不存在"污染。
> 所以程序不能只凭一个路径下判断，**得先确认那个盘根还在不在**；盘根还在，才谈"文件被删"。

## 四、没测到 / 不确定的（**如实写，不许当成"已知"** ✗）

- **真 USB 拔插没做** ✗。`subst` 造的是**本地虚拟盘**（`DriveType=Fixed`），`/D` 之后**盘符整体消失**；
  真 U 盘拔掉后**盘符可能仍保留、只是 `IsReady=False`** —— 那种情况下 `Test-Path X:\` 是否仍回 False、
  异常码是否仍是 `0x80070003`，**没验**，**不能假设相同** ✗。
- **「盘符在、介质不在」那一格是空的**（本机 D/E/F 是虚拟光驱且 `IsReady=True`，没有可用的空介质盘符）✗。
- **网络盘 / UNC 路径没测** ✗（超时、凭据、断连的表现可能完全不同）。
- **WSL 映射盘（`\\wsl$\…`）没测** ✗。
- 只测了 **PowerShell 5.1 / .NET Framework**；**PowerShell 7 / .NET 6+ 没测** ✗。
- 只有**这一台、这一个版本**的 Windows。
- `subst` 是否 100% 等价于"卷被卸载"**未做磁盘级验证** ✗。

## 五、这一轮没动产品代码

只读核查 ✓：没改任何产品代码、没提交任何东西；造出来的盘符与目录都已清理 ✓（`subst` 列表为空、
`C:\<临时目录>` 已删 ✓）。
