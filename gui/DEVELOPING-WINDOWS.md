# 在 Windows 上验证（我们最大的验证缺口）

产品**以 Windows 为先**（王姐的电脑是 Windows），而开发一直在 macOS 上做。这份文档写清三件事：
我们缺什么、有哪些办法补上、以及**每次改完要在 Windows 上看什么**。

## 缺口到底是什么

macOS 上能做的：单元测试、`e2e.sh`（含 `cargo test`）、`dom-smoke.sh`（用 Chrome 渲染同一份前端产物）。
macOS 上**做不到**的（也就是我们真正缺的）：

1. **真 Windows + 真 WebView2 渲染**（字体、字号、中文排版、emoji 回退都可能和 Chrome/macOS 不同）；
2. **原生文件对话框**、中文路径、驱动器盘符；
3. **控制台黑窗**会不会闪（我们改过 `CREATE_NO_WINDOW`，但没在真 Windows 上确认过）；
4. **安装包**（NSIS/MSI）能不能装、能不能起；未签名时的 **SmartScreen / 杀软提示**长什么样；
5. **16GB 无独显机器上的手感**——这是画像机，也是 M4 Max 上永远感知不到的东西；
6. WPS（`.et`）、微信 PC、中文输入法这些**真环境**。

## 办法一：把 UI 验证搬进 CI（零成本，自动防回归）

Tauri 官方支持在 **Windows（Edge WebDriver / `msedgedriver`）** 与 Linux 上做 WebDriver 测试——
**macOS 不支持**，恰好我们缺的就是 Windows。所以：在 `windows-latest` 上构建应用、起
`tauri-driver` + `msedgedriver`、驱动**真实窗口**，断言简单界面的关键文案真的渲染出来
（与 `dom-smoke.sh` 同一组断言）。

- 优点：每次 PR 自动跑，不依赖谁的机器；抓到的是"Windows 上起不来 / 渲染不出来"这类硬故障。
- 局限：**原生文件对话框无法自动化**，所以只能走到"确认页"；不能替代人眼对字体/手感/安装体验的判断。
- 实现与状态：`gui/README.md` 末尾那节（以及 `.github/workflows/gui.yml` 里的 Windows job）。

## 办法二：在本机开一台 Windows 虚拟机（要看/要摸的时候）

Apple Silicon 只能虚拟化**同架构**的客户机，所以跑的是 **Windows 11 ARM**；x64/x64 应用靠
微软的 **Prism** 模拟运行（我们的 x64 安装包能跑，只是会慢一点——反过来这也更接近画像机的体感）。

| 方案 | 价格（2026） | 微软官方授权 | 说明 |
| --- | --- | --- | --- |
| **Parallels Desktop** | 约 $99.99/年 | ✅ 是（唯一被授权的第三方） | 一键装 Windows 11 ARM，最省心；**Windows 授权要另买**（x64 与 ARM 的密钥通用） |
| **VMware Fusion** | 免费 | 否 | 功能够用，3D 支持完整；免费方案里的首选 |
| **UTM** | 免费开源 | 否 | 只有软件渲染，整体最慢，但能用（我们的界面是 WebView2，不依赖 GPU） |
| **VirtualBox 7.2+** | 免费开源 | 否 | 3D 还是实验性 |
| **Windows 365 Cloud PC** | 订阅 | ✅ 是 | 云端 Windows，不用占本机磁盘；按订阅付费 |

**注意**：微软唯一"官方认可"的第三方是 Parallels（2023 年起）；其余方案能跑，但 Windows 的
授权与更新支持要自己担。合规敏感的场合选 Parallels 或 Windows 365。

**放哪里**：虚拟机系统盘 60–120GB。本机内部盘只剩几十 GB，**把镜像放到外置盘**
（`/Volumes/External`，还有 2.2TB）。Parallels / Fusion / UTM 都允许自定义位置。

**不要用的**：
- **Whisky / Wine**（本机已装）：Tauri 依赖 **WebView2（Edge）**，在 Wine 下基本跑不起来，
  而且它不是真实 Windows 环境——别在这上面花时间。
- **VirtualBuddy**（本机已装）：它只能跑 **macOS 客户机**，帮不上 Windows。

## 办法三：一台便宜的 Intel 小主机（最忠实，也最便宜）

如果能接受再添一台机器：**二手/全新 Intel N100 或 i5 小主机 + 16GB 内存（约 ¥700–1500）+ 远程桌面**。

- 它**就是画像机的规格**：16GB、无独显、真 Windows、真杀软、真 WPS、真微信——
  "在她那种电脑上到底是什么手感"只有这种机器能给答案；
- 顺带还能当 Windows 原生构建/试装机器（避免"只有 CI 能出安装包"）；
- 比任何虚拟机都便宜，而且不需要 Mac 常开。

## 每次要在 Windows 上过一遍的清单

按顺序做，每一条都写清"怎么看、算通过的标准是什么"。

1. **装得上、起得来**：把 `Cante_x.x.x_x64-setup.exe` 拷过去双击安装 → 开始菜单能启动 → 窗口出现。
   *通过*：不需要任何命令行操作；安装过程没有报错弹窗。
2. **未签名提示的第一印象**：记录 SmartScreen / 杀软（Windows Defender 或第三方）具体说了什么。
   *通过*：我们知道**用户会看到什么**，并且产品里有对应的解释文案；如果提示吓人，这就是必须解决的产品问题。
3. **启动不闪黑窗**：启动应用、点几张卡，全程盯着有没有控制台窗口一闪。
   *通过*：一次都没有。**不通过就是 bug**（我们在代码里处理过，但没在真 Windows 上确认）。
4. **文件选择与中文路径**：把要处理的文件放在 `C:\Users\<名字>\Desktop\测试 文件夹\` 这种**带空格和中文**的路径下，走一遍完整任务。
   *通过*：对话框能打开、能多选、路径不出乱码、结果文件落在**原文件旁边**且能在资源管理器里看到。
5. **「打开所在文件夹」真的打开**：在结果卡片上点它。
   *通过*：资源管理器打开到**那个文件夹**（不是"文档"或空白窗口）。
6. **WPS 的 `.et`**：用真 WPS 存一个 `.et`，选进来。
   *通过*：**在开始之前**就被说清"这是 WPS 自己的格式、读不了"，并且给出的"另存为 Excel 文件"这一步
   在真 WPS 里确实做得到（这是 #88 的文案能不能落地的唯一验证方式）。
7. **微信 PC 常开时的表现**：一边开着微信（含中文输入法）一边用它。
   *通过*：窗口切换正常、输入框能用中文输入法正常输入、**产品里没有任何"自动发送"的入口**；
   接龙/聊天记录"粘进来"这条路走得通。
8. **手感（16GB 机器）**：启动到能点第一张卡要多久？跑一张表的时候界面卡不卡？
   *通过*：启动几秒内可用；点击有即时反馈；没有"点了没反应"的瞬间。

## 发现问题怎么报回来

一句话就够，但请带上这四样（缺一样都会让我多花一轮去猜）：

1. **在哪一步**（上面清单的编号）；
2. **看到什么**（截图最好；文案/弹窗原文）；
3. **期望是什么**；
4. **机器信息**（Windows 版本、内存、是虚拟机还是真机——虚拟机上的性能问题不等于真机问题）。

我会把它落成 issue，按"能不能看懂 / 会不会弄坏她的东西 / 是不是白等"三条产品律排优先级。

## 用密钥登录那台测试机（免密码）

一次性配好，之后 `ssh win11` 就能直接进（我们本机的辅助脚本也走它）。

```bash
# 1) 生成一把**专用**密钥（不要复用主密钥：它只用来连这台测试机，能单独吊销）
ssh-keygen -t ed25519 -N "" -C "mac -> win11 test box" -f ~/.ssh/id_ed25519_win11

# 2) 把公钥放到 Windows 上（注意下面的坑）
scp ~/.ssh/id_ed25519_win11.pub win11@<IP>:C:/Users/<用户>/win11.pub

# 3) 在 Windows 上（用密码登录的一次会话即可）
#    —— 因为 win11 是**管理员**，Windows OpenSSH 只看中央文件，用户目录下的
#       authorized_keys 会被忽略！
$p = "C:\ProgramData\ssh\administrators_authorized_keys"
$key = (Get-Content "$env:USERPROFILE\win11.pub" -Raw).Trim()
Add-Content -Path $p -Value $key
#    ACL 必须收紧，否则 sshd 直接忽略这个文件
icacls $p /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"

# 4) 本机 ~/.ssh/config 写一条（用 IdentitiesOnly 避免试错别的密钥）
```

```
Host win11
    HostName <IP>
    User win11
    IdentityFile ~/.ssh/id_ed25519_win11
    IdentitiesOnly yes
    ServerAliveInterval 30
```

**验证必须用 BatchMode**（它不允许回退到密码，所以"能连上"就证明密钥真的生效）：

```bash
ssh -o BatchMode=yes win11 "whoami"
```

### 两个真实的坑

- **管理员账号的公钥位置**：`win11` 属于 Administrators，公钥必须进
  `C:\ProgramData\ssh\administrators_authorized_keys`（并且 ACL 只留
  `SYSTEM` 与 `Administrators`）；放在 `C:\Users\win11\.ssh\authorized_keys` 里**不会生效**，而且不会报错——你会以为密钥配错了。
- **cmd 不认分号**：Windows OpenSSH 默认 shell 是 `cmd.exe`，`whoami; hostname`
  会报 `Invalid argument/option - ';'`。要用 `&&`，或者直接用 PowerShell。

### 吊销与加固

- 吊销：删掉本机的 `~/.ssh/id_ed25519_win11*`，并从上面那个中央文件里删掉对应那一行；
- **密码登录默认仍然开着**：如果这台机器上还留着初始密码，建议改掉或关掉密码登录
  （`sshd_config` 里 `PasswordAuthentication no` 后重启 `sshd` 服务）——但先确认密钥能用，
  否则会把自己关在门外。
