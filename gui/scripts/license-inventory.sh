#!/usr/bin/env bash
# 第三方开源组件与许可证清单 —— 生成它，并让「清单过期」变成 CI 能挡的失败。
#
#   bash gui/scripts/license-inventory.sh             重新生成 gui/THIRD-PARTY-LICENSES.md
#   bash gui/scripts/license-inventory.sh --check     重新生成并与已提交的文件比对；过期退出 1，
#                                                     并点名是哪些组件变了（不是「文件不同」）
#   bash gui/scripts/license-inventory.sh --stdout    只打印到 stdout，不落盘
#   bash gui/scripts/license-inventory.sh --self-check  真的跑两遍，断言两次逐字节相同
#
# 输入：
#   Rust  gui/src-tauri/Cargo.lock  —— 经 `cargo metadata --locked` 解析（含构建期/开发期依赖）
#   npm   gui/package.json + gui/bun.lock + 已安装的 gui/node_modules
#
# 确定性：条目按 (name, version) 的字节序排序；不写时间戳、机器名、绝对路径。
# 同一份输入两次运行逐字节相同（--self-check 会真的跑两遍来证）。
#
# 为什么 npm 侧要读 node_modules：许可证与版权行只存在于每个包自己的 package.json 里，
# bun.lock 里没有这两个字段。所以这一步必须排在 `bun install` 之后 —— e2e.sh 里就是这么放的。
#
# 依赖：bash + cargo + bun（本项目 e2e 本来就都要）。不联网取元数据：
# cargo 用本地 registry 缓存，npm 用已安装的包。

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"
out="$gui_root/THIRD-PARTY-LICENSES.md"

mode="write"
case "${1:-}" in
  "" | --write) mode="write" ;;
  --check) mode="check" ;;
  --stdout) mode="stdout" ;;
  --self-check) mode="self-check" ;;
  -h | --help)
    sed -n '2,21p' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  *)
    printf 'license-inventory: 不认识的参数：%s\n' "$1" >&2
    exit 2
    ;;
esac

# --self-check：把「两次运行逐字节相同」变成一条真的会跑的断言。
if [ "$mode" = "self-check" ]; then
  self="$here/$(basename -- "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  bash "$self" --stdout > "$tmp/first.md"
  bash "$self" --stdout > "$tmp/second.md"
  if ! cmp -s "$tmp/first.md" "$tmp/second.md"; then
    printf 'license-inventory: 确定性自检失败 —— 两次生成不一致：\n' >&2
    diff -u "$tmp/first.md" "$tmp/second.md" | head -40 >&2 || true
    exit 1
  fi
  printf 'license-inventory: 确定性自检通过（两次生成逐字节相同，%s 行）\n' \
    "$(wc -l < "$tmp/first.md" | tr -d ' ')"
  exit 0
fi

command -v cargo >/dev/null 2>&1 || {
  printf 'license-inventory: 找不到 cargo（Rust 依赖要靠它解析）\n' >&2
  exit 2
}
command -v bun >/dev/null 2>&1 || {
  printf 'license-inventory: 找不到 bun（npm 元数据与渲染靠它）\n' >&2
  exit 2
}

# bun 是原生程序：Git Bash 下的 /tmp/... 它打不开，交给 cygpath 换成 Windows 路径。
to_native() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cargo metadata --manifest-path "$gui_root/src-tauri/Cargo.toml" --format-version 1 --locked \
  > "$tmp/cargo-meta.json"

cat > "$tmp/inventory.mjs" <<'INVENTORY_JS'
// 由 gui/scripts/license-inventory.sh 生成的临时程序（不提交）。
//
// 两条数据来源合并成一张按许可证分组的清单：
//   - Rust：cargo metadata 的 packages（去掉 workspace 成员，即我们这个仓库自己的 crate）。
//   - npm ：package.json 的直接依赖 + dependencies 的传递闭包，元数据取自已安装的包。

const mode = process.env.MODE;
const gui = process.env.GUI_ROOT;
const outPath = process.env.OUT_PATH;
const newOut = process.env.NEW_OUT || "";

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// 许可类别：(MIT / Apache-2.0 / ISC / BSD-* / 其他) 五桶。
// 旧式 SPDX 里的 "/" 就是 OR；带顶层 AND 的表达式只报不归类（两种义务都要满足）。
function category(expr) {
  const e = String(expr || "").replace(/\//g, " OR ").replace(/\s+/g, " ").trim();
  if (!e) return "其他 / 未知";
  if (/\sAND\s/.test(e)) return "其他 / 未知";
  const alts = e.split(" OR ").map((s) => s.trim());
  if (alts.some((a) => a === "MIT" || a.startsWith("MIT "))) return "MIT";
  if (alts.some((a) => a.startsWith("Apache-2.0"))) return "Apache-2.0";
  if (alts.some((a) => a === "ISC")) return "ISC";
  if (alts.some((a) => a.startsWith("BSD-"))) return "BSD-*";
  return "其他 / 未知";
}

const GROUPS = ["MIT", "Apache-2.0", "ISC", "BSD-*", "其他 / 未知"];

// copyleft / 传染性关键字：命中就进「需要留意」一节，由人（不是脚本）决定怎么办。
const COPYLEFT =
  /\b(?:A?LGPL|GPL|MPL|EPL|CDDL|SSPL|OSL|CPL|EUPL|RPL|QPL|Sleepycat|CC-BY-(?:NC|ND))\b/i;

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const meta = JSON.parse(await Bun.file(process.env.CARGO_META).text());
const members = new Set(meta.workspace_members);
const entries = [];
for (const p of meta.packages) {
  if (members.has(p.id)) continue; // 本仓库自己的 crate 不算第三方
  const license = (p.license || "").trim() || (p.license_file ? "(见包内 license_file)" : "(无)");
  entries.push({
    kind: "Rust",
    name: p.name,
    version: p.version,
    license,
    authors: Array.isArray(p.authors) ? p.authors.join(", ") : "",
  });
}
const rustCount = entries.length;

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

const pkg = await Bun.file(`${gui}/package.json`).json();

// bun.lock 是 bun 的宽松 JSON（对象/数组尾随逗号），严格 JSON.parse 会拒绝。
const lockText = await Bun.file(`${gui}/bun.lock`).text();
let lock;
try {
  lock = JSON.parse(lockText);
} catch {
  lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1"));
}
const lockPkgs = lock.packages || {};
function lockVersion(name) {
  const entry = lockPkgs[name];
  if (!entry) return null;
  const m = /^(.+)@([^@]+)$/.exec(entry[0]);
  return m ? m[2] : null;
}

// 直接依赖 + dependencies 的传递闭包。devDependencies 只取直接那一层：
// 它的传递树里全是构建/测试工具（vite、rollup、esbuild…），不进安装包，
// 而且带平台专有二进制包（win32/linux/darwin 各一份），会让清单随机器变。
const runtimeRoots = Object.keys(pkg.dependencies || {});
const closure = new Set(runtimeRoots);
const queue = [...runtimeRoots];
while (queue.length) {
  const name = queue.shift();
  const entry = lockPkgs[name];
  if (!entry) continue;
  const deps = { ...(entry[2]?.dependencies || {}), ...(entry[2]?.optionalDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    if (!closure.has(dep)) {
      closure.add(dep);
      queue.push(dep);
    }
  }
}

const npmNames = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
  ...closure,
]);

for (const name of [...npmNames].sort(cmp)) {
  const version = lockVersion(name);
  if (!version) throw new Error(`npm 依赖 ${name} 不在 gui/bun.lock 里：先跑 bun install`);
  const metaFile = Bun.file(`${gui}/node_modules/${name}/package.json`);
  if (!(await metaFile.exists())) {
    throw new Error(`npm 依赖 ${name} 没装：这个脚本必须排在 bun install 之后`);
  }
  const np = await metaFile.json();
  if (String(np.version) !== String(version)) {
    throw new Error(
      `npm 依赖 ${name} 装的是 ${np.version}，bun.lock 写的是 ${version}：先跑 bun install`,
    );
  }
  let license = "";
  if (typeof np.license === "string") license = np.license;
  else if (np.license && typeof np.license.type === "string") license = np.license.type;
  else if (Array.isArray(np.licenses)) license = np.licenses.map((l) => l?.type).filter(Boolean).join(" OR ");
  license = license.trim() || "(无)";

  let authors = "";
  const a = np.author;
  if (typeof a === "string") authors = a;
  else if (a && typeof a === "object") {
    authors = [a.name, a.email ? `<${a.email}>` : ""].filter(Boolean).join(" ");
  }

  entries.push({ kind: "npm", name, version, license, authors });
}
const npmCount = entries.length - rustCount;

// 排序是确定性的来源；顺带断言它真的排好了、且没有空许可证。
entries.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
for (let i = 1; i < entries.length; i++) {
  if (cmp(entries[i - 1].name, entries[i].name) > 0) throw new Error("内部错误：条目没有按名字排好序");
}
for (const e of entries) if (!e.license) throw new Error(`内部错误：${e.name} 没有许可证`);

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render(list) {
  const byGroup = new Map(GROUPS.map((g) => [g, []]));
  for (const e of list) byGroup.get(category(e.license)).push(e);
  const countOf = (g, kind) => byGroup.get(g).filter((e) => e.kind === kind).length;

  const L = [];
  L.push("# 第三方开源组件与许可证清单");
  L.push("");
  L.push("> **本文件由 `gui/scripts/license-inventory.sh` 生成，不要手改。**");
  L.push(">");
  L.push("> - 重新生成：`bash gui/scripts/license-inventory.sh`");
  L.push("> - 校验是否过期（CI 用的就是这条）：`bash gui/scripts/license-inventory.sh --check`");
  L.push("");
  L.push("## 覆盖范围：这份清单覆盖什么、不覆盖什么");
  L.push("");
  L.push("**覆盖**");
  L.push("");
  L.push(
    "- **Rust**：`gui/src-tauri/Cargo.lock` 锁定的**全部**传递依赖（含构建期与开发期依赖，也含各平台专有的依赖）。版本、许可证表达式与版权行取自 `cargo metadata --locked`。",
  );
  L.push(
    "- **npm**：`gui/package.json` 里声明的**直接**依赖（`dependencies` + `devDependencies`），加上 `dependencies` 的**传递闭包**（真正会打进前端产物那几包）。版本取自 `gui/bun.lock`；许可证与版权行取自已安装的 `gui/node_modules/<包>/package.json`。",
  );
  L.push("");
  L.push("**不覆盖**");
  L.push("");
  L.push(
    "- npm `devDependencies` 的**传递**依赖（vite / rollup / esbuild 那一整棵构建、测试期的树）。它们是构建期工具、不进安装包；要把它们纳进来，得先解决「平台专有的二进制包在不同机器上装的不一样」这件事，否则这份文件会随机器变。",
  );
  L.push("- 系统库与运行时：WebView2、WebKitGTK、Node / Bun、操作系统自带的 C 库。");
  L.push(
    "- 不在本仓库依赖树里、另行分发的组件（例如将来若把 `pi` 宿主随包分发，它自带的依赖树要另出一份清单）。",
  );
  L.push("- 各许可证的**原文**：本文件只列名字 / 版本 / 许可证表达式 / 版权行，不内嵌全文。");
  L.push("");
  L.push("## 统计");
  L.push("");
  L.push("| 许可类别 | Rust | npm | 合计 |");
  L.push("| --- | --- | --- | --- |");
  for (const g of GROUPS) {
    L.push(`| ${g} | ${countOf(g, "Rust")} | ${countOf(g, "npm")} | ${byGroup.get(g).length} |`);
  }
  L.push(`| **合计** | **${rustCount}** | **${npmCount}** | **${entries.length}** |`);
  L.push("");
  for (const g of GROUPS) {
    L.push(`## ${g}`);
    L.push("");
    const group = byGroup.get(g);
    if (!group.length) {
      L.push("（无）");
      L.push("");
      continue;
    }
    for (const e of group) {
      L.push(`- ${e.name} ${e.version} — ${e.license}${e.authors ? ` — ${e.authors}` : ""}`);
    }
    L.push("");
  }
  L.push("## 需要留意（copyleft / 无许可证 / 自定义）");
  L.push("");
  const risky = list.filter(
    (e) => COPYLEFT.test(e.license) || e.license === "(无)" || e.license.startsWith("(见"),
  );
  if (!risky.length) {
    L.push("（无）");
  } else {
    L.push("这一节只**点名**，不代表脚本可以动依赖 —— 换不换、怎么合规，是产品/法务的决定。");
    L.push("");
    for (const e of risky) L.push(`- ${e.kind} ${e.name} ${e.version} — ${e.license}`);
  }
  L.push("");
  return L.join("\n");
}

const md = render(entries);
if (render(entries) !== md) throw new Error("内部错误：渲染结果不稳定");

// ---------------------------------------------------------------------------
// 模式
// ---------------------------------------------------------------------------

if (mode === "stdout") {
  process.stdout.write(md);
} else if (mode === "write") {
  await Bun.write(outPath, md);
  console.error(
    `license-inventory: 已写出 ${outPath}（Rust ${rustCount} + npm ${npmCount} = ${entries.length} 条）`,
  );
} else if (mode === "check") {
  const existing = (await Bun.file(outPath).exists()) ? await Bun.file(outPath).text() : "";
  if (existing === md) {
    console.log(
      `license-inventory: 清单是最新的（Rust ${rustCount} + npm ${npmCount} = ${entries.length} 条）`,
    );
    process.exit(0);
  }
  if (newOut) await Bun.write(newOut, md);

  // 只解析「许可类别」小节里的条目；「需要留意」那一节的行不算条目。
  const parse = (text) => {
    const map = new Map();
    let inGroup = false;
    for (const line of text.split("\n")) {
      if (line.startsWith("## ")) {
        inGroup = GROUPS.includes(line.slice(3).trim());
        continue;
      }
      if (!inGroup) continue;
      const m = /^- (.+?) (\S+) — (.*?)(?: — .*)?$/.exec(line);
      if (m) map.set(m[1], { name: m[1], version: m[2], license: m[3] });
    }
    return map;
  };
  const oldMap = parse(existing);
  const newMap = parse(md);
  const added = [...newMap.keys()].filter((k) => !oldMap.has(k)).sort(cmp);
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k)).sort(cmp);
  const changed = [...newMap.keys()]
    .filter((k) => {
      if (!oldMap.has(k)) return false;
      const o = oldMap.get(k);
      const n = newMap.get(k);
      return o.version !== n.version || o.license !== n.license;
    })
    .sort(cmp);

  const say = (head, list, format) => {
    if (!list.length) return;
    console.error(`  ${head} ${list.length} 个：`);
    for (const k of list.slice(0, 25)) console.error(`    ${format(k)}`);
    if (list.length > 25) console.error(`    …（还有 ${list.length - 25} 个）`);
  };
  console.error("license-inventory: 清单过期 —— gui/THIRD-PARTY-LICENSES.md 与现在的依赖树对不上。");
  say("新增", added, (k) => `+ ${k} ${newMap.get(k).version} (${newMap.get(k).license})`);
  say("删除", removed, (k) => `- ${k} ${oldMap.get(k).version} (${oldMap.get(k).license})`);
  say("变化", changed, (k) => {
    const o = oldMap.get(k);
    const n = newMap.get(k);
    const bits = [];
    if (o.version !== n.version) bits.push(`${o.version} → ${n.version}`);
    if (o.license !== n.license) bits.push(`${o.license} → ${n.license}`);
    return `~ ${k}（${bits.join("；")}）`;
  });
  if (!added.length && !removed.length && !changed.length) {
    console.error("  组件没有增减，是文件格式/表头变了（重新生成即可）。");
  }
  console.error("  重新生成：bash gui/scripts/license-inventory.sh");
  process.exit(1);
} else {
  console.error(`license-inventory: 内部错误：未知模式 ${mode}`);
  process.exit(2);
}
INVENTORY_JS

export CARGO_META="$(to_native "$tmp/cargo-meta.json")"
export GUI_ROOT="$(to_native "$gui_root")"
export OUT_PATH="$(to_native "$out")"
export MODE="$mode"
export NEW_OUT=""
if [ "$mode" = "check" ]; then
  export NEW_OUT="$(to_native "$tmp/generated.md")"
fi

# stdout 模式要让生成的 markdown 独占 stdout（bun 的 console.error 走 stderr，不干扰）。
status=0
bun run "$(to_native "$tmp/inventory.mjs")" || status=$?

if [ "$mode" = "check" ] && [ "$status" -ne 0 ] && [ -f "$tmp/generated.md" ]; then
  printf '\n--- 与已提交文件的前 40 行差异（- 已提交 / + 现在生成）---\n' >&2
  diff -u "$out" "$tmp/generated.md" | head -40 >&2 || true
fi
exit "$status"
