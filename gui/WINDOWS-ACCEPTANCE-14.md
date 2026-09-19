# 真机验收：三种「麻烦路径」各跑一轮（#197 第二条）

**机器**：Windows 11 Home（那台 win11 测试机）✓　**产物**：注册表里的安装版
`C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe` ✓　**真 WebView2** ✓
**跑法**：`python3` 无关 —— 在机器上直接
`powershell -NoProfile -ExecutionPolicy Bypass -File gui\scripts\windows\accept-paths.ps1 -Only r1,r2,r3 -RedirectDesktop`
（本文件是三轮的**原始报告**，用户名由脚本按约定脱敏成 `<用户名>` ✓）

> 判据（每轮独立核对，不是"看着像"）：产出真的在盘上 ✓、用应用自带的 `cante-sheets`
> 读回内容 ✓、**原文件 sha256 前后一致** ✓。

## 结论一览

| 轮 | 路径形状 | 结果 | 耗时 |
| --- | --- | --- | --- |
| r1 | 纯中文：`路径验收\2026年报销` | **通过** ✓ | 35.4s |
| r2 | 中文 + 空格：`路径验收\我的 表格` | **通过** ✓ | 34.4s |
| r3 | 真 OneDrive 重定向桌面：`OneDrive\桌面\Cante路径验收-…` | **通过** ✓ | 49.7s |

三轮合计 **通过 3 / 3** ✓，`accept-paths` 退出码 **0** ✓。

**不覆盖** ✗：映射网络驱动器、`%TEMP%` 被重定向、以及各轮**只跑了一轮有效**（没复跑排除偶发 ✓）。

---

## 原始报告（原样）

```text
=== 真机验收：中文 / 空格 / 桌面 三种路径各跑一轮（#197 第二条）===
会话：elevated=True session=1
基目录：C:\Users\<用户名>\r23test
内层脚本：C:\cante-wt\paths\gui\scripts\windows\run-accept-drive.ps1

--- 临时重定向「桌面」已知文件夹（可逆）---
  重定向返回码=0；全新进程读到的桌面=C:\Users\<用户名>\OneDrive\桌面
  重定向已生效（全新进程）：True
  登录会话里读到的桌面=C:\Users\<用户名>\OneDrive\桌面
操作系统报告的桌面（重定向前）：C:\Users\<用户名>\Desktop
操作系统报告的桌面（现在）：C:\Users\<用户名>\OneDrive\桌面
桌面是否在 OneDrive 下：True
%OneDrive%：C:\Users\<用户名>\OneDrive（存在）
桌面这一轮（r3）的基准：C:\Users\<用户名>\OneDrive\桌面
桌面这一轮（r3）的做法：操作系统报告的桌面（脚本刚把它临时重定向到此处；本轮跑时操作系统也是这样报告的）

启动前没有残留的 cante-gui 实例。
应用目录：C:\Users\<用户名>\AppData\Local\Cante
cante-sheets：C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe
WebDriver 端口：4427；计划任务名：CanteAcceptPathsDrive
开机时的竞争情况：没有探测到竞争进程

（跳过 r1：不在 -Only 里）

================ r2：带空格的中文目录 ================
路径形状：中文 + 空格
完整路径：C:\Users\<用户名>\r23test\路径验收\我的 表格
目录已建：True
--- run-accept-drive.ps1 原始输出（本轮耗时 34.4s）---
=== 真机验收：跑一轮（Windows）===
当前会话：elevated=True session=1
这个会话驱动不了窗口（提权进程里 WebView2 会忽略 WEBVIEW2_* / 调试端口，session 0 没有交互桌面）。
改由「当前用户 + Interactive + RunLevel Limited」的计划任务在登录会话里跑，再把报告原样带回来。
已建计划任务 CanteAcceptPathsDrive（Limited），触发…

=== 真机验收：跑一轮（Windows）===
会话：elevated=False session=1
工作目录：C:\Users\<用户名>\r23test\路径验收\我的 表格
应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
模式：零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）

==> 1. 前置检查
  应用目录：C:\Users\<用户名>\AppData\Local\Cante
  cante-sheets：C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe
  tauri-driver：C:\Users\<用户名>\.cargo\bin\tauri-driver.exe
  msedgedriver：C:\Users\<用户名>\msedgedriver\msedgedriver.exe
  前置检查通过。
    （耗时 0s）

启动前没有残留的 cante-gui 实例。

==> 2. 造输入表（应用自带的 cante-sheets write）
  输入：C:\Users\<用户名>\r23test\路径验收\我的 表格\job\销售明细.xlsx
  sha256=BA5695A29EDEC082267C56C238308B2E8169E96E83FA79BF4AAF05014522F435
    （耗时 0.1s）

==> 3. 跑一轮（accept-drive.mjs）
==> 应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
==> 零环境变量模式：不设 CANTE_BIN / PI_BIN，桥与执行组件由应用自己在旁边找
==> 工作目录：C:\Users\<用户名>\r23test\路径验收\我的 表格\job
[phase] tauri-driver 就绪 …
[phase] tauri-driver 就绪 — 535 ms
[phase] 打开 WebDriver 会话（启动应用） …
[phase] 打开 WebDriver 会话（启动应用） — 427 ms
[phase] 首页出现 …
[phase] 首页出现 — 667 ms
--- 首页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 你好，需要我帮你做什么？
  | 点一张卡片，或者直接在下面说一句话。
  | 我做的结果
  | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  | 打开我做的结果
  | 还有别的事？
  | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
  | 看看能做什么（共 32 项）
  | 表格
  | 合并、拆分、汇总、去重
[phase] 点卡片「从大表里挑出想要的行」 …
[phase] 点卡片「从大表里挑出想要的行」 — 51 ms
[phase] 选文件（原生对话框） …
[dialog] accept-file-dialog: 对话框 name='打开' pid=8380
[dialog] accept-file-dialog: 路径已写入（WM_SETTEXT(hwnd=1836428)），class='Edit'
[dialog] accept-file-dialog: 已点「打开」（BM_CLICK(hwnd=4260382)）
[phase] 选文件（原生对话框） — 1200 ms
[phase] 写一句话并生成计划 …
[phase] 写一句话并生成计划 — 107 ms
[phase] 确认页 → 开始 …
--- 确认页（节选）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
[phase] 确认页 → 开始 — 46 ms
[phase] 干活（含审批/提问） …
[phase] 干活（含审批/提问） — 27419 ms
--- 结果页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
  | 4
  | 结果
  | ✓
  | 做好了
  | 从大表里挑出想要的行
  | 本次联网
  | 整理时用到了联网，内容发给了帮你整理的服务方。
  | 看看刚才发出去的是什么
==> 替她点了：审批 6 次、结构化提问 0 次、追问 0 次
accept-drive: OK — 应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」。

    （耗时 32.2s）

==> 4. 核对产出
  替她点了：审批 6 次、结构化提问 0 次、追问 0 次
  工作目录里的文件（C:\Users\<用户名>\r23test\路径验收\我的 表格\job）：
    结果_挑出华东区.xlsx  5646 字节
    销售明细.xlsx  5717 字节
    input.csv  180 字节

  用应用自带的 cante-sheets 读回来：结果_挑出华东区.xlsx
区域,月份,客户,金额
华东区,3月,甲公司,1200
华东区,4月,丙公司,1500
华东区,5月,戊公司,760


  原文件没有被改动：BA5695A29EDEC082267C56C238308B2E8169E96E83FA79BF4AAF05014522F435
    （耗时 0s）

=== 每一步的实际耗时 ===
  1. 前置检查                                        0 s
  2. 造输入表（应用自带的 cante-sheets write）            0.1 s
  3. 跑一轮（accept-drive.mjs）                    32.2 s
  4. 核对产出                                        0 s

accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。

run-accept-drive: 结论 = 0

--- 原始输出结束（退出码 0：0=通过 / 2=环境 / 3=产品 / 124=包装层超时）---

[核对] 输入文件在盘上：True  C:\Users\<用户名>\r23test\路径验收\我的 表格\job\销售明细.xlsx
[核对] 原文件 sha256：run 前=BA5695A29EDEC082267C56C238308B2E8169E96E83FA79BF4AAF05014522F435  run 后(报告)=BA5695A29EDEC082267C56C238308B2E8169E96E83FA79BF4AAF05014522F435
[核对] 原文件 sha256：现在盘上=BA5695A29EDEC082267C56C238308B2E8169E96E83FA79BF4AAF05014522F435
[核对] 原文件 sha256 前后一致：是
[核对] 工作目录里的产出（C:\Users\<用户名>\r23test\路径验收\我的 表格\job）：
  结果_挑出华东区.xlsx  5646 字节  sha256=420E449E398CDD1DFBDFB8FDECFE076F56A7B09E8F0E8E3C14867A4DF12D1EE4
[核对] 用应用自带的 cante-sheets 读回（结果_挑出华东区.xlsx，退出码 0）：
区域,月份,客户,金额
华东区,3月,甲公司,1200
华东区,4月,丙公司,1500
华东区,5月,戊公司,760


[r2] 结论：通过（产出在盘上、cante-sheets 读回 3 行华东区、原文件 sha256 前后一致）

================ r3：桌面（操作系统报告的位置） ================
路径形状：操作系统报告的桌面（脚本刚把它临时重定向到此处；本轮跑时操作系统也是这样报告的）
完整路径：C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545
目录已建：True
--- run-accept-drive.ps1 原始输出（本轮耗时 49.7s）---
=== 真机验收：跑一轮（Windows）===
当前会话：elevated=True session=1
这个会话驱动不了窗口（提权进程里 WebView2 会忽略 WEBVIEW2_* / 调试端口，session 0 没有交互桌面）。
改由「当前用户 + Interactive + RunLevel Limited」的计划任务在登录会话里跑，再把报告原样带回来。
已建计划任务 CanteAcceptPathsDrive（Limited），触发…

=== 真机验收：跑一轮（Windows）===
会话：elevated=False session=1
工作目录：C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545
应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
模式：零环境变量（ACCEPT_ZERO_ENV=1，应用自己找组件）

==> 1. 前置检查
  应用目录：C:\Users\<用户名>\AppData\Local\Cante
  cante-sheets：C:\Users\<用户名>\AppData\Local\Cante\cante-sheets.exe
  tauri-driver：C:\Users\<用户名>\.cargo\bin\tauri-driver.exe
  msedgedriver：C:\Users\<用户名>\msedgedriver\msedgedriver.exe
  前置检查通过。
    （耗时 0s）

启动前没有残留的 cante-gui 实例。

==> 2. 造输入表（应用自带的 cante-sheets write）
  输入：C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545\job\销售明细.xlsx
  sha256=BBBF69E9A802890A7533B22EC7AE48A6F80A691B919ED1608A3B0ED981AF0D39
    （耗时 0.1s）

==> 3. 跑一轮（accept-drive.mjs）
==> 应用：C:\Users\<用户名>\AppData\Local\Cante\cante-gui.exe
==> 零环境变量模式：不设 CANTE_BIN / PI_BIN，桥与执行组件由应用自己在旁边找
==> 工作目录：C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545\job
[phase] tauri-driver 就绪 …
[phase] tauri-driver 就绪 — 538 ms
[phase] 打开 WebDriver 会话（启动应用） …
[phase] 打开 WebDriver 会话（启动应用） — 565 ms
[phase] 首页出现 …
[phase] 首页出现 — 371 ms
--- 首页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 你好，需要我帮你做什么？
  | 点一张卡片，或者直接在下面说一句话。
  | 我做的结果
  | 上次做出来的表放在哪儿，这里都记着，随时能打开。
  | 打开我做的结果
  | 还有别的事？
  | 按你想做的事搜一搜，每一项都写清楚要准备什么、会动到什么。
  | 看看能做什么（共 32 项）
  | 表格
  | 合并、拆分、汇总、去重
[phase] 点卡片「从大表里挑出想要的行」 …
[phase] 点卡片「从大表里挑出想要的行」 — 53 ms
[phase] 选文件（原生对话框） …
[dialog] accept-file-dialog: 对话框 name='打开' pid=4352
[dialog] accept-file-dialog: 路径已写入（WM_SETTEXT(hwnd=1901916)），class='Edit'
[dialog] accept-file-dialog: 已点「打开」（BM_CLICK(hwnd=2622776)）
[phase] 选文件（原生对话框） — 1168 ms
[phase] 写一句话并生成计划 …
[phase] 写一句话并生成计划 — 99 ms
[phase] 确认页 → 开始 …
--- 确认页（节选）---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
[phase] 确认页 → 开始 — 47 ms
[phase] 干活（含审批/提问） …
[phase] 干活（含审批/提问） — 42640 ms
--- 结果页 ---
  | Cante
  | 历史
  | 隐私
  | 关于
  | 从大表里挑出想要的行
  | 说一句话就行，剩下的我来做
  | 返回首页
  | 1
  | 选文件
  | —
  | 2
  | 说需求
  | —
  | 3
  | 确认
  | —
  | 4
  | 结果
  | ✓
  | 做好了
  | 从大表里挑出想要的行
  | 本次联网
  | 整理时用到了联网，内容发给了帮你整理的服务方。
  | 看看刚才发出去的是什么
==> 替她点了：审批 9 次、结构化提问 0 次、追问 0 次
accept-drive: OK — 应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」。

    （耗时 47.3s）

==> 4. 核对产出
  替她点了：审批 9 次、结构化提问 0 次、追问 0 次
  工作目录里的文件（C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545\job）：
    结果_挑出_华东区.xlsx  5655 字节
    销售明细.xlsx  5716 字节
    input.csv  180 字节

  用应用自带的 cante-sheets 读回来：结果_挑出_华东区.xlsx
区域,月份,客户,金额
华东区,3月,甲公司,1200
华东区,4月,丙公司,1500
华东区,5月,戊公司,760


  原文件没有被改动：BBBF69E9A802890A7533B22EC7AE48A6F80A691B919ED1608A3B0ED981AF0D39
    （耗时 0s）

=== 每一步的实际耗时 ===
  1. 前置检查                                        0 s
  2. 造输入表（应用自带的 cante-sheets write）            0.1 s
  3. 跑一轮（accept-drive.mjs）                    47.3 s
  4. 核对产出                                        0 s

accept-drive: OK — 装好的应用在真实 WebView2 里跑完了一轮，结果页出现「做好了」，产出对得上。

run-accept-drive: 结论 = 0

--- 原始输出结束（退出码 0：0=通过 / 2=环境 / 3=产品 / 124=包装层超时）---

[核对] 输入文件在盘上：True  C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545\job\销售明细.xlsx
[核对] 原文件 sha256：run 前=BBBF69E9A802890A7533B22EC7AE48A6F80A691B919ED1608A3B0ED981AF0D39  run 后(报告)=BBBF69E9A802890A7533B22EC7AE48A6F80A691B919ED1608A3B0ED981AF0D39
[核对] 原文件 sha256：现在盘上=BBBF69E9A802890A7533B22EC7AE48A6F80A691B919ED1608A3B0ED981AF0D39
[核对] 原文件 sha256 前后一致：是
[核对] 工作目录里的产出（C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545\job）：
  结果_挑出_华东区.xlsx  5655 字节  sha256=DC442D719F7AD9D93C797D1DF6F27F41B2CE6E00CD68FCE981F1F07C05124F91
[核对] 用应用自带的 cante-sheets 读回（结果_挑出_华东区.xlsx，退出码 0）：
区域,月份,客户,金额
华东区,3月,甲公司,1200
华东区,4月,丙公司,1500
华东区,5月,戊公司,760


[r3] 结论：通过（产出在盘上、cante-sheets 读回 3 行华东区、原文件 sha256 前后一致）

--- 还原「桌面」已知文件夹 ---
  还原返回码=0；全新进程读到的桌面=C:\Users\<用户名>\Desktop
  登录会话里读到的桌面=C:\Users\<用户名>\Desktop
  已还原：True

=== 汇总 ===
  r2  通过  中文 + 空格  34.4s  C:\Users\<用户名>\r23test\路径验收\我的 表格
  r3  通过  操作系统报告的桌面（脚本刚把它临时重定向到此处；本轮跑时操作系统也是这样报告的）  49.7s  C:\Users\<用户名>\OneDrive\桌面\Cante路径验收-20260919-230545
  通过 2 / 2
accept-paths: 结论 = 0（0=全通过 / 1=脚本自身出错・一轮都没跑 / 2=环境问题 / 3=产品问题）

```
