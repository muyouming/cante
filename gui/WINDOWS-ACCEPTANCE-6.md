# 第六次真机验收：验收**发布出去的 v0.2.1 安装包**（重点：装完目录干净了吗）

- 验收对象：GitHub Release **`gui-v0.2.1`**（tag 指向 `75843c9`；验收时 `origin/main` 也是这个提交），
  资产 `Cante_0.2.1_x64-setup.exe`（NSIS）与 `Cante_0.2.1_x64_en-US.msi`。
- 验收机器：Windows 11 Home 25H2 / `10.0.26200` / x64（真机）；WebView2 运行时 `153.0.4234.32`。
- 起始提交：`75843c9`；工作分支：`pool2/accept-021`。
- 验收人：跑在那台机器上的 pi（**无交互桌面**，限制见 §5）。
- 原始输出：`%TEMP%\cante-acc6\`（文件名编号与本报告各节对应）。
- 本报告里所有长命令都带超时；**没有一条超时**（下文的「确认没有」都是**列过目录/查过注册表**才写的）。

---

## 0. 结论先行：**干净了，而且两份包内容对得上**

| | 0.2.0（验收前机器上那份旧安装） | **0.2.1（本次装的发布包）** |
| --- | --- | --- |
| 顶层文件 | 4 个（`cante-gui` / `cante-sheets` / `cante-pdf` / `uninstall`） | **5 个**（上面 4 个 + `cante-bridge`） |
| 目录 | 有 `target\release\` | **0 个目录** |
| `.d` 文件 | **2 个**（`cante-pdf.d` 1806 B、`cante-sheets.d` 1812 B） | **0 个（确认没有）** |
| 0 字节的无扩展名文件 | **2 个**（`target\release\cante-pdf`、`cante-sheets`） | **0 个（确认没有，连任何 0 字节文件都没有）** |
| 版本资源 | 0.2.0 | 全部 **0.2.1** |
| 两个工具能跑吗 | — | `cante-sheets --version` → `cante-sheets 0.2.1`（exit 0）；`cante-pdf --version` → `cante-pdf 0.2.1`（exit 0） |

**一句话**：0.2.0 的「`target/release` 整个 glob 进去」那条路留下的垃圾，在这一版里**一个都没有了**；
装完就是「主程序 + 三个自带 exe + 卸载器」5 个文件，没有目录、没有 `.d`、没有 0 字节文件。
（任务里说「有 3 个 exe」——实测是 **4 个 exe**：必须的 3 个之外还有 `cante-bridge.exe`，
它和另外三个 helper 一样是 `[[bin]]`，由 tauri 自动装到主程序旁边；再加卸载器一共 5 个文件，
正好对上「10 → 5」。）

另外两份包**内容对应**：都是同样 4 个 exe、同名同大小；唯一差异是 `cante-gui.exe` 里有 **2 个字节**
（tauri 自己嵌的 bundle 类型标记 `BUNDLE_TYPE_VAR_NSS` ↔ `BUNDLE_TYPE_VAR_MSI`），§1.4 有原样对比。

启动全新档案后的第一屏**是中文简单模式向导第 1 步**，窗口文字原样贴在 §3。
卸载后**安装目录、注册表卸载项、开始菜单与桌面快捷方式全部清掉**，只剩 WebView2 用户档案（§4）。

---

## 1. 包内清单

### 1.1 下载与校验

```
gh release download gui-v0.2.1 --repo <仓库> --pattern Cante_0.2.1_x64-setup.exe --pattern Cante_0.2.1_x64_en-US.msi
```

```
891c64272c56478c36286300f8c273ba8f05079ff7d7dcc1a44ed5817c6168e7 *Cante_0.2.1_x64-setup.exe   (3,553,110 B)
2544410d094babeabcc664fcdbf7a484f1043ca196a349bac6205c892ec8e93f *Cante_0.2.1_x64_en-US.msi    (5,840,896 B)
```

与 Release 资产自带的 digest **逐字符一致**（setup `sha256:891c64…6168e7`、msi `sha256:2544410…c8e93f`）。

安装器自己的版本资源：`FileDescription=Cante / FileVersion=0.2.1 / ProductName=Cante / ProductVersion=0.2.1`。

### 1.2 NSIS 包内容（`7z l/x`，`inspect-installer.ps1`）

```
$PLUGINSDIR\System.dll / modern-wizard.bmp / nsDialogs.dll / nsis_tauri_utils.dll / StartMenu.dll / NSISdl.dll
cante-gui.exe     10,295,808 B
cante-bridge.exe     708,608 B
cante-pdf.exe      2,174,976 B
cante-sheets.exe   2,504,192 B
uninstall.exe         79,142 B
```

### 1.3 MSI 内容（`msiexec /a` 管理安装，只解包不注册）

```
\PFiles\Cante\cante-bridge.exe     708,608 B
\PFiles\Cante\cante-gui.exe     10,295,808 B
\PFiles\Cante\cante-pdf.exe      2,174,976 B
\PFiles\Cante\cante-sheets.exe   2,504,192 B
```

> 注意：管理安装解出来的树是 `PFiles\Cante`，也就是说 **MSI 默认往 `Program Files` 装（每机、
> 需要管理员）**，和 NSIS 的 `currentUser`（装到 `%LOCALAPPDATA%\Cante`）不是同一种安装方式。
> **这一条是按解包目录树推断的，我没有真正安装 MSI 去实测落点**（§5 第 2 条）。

### 1.4 两份包「是否对应」：逐文件 sha256

| 文件 | NSIS 包里 | MSI 包里 | 结论 |
| --- | --- | --- | --- |
| `cante-gui.exe` | `28164d8f…89abd8` | `2007090f…baf9f1` | 同大小，**不同**（见下） |
| `cante-bridge.exe` | `b848aa2b…2ebaeee` | `b848aa2b…2ebaeee` | 一致 |
| `cante-pdf.exe` | `3256485c…3c4087a` | `3256485c…3c4087a` | 一致 |
| `cante-sheets.exe` | `2a2fde69…1464b116` | `2a2fde69…1464b116` | 一致 |

`cante-gui.exe` 的差异**只有 2 个字节**，而且就在 tauri 自己嵌的 bundle 类型标记里（逐字节 diff 原文）：

```
0x75a1c2  1 byte
0x75a1c4  1 byte
nsis : b'BUNDLE_TYPE_VAR_NSS\xc0\x00text/csstext'
msi  : b'BUNDLE_TYPE_VAR_MSI\xc0\x00text/csstext'
```

即 NSIS 包写 `NSS`、MSI 包写 `MSI`，其余 10,295,806 字节完全相同。**这是打包格式自己带的标记，
不是两份程序不一样** —— 两个 exe 的 `FileVersion`/`ProductVersion` 都是 0.2.1。

### 1.5 签名与「来自互联网」标记

```
Cante_0.2.1_x64-setup.exe        NotSigned  signer=<无>
Cante_0.2.1_x64_en-US.msi        NotSigned  signer=<无>
cante-gui.exe / cante-sheets.exe / cante-pdf.exe / cante-bridge.exe  NotSigned  signer=<无>
```

两份包**都没有 Authenticode 签名**。本次是命令行（`gh`）下载的，**没有 `Zone.Identifier`（Mark of the Web）**，
所以这次安装没触发 SmartScreen。用户用浏览器下载会带上 MoW，那时会不会弹「未知发布者」**这次没验证**（§5 第 1 条）。

---

## 2. 装完清单（NSIS 静默安装）

安装：`Cante_0.2.1_x64-setup.exe /S` → 退出码 0，**1.1 秒**完成。

安装目录 `%LOCALAPPDATA%\Cante` 的**完整递归清单**（`Get-ChildItem -Recurse -Force`，含大小）：

```
      708608  \cante-bridge.exe
    10295808  \cante-gui.exe
     2174976  \cante-pdf.exe
     2504192  \cante-sheets.exe
       79142  \uninstall.exe
```

```
文件总数 = 5，目录数 = 0
exe: cante-bridge.exe, cante-gui.exe, cante-pdf.exe, cante-sheets.exe, uninstall.exe
```

**必须有的 4 个（确认都在）**

```
OK   cante-gui.exe      10,295,808 B
OK   cante-sheets.exe    2,504,192 B
OK   cante-pdf.exe       2,174,976 B
OK   uninstall.exe          79,142 B
```

**必须没有的（确认没有）**

```
.d 文件：                        没有 .d 文件（确认没有）
0 字节的无扩展名文件：           没有（确认没有）
任何 0 字节文件（不限扩展名）：  一个 0 字节文件都没有
子目录：                         0 个
```

**版本资源（全部 0.2.1）**

```
cante-gui.exe     FileVersion=0.2.1  ProductVersion=0.2.1
cante-sheets.exe  FileVersion=0.2.1  ProductVersion=0.2.1
cante-pdf.exe     FileVersion=0.2.1  ProductVersion=0.2.1
cante-bridge.exe  FileVersion=0.2.1  ProductVersion=0.2.1
uninstall.exe     FileVersion=0.2.1  ProductVersion=0.2.1
```

**装到盘上的哈希（与 NSIS 包内的一致 → 安装器发的就是包里的那几份）**

```
b848aa2b…2ebaeee    708608  cante-bridge.exe
28164d8f…89abd8   10295808  cante-gui.exe      ← 与 NSIS 包内一致
3256485c…3c4087a   2174976  cante-pdf.exe
2a2fde69…1464b116  2504192  cante-sheets.exe
ea6cc7ad…8efd677     79142  uninstall.exe
```

**两个自带工具能直接执行**（直接调安装目录里的 exe）：

```
C:\...\Cante\cante-sheets.exe --version   → cante-sheets 0.2.1        exit 0
C:\...\Cante\cante-pdf.exe    --version   → cante-pdf 0.2.1           exit 0
C:\...\Cante\cante-bridge.exe --version   → cante-bridge 0.2.1        exit 0   （额外顺手验的）
cante-sheets.exe（无参数）                 → 中文用法，exit 2（不是只会答版本）
```

**对照：装之前机器上那份 0.2.0 的旧安装**（同一台机器，验收开始时先记录、再卸载清场）：

```
[DIR ] \target
       10328064  \cante-gui.exe        (0.2.0)
        2177024  \cante-pdf.exe        (0.2.0)
        2513408  \cante-sheets.exe     (0.2.0)
          79156  \uninstall.exe
[DIR ] \target\release
              0  \target\release\cante-pdf          ← 0 字节、无扩展名
           1806  \target\release\cante-pdf.d
              0  \target\release\cante-sheets       ← 0 字节、无扩展名
           1812  \target\release\cante-sheets.d
        2177024  \target\release\cante-pdf.exe
        2513408  \target\release\cante-sheets.exe
```

这就是「0.2.0 混着 4 个垃圾文件」的现场；0.2.1 装完那份里**一个都没有**。

---

## 3. 窗口文字（全新档案 + UI Automation）

先删掉应用档案目录（`%LOCALAPPDATA%\dev.cante.gui`，WebView2 与 localStorage 都在里面），
让它以**全新档案**启动，然后跑 `gui/scripts/windows/dump-window-text.ps1 -ForceAccessibility`。

```
MainWindowTitle  = 'Cante'
UI Automation 树（节选，原样）：
  Document | Cante
    Group |
      Text   | Cante
      Button | 历史
      Button | 隐私
    Group |
      List   | 进度
        ListItem | 1欢迎
          Group |   Text | 1
        ListItem | 2检查电脑
        ListItem | 3开始使用
      Text   | 欢迎使用 Cante
      Text   | 我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先检查一下你的电脑，好吗？
      Button | 开始检查
```

**确认：第一屏就是中文简单模式向导第 1 步（欢迎）**，没有出现任何英文界面或术语。

### 关于「欢迎语 + 三件事」那类新文案：**这一版里没有，如实说**

窗口里读到的与欢迎有关的文字只有上面三行（标题、欢迎语、按钮）+ 三步进度条，
**没有**「三件事」那类交代文案。

原因是查证过的，不是没读到：

```
$ git merge-base --is-ancestor 2df9808 75843c9   → 不是祖先
$ git log --oneline 75843c9..origin/main          → 空（origin/main 就是 tag 那个提交）
```

`2df9808`（`feat(gui): 头 60 秒教她第一句话怎么说……向导最后一步交代三件事`）
是**另一条还没合进这个 tag 的工作**；`gui-v0.2.1` 的代码里根本没有那段文案，
所以安装出来的窗口不可能显示它。**「0.2.1 加过」这个前提与 tag 的实际内容不符。**

（另外：向导第 2 步「检查电脑」与第 3 步没有点进去——SSH 会话里点不动原生控件，
§5 第 3 条；所以「最后一步交代三件事」即使以后合进来，这一轮也读不到。）

---

## 4. 卸载残留

静默卸载：`%LOCALAPPDATA%\Cante\uninstall.exe /S` → 退出码 0。（第二轮为了取哈希又装了一次，
卸载行为与第一轮一致；下面列的是**逐个查过**的位置。）

| 检查位置 | 卸载前 | 卸载后 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Cante`（安装目录） | 存在，5 个文件 | **不存在（确认清掉）**，目录内无残留文件 |
| 注册表 `HKCU\...\Uninstall` 里 DisplayName `Cante` | 有（Version=0.2.1，UninstallString 指 `uninstall.exe`） | **没有（确认清掉）** |
| 注册表 `HKLM\...\Uninstall` / `WOW6432Node` | 无 | 无 |
| 开始菜单 `...\Start Menu\Programs\Cante.lnk` | 有 | **没有（确认清掉）** |
| 桌面 `Cante.lnk` | 有 | **没有（确认清掉）** |
| `%APPDATA%\Cante` | 不存在 | 不存在 |
| `%USERPROFILE%\.cante` | 不存在 | 不存在 |
| `%USERPROFILE%\.ante` | 不存在 | 不存在 |
| `%LOCALAPPDATA%\dev.cante.gui`（WebView2 + localStorage） | 存在 | **仍然存在（唯一残留）**：169 个文件、8.41 MB |

**结论**：卸载把「装进去的东西」清得很干净（目录、注册表、两处快捷方式全没了）；
唯一留下的是 **WebView2 用户档案** `%LOCALAPPDATA%\dev.cante.gui`，属于用户数据/浏览器缓存。
这是常见做法（下次重装还认得她的设置），但**严格说它叫「残留」**，所以照实列在这里。

---

## 5. 我没能验证什么

1. **SmartScreen 的真实表现**：这次是命令行下载、**没有 Mark of the Web**，所以没触发。
   用户用浏览器下载（带 MoW）+ 包**未签名**（§1.5）时会怎样，**没验证**。要看真画面要 RDP。
2. **MSI 我没有真正安装**：只做了 `msiexec /a`（管理安装/解包）来比内容。
   所以「MSI 装到哪里（Program Files？需要管理员吗？）」是**按解包目录树推断**的，
   MSI 的安装与卸载路径**都没实测**。
3. **向导第 2、3 步没点进去**：SSH 会话没有可点的交互桌面，原生文件对话框/控件点不动。
   这一轮只读到第 1 屏（§3）。「欢迎语 + 三件事」那段新文案也因此没读到——它本来也不在本 tag 里。
4. **没有截图 / 没有看画面**：判定依据是 UI Automation 读出的文字，不是像素。
   控制台黑窗有没有闪、字好不好看、窗口大小对不对，**都没看**。
5. **没有在「干净机器」上验 WebView2 引导**：这台机器已经装了 WebView2 `153.0.4234.32`，
   所以 `webviewInstallMode=downloadBootstrapper`（需要联网下载运行时）这条路径**没走到**。
6. **没有验「装了之后真的能干活」**：本轮只验安装包与第一屏；用发布包跑一张真实任务
   需要配 `CANTE_BIN`/`PI_BIN`，那是上一次验收（`WINDOWS-ACCEPTANCE-5.md`）的范围，
   本轮**没有重复**。
7. **macOS / Linux 产物**：这一轮只碰 Windows 的 `.exe`/`.msi`（Release 里还有一份 aarch64 dmg，没下载、没验）。

**「超时」与「确认没有」分开写**：本节所有命令都带超时（下载 300s、安装 600s、卸载 300s、
窗口读取 300s、目录列取 300s），**一次都没有超时**；所有「确认没有/确认清掉」都是
**列过目录、查过注册表、逐条比对过**才写的。

---

## 附：这一轮动过的东西

| 文件 | 动作 |
| --- | --- |
| `gui/WINDOWS-ACCEPTANCE-6.md` | 新增（本文件） |

**没有改任何产品代码**（`gui/src/**`、`gui/src-tauri/**`、脚本、AGENTS.md 一个字节没动）。
仓库外只多了一个工作目录 `%TEMP%\cante-acc6\`（报告里引用的原始输出都在那里）：

```
01-inspect-msi.txt         MSI 7-Zip 清单 + msiexec /a 解包
02-inspect-nsis.txt        NSIS 包清单与解包
03-existing-install.txt    装之前那份 0.2.0 的目录与版本（含 4 个垃圾文件）
04-uninstall-020.txt       清场：卸载 0.2.0
05-install-021.txt         静默安装 0.2.1（退出码 0，1.1s）
06-installed-tree.txt      装完目录递归清单 + 必需/禁止项检查
07-tools-run.txt           两个工具 --version（含无参数用法）
08-profile-before.txt      全新档案前：相关目录存在情况
09-window-text.txt         UI Automation 读到的窗口文字（第一屏）
10-uninstall-021-leftovers.txt  卸载残留（含唯一残留 dev.cante.gui 的大小）
11-installed-hashes.txt    装到盘上的哈希 + 两个包 gui 的版本资源
12-uninstall-second.txt    第二次卸载（为取哈希重装后）
13-environment.txt         OS / WebView2 版本
14-signatures.txt          Authenticode 签名状态
```
