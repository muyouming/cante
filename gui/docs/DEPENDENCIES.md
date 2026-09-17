# 依赖告警台账（DEPENDENCIES.md）

> 这份文件回答一个问题：**Dependabot 上那几条依赖告警，哪些修了、哪些是「有理由地接受」、
> 什么时候必须回头看。** 每条都写清四件事：是什么、会不会到用户机器上、为什么现在不动、
> 什么条件下必须动。
>
> 写给下一个人直接读，不用再去翻告警页面把同一套推理重做一遍。凡是我**推断**的都标出来；
> 文末有「我没能验证的」一节。

---

## 0. 先看这一节

写这份台账的时间点，`gh api repos/muyouming/cante/dependabot/alerts` 上开着 **4 条**告警，
按生态分是 **1 条 Rust + 3 条 npm**。处置如下：

| # | 包 | 生态 | 级别 | manifest | 会不会进用户安装包 | 处置 |
| --- | --- | --- | --- | --- | --- | --- |
| 67 | `glib` | rust | medium | `gui/src-tauri/Cargo.lock` | **不会**（macOS/Windows 上根本不编译；Linux 不发安装包） | **有理由地接受**，见 §2 |
| 4 | `serialize-javascript` | npm | high | `docs-site/package-lock.json` | **不会**（只在 CI 构建文档站时跑） | **已修**：6.0.2 → 7.0.5，见 §3 |
| 7 | `serialize-javascript` | npm | medium | `docs-site/package-lock.json` | 同上 | **已修**（同上一条一次解决） |
| 6 | `uuid` | npm | medium | `docs-site/package-lock.json` | **不会**（同上） | **已修**：8.3.2 → 11.1.1，见 §4 |

**注意**：GitHub 上的告警状态要等这次改动合进默认分支才会变（Dependabot 读的是默认分支上的
manifest）。也就是说：**这份台账写下时页面上还是 4 条，合入之后应该是 1 条**。这一点别误读成
「改了没用」。

---

## 1. 怎么复查

本机（需要 `gh` 已登录）：

```bash
gh api "repos/muyouming/cante/dependabot/alerts?state=open&per_page=50" \
  | python3 -c "import json,sys;[print(a['number'], a['dependency']['package']['ecosystem'], a['dependency']['package']['name'], a['security_advisory']['severity'], a['dependency']['manifest_path']) for a in json.load(sys.stdin)]"
```

Rust 侧只用 Cargo 自己的命令就能确认「升不动」，不需要装额外工具：

```bash
source gui/scripts/toolchain.sh
cargo update --manifest-path gui/src-tauri/Cargo.toml -p glib --dry-run   # 有没有更新的 0.18.x
cargo update --manifest-path gui/src-tauri/Cargo.toml -p glib --precise 0.20.0   # 能不能跳到修复版
cargo tree  --manifest-path gui/src-tauri/Cargo.toml -i glib --target aarch64-apple-darwin
cargo tree  --manifest-path gui/src-tauri/Cargo.toml -i glib --target x86_64-pc-windows-msvc
```

npm 侧：

```bash
cd docs-site && npm ci && npm audit && npm run build
```

（`npm audit` 的数字比 Dependabot 上的大：上游一条告警会沿依赖链传播成十几条
`@docusaurus/*` 的条目。**看根因，别数条数**：这次 23 条全是从 `serialize-javascript` 与
`sockjs → uuid` 两个根因传上来的。）

---

## 2. `glib`（rust，medium）—— 有理由地接受

**是什么。** RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g。`glib::VariantStrIter` 的 `Iterator` /
`DoubleEndedIterator` 实现里，一个初始化为 `NULL` 的指针通过 `&p`（不可变引用）传给了会就地改它的
C 变参函数；新版本 rustc 会把这种「穿过 `&` 的写」优化掉，于是后续 `CStr::from_ptr` 收到 `NULL`，
**崩溃（空指针解引用）属于 UB**。上游修复方式是把 `&p` 改成 `&mut p`。

**受影响范围。** `>= 0.15.0, < 0.20.0`，首个修复版本 **0.20.0**。我们锁的是 **0.18.5**
（`gui/src-tauri/Cargo.lock:1513`）。关键点：**0.18 这条线上没有任何一个修复版**——修复只存在于
0.20.0，而 0.20.0 是 gtk-rs 的**大版本**。

**它会不会到用户机器上：不会。** 两条独立证据：

1. `cargo tree -i glib --target aarch64-apple-darwin` 与 `--target x86_64-pc-windows-msvc`
   **都输出 "nothing to print"**——这条依赖根本不在 macOS / Windows 的依赖图里。
   `glib` 只在 Linux 上通过 GTK 栈进来：
   `cante-gui → tauri 2.11.5 → {muda, tao, webkit2gtk, wry, tauri-runtime-wry} → gtk 0.18.2 → glib 0.18.5`。
2. 我们**只发 macOS arm64 与 Windows x86_64 两个安装包**（`.github/workflows/gui-release.yml:39-43`
   的 matrix，只有这两项；macOS 还是 Apple silicon only）。Linux 只在 CI 的 Ubuntu job 里被编译
   （`.github/workflows/gui.yml:24`），**不产出任何 Linux 安装包**。

另外，应用自己的 Rust 代码里**没有直接引用 glib**（`grep -rn glib gui/src-tauri/src/` 无结果），
所以这条告警要么不可达（macOS/Windows，压根不编译），要么只在 Linux 上可能被 GTK 内部触发
（我们不发 Linux 包）。

**为什么现在不升。** 升不动，不是不想升：

```
$ cargo update --manifest-path gui/src-tauri/Cargo.toml -p glib --precise 0.20.0
error: failed to select a version for the requirement `glib = "^0.18"`
candidate versions found which didn't match: 0.20.0
location searched: crates.io index
required by package `gtk v0.18.2`
    ... which satisfies dependency `gtk = "^0.18"` (locked to 0.18.2) of package `tauri v2.11.5`
```

`tauri 2.11.5` **就是 crates.io 上最新的 stable**（`crates.io/api/v1/crates/tauri` 的
`max_stable_version`），它声明的是 `gtk ^0.18`（只对 linux/*bsd target）。也就是说：
**在 tauri 2.x 里，glib 被钉在 0.18 线上，而这条线上没有修复版。** 顺便，
`cargo update -p glib --dry-run` 也是「Locking 0 packages」——0.18 线本身已经没有更新的版本了。

硬要消掉这条告警，就得把整个 gtk-rs 栈从 0.18 跳到 0.20（gtk/gdk/gdkx11/gdk-pixbuf/pango/
cairo/atk/soup3/webkit2gtk/javascriptcore-rs 一整套），那是「换一个 GUI 工具链大版本」，
不是为了少一条 Linux-only 告警该做的事；而且 tauri 2 会不会接受 0.20 的 crate 也没有保证。
**强升或删包是明确禁止的**，这里两条都不做。

**重访条件（任意一条成立就必须动）。**

1. **我们开始发 Linux 安装包**（或者把 Linux 从「CI 能编译」升级成「用户能装」）。那一刻
   `glib` 就从「CI 里的编译产物」变成「用户机器上的运行时依赖」，这条必须修完才能发。
2. **tauri 换到 gtk-rs 0.20 系列**（例如 tauri 升到 3.x，或 2.x 里出现 gtk 0.20 的版本）。
   那时 `cargo update -p glib` 会自动落到 ≥ 0.20，这条告警自己会消失；升完照例跑一遍
   `bash gui/scripts/e2e.sh`。
3. **有人要在 Linux 上真的用这个应用去处理不可信输入**（那就是条件 1 的子集，按条件 1 处理）。

---

## 3. `serialize-javascript`（npm，high + medium）—— 已修

**两条告警，一个包。**

- **high** GHSA-5c6j-r48x-rmvq（range `<= 7.0.2`，修复 7.0.3）：`RegExp.flags` 与
  `Date.prototype.toISOString()` 的输出没转义就拼进生成的代码里，**谁能控制传给 `serialize()`
  的对象，谁就能在对方 `eval` 这段输出时注入并执行任意代码**（RCE）。这是 CVE-2020-7660 的
  不完整修复。
- **medium** GHSA-qj8w-gfj5-8c6v / CVE-2026-34043（range `>= 5.0.0, < 7.0.5`，修复 7.0.5）：
  伪造的「类数组」对象会让序列化进入死循环，**吃满一个核**（DoS）。

原来的锁定版本是 **6.0.2**，同时落在两条 range 里。**7.0.5 一次清掉两条**（7.0.3 修 RCE，
7.0.5 修 CPU 耗尽），所以直接取 **7.0.5**。

**它会不会到用户机器上：不会。** 它只在文档站的**构建期**跑：`copy-webpack-plugin` 与
`css-minimizer-webpack-plugin`（都在 `@docusaurus/bundler` 底下，是构建工具）用它算缓存键之类的
内部数据。用户装的桌面应用（Tauri 安装包）里没有它；文档站构建产物是静态 HTML/JS，也不会把它
打进去。

**怎么修的。** 父包把范围钉死了（`copy-webpack-plugin` 要 `^6.0.0`，`css-minimizer-webpack-plugin`
要 `^6.0.1`），`npm audit fix` 给出的「修复方案」是把 `@docusaurus/core` **降到 3.5.2**——那是
**降级**，不采纳。按本仓库已有的做法（`docs-site/package.json` 的 `overrides`，`minimatch`
`yaml` `serve-handler` 都是上一轮这么处理的）加了一条：

```json
"serialize-javascript": "7.0.5"
```

**兼容性**：7.x 相对 6.x 是大版本，但 `main` 仍是 `index.js` 且没有 `"type": "module"`，
也就是**仍然是 CommonJS**，父包的 `require()` 用法不变；新增的限制只是 `engines.node >= 20`
（文档站 `engines` 要 `>= 22`，`.nvmrc` 是 24）。这一点**是跑出来的**，不是看 changelog 推的：
见 §5 的验证结果，`npm ci` + 两种语言的 `npm run build` 都过了。

---

## 4. `uuid`（npm，medium）—— 已修

**是什么。** GHSA-w5hq-g745-h8pq / CVE-2026-41907（range `< 11.1.1`，修复 11.1.1）：`v3()`/`v5()`/
`v6()` 接受调用方给的外部缓冲区，但**不检查边界**，参数越界时会「静默地只写一部分」，
而 `v4()`/`v1()`/`v7()` 会老老实实抛 `RangeError`。影响是**完整性/健壮性**：谁要是假设「写满了
一个 UUID」，就会拿到截断或半旧的标识符而得不着任何报错。

**受影响的是哪一份 uuid。** 文档站的 lock 里有**两份** uuid：`node_modules/uuid@14.0.0`
（`mermaid` 用，**不受影响**）和 **`node_modules/sockjs/node_modules/uuid@8.3.2`**（受影响的那份）。
`8.3.2` 来自 `@docusaurus/core → webpack-dev-server@5.2.6 → sockjs@0.3.24`，而 sockjs 声明的是
`uuid ^8.3.2`，所以**不能靠普通升级解决**。

**它会不会到用户机器上：不会。** sockjs 是 webpack **开发服务器**的传输层，只在 `npm run start`
（本机预览）时用到；`npm run build` 不碰它，用户拿到的桌面应用也不含它。

**怎么修的。** 用**限定父包的** override，只动 sockjs 底下那一份，`mermaid` 的 14.0.0 原地不动：

```json
"sockjs": { "uuid": "11.1.1" }
```

**兼容性**：sockjs 只用 `require('uuid').v4`（`node_modules/sockjs/lib/transport.js:9,37`），
uuid 11 仍然提供 CommonJS 构建，`v4()` 的签名没变。npm 自己在废弃提示里写的也是
「For CommonJS codebases, use uuid@11」。**验证范围见 §5——这条我没有在真实运行路径上跑通，
理由写在那一节。**

---

## 5. 判定「会不会进用户安装包」用的三条硬事实

这三条是上面每条结论的依据，单独列出来，方便下次不用重新查：

1. **Tauri 安装包只发两个平台**：`.github/workflows/gui-release.yml:39-43` 的 matrix 只有
   `macos-latest`（macOS arm64）和 `windows-latest`（Windows x86_64）。**没有 Linux 包。**
2. **Linux 只在 CI 里被编译**：`.github/workflows/gui.yml:24` 的 job 跑在 `ubuntu-latest`，
   它装 WebKitGTK 依赖并跑 `bash gui/scripts/e2e.sh`（因此会编译 GTK 栈）。**编译 ≠ 发布。**
3. **文档站只在 CI 里被构建**：`.github/workflows/docs-site-build.yml` 只在
   `docs-site/**` 变动时触发，做 `npm ci` + `npm run build`（两种语言都构建），产物是静态站点。
   仓库里的 `docs-site/package-lock.json` 因此**只影响 CI 与本地预览**，不影响任何用户装到机器上的东西。

---

## 6. 我没能验证的（诚实清单）

- **本次改动的真机/生产验证**：我只跑了 `npm ci`、`npm audit`、`npm run build`（en + zh-Hans）
  和 `npm run start` 的开发服务器冒烟，**没有把文档站发布到真实托管的站点上再看一眼**。
  `docusaurus build` 的成功只说明本地构建通过。
- **sockjs + uuid 11.1.1 的运行时行为没有真正被触发。** 理由：webpack-dev-server 5 默认用
  原生 `ws` 传输，开发服务器起来之后 `/sockjs-node/info` 走的是 SPA 回退（返回 index.html），
  也就是说 **sockjs 的代码路径没有被执行**。我验证到的只有：模块能被 `require` 到、
  它能解析到 uuid 11.1.1、`v4()` 能被调用并返回合法 UUID、开发服务器能正常编译并响应 200。
  **「换 uuid 会不会把 webpack-dev-server 的传输搞坏」我没有真实跑通一个浏览器会话去确认。**
  风险面很小（只在 `npm run start` 的开发服务器上，任何受影响都不是用户可见的），但这是没验证。
- **`serialize-javascript` 7.0.5 走的是哪条内部 API 没有逐一核对**。我确认的是父包
  （copy-webpack-plugin / css-minimizer-webpack-plugin）在构建时**确实加载到了 7.0.5**，
  且完整的 webpack 生产构建成功。没有去读它内部具体调用了哪些导出。
- **glib 那条「Linux 上是否会被 GTK 内部真的触发」我没有查证**。我能确认的是它在
  macOS/Windows 上不编译、我们不发 Linux 包；至于 GTK 自己在什么情况下调用
  `VariantStrIter`，我没有去读 GTK/glib 的源码或做 Linux 运行验证。这条在接受风险时不重要
  （因为不发包），但如果将来条件 1（发 Linux 包）成立，**必须重新把它查清并升掉，不能直接引用
  这份文档的结论**。
- **上面所有 `cargo` 命令都是本机（macOS）跑出来的（含 `--target` 交叉目标下的依赖图查询）**，
  没有在 Linux 上跑一遍确认 `glib` 真的会被编译进去。这条来自依赖图 + tauri 的 target 声明，
  属于**强推断**，不是实机证据。
- **npm 的托管部署方式没有核到**：仓库里没有部署 workflow，`.gitignore` 里提到 wrangler。
  文档站最终发布到哪里、发布的产物是否与 CI 构建一致，我不知道。

---

## 7. 重访条件汇总

| 条目 | 什么时候必须回头看 |
| --- | --- |
| `glib`（RUSTSEC-2024-0429） | ① 开始发 Linux 安装包（**必须先修再发**）；② tauri 换到 gtk-rs 0.20（告警会自动消失，跟一次 `e2e.sh`） |
| `serialize-javascript` ≥ 7.0.5 | 只需在升级 `@docusaurus/core` 时留意 override 是否仍然匹配（`npm ls serialize-javascript` 应显示 `overridden`） |
| `uuid` ≥ 11.1.1（sockjs 下） | 同上；另外 sockjs 若被上游换掉，可以删掉这条 override |
