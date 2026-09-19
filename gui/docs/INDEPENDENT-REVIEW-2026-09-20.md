# 独立评审：最近合并的一批（#200 / #201 / #202 / #204 / #205）

- **评审分支**：`feat/independent-review`（worktree `/private/tmp/r3-review`，HEAD `b0b3a7d`）
- **评审时间**：2026-09-20
- **评审对象**（`git log` 就近这 5 个提交）：
  | 提交 | 标题 |
  | --- | --- |
  | `0b4619c` | `fix(tasks)`: 工作总结卡改成诚实的「只走粘贴」，删掉走不到的死文案与死断言 (#200) |
  | `e4d4f71` | `test(windows)`: 给 #195/#196 补真机证据 (#201) |
  | `aef4cab` | `test(trust)`: 「原文件一字未动」改成真目录真字节的检查 (#202) |
  | `3c9d640` | `fix(recovery)`: 公司代理挡住请求时，不再被说成「文件被 Excel 占着」 (#204) |
  | `b0b3a7d` | `feat(windows)`: 一条命令看清「每个子 agent 在干什么」 (#205) |
- **纪律**：**没有改任何产品代码**。方法一（挑 5 条断言真的改坏一次）在 `/tmp/r3-mut` 这个 **git worktree 副本**里做，做完 `git checkout -- .` 复原；评审工作区始终 `git status` 干净。
- **唯一的产出代码**：`gui/src/simple/recovery-proxy.test.ts`（**能红的测试**，不是产品修复；当前 HEAD 上 **1 红 2 绿**，理由见发现 1）。

> ⚠️ **这条红是有意的**，也是本分支唯一的红：产品 bug 一天不修，它就一天红着（这正是任务要的「能红的测试」）。所以在本分支上 `bun test src` 会看到 `874 pass / 1 fail`（基线是 872/0）——**不是我把别的东西弄红了**。它红的那条就是发现 1 的可复现判据。修好后应全绿。

---

## 0. 结论先行

**发现 1（高）**：`3c9d640`（#204）的 `BUSY` 规则把 `blocked` 写成了 `\blocked\b`。正则里 `\b` 是**词边界**，所以这条实际匹配的是字面量 **`locked`**，**不是** `blocked`。后果：**任何含 `locked` 的非文件错误**（账号被锁 / 密钥库被锁 / 数据库锁 / `HTTP 423 Locked`）都会被判成「文件被那个窗口占着」，屏幕上让她去关一个**根本不存在的 Excel/WPS 窗口** —— 正是 #197 点名绝不能发生的那类错，也是 #204 自己要防的那类错，只是换了个方向。（**这是本次最有价值的发现**：#204 的两条回归用例都碰不到它。）

**发现 2（高）**：`b0b3a7d`（#205）的 `agent-dashboard.ps1` 解析转录时按 `$_.type -eq 'tool_use'` 找工具，但**真 pi 转录里工具块的类型是 `toolCall`**（本机 40 个转录文件、14981 个工具块，全部是 `toolCall`；`tool_use` 只作为文本/思考里的字面词出现过，**从不**是内容类型）。也就是说 `tools:` 那一行**永远打不出来** —— 而 commit 把它写成"最后用过的工具 ✓"，属于「把没验证写成通过」。实测本机任一真实转录，按该脚本的解析逻辑 `lastTools` 恒为空串。

**发现 3（中）**：`3c9d640`（#204）的提交信息与代码注释都引用 `gui/WINDOWS-ACCEPTANCE-13.md` 作为真机证据，但**该文件不在这次合并进来的历史里**（它在 `origin/pool/win-offline` 的 `3ff4555` 上，**不是** main 的祖先，main 的树里没有这个文件）。引用一份不在仓库里的证据，等于没有证据。

**发现 4（中）**：`b0b3a7d`（#205）的 commit message 与 `VERIFICATION-MAP.md` 都写"**12 秒**采样"，但脚本默认 `$SampleSeconds = 8`，且没有任何调用方传 12。文档与代码不一致。

**发现 5（低）**：`gui/WINDOWS-ACCEPTANCE-11.md`（#201）的报告内部数字自相矛盾：§0 写命中矩形 `[388,540,580,560]`、客户区 `[92,32,1272,792]`、off 元素"y 到了 **880**"；§3.2 的原始输出却是 `[356,540,548,560]`、客户区 `[34,32,1214,792]`、最大 y **927**。同一份报告里同一组量出现两套值。

**没发现问题的项**（逐条给了命令与结果）：文案闸门未被绕过、无新增内联中文、内联预算表未被调大、微信红线未破、本批无新增产品写文件路径、`.ps1` BOM 齐、`bun test src` 基线 872 绿、`tsc --noEmit` 通过、`secret-scan.sh` 通过。

---

## 1. 发现清单（按严重度排序）

### 发现 1（高）— `BUSY` 的 `\blocked\b` 匹配的是 `locked`，把非文件错误说成"文件被占用"

**哪一行**：`gui/src/simple/recovery.ts:108-109`

```js
const BUSY =
  /\blocked\b|being used by another|resource busy|\bEBUSY\b|file is locked|locked for writing|...
```

同文件 `:100-107` 的注释写的是：

> 英文里只认 **lock 开头**的词，不能写 `locked by` ✗ —— `blocked by` 的后半截恰好**就是** `locked by` ✓

注释的**判断是对的**（`blocked by …` 的后半截确实是 `locked by`），但改出来的规则写错了：`\blocked\b` 里的 `\b` 是词边界，等价于"字面量 `locked` 前面加个词边界"。

**怎么复现**（`node`，不依赖任何仓库代码）：

```console
$ node -e 'const r = /\blocked\b/i;
  for (const s of ["locked","blocked","account has been locked","blocked by corporate proxy"])
    console.log(JSON.stringify(r.source), JSON.stringify(s), "->", r.test(s))'
"\\blocked\\b" "locked"                      -> true
"\\blocked\\b" "blocked"                     -> false
"\\blocked\\b" "account has been locked"     -> true
"\\blocked\\b" "blocked by corporate proxy"  -> false
```

**走产品路径复现**（`actionsFor` 是界面真正调的那一层）：

```console
$ cd gui && bun test /tmp/f1.test.ts      # 一个只调 actionsFor 的探针
IN : Your account has been locked after too many failed sign-in attempts
OUT: close-file:关掉那个窗口再试 | copy-detail:复制详情
IN : The keyring is locked; unlock it to continue
OUT: close-file:关掉那个窗口再试 | copy-detail:复制详情
IN : database is locked: could not write session state
OUT: close-file:关掉那个窗口再试 | copy-detail:复制详情
IN : HTTP 423 Locked
OUT: close-file:关掉那个窗口再试 | copy-detail:复制详情
```

`close-file` 的按钮文案是 `closeFile.label = "关掉那个窗口再试"` / `closeOffice.label = "关掉 Excel 里那个窗口"`（`gui/src/simple/copy-recovery.ts`）。上面四种原文里没有任何"文件"，她却会被指去关窗口。

**期望什么**：非文件的 `locked`（账号 / 密钥 / 数据库 / 423）**不许**落到 `close-file`（应走 AUTH 的"重新登录"或通用出口）。
**实际什么**：全部落到 `close-file`，按钮写着"关掉那个窗口再试"。

**正确修法（实测）**：把 `\blocked\b` 这个分支**整个删掉**。注释自己说的就是「英文里只认 lock 开头的词」——`file is locked` / `locked for writing` 已经覆盖真被锁的情况，那个分支本来就是凭空多出来的。

```console
# 在 /tmp/r3-mut 副本里执行：把 BUSY 首部的 「\blocked\b|」 删掉
$ bun test src/simple/recovery.test.ts src/simple/recovery-proxy.test.ts
 37 pass / 0 fail          # 原有 34 条 + 我新增的 3 条，全绿
```

**⚠️ 不要改成 `\bblocked\b`**（这是最容易想到的"修法"，但它是错的）：

```console
$ node -e 'console.log(/\bblocked\b/i.test("403: Forbidden: blocked by corporate proxy"))'
true        # ← 又把 #204 修掉的 P0 带回来了
```

**#204 的两条用例为什么盖不住这个 bug**：
- 用例 A（代理）输入 `403: {...Forbidden: blocked by corporate proxy}`。这段文本里**没有**独立的 `locked` 词（写的是 `blocked`），所以当前这条写错的 `BUSY` 在这里返回 false——用例 A 实际靠 `NETWORK` 新增的 `(blocked|denied|rejected) by .{0,20}proxy` 子句拿到 `retry`，**绿**。它只能证明"最终没落到 close-file"，**证明不了"BUSY 规则写对了"**：规则里那个 `\blocked\b` 分支全程没被触发。
  （旁证：把 `NETWORK` 的 proxy 子句删掉（实验 M2），这条立刻变 `copy-detail` 红——说明 `retry` 完全来自 `NETWORK`，与 `BUSY` 无关。）
- 用例 B（真被锁）输入 `EBUSY: resource busy or locked` / `The file is locked by another process`。这两串里恰好**有**独立的 `locked` 词，当前规则命中 → `close-file`，**绿**。它证明不了"这个 `locked` 匹配是**有意为之**还是**正则写错的副产品**"。
- 两条都绿，但一条把 `locked` 当"文件被锁"、另一条根本没说 `locked` 该不该匹配。**没有任何一条钉住"非文件的 locked 不许触发 BUSY"**——我的 `recovery-proxy.test.ts` 补的就是这个缺口。

**我加的能红测试**：`gui/src/simple/recovery-proxy.test.ts`（同时钉住"非文件 locked 不许 close-file"和"真文件被锁仍必须 close-file"两侧）

```console
$ bun test src/simple/recovery-proxy.test.ts
(fail) 评审发现：#204 把 BUSY 规则放宽到了非文件错误（\blocked\b 其实匹配 locked） > 账号/密钥/数据库被锁，不许说成「文件被占用」
(pass) ... > 真是文件被锁：仍然判成「关掉那个窗口」
(pass) ... > 英文 blocked（非文件语境）不许触发 close-file
 2 pass / 1 fail
```

这条红是**故意的**：评审不动产品代码，所以把 bug 钉成可复现的判据留在分支上；产品修好后应全绿。

---

### 发现 2（高）— #205 的子 agent 面板找 `tool_use`，真转录里是 `toolCall`，`tools:` 永远为空

**哪一行**：`gui/scripts/windows/agent-dashboard.ps1:115`

```powershell
$tools = (($o.message.content | Where-Object { $_.type -eq 'tool_use' } | ForEach-Object { $_.name }) -join ',')
```

**怎么复现**（本机 `~/.pi/agent/sessions/` 下**真实**转录，不需要 Windows）：

```console
$ python3 - <<'PY'   # 统计所有 pi 转录里 tool 内容块的类型
import json,glob,collections
h=collections.Counter()
for f in glob.glob('/Users/muyouming/.pi/agent/sessions/*/*.jsonl'):
  for l in open(f,encoding='utf-8',errors='ignore'):
    try:
      o=json.loads(l)
      if o.get('type')=='message':
        for c in o['message'].get('content',[]) or []:
          if isinstance(c,dict): h[c.get('type')]+=1
    except: pass
print(dict(h))
PY
{'text': 25324, 'toolCall': 14981, 'thinking': 8671, 'image': 6}
```

一个真实工具块长这样（逐字取自本机转录）：

```json
{"type": "toolCall", "id": "call_00_5uv27aWygjjqtHO7njgh9284", "name": "read", "arguments": {"path": "..."}}
```

按脚本的解析逻辑（`Where-Object { $_.type -eq 'tool_use' }`）在真实转录上跑（下面的 python 逐行模拟脚本第 107-119 行）：

```console
$ python3 - <<'PY'
import json, sys
f = sys.argv[1]   # 任取本机一个真实转录（下面那条路径跑出来的就是这个结果）
lastTools = lastUser = lastAsst = ''
for l in open(f, encoding='utf-8', errors='ignore'):
    try: o = json.loads(l)
    except Exception: continue
    if o.get('type') != 'message': continue
    m = o['message']; role = m.get('role')
    text = ' '.join(c.get('text', '') for c in (m.get('content') or [])
                    if isinstance(c, dict) and c.get('type') == 'text')
    if role == 'user' and text: lastUser = text
    if role == 'assistant':
        # 脚本的过滤条件：type -eq 'tool_use'
        tools = ','.join(c.get('name', '') for c in (m.get('content') or [])
                         if isinstance(c, dict) and c.get('type') == 'tool_use')
        if tools: lastTools = tools
        if text and len(text) > 30: lastAsst = text
print('lastTools (=tool_use filter):', repr(lastTools))
print('lastUser:', repr(lastUser[:50]))
print('lastAsst:', repr(lastAsst[:60]))
PY
# 用本机一个真实文件跑（路径按机器自行替换）：
#   ~/.pi/agent/sessions/--Volumes-External-Dev-privacy--/2026-09-19T14-38-20-523Z_01a0ba1a-....jsonl
lastTools (=tool_use filter): ''
lastUser: '继续'
lastAsst: 'Now the detector definitions (patterns, validators, L2 conte...'
```

验证同一文件里**确实有** `toolCall`（所以 `tools:` 本该有输出，不是这个转录恰巧没用工具）：

```console
$ grep -c '"type":"toolCall"' <上面那个文件>
118              # 该转录里工具块真实存在（118 个），只是类型叫 toolCall，脚本认不出来
$ grep -c '"type":"tool_use"' <上面那个文件>
0
```

**期望什么**：`tools:` 行打印她最后用过的工具（`read,bash,...`）——commit `b0b3a7d` 与 `VERIFICATION-MAP.md` 都把"最后一句人话与用过的工具"写成已实现的能力 ✓。
**实际什么**：`tools:` 行**永远不打印**（`$lastTools` 恒为空串，被 `if ($lastTools)` 挡掉）。这条能力实际上不存在。

**边界（诚实）**：我**没有**在 Windows 上跑过这个脚本（本机没有 `pwsh`，也没有 Windows）。但"真转录用 `toolCall`"是**本机 pi 0.85.1 的实测事实**（40 个文件、14981 个块），而脚本读的正是同一套 `~/.pi/agent/sessions/*.jsonl`。除非 Windows 上那份 pi 的转录格式不同（无证据），否则这条在真机上同样恒空。

**没有测试覆盖它**：`grep -rln "agent-dashboard" src/` → 无；`VERIFICATION-MAP.md` 也只把它列成"取证脚本"，**不进门禁**。所以这条错误不会被 CI 拦下。

---

### 发现 3（中）— #204 引用的真机证据文件不在仓里

**哪一行**：`gui/src/simple/recovery.ts:105` 注释与 `3c9d640` 提交信息都写"见 `WINDOWS-ACCEPTANCE-13`"。

```console
$ ls gui/WINDOWS-ACCEPTANCE-*.md
gui/WINDOWS-ACCEPTANCE-1.md ... -11.md        # 没有 -13

$ git merge-base --is-ancestor 3ff4555 HEAD && echo yes || echo "NOT an ancestor"
NOT an ancestor
$ git ls-tree -r --name-only HEAD | grep ACCEPTANCE-13 || echo "absent from HEAD tree"
absent from HEAD tree
$ git branch -a --contains 3ff4555
  remotes/origin/pool/win-offline
```

**期望什么**：引用的证据文件可在仓库里查到（AGENTS.md §6.9「『已验证』必须能回答在哪台机器上、看的是什么产物」）。
**实际什么**：`WINDOWS-ACCEPTANCE-13.md` 只存在于 `origin/pool/win-offline`，**没进 main**。当前 HEAD 上，#204 的"真机证据"是不可核对的。

> 这不是"文件丢了"，更像是"先写了引用、那个文档还在另一条分支上尚未合并"。但按仓库自己的规矩，落到 main 的提交不该引用一份 main 里没有的证据。**至少要在提交信息里注明"证据在 pool/win-offline 的 3ff4555，待合并"**。

---

### 发现 4（中）— #205 文档说 12 秒采样，代码默认 8 秒

**哪一行**：`gui/scripts/windows/agent-dashboard.ps1:10`（默认 8）vs `gui/VERIFICATION-MAP.md:33` 与 `b0b3a7d` 提交信息（写 12）。

```console
$ grep -rn "SampleSeconds\|agent-dashboard" --include="*.ps1" --include="*.md" .
./gui/scripts/windows/agent-dashboard.ps1:7:  # 用法 ... [-SampleSeconds 8] [-Tail 60]
./gui/scripts/windows/agent-dashboard.ps1:10:  [int]$SampleSeconds = 8,
./gui/scripts/windows/agent-dashboard.ps1:74:  Start-Sleep -Seconds $SampleSeconds
./gui/VERIFICATION-MAP.md:33:  ... 转录文件 12 秒有没有在长 ✓ ...
```

**期望什么**：文档与代码一致，或注明"默认 8s，建议传 12"。
**实际什么**：不一致；且没有任何调用方传 12（`grep` 全仓只有这两处）。小问题，但它属于"文档与事实不符"——这个仓库明确把它当红线管过（见 `9f3c6ba`/`186` 的历史）。

---

### 发现 5（低）— #201 的报告内部数字自相矛盾

**哪一行**：`gui/WINDOWS-ACCEPTANCE-11.md` §0（`:24-26`）vs §3.2（`:226`、`:235`）。

| 量 | §0 写的 | §3.2 原始输出写的 |
| --- | --- | --- |
| 目标元素矩形 | `[388,540,580,560]` | `[356,540,548,560]` |
| 窗口客户区 | `[92,32,1272,792]` | `[34,32,1214,792]` |
| 客户区外最大 y | "y 到了 **880**" | "底边 y 最大到了 **927**" |

**期望什么**：摘要与原始输出一致（摘要就是从原始输出抄的）。
**实际什么**：两套值。§3.2 自称是"UIA 原样读回"，§0 的数字来源不明。**两者必有一个是旧的/手抄错的**。这直接关系到"这份报告里的哪组数字是我真读到的"——正是 AGENTS.md §3.6 那个判据要防的事。

> 补充：§0 说"13 个矩形落在客户区外、y 到了 880"，§3.2 举例里确实有一行 `rect=[371,850,983,880]`（y **850**，底边 **880**）。所以 §0 的"880"可能是把某个元素的**底边**当成了"最大 y"，而 §3.2 的"927"又是另一个算法的结果。**口径没统一**，报告里没写哪个是"最大底边"。

---

## 2. 改坏它也不红 / 套话断言（最有价值的发现）

我按任务要求，**至少挑了 5 条新增断言在 `/tmp/r3-mut` 副本上真的改坏一次**。红了的（说明断言有牙）记 `✓红`；怎么改都不红的记 `✗套话`。

| # | 被改坏的断言 | 改坏方式 | 结果 | 语言 |
| --- | --- | --- | --- | --- |
| M1 | `recovery.test.ts` 代理用例（#204） | 把 `BUSY` 改回 `file is locked\|locked by\|locked for writing` | `✓红`：`Expected to not contain: "close-file" / Received: ["close-file","copy-detail"]` | 有牙 |
| M2 | `recovery.test.ts` 代理用例（#204） | **删掉 `NETWORK` 新增的 proxy 子句** | `✓红`：`Expected: "retry" / Received: "copy-detail"` | 有牙 |
| M3 | `worksummary.test.ts`「传进文件也不读它」（#200） | 把 `files: []` 改回 `files` + 恢复参数名 | `✓红`：那条用例 fail（指令里出现了文件路径） | 有牙 |
| M4 | `worksummary.test.ts`「目录里有、且只在一处导出」（#200） | 在 `TASKS` 里用**影子拷贝**代替真实导出 | `✓红`：`expect(inCatalogue[0]).toBe(WORK_SUMMARY_TASKS[0])` | 有牙 |
| M5 | `worksummary.test.ts`「首页分组到文书」（#200） | 让 `groupTasks` 过滤掉这张卡 | `✓红` | 有牙 |
| M6 | `try-first.test.ts`「默认焦点在取消」（#202） | 把 `ref={cancelButton}` **挪到「开始」按钮**、变量名照旧 | `✓红`：正是 #202 commit 声称要防的那个骗法 | 有牙（#202 的修法有效） |
| M7 | `trust.test.ts`「原文件一字未动」（#202） | `store.ts` 的 `dryRun` **去掉 `beginSnapshot`** | `✓红`：指纹 `after != before`（还有另一条 `begin_run` 断言也红） | 有牙 |
| M8 | `trust.test.ts`「备份是副本」（#202） | 把**测试自己 mock 的** `copyAll` 改成"搬走"（删源文件） | `✓红`：指纹不等 | **注意**：见下 |
| **M9** | **`worksummary.test.ts`「首页点得进来」（#200）** | **在 `Home.tsx` 里 `visibleTasks().filter(t => t.id !== "doc.worksummary")` —— 把这张卡从首屏藏起来** | **`✗ 全套 872 pass / 0 fail`** | **套话/覆盖缺口** |
| M10 | 同一批的 `impactOf` 永远返回 0（全局产品破坏） | 改 `run.ts` 的 `impactOf` | `✓红`（`trust.test.ts` + 全库 2 fail） | 有牙（但不在本批新增里） |

### M9 展开：这是"改坏也不红"的那一条

`worksummary.test.ts` 新增的"这张卡从首页点得进来"三条断言，**注释自称**盯的是"首页卡片分组（`groupTasks`，和 `Home.tsx` 的 sections 同一套组顺序）"。但我把**真正的首屏组件** `Home.tsx` 改成不显示这张卡之后：

```console
$ cd gui && bun test src
 872 pass
 0 fail          # ← 全套绿，没有任何测试发现首屏少了一张卡
```

**根因**：`Home.tsx` **没有用** `groupTasks`。它自己写了一份 `sections()`（`Home.tsx:174-192`），逻辑与 `groupTasks` **平行但独立**；`groupTasks` 只被**能力中心** `TaskLibrary.tsx:115` 用。所以那条断言测的是**能力中心**那条路，而注释和测试名都说是"首页"。**注释与测试名在说谎**：它给了"首屏可达性已验证"的错觉，实际首屏没有任何测试覆盖。

**期望什么**：断言要么去覆盖 `Home.tsx` 的真实分组（例如把 Home 的 `sections()` 抽成可单测的纯函数并测它），要么把测试名/注释改成"能力中心（TaskLibrary）分组"，别写"首页"。
**实际什么**：测试名写"首页点得进来"，改坏首屏全绿。

> 附：`a11y.test.ts:373` 只断言"扫描到过 Home.tsx 这个文件"，不做行为断言；`catalog.test.ts` 测的是 `groupTasks`（能力中心那条路）。**没有任何测试渲染 Home 的分组。**

### M8 展开：一条"验了桩、没验产品"的边界（不算套话，但要写清）

`trust.test.ts` 新增的"备份是副本"断言（`expect(treeFingerprint(backup)).toEqual(before)`）**只**能验证**测试自己写的 mock** `copyAll` 是复制还是搬走 —— 因为 `begin_run` / `snapshot_paths` 的复制语义是**桥/Rust 层**的事，而 `store.ts` **根本没有文件系统能力**（`grep node:fs src/store.ts` → 无）。所以：

- 改坏 mock 的 `copyAll`（M8）→ 会红 ✓；
- 改坏**真实的 Rust** `files.rs` 复制语义 → **这条测试不会红**，因为它压根不经过 Rust。

这不是 bug（commit 也诚实写了"桥/Rust 那层的真实扫描与复制仍由 `src-tauri/tests/files.rs` 覆盖"），但**它比名字听起来弱**：名字叫"原文件一字未动 —— 真目录、真字节"，真正被验的其实只有 store 的 diff 计算 + 一个忠实桩。要真验"原件没动、备份是副本"，得跑 `cargo test`（本机未跑，见 §3）。

---

## 3. 我跑过但没跑成 / 超时 / 没条件的项（与"确认没有"分开写）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| Windows 真机跑 `agent-dashboard.ps1` | **没跑** | 本机是 macOS，无 `pwsh`/`powershell`（`which pwsh` 为空）。发现 2 的证据来自**本机 pi 转录格式**（同一下游格式），不是 Windows 实测。 |
| Windows 真机跑 `read-confirm-visible.ps1` / `run-accept-drive.ps1` | **没跑** | 同上，需真 Windows + 真 WebView2 + 交互桌面（AGENTS.md §6）。#201 报告里的 UIA 读数**我无法复核**，只能指出其内部数字矛盾（发现 5）。 |
| `cargo test`（Rust `files.rs` 的复制/扫描语义） | **没跑** | 本机无 Rust 工具链保证 / 未配；按 AGENTS.md §5「Rust / 打包交给 CI」。所以 M8 那条"备份是副本"的真实验证**缺位**。 |
| `bash gui/scripts/e2e.sh` 全 8 步 | **只跑了前 5 步里的 4 步** | `secret-scan.sh` ✓、`bun install` ✓、`bun test src` ✓（872 绿）、`bunx tsc --noEmit` ✓；**没跑** `license-inventory.sh --check`、`build:web`、`fixtures`、`cargo test`（时间/工具链）。 |
| `git push` / 开 PR | **按任务要求没做** | 任务明确「不要开 PR」，只推分支。 |
| 本机 pi 转录是不是 Windows 上那份的同一格式 | **没有直接验证** | 无 Windows 环境。发现 2 依赖"Windows 上的 pi 转录同样是 `toolCall`"这一假设——**如果** Windows 那份 pi 版本会写 `tool_use`，发现 2 就不成立。请接手的人在真机上 `Select-String -Path <转录> -Pattern 'toolCall','tool_use'` 各数一遍即可证实/证伪。 |

**"确认没有"（与上面分开）—— 下面是**列过证据**之后的确认：**

- 本批**未**新增产品写文件路径：`for c in <5 提交>; do git show $c -- gui/src gui/src-tauri/src; done | grep -E '^\+.*(fs::write|writeFile|write_text|File::create|OpenOptions)'` → **只有 `trust.test.ts` 里的测试写**，产品代码零命中。
- **微信红线未破**：`grep -rniE 'webhook|sendMessage|send_message|群发|自动发送|发到微信|itchat|wechaty|wx\.[a-z]' gui/src gui/src-tauri/src`（排除测试）→ 只有三处**说明性文字**：`copy.ts:48` 的"（绝不自动发送）"、`run.ts:245` 的**风险针** `["发送","群发","发消息","自动回复"]`（用于生成"不会自动发消息"的红框）、`admin-config.ts:89` 的注释。**没有发送路径**。`wechat.ts` 本批**未被触碰**（5 个提交的改动文件里没有它）。
- **文案闸门未被绕过**：本批 **`git show --name-only` 里没有一个 `.tsx`**，所以不可能新增内联中文；`copy-guard.test.ts` 6 项全绿（含"内联中文只能减少"的预算校验）；`INLINE_COPY_BUDGET` 本批未被改（`git log -3 -- copy-guard.test.ts` 最后两次都在本批之前）。
- `.ps1` BOM：`agent-dashboard.ps1` / `read-confirm-visible.ps1` / `run-accept-drive.ps1` 开头均为 `efbbbf` ✓（13 个 `.ps1` 全部带 BOM）。

---

## 4. 我自己没覆盖的范围

- **没验真机**：Windows 上的 UIA 几何读数（发现 5 只做"文档内部一致性"核对，**没有**复核 UI 事实）、`run-accept-drive.ps1` 的 docx 读回、SmartScreen/黑窗/中文路径等（#201 报告的主体）。
- **没验 Rust**：桥/Rust 的 `begin_run` 真扫描、快照复制、"目标已存在就报错"的 #95 覆盖守卫 —— 靠 `src-tauri/tests/files.rs`，**我没跑**。
- **没验模型路径**：`task-sweep.sh` / 真守护进程 / 真夹具跑卡（需模型端点），**没跑**。
- **#205 我只做了静态+格式层核对**：`Resolve-Tree` 的路径还原、SYSTEM 身份找转录目录、`$delta` 的 WORKING 判定，这些逻辑我**读了**但**没跑**（无 PowerShell）。`Resolve-Tree` 里 `--C--cante-wt-ci--` → 我手工验了输出，但那是主分支；`--C--a-b-cante-wt-ci--` 这类多层路径只做了正则推演。
- **`\b` 家族的其他写法**：我只核了 `recovery.ts:109` 这一处异常（其余 `\bExcel\b`、`\bEBUSY\b`、`\b40[13]\b` 语义正确）。
- **发现 3 的动机**：我只证明"文件不在 main"，**没有**去 `origin/pool/win-offline` 打开那份报告核对内容——所以我说的是"引用不可核对"，**不是**"那份真机验收是编的"。

---

## 5. 复现清单（本次全部命令）

```bash
# 基线（§5.5：新 worktree 先装依赖）
cd gui && bun install
bun test src                     # 872 pass / 0 fail
bunx tsc --noEmit                # exit 0
bash scripts/secret-scan.sh      # OK, 529 files

# 发现 1：BUSY 正则
node -e 'const r=/\blocked\b/i; console.log(r.test("blocked"), r.test("locked"))'  # false true
cd gui && bun test /tmp/f1.test.ts    # close-file 命中非文件 locked
bun test src/simple/recovery-proxy.test.ts   # 1 fail（能红的测试）

# 发现 2：真转录里的工具块类型（本机所有 pi 转录的内容类型直方图）
python3 - <<'PY'
import json, glob, collections
h = collections.Counter()
for f in glob.glob('/Users/muyouming/.pi/agent/sessions/*/*.jsonl'):
    for l in open(f, encoding='utf-8', errors='ignore'):
        try:
            o = json.loads(l)
            if o.get('type') == 'message':
                for c in o['message'].get('content') or []:
                    if isinstance(c, dict): h[c.get('type')] += 1
        except Exception: pass
print(dict(h))
PY
# {'text': 25324, 'toolCall': 14981, 'thinking': 8671, 'image': 6}
# 换个用户名/机器路径时把 glob 改成自己的 ~/.pi/agent/sessions

# 发现 3：引用文件不在 main
git merge-base --is-ancestor 3ff4555 HEAD; echo $?     # 1 = 不是祖先
git ls-tree -r --name-only HEAD | grep ACCEPTANCE-13   # 空

# 发现 4：12 vs 8
grep -rn "SampleSeconds" gui/scripts/windows/agent-dashboard.ps1
grep -n "12 秒" gui/VERIFICATION-MAP.md

# M9：首屏藏卡，全套仍绿
#   在副本里把 Home.tsx 的 visibleTasks() 过滤掉 doc.worksummary，然后 bun test src → 872 pass
```

**方法学备注**：所有"改坏产品代码"的实验都在 `/tmp/r3-mut`（`git worktree add HEAD` 出来的**独立副本**）里做，每次改完 `git checkout -- <file>` 复原；评审工作区 `/private/tmp/r3-review` **全程 `git status` 干净**，产品代码**零改动**。
