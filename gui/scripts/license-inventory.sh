#!/usr/bin/env bash
# 第三方开源组件与许可证清单 —— 生成它，并让「清单过期」变成 CI 能挡的失败。
#
#   bash gui/scripts/license-inventory.sh             重新生成两个产物，都落盘：
#                                                       gui/THIRD-PARTY-LICENSES.md（给人看）
#                                                       gui/src/simple/third-party-notices.ts（随软件发给她）
#   bash gui/scripts/license-inventory.sh --check     重新生成并与两个已提交的文件比对；任一个过期
#                                                     就退出 1，并点名是哪些组件/哪份原文变了
#   bash gui/scripts/license-inventory.sh --stdout    只把 markdown 打印到 stdout，不落盘
#   bash gui/scripts/license-inventory.sh --stdout-ts 只把 third-party-notices.ts 打印到 stdout
#   bash gui/scripts/license-inventory.sh --self-check  两个产物各跑两遍，断言逐字节相同
#
# 为什么有两个产物：markdown 是给评审看的清单；third-party-notices.ts 是许可说明本身，
# 随前端产物一起发出去（她不会去安装目录或网页里找许可，见 gui/docs/DECISION-windows-runtime.md §10）。
# 两者的输入完全相同，所以必须同时新鲜：只更新一个 = 过期。
#
# 输入：
#   Rust  gui/src-tauri/Cargo.lock  —— 经 `cargo metadata --locked` 解析（含构建期/开发期依赖）
#   npm   gui/package.json + gui/bun.lock + 已安装的 gui/node_modules
#   补回  脚本里带的那张表（RESTORED，见 #158）—— 43 个包发布到 registry 时就没把 LICENSE
#         打进包，原文从它们的上游仓库取回，每条都带来源链接。它是**数据**，不是联网取
#         的：生成过程一次网都不上（否则 --check 会随网络时好时坏）。
#
# 确定性：条目按 (name, version) 的字节序排序；不写时间戳、机器名、绝对路径。
# 同一份输入两次运行逐字节相同（--self-check 会真的跑两遍来证）。
#
# 为什么 npm 侧要读 node_modules：许可证与版权行只存在于每个包自己的 package.json 里，
# bun.lock 里没有这两个字段；许可原文也在包里（npm 是 node_modules/<包>/LICENSE*，cargo 是
# 包自己的目录里）。所以这一步必须排在 `bun install` 之后 —— e2e.sh 里就是这么放的。
#
# 依赖：bash + cargo + bun（本项目 e2e 本来就都要）。不联网取元数据：
# cargo 用本地 registry 缓存，npm 用已安装的包。

set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
gui_root="$(cd -- "$here/.." && pwd)"
out="$gui_root/THIRD-PARTY-LICENSES.md"
ts_out="$gui_root/src/simple/third-party-notices.ts"

mode="write"
case "${1:-}" in
  "" | --write) mode="write" ;;
  --check) mode="check" ;;
  --stdout) mode="stdout" ;;
  --stdout-ts) mode="stdout-ts" ;;
  --self-check) mode="self-check" ;;
  -h | --help)
    sed -n '2,28p' "${BASH_SOURCE[0]}"
    exit 0
    ;;
  *)
    printf 'license-inventory: 不认识的参数：%s\n' "$1" >&2
    exit 2
    ;;
esac

# --self-check：把「两次运行逐字节相同」变成一条真的会跑的断言（两个产物都要）。
if [ "$mode" = "self-check" ]; then
  self="$here/$(basename -- "${BASH_SOURCE[0]}")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for pair in "md:--stdout" "ts:--stdout-ts"; do
    tag="${pair%%:*}"
    flag="${pair#*:}"
    bash "$self" "$flag" > "$tmp/first.$tag"
    bash "$self" "$flag" > "$tmp/second.$tag"
    if ! cmp -s "$tmp/first.$tag" "$tmp/second.$tag"; then
      printf 'license-inventory: 确定性自检失败 —— %s 两次生成不一致：\n' "$tag" >&2
      diff -u "$tmp/first.$tag" "$tmp/second.$tag" | head -40 >&2 || true
      exit 1
    fi
    printf 'license-inventory: 确定性自检通过：%s 两次生成逐字节相同（%s 行）\n' \
      "$tag" "$(wc -l < "$tmp/first.$tag" | tr -d ' ')"
  done
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

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.env.MODE;
const gui = process.env.GUI_ROOT;
const outPath = process.env.OUT_PATH;
const tsOutPath = process.env.TS_OUT_PATH;
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
    // 许可原文就在这个包自己的目录里；license_file 是相对 manifest 的路径。
    dir: p.manifest_path ? dirname(p.manifest_path) : "",
    licenseFile: p.license_file || "",
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

  entries.push({
    kind: "npm",
    name,
    version,
    license,
    authors,
    dir: `${gui}/node_modules/${name}`,
    licenseFile: "",
  });
}
const npmCount = entries.length - rustCount;

// 排序是确定性的来源；顺带断言它真的排好了、且没有空许可证。
entries.sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
for (let i = 1; i < entries.length; i++) {
  if (cmp(entries[i - 1].name, entries[i].name) > 0) throw new Error("内部错误：条目没有按名字排好序");
}
for (const e of entries) if (!e.license) throw new Error(`内部错误：${e.name} 没有许可证`);

// ---------------------------------------------------------------------------
// 许可原文：从每个包自己的目录里找，找不到就如实标成「未附带原文」，不替它编。
//
// 为什么要去重：几百个包里大量是同一份 MIT / Apache-2.0 文本，逐字节重复几千次没有
// 意义。按**内容**去重（同一份只存一份），条目用 textHash 指过去；哈希算在规范化后的
// 文本上（换行统一成 \n、行尾空白去掉）——否则同一个包在 Windows 与 macOS 上会算出
// 两个哈希，--check 会在 CI 上左右横跳。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 补回的许可原文（#158）。
//
// 这 43 个包发布到 registry 时就没把 LICENSE 打进包，所以包目录里翻不到原文。
// 原文逐字来自下面的来源链接：
//   origin: "repo"             上游仓库里对应这个版本的那份许可文件（链接带 commit，
//                              永远指向当时那一份）
//   origin: "license-official" 上游仓库里**任何版本**都没有许可文件，取的是许可证
//                              官方公开的原文（SPDX / Apache 基金会 / Mozilla），
//                              来源链接就是那条官方地址
//
// 不替任何上游编原文：这里没有的包，照实标成「未附带原文」。同一份文本只写一次，
// 用它的包列在 entries 里。包升级、改名以后，对不上的条目会在生成时被点名报错，
// 不会安安静静留着。
// ---------------------------------------------------------------------------

const RESTORED = [
  {
    origin: "repo",
    text: "Copyright (c) 2016 Dropbox, Inc.\nAll rights reserved.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:\n\n1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.\n\n2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.\n\n3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\nTHIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS \"AS IS\" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.\n",
    entries: [
      ["alloc-stdlib 0.2.4", ["https://github.com/dropbox/rust-alloc-no-stdlib/blob/ae42d22078b9/LICENSE"]],
    ],
  },
  {
    origin: "repo",
    text: "# License\n\nThe licensing of these crates is a bit complicated:\n- The crates `objc2`, `block2`, `objc2-foundation` and `objc2-encode` are\n  [currently][#23] licensed under [the MIT license][MIT].\n- All other crates are trio-licensed under the [Zlib], [Apache-2.0] or [MIT]\n  license, at your option.\n\nFurthermore, the crates are (usually automatically) derived from Apple SDKs,\nand that may have implications for licensing, see below for details.\n\n[#23]: https://github.com/madsmtm/objc2/issues/23\n[MIT]: https://opensource.org/license/MIT\n[Zlib]: https://zlib.net/zlib_license.html\n[Apache-2.0]: https://www.apache.org/licenses/LICENSE-2.0\n\n\n## Apple SDKs\n\nThese crates are derived from Apple SDKs shipped with Xcode. You can obtain a\ncopy of the Xcode license at:\n\nhttps://www.apple.com/legal/sla/docs/xcode.pdf\n\nOr by typing `xcodebuild -license` in your terminal.\n\nFrom reading the license, it is unclear whether distributing derived works\nsuch as these crates are allowed?\n\nBut in any case, to practically use these crates, you will have to link, and\nthat only works when you have the correct Xcode SDK available to provide the\nrequired `.tbd` files, which is why we choose to still use the normal SPDX\nidentifiers in the crates (Xcode is required to use the crates, and when using\nXcode you have already agreed to the Xcode license).\n",
    entries: [
      ["block2 0.6.2", ["https://github.com/madsmtm/objc2/blob/b4167b582b2f/LICENSE.md"]],
      ["dispatch2 0.3.1", ["https://github.com/madsmtm/objc2/blob/8852b424193c/LICENSE.md"]],
      ["objc2 0.6.4", ["https://github.com/madsmtm/objc2/blob/8852b424193c/LICENSE.md"]],
      ["objc2-app-kit 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-cloud-kit 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-data 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-foundation 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-graphics 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-image 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-location 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-core-text 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-encode 4.1.0", ["https://github.com/madsmtm/objc2/blob/8d214f547736/LICENSE.md"]],
      ["objc2-exception-helper 0.1.1", ["https://github.com/madsmtm/objc2/blob/8d214f547736/LICENSE.md"]],
      ["objc2-foundation 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-io-surface 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-quartz-core 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-ui-kit 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-user-notifications 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
      ["objc2-web-kit 0.3.2", ["https://github.com/madsmtm/objc2/blob/7b1abfd750a2/LICENSE.md"]],
    ],
  },
  {
    origin: "license-official",
    text: "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and\nassociated documentation files (the \"Software\"), to deal in the Software without restriction, including\nwithout limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the\nfollowing conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial\nportions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT\nLIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO\nEVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER\nIN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE\nUSE OR OTHER DEALINGS IN THE SOFTWARE.\n\n                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"[]\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright [yyyy] [name of copyright owner]\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n",
    entries: [
      ["cesu8 1.1.0", ["https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt", "https://www.apache.org/licenses/LICENSE-2.0.txt"]],
      ["r-efi 5.3.0", ["https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt", "https://www.apache.org/licenses/LICENSE-2.0.txt"]],
      ["r-efi 6.0.0", ["https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt", "https://www.apache.org/licenses/LICENSE-2.0.txt"]],
    ],
  },
  {
    origin: "repo",
    text: "                              Apache License\n                        Version 2.0, January 2004\n                     http://www.apache.org/licenses/\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n1. Definitions.\n\n   \"License\" shall mean the terms and conditions for use, reproduction,\n   and distribution as defined by Sections 1 through 9 of this document.\n\n   \"Licensor\" shall mean the copyright owner or entity authorized by\n   the copyright owner that is granting the License.\n\n   \"Legal Entity\" shall mean the union of the acting entity and all\n   other entities that control, are controlled by, or are under common\n   control with that entity. For the purposes of this definition,\n   \"control\" means (i) the power, direct or indirect, to cause the\n   direction or management of such entity, whether by contract or\n   otherwise, or (ii) ownership of fifty percent (50%) or more of the\n   outstanding shares, or (iii) beneficial ownership of such entity.\n\n   \"You\" (or \"Your\") shall mean an individual or Legal Entity\n   exercising permissions granted by this License.\n\n   \"Source\" form shall mean the preferred form for making modifications,\n   including but not limited to software source code, documentation\n   source, and configuration files.\n\n   \"Object\" form shall mean any form resulting from mechanical\n   transformation or translation of a Source form, including but\n   not limited to compiled object code, generated documentation,\n   and conversions to other media types.\n\n   \"Work\" shall mean the work of authorship, whether in Source or\n   Object form, made available under the License, as indicated by a\n   copyright notice that is included in or attached to the work\n   (an example is provided in the Appendix below).\n\n   \"Derivative Works\" shall mean any work, whether in Source or Object\n   form, that is based on (or derived from) the Work and for which the\n   editorial revisions, annotations, elaborations, or other modifications\n   represent, as a whole, an original work of authorship. For the purposes\n   of this License, Derivative Works shall not include works that remain\n   separable from, or merely link (or bind by name) to the interfaces of,\n   the Work and Derivative Works thereof.\n\n   \"Contribution\" shall mean any work of authorship, including\n   the original version of the Work and any modifications or additions\n   to that Work or Derivative Works thereof, that is intentionally\n   submitted to Licensor for inclusion in the Work by the copyright owner\n   or by an individual or Legal Entity authorized to submit on behalf of\n   the copyright owner. For the purposes of this definition, \"submitted\"\n   means any form of electronic, verbal, or written communication sent\n   to the Licensor or its representatives, including but not limited to\n   communication on electronic mailing lists, source code control systems,\n   and issue tracking systems that are managed by, or on behalf of, the\n   Licensor for the purpose of discussing and improving the Work, but\n   excluding communication that is conspicuously marked or otherwise\n   designated in writing by the copyright owner as \"Not a Contribution.\"\n\n   \"Contributor\" shall mean Licensor and any individual or Legal Entity\n   on behalf of whom a Contribution has been received by Licensor and\n   subsequently incorporated within the Work.\n\n2. Grant of Copyright License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   copyright license to reproduce, prepare Derivative Works of,\n   publicly display, publicly perform, sublicense, and distribute the\n   Work and such Derivative Works in Source or Object form.\n\n3. Grant of Patent License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   (except as stated in this section) patent license to make, have made,\n   use, offer to sell, sell, import, and otherwise transfer the Work,\n   where such license applies only to those patent claims licensable\n   by such Contributor that are necessarily infringed by their\n   Contribution(s) alone or by combination of their Contribution(s)\n   with the Work to which such Contribution(s) was submitted. If You\n   institute patent litigation against any entity (including a\n   cross-claim or counterclaim in a lawsuit) alleging that the Work\n   or a Contribution incorporated within the Work constitutes direct\n   or contributory patent infringement, then any patent licenses\n   granted to You under this License for that Work shall terminate\n   as of the date such litigation is filed.\n\n4. Redistribution. You may reproduce and distribute copies of the\n   Work or Derivative Works thereof in any medium, with or without\n   modifications, and in Source or Object form, provided that You\n   meet the following conditions:\n\n   (a) You must give any other recipients of the Work or\n       Derivative Works a copy of this License; and\n\n   (b) You must cause any modified files to carry prominent notices\n       stating that You changed the files; and\n\n   (c) You must retain, in the Source form of any Derivative Works\n       that You distribute, all copyright, patent, trademark, and\n       attribution notices from the Source form of the Work,\n       excluding those notices that do not pertain to any part of\n       the Derivative Works; and\n\n   (d) If the Work includes a \"NOTICE\" text file as part of its\n       distribution, then any Derivative Works that You distribute must\n       include a readable copy of the attribution notices contained\n       within such NOTICE file, excluding those notices that do not\n       pertain to any part of the Derivative Works, in at least one\n       of the following places: within a NOTICE text file distributed\n       as part of the Derivative Works; within the Source form or\n       documentation, if provided along with the Derivative Works; or,\n       within a display generated by the Derivative Works, if and\n       wherever such third-party notices normally appear. The contents\n       of the NOTICE file are for informational purposes only and\n       do not modify the License. You may add Your own attribution\n       notices within Derivative Works that You distribute, alongside\n       or as an addendum to the NOTICE text from the Work, provided\n       that such additional attribution notices cannot be construed\n       as modifying the License.\n\n   You may add Your own copyright statement to Your modifications and\n   may provide additional or different license terms and conditions\n   for use, reproduction, or distribution of Your modifications, or\n   for any such Derivative Works as a whole, provided Your use,\n   reproduction, and distribution of the Work otherwise complies with\n   the conditions stated in this License.\n\n5. Submission of Contributions. Unless You explicitly state otherwise,\n   any Contribution intentionally submitted for inclusion in the Work\n   by You to the Licensor shall be under the terms and conditions of\n   this License, without any additional terms or conditions.\n   Notwithstanding the above, nothing herein shall supersede or modify\n   the terms of any separate license agreement you may have executed\n   with Licensor regarding such Contributions.\n\n6. Trademarks. This License does not grant permission to use the trade\n   names, trademarks, service marks, or product names of the Licensor,\n   except as required for reasonable and customary use in describing the\n   origin of the Work and reproducing the content of the NOTICE file.\n\n7. Disclaimer of Warranty. Unless required by applicable law or\n   agreed to in writing, Licensor provides the Work (and each\n   Contributor provides its Contributions) on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n   implied, including, without limitation, any warranties or conditions\n   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n   PARTICULAR PURPOSE. You are solely responsible for determining the\n   appropriateness of using or redistributing the Work and assume any\n   risks associated with Your exercise of permissions under this License.\n\n8. Limitation of Liability. In no event and under no legal theory,\n   whether in tort (including negligence), contract, or otherwise,\n   unless required by applicable law (such as deliberate and grossly\n   negligent acts) or agreed to in writing, shall any Contributor be\n   liable to You for damages, including any direct, indirect, special,\n   incidental, or consequential damages of any character arising as a\n   result of this License or out of the use or inability to use the\n   Work (including but not limited to damages for loss of goodwill,\n   work stoppage, computer failure or malfunction, or any and all\n   other commercial damages or losses), even if such Contributor\n   has been advised of the possibility of such damages.\n\n9. Accepting Warranty or Additional Liability. While redistributing\n   the Work or Derivative Works thereof, You may choose to offer,\n   and charge a fee for, acceptance of support, warranty, indemnity,\n   or other liability obligations and/or rights consistent with this\n   License. However, in accepting such obligations, You may act only\n   on Your own behalf and on Your sole responsibility, not on behalf\n   of any other Contributor, and only if You agree to indemnify,\n   defend, and hold each Contributor harmless for any liability\n   incurred by, or claims asserted against, such Contributor by reason\n   of your accepting any such warranty or additional liability.\n\nEND OF TERMS AND CONDITIONS\n\nAPPENDIX: How to apply the Apache License to your work.\n\n   To apply the Apache License to your work, attach the following\n   boilerplate notice, with the fields enclosed by brackets \"[]\"\n   replaced with your own identifying information. (Don't include\n   the brackets!)  The text should be enclosed in the appropriate\n   comment syntax for the file format. We also recommend that a\n   file or class name and description of purpose be included on the\n   same \"printed page\" as the copyright notice for easier\n   identification within third-party archives.\n\nCopyright [yyyy] [name of copyright owner]\n\nLicensed under the Apache License, Version 2.0 (the \"License\");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n    http://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an \"AS IS\" BASIS,\nWITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\nSee the License for the specific language governing permissions and\nlimitations under the License.\n\nCopyright (c) Ferrous Systems\n\nPermission is hereby granted, free of charge, to any\nperson obtaining a copy of this software and associated\ndocumentation files (the \"Software\"), to deal in the\nSoftware without restriction, including without\nlimitation the rights to use, copy, modify, merge,\npublish, distribute, sublicense, and/or sell copies of\nthe Software, and to permit persons to whom the Software\nis furnished to do so, subject to the following\nconditions:\n\nThe above copyright notice and this permission notice\nshall be included in all copies or substantial portions\nof the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF\nANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED\nTO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A\nPARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT\nSHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY\nCLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION\nOF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR\nIN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER\nDEALINGS IN THE SOFTWARE.\n",
    entries: [
      ["defmt-parser 1.0.0", ["https://github.com/knurling-rs/defmt/blob/4a8cdb44891e/LICENSE-APACHE", "https://github.com/knurling-rs/defmt/blob/4a8cdb44891e/LICENSE-MIT"]],
    ],
  },
  {
    origin: "repo",
    text: "MIT License\n\nCopyright (c) 2017 Szymon Wieloch\nCopyright (C) 2019 Ahmed Masud <ahmed.masud@saf.ai>\nCopyright (C) 2022 OpenByte <development.openbyte@gmail.com>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["dlopen2 0.8.2", ["https://github.com/OpenByteDev/dlopen2/blob/cc80e4a0a90d/LICENSE"]],
      ["dlopen2_derive 0.4.3", ["https://github.com/OpenByteDev/dlopen2/blob/cc80e4a0a90d/LICENSE"]],
    ],
  },
  {
    origin: "repo",
    text: "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"{}\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright {yyyy} {name of copyright owner}\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n\nCopyright (c) 2015 The rust-jni-sys Developers\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["jni-sys-macros 0.4.1", ["https://github.com/jni-rs/jni-sys/blob/64d77b7a5f11/LICENSE-APACHE", "https://github.com/jni-rs/jni-sys/blob/64d77b7a5f11/LICENSE-MIT"]],
    ],
  },
  {
    origin: "repo",
    text: "                              Apache License\n                        Version 2.0, January 2004\n                     http://www.apache.org/licenses/\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n1. Definitions.\n\n   \"License\" shall mean the terms and conditions for use, reproduction,\n   and distribution as defined by Sections 1 through 9 of this document.\n\n   \"Licensor\" shall mean the copyright owner or entity authorized by\n   the copyright owner that is granting the License.\n\n   \"Legal Entity\" shall mean the union of the acting entity and all\n   other entities that control, are controlled by, or are under common\n   control with that entity. For the purposes of this definition,\n   \"control\" means (i) the power, direct or indirect, to cause the\n   direction or management of such entity, whether by contract or\n   otherwise, or (ii) ownership of fifty percent (50%) or more of the\n   outstanding shares, or (iii) beneficial ownership of such entity.\n\n   \"You\" (or \"Your\") shall mean an individual or Legal Entity\n   exercising permissions granted by this License.\n\n   \"Source\" form shall mean the preferred form for making modifications,\n   including but not limited to software source code, documentation\n   source, and configuration files.\n\n   \"Object\" form shall mean any form resulting from mechanical\n   transformation or translation of a Source form, including but\n   not limited to compiled object code, generated documentation,\n   and conversions to other media types.\n\n   \"Work\" shall mean the work of authorship, whether in Source or\n   Object form, made available under the License, as indicated by a\n   copyright notice that is included in or attached to the work\n   (an example is provided in the Appendix below).\n\n   \"Derivative Works\" shall mean any work, whether in Source or Object\n   form, that is based on (or derived from) the Work and for which the\n   editorial revisions, annotations, elaborations, or other modifications\n   represent, as a whole, an original work of authorship. For the purposes\n   of this License, Derivative Works shall not include works that remain\n   separable from, or merely link (or bind by name) to the interfaces of,\n   the Work and Derivative Works thereof.\n\n   \"Contribution\" shall mean any work of authorship, including\n   the original version of the Work and any modifications or additions\n   to that Work or Derivative Works thereof, that is intentionally\n   submitted to Licensor for inclusion in the Work by the copyright owner\n   or by an individual or Legal Entity authorized to submit on behalf of\n   the copyright owner. For the purposes of this definition, \"submitted\"\n   means any form of electronic, verbal, or written communication sent\n   to the Licensor or its representatives, including but not limited to\n   communication on electronic mailing lists, source code control systems,\n   and issue tracking systems that are managed by, or on behalf of, the\n   Licensor for the purpose of discussing and improving the Work, but\n   excluding communication that is conspicuously marked or otherwise\n   designated in writing by the copyright owner as \"Not a Contribution.\"\n\n   \"Contributor\" shall mean Licensor and any individual or Legal Entity\n   on behalf of whom a Contribution has been received by Licensor and\n   subsequently incorporated within the Work.\n\n2. Grant of Copyright License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   copyright license to reproduce, prepare Derivative Works of,\n   publicly display, publicly perform, sublicense, and distribute the\n   Work and such Derivative Works in Source or Object form.\n\n3. Grant of Patent License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   (except as stated in this section) patent license to make, have made,\n   use, offer to sell, sell, import, and otherwise transfer the Work,\n   where such license applies only to those patent claims licensable\n   by such Contributor that are necessarily infringed by their\n   Contribution(s) alone or by combination of their Contribution(s)\n   with the Work to which such Contribution(s) was submitted. If You\n   institute patent litigation against any entity (including a\n   cross-claim or counterclaim in a lawsuit) alleging that the Work\n   or a Contribution incorporated within the Work constitutes direct\n   or contributory patent infringement, then any patent licenses\n   granted to You under this License for that Work shall terminate\n   as of the date such litigation is filed.\n\n4. Redistribution. You may reproduce and distribute copies of the\n   Work or Derivative Works thereof in any medium, with or without\n   modifications, and in Source or Object form, provided that You\n   meet the following conditions:\n\n   (a) You must give any other recipients of the Work or\n       Derivative Works a copy of this License; and\n\n   (b) You must cause any modified files to carry prominent notices\n       stating that You changed the files; and\n\n   (c) You must retain, in the Source form of any Derivative Works\n       that You distribute, all copyright, patent, trademark, and\n       attribution notices from the Source form of the Work,\n       excluding those notices that do not pertain to any part of\n       the Derivative Works; and\n\n   (d) If the Work includes a \"NOTICE\" text file as part of its\n       distribution, then any Derivative Works that You distribute must\n       include a readable copy of the attribution notices contained\n       within such NOTICE file, excluding those notices that do not\n       pertain to any part of the Derivative Works, in at least one\n       of the following places: within a NOTICE text file distributed\n       as part of the Derivative Works; within the Source form or\n       documentation, if provided along with the Derivative Works; or,\n       within a display generated by the Derivative Works, if and\n       wherever such third-party notices normally appear. The contents\n       of the NOTICE file are for informational purposes only and\n       do not modify the License. You may add Your own attribution\n       notices within Derivative Works that You distribute, alongside\n       or as an addendum to the NOTICE text from the Work, provided\n       that such additional attribution notices cannot be construed\n       as modifying the License.\n\n   You may add Your own copyright statement to Your modifications and\n   may provide additional or different license terms and conditions\n   for use, reproduction, or distribution of Your modifications, or\n   for any such Derivative Works as a whole, provided Your use,\n   reproduction, and distribution of the Work otherwise complies with\n   the conditions stated in this License.\n\n5. Submission of Contributions. Unless You explicitly state otherwise,\n   any Contribution intentionally submitted for inclusion in the Work\n   by You to the Licensor shall be under the terms and conditions of\n   this License, without any additional terms or conditions.\n   Notwithstanding the above, nothing herein shall supersede or modify\n   the terms of any separate license agreement you may have executed\n   with Licensor regarding such Contributions.\n\n6. Trademarks. This License does not grant permission to use the trade\n   names, trademarks, service marks, or product names of the Licensor,\n   except as required for reasonable and customary use in describing the\n   origin of the Work and reproducing the content of the NOTICE file.\n\n7. Disclaimer of Warranty. Unless required by applicable law or\n   agreed to in writing, Licensor provides the Work (and each\n   Contributor provides its Contributions) on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n   implied, including, without limitation, any warranties or conditions\n   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n   PARTICULAR PURPOSE. You are solely responsible for determining the\n   appropriateness of using or redistributing the Work and assume any\n   risks associated with Your exercise of permissions under this License.\n\n8. Limitation of Liability. In no event and under no legal theory,\n   whether in tort (including negligence), contract, or otherwise,\n   unless required by applicable law (such as deliberate and grossly\n   negligent acts) or agreed to in writing, shall any Contributor be\n   liable to You for damages, including any direct, indirect, special,\n   incidental, or consequential damages of any character arising as a\n   result of this License or out of the use or inability to use the\n   Work (including but not limited to damages for loss of goodwill,\n   work stoppage, computer failure or malfunction, or any and all\n   other commercial damages or losses), even if such Contributor\n   has been advised of the possibility of such damages.\n\n9. Accepting Warranty or Additional Liability. While redistributing\n   the Work or Derivative Works thereof, You may choose to offer,\n   and charge a fee for, acceptance of support, warranty, indemnity,\n   or other liability obligations and/or rights consistent with this\n   License. However, in accepting such obligations, You may act only\n   on Your own behalf and on Your sole responsibility, not on behalf\n   of any other Contributor, and only if You agree to indemnify,\n   defend, and hold each Contributor harmless for any liability\n   incurred by, or claims asserted against, such Contributor by reason\n   of your accepting any such warranty or additional liability.\n\nEND OF TERMS AND CONDITIONS\n\nAPPENDIX: How to apply the Apache License to your work.\n\n   To apply the Apache License to your work, attach the following\n   boilerplate notice, with the fields enclosed by brackets \"[]\"\n   replaced with your own identifying information. (Don't include\n   the brackets!)  The text should be enclosed in the appropriate\n   comment syntax for the file format. We also recommend that a\n   file or class name and description of purpose be included on the\n   same \"printed page\" as the copyright notice for easier\n   identification within third-party archives.\n\nCopyright [yyyy] [name of copyright owner]\n\nLicensed under the Apache License, Version 2.0 (the \"License\");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n\thttp://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an \"AS IS\" BASIS,\nWITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\nSee the License for the specific language governing permissions and\nlimitations under the License.\n\nMIT License\n\nCopyright (c) 2017-2021 qDot\nCopyright (c) 2021 Tauri Apps Contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["libappindicator-sys 0.9.0", ["https://github.com/tauri-apps/libappindicator-rs/blob/eafd1e3682a1/LICENSE-APACHE", "https://github.com/tauri-apps/libappindicator-rs/blob/eafd1e3682a1/LICENSE-MIT"]],
    ],
  },
  {
    origin: "repo",
    text: "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"[]\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright [yyyy] [name of copyright owner]\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n\nMIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["ndk 0.9.0", ["https://github.com/rust-mobile/ndk/blob/49bbbba16c58/LICENSE-APACHE", "https://github.com/rust-mobile/ndk/blob/49bbbba16c58/LICENSE-MIT"]],
      ["ndk-sys 0.6.0+11769913", ["https://github.com/rust-mobile/ndk/blob/49bbbba16c58/LICENSE-APACHE", "https://github.com/rust-mobile/ndk/blob/49bbbba16c58/LICENSE-MIT"]],
    ],
  },
  {
    origin: "license-official",
    text: "Mozilla Public License Version 2.0\n==================================\n\n1. Definitions\n--------------\n\n1.1. \"Contributor\"\n    means each individual or legal entity that creates, contributes to\n    the creation of, or owns Covered Software.\n\n1.2. \"Contributor Version\"\n    means the combination of the Contributions of others (if any) used\n    by a Contributor and that particular Contributor's Contribution.\n\n1.3. \"Contribution\"\n    means Covered Software of a particular Contributor.\n\n1.4. \"Covered Software\"\n    means Source Code Form to which the initial Contributor has attached\n    the notice in Exhibit A, the Executable Form of such Source Code\n    Form, and Modifications of such Source Code Form, in each case\n    including portions thereof.\n\n1.5. \"Incompatible With Secondary Licenses\"\n    means\n\n    (a) that the initial Contributor has attached the notice described\n        in Exhibit B to the Covered Software; or\n\n    (b) that the Covered Software was made available under the terms of\n        version 1.1 or earlier of the License, but not also under the\n        terms of a Secondary License.\n\n1.6. \"Executable Form\"\n    means any form of the work other than Source Code Form.\n\n1.7. \"Larger Work\"\n    means a work that combines Covered Software with other material, in\n    a separate file or files, that is not Covered Software.\n\n1.8. \"License\"\n    means this document.\n\n1.9. \"Licensable\"\n    means having the right to grant, to the maximum extent possible,\n    whether at the time of the initial grant or subsequently, any and\n    all of the rights conveyed by this License.\n\n1.10. \"Modifications\"\n    means any of the following:\n\n    (a) any file in Source Code Form that results from an addition to,\n        deletion from, or modification of the contents of Covered\n        Software; or\n\n    (b) any new file in Source Code Form that contains any Covered\n        Software.\n\n1.11. \"Patent Claims\" of a Contributor\n    means any patent claim(s), including without limitation, method,\n    process, and apparatus claims, in any patent Licensable by such\n    Contributor that would be infringed, but for the grant of the\n    License, by the making, using, selling, offering for sale, having\n    made, import, or transfer of either its Contributions or its\n    Contributor Version.\n\n1.12. \"Secondary License\"\n    means either the GNU General Public License, Version 2.0, the GNU\n    Lesser General Public License, Version 2.1, the GNU Affero General\n    Public License, Version 3.0, or any later versions of those\n    licenses.\n\n1.13. \"Source Code Form\"\n    means the form of the work preferred for making modifications.\n\n1.14. \"You\" (or \"Your\")\n    means an individual or a legal entity exercising rights under this\n    License. For legal entities, \"You\" includes any entity that\n    controls, is controlled by, or is under common control with You. For\n    purposes of this definition, \"control\" means (a) the power, direct\n    or indirect, to cause the direction or management of such entity,\n    whether by contract or otherwise, or (b) ownership of more than\n    fifty percent (50%) of the outstanding shares or beneficial\n    ownership of such entity.\n\n2. License Grants and Conditions\n--------------------------------\n\n2.1. Grants\n\nEach Contributor hereby grants You a world-wide, royalty-free,\nnon-exclusive license:\n\n(a) under intellectual property rights (other than patent or trademark)\n    Licensable by such Contributor to use, reproduce, make available,\n    modify, display, perform, distribute, and otherwise exploit its\n    Contributions, either on an unmodified basis, with Modifications, or\n    as part of a Larger Work; and\n\n(b) under Patent Claims of such Contributor to make, use, sell, offer\n    for sale, have made, import, and otherwise transfer either its\n    Contributions or its Contributor Version.\n\n2.2. Effective Date\n\nThe licenses granted in Section 2.1 with respect to any Contribution\nbecome effective for each Contribution on the date the Contributor first\ndistributes such Contribution.\n\n2.3. Limitations on Grant Scope\n\nThe licenses granted in this Section 2 are the only rights granted under\nthis License. No additional rights or licenses will be implied from the\ndistribution or licensing of Covered Software under this License.\nNotwithstanding Section 2.1(b) above, no patent license is granted by a\nContributor:\n\n(a) for any code that a Contributor has removed from Covered Software;\n    or\n\n(b) for infringements caused by: (i) Your and any other third party's\n    modifications of Covered Software, or (ii) the combination of its\n    Contributions with other software (except as part of its Contributor\n    Version); or\n\n(c) under Patent Claims infringed by Covered Software in the absence of\n    its Contributions.\n\nThis License does not grant any rights in the trademarks, service marks,\nor logos of any Contributor (except as may be necessary to comply with\nthe notice requirements in Section 3.4).\n\n2.4. Subsequent Licenses\n\nNo Contributor makes additional grants as a result of Your choice to\ndistribute the Covered Software under a subsequent version of this\nLicense (see Section 10.2) or under the terms of a Secondary License (if\npermitted under the terms of Section 3.3).\n\n2.5. Representation\n\nEach Contributor represents that the Contributor believes its\nContributions are its original creation(s) or it has sufficient rights\nto grant the rights to its Contributions conveyed by this License.\n\n2.6. Fair Use\n\nThis License is not intended to limit any rights You have under\napplicable copyright doctrines of fair use, fair dealing, or other\nequivalents.\n\n2.7. Conditions\n\nSections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted\nin Section 2.1.\n\n3. Responsibilities\n-------------------\n\n3.1. Distribution of Source Form\n\nAll distribution of Covered Software in Source Code Form, including any\nModifications that You create or to which You contribute, must be under\nthe terms of this License. You must inform recipients that the Source\nCode Form of the Covered Software is governed by the terms of this\nLicense, and how they can obtain a copy of this License. You may not\nattempt to alter or restrict the recipients' rights in the Source Code\nForm.\n\n3.2. Distribution of Executable Form\n\nIf You distribute Covered Software in Executable Form then:\n\n(a) such Covered Software must also be made available in Source Code\n    Form, as described in Section 3.1, and You must inform recipients of\n    the Executable Form how they can obtain a copy of such Source Code\n    Form by reasonable means in a timely manner, at a charge no more\n    than the cost of distribution to the recipient; and\n\n(b) You may distribute such Executable Form under the terms of this\n    License, or sublicense it under different terms, provided that the\n    license for the Executable Form does not attempt to limit or alter\n    the recipients' rights in the Source Code Form under this License.\n\n3.3. Distribution of a Larger Work\n\nYou may create and distribute a Larger Work under terms of Your choice,\nprovided that You also comply with the requirements of this License for\nthe Covered Software. If the Larger Work is a combination of Covered\nSoftware with a work governed by one or more Secondary Licenses, and the\nCovered Software is not Incompatible With Secondary Licenses, this\nLicense permits You to additionally distribute such Covered Software\nunder the terms of such Secondary License(s), so that the recipient of\nthe Larger Work may, at their option, further distribute the Covered\nSoftware under the terms of either this License or such Secondary\nLicense(s).\n\n3.4. Notices\n\nYou may not remove or alter the substance of any license notices\n(including copyright notices, patent notices, disclaimers of warranty,\nor limitations of liability) contained within the Source Code Form of\nthe Covered Software, except that You may alter any license notices to\nthe extent required to remedy known factual inaccuracies.\n\n3.5. Application of Additional Terms\n\nYou may choose to offer, and to charge a fee for, warranty, support,\nindemnity or liability obligations to one or more recipients of Covered\nSoftware. However, You may do so only on Your own behalf, and not on\nbehalf of any Contributor. You must make it absolutely clear that any\nsuch warranty, support, indemnity, or liability obligation is offered by\nYou alone, and You hereby agree to indemnify every Contributor for any\nliability incurred by such Contributor as a result of warranty, support,\nindemnity or liability terms You offer. You may include additional\ndisclaimers of warranty and limitations of liability specific to any\njurisdiction.\n\n4. Inability to Comply Due to Statute or Regulation\n---------------------------------------------------\n\nIf it is impossible for You to comply with any of the terms of this\nLicense with respect to some or all of the Covered Software due to\nstatute, judicial order, or regulation then You must: (a) comply with\nthe terms of this License to the maximum extent possible; and (b)\ndescribe the limitations and the code they affect. Such description must\nbe placed in a text file included with all distributions of the Covered\nSoftware under this License. Except to the extent prohibited by statute\nor regulation, such description must be sufficiently detailed for a\nrecipient of ordinary skill to be able to understand it.\n\n5. Termination\n--------------\n\n5.1. The rights granted under this License will terminate automatically\nif You fail to comply with any of its terms. However, if You become\ncompliant, then the rights granted under this License from a particular\nContributor are reinstated (a) provisionally, unless and until such\nContributor explicitly and finally terminates Your grants, and (b) on an\nongoing basis, if such Contributor fails to notify You of the\nnon-compliance by some reasonable means prior to 60 days after You have\ncome back into compliance. Moreover, Your grants from a particular\nContributor are reinstated on an ongoing basis if such Contributor\nnotifies You of the non-compliance by some reasonable means, this is the\nfirst time You have received notice of non-compliance with this License\nfrom such Contributor, and You become compliant prior to 30 days after\nYour receipt of the notice.\n\n5.2. If You initiate litigation against any entity by asserting a patent\ninfringement claim (excluding declaratory judgment actions,\ncounter-claims, and cross-claims) alleging that a Contributor Version\ndirectly or indirectly infringes any patent, then the rights granted to\nYou by any and all Contributors for the Covered Software under Section\n2.1 of this License shall terminate.\n\n5.3. In the event of termination under Sections 5.1 or 5.2 above, all\nend user license agreements (excluding distributors and resellers) which\nhave been validly granted by You or Your distributors under this License\nprior to termination shall survive termination.\n\n************************************************************************\n*                                                                      *\n*  6. Disclaimer of Warranty                                           *\n*  -------------------------                                           *\n*                                                                      *\n*  Covered Software is provided under this License on an \"as is\"       *\n*  basis, without warranty of any kind, either expressed, implied, or  *\n*  statutory, including, without limitation, warranties that the       *\n*  Covered Software is free of defects, merchantable, fit for a        *\n*  particular purpose or non-infringing. The entire risk as to the     *\n*  quality and performance of the Covered Software is with You.        *\n*  Should any Covered Software prove defective in any respect, You     *\n*  (not any Contributor) assume the cost of any necessary servicing,   *\n*  repair, or correction. This disclaimer of warranty constitutes an   *\n*  essential part of this License. No use of any Covered Software is   *\n*  authorized under this License except under this disclaimer.         *\n*                                                                      *\n************************************************************************\n\n************************************************************************\n*                                                                      *\n*  7. Limitation of Liability                                          *\n*  --------------------------                                          *\n*                                                                      *\n*  Under no circumstances and under no legal theory, whether tort      *\n*  (including negligence), contract, or otherwise, shall any           *\n*  Contributor, or anyone who distributes Covered Software as          *\n*  permitted above, be liable to You for any direct, indirect,         *\n*  special, incidental, or consequential damages of any character      *\n*  including, without limitation, damages for lost profits, loss of    *\n*  goodwill, work stoppage, computer failure or malfunction, or any    *\n*  and all other commercial damages or losses, even if such party      *\n*  shall have been informed of the possibility of such damages. This   *\n*  limitation of liability shall not apply to liability for death or   *\n*  personal injury resulting from such party's negligence to the       *\n*  extent applicable law prohibits such limitation. Some               *\n*  jurisdictions do not allow the exclusion or limitation of           *\n*  incidental or consequential damages, so this exclusion and          *\n*  limitation may not apply to You.                                    *\n*                                                                      *\n************************************************************************\n\n8. Litigation\n-------------\n\nAny litigation relating to this License may be brought only in the\ncourts of a jurisdiction where the defendant maintains its principal\nplace of business and such litigation shall be governed by laws of that\njurisdiction, without reference to its conflict-of-law provisions.\nNothing in this Section shall prevent a party's ability to bring\ncross-claims or counter-claims.\n\n9. Miscellaneous\n----------------\n\nThis License represents the complete agreement concerning the subject\nmatter hereof. If any provision of this License is held to be\nunenforceable, such provision shall be reformed only to the extent\nnecessary to make it enforceable. Any law or regulation which provides\nthat the language of a contract shall be construed against the drafter\nshall not be used to construe this License against a Contributor.\n\n10. Versions of the License\n---------------------------\n\n10.1. New Versions\n\nMozilla Foundation is the license steward. Except as provided in Section\n10.3, no one other than the license steward has the right to modify or\npublish new versions of this License. Each version will be given a\ndistinguishing version number.\n\n10.2. Effect of New Versions\n\nYou may distribute the Covered Software under the terms of the version\nof the License under which You originally received the Covered Software,\nor under the terms of any subsequent version published by the license\nsteward.\n\n10.3. Modified Versions\n\nIf you create software not governed by this License, and you want to\ncreate a new license for such software, you may create and use a\nmodified version of this License if you rename the license and remove\nany references to the name of the license steward (except to note that\nsuch modified license differs from this License).\n\n10.4. Distributing Source Code Form that is Incompatible With Secondary\nLicenses\n\nIf You choose to distribute Source Code Form that is Incompatible With\nSecondary Licenses under the terms of this version of the License, the\nnotice described in Exhibit B of this License must be attached.\n\nExhibit A - Source Code Form License Notice\n-------------------------------------------\n\n  This Source Code Form is subject to the terms of the Mozilla Public\n  License, v. 2.0. If a copy of the MPL was not distributed with this\n  file, You can obtain one at https://mozilla.org/MPL/2.0/.\n\nIf it is not possible or desirable to put the notice in a particular\nfile, then You may include the notice in a location (such as a LICENSE\nfile in a relevant directory) where a recipient would be likely to look\nfor such a notice.\n\nYou may add additional accurate notices of copyright ownership.\n\nExhibit B - \"Incompatible With Secondary Licenses\" Notice\n---------------------------------------------------------\n\n  This Source Code Form is \"Incompatible With Secondary Licenses\", as\n  defined by the Mozilla Public License, v. 2.0.\n",
    entries: [
      ["selectors 0.36.1", ["https://www.mozilla.org/media/MPL/2.0/index.txt"]],
    ],
  },
  {
    origin: "repo",
    text: "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\nMIT License\n\nCopyright (c) 2017 - Present Tauri Apps Contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["tauri-plugin 2.6.3", ["https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3/LICENSE_APACHE-2.0", "https://github.com/tauri-apps/tauri/blob/6f6ab1207bb3/LICENSE_MIT"]],
    ],
  },
  {
    origin: "repo",
    text: "                              Apache License\n                        Version 2.0, January 2004\n                     http://www.apache.org/licenses/\n\nTERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n1. Definitions.\n\n   \"License\" shall mean the terms and conditions for use, reproduction,\n   and distribution as defined by Sections 1 through 9 of this document.\n\n   \"Licensor\" shall mean the copyright owner or entity authorized by\n   the copyright owner that is granting the License.\n\n   \"Legal Entity\" shall mean the union of the acting entity and all\n   other entities that control, are controlled by, or are under common\n   control with that entity. For the purposes of this definition,\n   \"control\" means (i) the power, direct or indirect, to cause the\n   direction or management of such entity, whether by contract or\n   otherwise, or (ii) ownership of fifty percent (50%) or more of the\n   outstanding shares, or (iii) beneficial ownership of such entity.\n\n   \"You\" (or \"Your\") shall mean an individual or Legal Entity\n   exercising permissions granted by this License.\n\n   \"Source\" form shall mean the preferred form for making modifications,\n   including but not limited to software source code, documentation\n   source, and configuration files.\n\n   \"Object\" form shall mean any form resulting from mechanical\n   transformation or translation of a Source form, including but\n   not limited to compiled object code, generated documentation,\n   and conversions to other media types.\n\n   \"Work\" shall mean the work of authorship, whether in Source or\n   Object form, made available under the License, as indicated by a\n   copyright notice that is included in or attached to the work\n   (an example is provided in the Appendix below).\n\n   \"Derivative Works\" shall mean any work, whether in Source or Object\n   form, that is based on (or derived from) the Work and for which the\n   editorial revisions, annotations, elaborations, or other modifications\n   represent, as a whole, an original work of authorship. For the purposes\n   of this License, Derivative Works shall not include works that remain\n   separable from, or merely link (or bind by name) to the interfaces of,\n   the Work and Derivative Works thereof.\n\n   \"Contribution\" shall mean any work of authorship, including\n   the original version of the Work and any modifications or additions\n   to that Work or Derivative Works thereof, that is intentionally\n   submitted to Licensor for inclusion in the Work by the copyright owner\n   or by an individual or Legal Entity authorized to submit on behalf of\n   the copyright owner. For the purposes of this definition, \"submitted\"\n   means any form of electronic, verbal, or written communication sent\n   to the Licensor or its representatives, including but not limited to\n   communication on electronic mailing lists, source code control systems,\n   and issue tracking systems that are managed by, or on behalf of, the\n   Licensor for the purpose of discussing and improving the Work, but\n   excluding communication that is conspicuously marked or otherwise\n   designated in writing by the copyright owner as \"Not a Contribution.\"\n\n   \"Contributor\" shall mean Licensor and any individual or Legal Entity\n   on behalf of whom a Contribution has been received by Licensor and\n   subsequently incorporated within the Work.\n\n2. Grant of Copyright License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   copyright license to reproduce, prepare Derivative Works of,\n   publicly display, publicly perform, sublicense, and distribute the\n   Work and such Derivative Works in Source or Object form.\n\n3. Grant of Patent License. Subject to the terms and conditions of\n   this License, each Contributor hereby grants to You a perpetual,\n   worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n   (except as stated in this section) patent license to make, have made,\n   use, offer to sell, sell, import, and otherwise transfer the Work,\n   where such license applies only to those patent claims licensable\n   by such Contributor that are necessarily infringed by their\n   Contribution(s) alone or by combination of their Contribution(s)\n   with the Work to which such Contribution(s) was submitted. If You\n   institute patent litigation against any entity (including a\n   cross-claim or counterclaim in a lawsuit) alleging that the Work\n   or a Contribution incorporated within the Work constitutes direct\n   or contributory patent infringement, then any patent licenses\n   granted to You under this License for that Work shall terminate\n   as of the date such litigation is filed.\n\n4. Redistribution. You may reproduce and distribute copies of the\n   Work or Derivative Works thereof in any medium, with or without\n   modifications, and in Source or Object form, provided that You\n   meet the following conditions:\n\n   (a) You must give any other recipients of the Work or\n       Derivative Works a copy of this License; and\n\n   (b) You must cause any modified files to carry prominent notices\n       stating that You changed the files; and\n\n   (c) You must retain, in the Source form of any Derivative Works\n       that You distribute, all copyright, patent, trademark, and\n       attribution notices from the Source form of the Work,\n       excluding those notices that do not pertain to any part of\n       the Derivative Works; and\n\n   (d) If the Work includes a \"NOTICE\" text file as part of its\n       distribution, then any Derivative Works that You distribute must\n       include a readable copy of the attribution notices contained\n       within such NOTICE file, excluding those notices that do not\n       pertain to any part of the Derivative Works, in at least one\n       of the following places: within a NOTICE text file distributed\n       as part of the Derivative Works; within the Source form or\n       documentation, if provided along with the Derivative Works; or,\n       within a display generated by the Derivative Works, if and\n       wherever such third-party notices normally appear. The contents\n       of the NOTICE file are for informational purposes only and\n       do not modify the License. You may add Your own attribution\n       notices within Derivative Works that You distribute, alongside\n       or as an addendum to the NOTICE text from the Work, provided\n       that such additional attribution notices cannot be construed\n       as modifying the License.\n\n   You may add Your own copyright statement to Your modifications and\n   may provide additional or different license terms and conditions\n   for use, reproduction, or distribution of Your modifications, or\n   for any such Derivative Works as a whole, provided Your use,\n   reproduction, and distribution of the Work otherwise complies with\n   the conditions stated in this License.\n\n5. Submission of Contributions. Unless You explicitly state otherwise,\n   any Contribution intentionally submitted for inclusion in the Work\n   by You to the Licensor shall be under the terms and conditions of\n   this License, without any additional terms or conditions.\n   Notwithstanding the above, nothing herein shall supersede or modify\n   the terms of any separate license agreement you may have executed\n   with Licensor regarding such Contributions.\n\n6. Trademarks. This License does not grant permission to use the trade\n   names, trademarks, service marks, or product names of the Licensor,\n   except as required for reasonable and customary use in describing the\n   origin of the Work and reproducing the content of the NOTICE file.\n\n7. Disclaimer of Warranty. Unless required by applicable law or\n   agreed to in writing, Licensor provides the Work (and each\n   Contributor provides its Contributions) on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n   implied, including, without limitation, any warranties or conditions\n   of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n   PARTICULAR PURPOSE. You are solely responsible for determining the\n   appropriateness of using or redistributing the Work and assume any\n   risks associated with Your exercise of permissions under this License.\n\n8. Limitation of Liability. In no event and under no legal theory,\n   whether in tort (including negligence), contract, or otherwise,\n   unless required by applicable law (such as deliberate and grossly\n   negligent acts) or agreed to in writing, shall any Contributor be\n   liable to You for damages, including any direct, indirect, special,\n   incidental, or consequential damages of any character arising as a\n   result of this License or out of the use or inability to use the\n   Work (including but not limited to damages for loss of goodwill,\n   work stoppage, computer failure or malfunction, or any and all\n   other commercial damages or losses), even if such Contributor\n   has been advised of the possibility of such damages.\n\n9. Accepting Warranty or Additional Liability. While redistributing\n   the Work or Derivative Works thereof, You may choose to offer,\n   and charge a fee for, acceptance of support, warranty, indemnity,\n   or other liability obligations and/or rights consistent with this\n   License. However, in accepting such obligations, You may act only\n   on Your own behalf and on Your sole responsibility, not on behalf\n   of any other Contributor, and only if You agree to indemnify,\n   defend, and hold each Contributor harmless for any liability\n   incurred by, or claims asserted against, such Contributor by reason\n   of your accepting any such warranty or additional liability.\n\nEND OF TERMS AND CONDITIONS\n\nAPPENDIX: How to apply the Apache License to your work.\n\n   To apply the Apache License to your work, attach the following\n   boilerplate notice, with the fields enclosed by brackets \"[]\"\n   replaced with your own identifying information. (Don't include\n   the brackets!)  The text should be enclosed in the appropriate\n   comment syntax for the file format. We also recommend that a\n   file or class name and description of purpose be included on the\n   same \"printed page\" as the copyright notice for easier\n   identification within third-party archives.\n\nCopyright [yyyy] [name of copyright owner]\n\nLicensed under the Apache License, Version 2.0 (the \"License\");\nyou may not use this file except in compliance with the License.\nYou may obtain a copy of the License at\n\n\thttp://www.apache.org/licenses/LICENSE-2.0\n\nUnless required by applicable law or agreed to in writing, software\ndistributed under the License is distributed on an \"AS IS\" BASIS,\nWITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\nSee the License for the specific language governing permissions and\nlimitations under the License.\n\nPermission is hereby granted, free of charge, to any\nperson obtaining a copy of this software and associated\ndocumentation files (the \"Software\"), to deal in the\nSoftware without restriction, including without\nlimitation the rights to use, copy, modify, merge,\npublish, distribute, sublicense, and/or sell copies of\nthe Software, and to permit persons to whom the Software\nis furnished to do so, subject to the following\nconditions:\n\nThe above copyright notice and this permission notice\nshall be included in all copies or substantial portions\nof the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF\nANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED\nTO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A\nPARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT\nSHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY\nCLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION\nOF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR\nIN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER\nDEALINGS IN THE SOFTWARE.\n",
    entries: [
      ["unic-char-property 0.9.0", ["https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-APACHE", "https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-MIT"]],
      ["unic-char-range 0.9.0", ["https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-APACHE", "https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-MIT"]],
      ["unic-common 0.9.0", ["https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-APACHE", "https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-MIT"]],
      ["unic-ucd-ident 0.9.0", ["https://github.com/open-i18n/rust-unic/blob/8a6ce83063d9/LICENSE-APACHE", "https://github.com/open-i18n/rust-unic/blob/8a6ce83063d9/LICENSE-MIT"]],
      ["unic-ucd-version 0.9.0", ["https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-APACHE", "https://github.com/open-i18n/rust-unic/blob/5878605364af/LICENSE-MIT"]],
    ],
  },
  {
    origin: "license-official",
    text: "MIT License\n\nCopyright (c) <year> <copyright holders>\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and\nassociated documentation files (the \"Software\"), to deal in the Software without restriction, including\nwithout limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the\nfollowing conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial\nportions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT\nLIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO\nEVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER\nIN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE\nUSE OR OTHER DEALINGS IN THE SOFTWARE.\n",
    entries: [
      ["vite-plugin-solid 2.11.14", ["https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt"]],
    ],
  },
  {
    origin: "repo",
    text: "MIT License\n\nCopyright (c) 2021 Bill Avery\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["webview2-com 0.38.2", ["https://github.com/wravery/webview2-rs/blob/b74dc5e2b394/LICENSE"]],
      ["webview2-com-macros 0.8.1", ["https://github.com/wravery/webview2-rs/blob/dffa41a8a46d/LICENSE"]],
      ["webview2-com-sys 0.38.2", ["https://github.com/wravery/webview2-rs/blob/b74dc5e2b394/LICENSE"]],
    ],
  },
  {
    origin: "repo",
    text: "                                 Apache License\n                           Version 2.0, January 2004\n                        http://www.apache.org/licenses/\n\n   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n\n   1. Definitions.\n\n      \"License\" shall mean the terms and conditions for use, reproduction,\n      and distribution as defined by Sections 1 through 9 of this document.\n\n      \"Licensor\" shall mean the copyright owner or entity authorized by\n      the copyright owner that is granting the License.\n\n      \"Legal Entity\" shall mean the union of the acting entity and all\n      other entities that control, are controlled by, or are under common\n      control with that entity. For the purposes of this definition,\n      \"control\" means (i) the power, direct or indirect, to cause the\n      direction or management of such entity, whether by contract or\n      otherwise, or (ii) ownership of fifty percent (50%) or more of the\n      outstanding shares, or (iii) beneficial ownership of such entity.\n\n      \"You\" (or \"Your\") shall mean an individual or Legal Entity\n      exercising permissions granted by this License.\n\n      \"Source\" form shall mean the preferred form for making modifications,\n      including but not limited to software source code, documentation\n      source, and configuration files.\n\n      \"Object\" form shall mean any form resulting from mechanical\n      transformation or translation of a Source form, including but\n      not limited to compiled object code, generated documentation,\n      and conversions to other media types.\n\n      \"Work\" shall mean the work of authorship, whether in Source or\n      Object form, made available under the License, as indicated by a\n      copyright notice that is included in or attached to the work\n      (an example is provided in the Appendix below).\n\n      \"Derivative Works\" shall mean any work, whether in Source or Object\n      form, that is based on (or derived from) the Work and for which the\n      editorial revisions, annotations, elaborations, or other modifications\n      represent, as a whole, an original work of authorship. For the purposes\n      of this License, Derivative Works shall not include works that remain\n      separable from, or merely link (or bind by name) to the interfaces of,\n      the Work and Derivative Works thereof.\n\n      \"Contribution\" shall mean any work of authorship, including\n      the original version of the Work and any modifications or additions\n      to that Work or Derivative Works thereof, that is intentionally\n      submitted to Licensor for inclusion in the Work by the copyright owner\n      or by an individual or Legal Entity authorized to submit on behalf of\n      the copyright owner. For the purposes of this definition, \"submitted\"\n      means any form of electronic, verbal, or written communication sent\n      to the Licensor or its representatives, including but not limited to\n      communication on electronic mailing lists, source code control systems,\n      and issue tracking systems that are managed by, or on behalf of, the\n      Licensor for the purpose of discussing and improving the Work, but\n      excluding communication that is conspicuously marked or otherwise\n      designated in writing by the copyright owner as \"Not a Contribution.\"\n\n      \"Contributor\" shall mean Licensor and any individual or Legal Entity\n      on behalf of whom a Contribution has been received by Licensor and\n      subsequently incorporated within the Work.\n\n   2. Grant of Copyright License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      copyright license to reproduce, prepare Derivative Works of,\n      publicly display, publicly perform, sublicense, and distribute the\n      Work and such Derivative Works in Source or Object form.\n\n   3. Grant of Patent License. Subject to the terms and conditions of\n      this License, each Contributor hereby grants to You a perpetual,\n      worldwide, non-exclusive, no-charge, royalty-free, irrevocable\n      (except as stated in this section) patent license to make, have made,\n      use, offer to sell, sell, import, and otherwise transfer the Work,\n      where such license applies only to those patent claims licensable\n      by such Contributor that are necessarily infringed by their\n      Contribution(s) alone or by combination of their Contribution(s)\n      with the Work to which such Contribution(s) was submitted. If You\n      institute patent litigation against any entity (including a\n      cross-claim or counterclaim in a lawsuit) alleging that the Work\n      or a Contribution incorporated within the Work constitutes direct\n      or contributory patent infringement, then any patent licenses\n      granted to You under this License for that Work shall terminate\n      as of the date such litigation is filed.\n\n   4. Redistribution. You may reproduce and distribute copies of the\n      Work or Derivative Works thereof in any medium, with or without\n      modifications, and in Source or Object form, provided that You\n      meet the following conditions:\n\n      (a) You must give any other recipients of the Work or\n          Derivative Works a copy of this License; and\n\n      (b) You must cause any modified files to carry prominent notices\n          stating that You changed the files; and\n\n      (c) You must retain, in the Source form of any Derivative Works\n          that You distribute, all copyright, patent, trademark, and\n          attribution notices from the Source form of the Work,\n          excluding those notices that do not pertain to any part of\n          the Derivative Works; and\n\n      (d) If the Work includes a \"NOTICE\" text file as part of its\n          distribution, then any Derivative Works that You distribute must\n          include a readable copy of the attribution notices contained\n          within such NOTICE file, excluding those notices that do not\n          pertain to any part of the Derivative Works, in at least one\n          of the following places: within a NOTICE text file distributed\n          as part of the Derivative Works; within the Source form or\n          documentation, if provided along with the Derivative Works; or,\n          within a display generated by the Derivative Works, if and\n          wherever such third-party notices normally appear. The contents\n          of the NOTICE file are for informational purposes only and\n          do not modify the License. You may add Your own attribution\n          notices within Derivative Works that You distribute, alongside\n          or as an addendum to the NOTICE text from the Work, provided\n          that such additional attribution notices cannot be construed\n          as modifying the License.\n\n      You may add Your own copyright statement to Your modifications and\n      may provide additional or different license terms and conditions\n      for use, reproduction, or distribution of Your modifications, or\n      for any such Derivative Works as a whole, provided Your use,\n      reproduction, and distribution of the Work otherwise complies with\n      the conditions stated in this License.\n\n   5. Submission of Contributions. Unless You explicitly state otherwise,\n      any Contribution intentionally submitted for inclusion in the Work\n      by You to the Licensor shall be under the terms and conditions of\n      this License, without any additional terms or conditions.\n      Notwithstanding the above, nothing herein shall supersede or modify\n      the terms of any separate license agreement you may have executed\n      with Licensor regarding such Contributions.\n\n   6. Trademarks. This License does not grant permission to use the trade\n      names, trademarks, service marks, or product names of the Licensor,\n      except as required for reasonable and customary use in describing the\n      origin of the Work and reproducing the content of the NOTICE file.\n\n   7. Disclaimer of Warranty. Unless required by applicable law or\n      agreed to in writing, Licensor provides the Work (and each\n      Contributor provides its Contributions) on an \"AS IS\" BASIS,\n      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or\n      implied, including, without limitation, any warranties or conditions\n      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A\n      PARTICULAR PURPOSE. You are solely responsible for determining the\n      appropriateness of using or redistributing the Work and assume any\n      risks associated with Your exercise of permissions under this License.\n\n   8. Limitation of Liability. In no event and under no legal theory,\n      whether in tort (including negligence), contract, or otherwise,\n      unless required by applicable law (such as deliberate and grossly\n      negligent acts) or agreed to in writing, shall any Contributor be\n      liable to You for damages, including any direct, indirect, special,\n      incidental, or consequential damages of any character arising as a\n      result of this License or out of the use or inability to use the\n      Work (including but not limited to damages for loss of goodwill,\n      work stoppage, computer failure or malfunction, or any and all\n      other commercial damages or losses), even if such Contributor\n      has been advised of the possibility of such damages.\n\n   9. Accepting Warranty or Additional Liability. While redistributing\n      the Work or Derivative Works thereof, You may choose to offer,\n      and charge a fee for, acceptance of support, warranty, indemnity,\n      or other liability obligations and/or rights consistent with this\n      License. However, in accepting such obligations, You may act only\n      on Your own behalf and on Your sole responsibility, not on behalf\n      of any other Contributor, and only if You agree to indemnify,\n      defend, and hold each Contributor harmless for any liability\n      incurred by, or claims asserted against, such Contributor by reason\n      of your accepting any such warranty or additional liability.\n\n   END OF TERMS AND CONDITIONS\n\n   APPENDIX: How to apply the Apache License to your work.\n\n      To apply the Apache License to your work, attach the following\n      boilerplate notice, with the fields enclosed by brackets \"{}\"\n      replaced with your own identifying information. (Don't include\n      the brackets!)  The text should be enclosed in the appropriate\n      comment syntax for the file format. We also recommend that a\n      file or class name and description of purpose be included on the\n      same \"printed page\" as the copyright notice for easier\n      identification within third-party archives.\n\n   Copyright {yyyy} {name of copyright owner}\n\n   Licensed under the Apache License, Version 2.0 (the \"License\");\n   you may not use this file except in compliance with the License.\n   You may obtain a copy of the License at\n\n       http://www.apache.org/licenses/LICENSE-2.0\n\n   Unless required by applicable law or agreed to in writing, software\n   distributed under the License is distributed on an \"AS IS\" BASIS,\n   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n   See the License for the specific language governing permissions and\n   limitations under the License.\n\nCopyright (c) 2015-2018 The winapi-rs Developers\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n",
    entries: [
      ["winapi-i686-pc-windows-gnu 0.4.0", ["https://github.com/retep998/winapi-rs/blob/5b1829956ef645f3c2f8236ba18bb198ca4c2468/LICENSE-APACHE", "https://github.com/retep998/winapi-rs/blob/5b1829956ef645f3c2f8236ba18bb198ca4c2468/LICENSE-MIT"]],
      ["winapi-x86_64-pc-windows-gnu 0.4.0", ["https://github.com/retep998/winapi-rs/blob/5b1829956ef645f3c2f8236ba18bb198ca4c2468/LICENSE-APACHE", "https://github.com/retep998/winapi-rs/blob/5b1829956ef645f3c2f8236ba18bb198ca4c2468/LICENSE-MIT"]],
    ],
  },
];

/** 把补回表摊平成「包 版本」-> { 原文, 来源链接 }。 */
const RESTORED_BY_KEY = new Map();
for (const group of RESTORED) {
  for (const [key, sources] of group.entries) {
    if (RESTORED_BY_KEY.has(key)) throw new Error(`内部错误：补回的原文里 ${key} 出现了两次`);
    RESTORED_BY_KEY.set(key, { text: group.text, sources, origin: group.origin });
  }
}

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)/i;

function licenseFilesIn(dir) {
  if (!dir) return [];
  const out = [];
  const addDir = (d, filter) => {
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names.sort(cmp)) {
      if (filter && !filter(name)) continue;
      const full = join(d, name);
      try {
        if (statSync(full).isFile()) out.push(full);
      } catch {
        // 读不到的单个文件不当成失败：它进不了清单，会在下面被记成「未附带原文」。
      }
    }
  };
  addDir(dir, (name) => LICENSE_FILE_RE.test(name));
  // 少数包按 REUSE 约定把授权文件放进 LICENSES/ 子目录。
  for (const sub of ["LICENSES", "licenses"]) addDir(join(dir, sub), null);
  return out;
}

function normalizeLicenseText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "\n");
}

const TEXTS = new Map(); // hash -> 许可原文（规范化后）
let rawTextBytes = 0; // 去重前：每个包各算一次
const missingText = [];
/** 补回表里真的被用上的条目；表里有而没用上的，最后会报错点名。 */
const restoredUsed = new Set();
const restoredOf = (e) => RESTORED_BY_KEY.get(`${e.name} ${e.version}`);

for (const e of entries) {
  const files = [];
  if (e.licenseFile) {
    const named = join(e.dir, e.licenseFile);
    try {
      if (statSync(named).isFile()) files.push(named);
    } catch {
      // license_file 指向的文件不在：继续按目录扫描找。
    }
  }
  for (const file of licenseFilesIn(e.dir)) if (!files.includes(file)) files.push(file);

  let text = "";
  if (files.length) {
    text = normalizeLicenseText(
      files.map((file) => readFileSync(file, "utf8")).join("\n\n"),
    );
  }
  // 包里没有：看补回表（#158）。表里的原文逐字来自来源链接，带链接一起进产物，
  // 方便法务照着核对；表里也没有的，就照实标成「未附带原文」，不替它编。
  e.sources = [];
  if (!text.trim()) {
    const restored = restoredOf(e);
    if (restored) {
      text = normalizeLicenseText(restored.text);
      e.sources = [...restored.sources];
      restoredUsed.add(`${e.name} ${e.version}`);
    }
  }
  if (!text.trim()) {
    e.textHash = null;
    missingText.push(e);
    continue;
  }
  rawTextBytes += Buffer.byteLength(text, "utf8");
  const hash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
  e.textHash = hash;
  if (!TEXTS.has(hash)) TEXTS.set(hash, text);
}

const uniqueTextBytes = [...TEXTS.values()].reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);

// 补回表里的每一条都得真的用上：包升级、改名、从依赖树里消失以后，那张过期的条目
// 必须在这里被点名，而不是安安静静地留着（清单过期 = --check 该红）。
const unusedRestored = [...RESTORED_BY_KEY.keys()]
  .filter((key) => !restoredUsed.has(key))
  .sort(cmp);
if (unusedRestored.length) {
  throw new Error(
    `补回的原文里有 ${unusedRestored.length} 条对不上任何包（包升级或换名了？重新取一次原文再更新这张表）：${unusedRestored.join("、")}`,
  );
}

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
  L.push("- 各许可证的**原文**：本文件只列名字 / 版本 / 许可证表达式 / 版权行，不内嵌全文；许可原文已随前端产物分发（`gui/src/simple/third-party-notices.ts`，界面里的「关于」页就是读它）。");
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
  const restored = list.filter((e) => e.sources.length);
  const official = restored.filter((e) => restoredOf(e)?.origin === "license-official");
  L.push("## 许可原文");
  L.push("");
  L.push(
    `- 附带原文的包：**${entries.length - missingText.length}** 个；按内容去重后 **${TEXTS.size}** 份不同文本（去重前 ${(rawTextBytes / 1024).toFixed(1)} KB，去重后 ${(uniqueTextBytes / 1024).toFixed(1)} KB）。原文已随前端产物分发：\`gui/src/simple/third-party-notices.ts\`。`,
  );
  L.push(
    `- 其中 **${restored.length}** 个是**补回**的（发布到 registry 时没把 LICENSE 打进包，原文照下一节的链接取回，不是脚本编的）。`,
  );
  L.push(`- 未附带原文的包：**${missingText.length}** 个（脚本不替它们编原文）。`);
  if (missingText.length) {
    L.push("");
    for (const e of missingText) L.push(`  - ${e.kind} ${e.name} ${e.version} — ${e.license}`);
  }
  L.push("");
  L.push("## 补回的许可原文（来源链接）");
  L.push("");
  L.push(
    `这 ${restored.length} 个包发布到 registry 时没把 LICENSE 打进包（所以包目录里翻不到），原文是按下面的链接取回来的；其中 ${official.length} 个连上游仓库里都没有任何许可文件，取的是许可证官方公开的原文。`,
  );
  L.push(
    "原文本身在 `gui/src/simple/third-party-notices.ts` 里（随软件发出去），这里列的是来源，方便逐字核对。",
  );
  L.push("");
  for (const e of restored) {
    const how = restoredOf(e)?.origin === "license-official" ? "（上游仓库里没有许可文件，用的是官方原文）" : "";
    L.push(`- ${e.kind} ${e.name} ${e.version}${how} — ${e.sources.join(" ")}`);
  }
  if (!restored.length) L.push("（无）");
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

/**
 * 第二个产物：许可说明本身（随前端产物发出去）。
 *
 * 它是**数据**：条目的形状固定，原文按内容去重后放在 TEXTS。生成物不写时间戳，
 * 两次运行逐字节相同（--self-check 会真的跑两遍来证）。
 */
function renderTs(list) {
  const L = [];
  L.push("// 第三方许可说明 —— 由 gui/scripts/license-inventory.sh 生成，不要手改。");
  L.push("//");
  L.push("// 为什么许可说明在代码里，而不只在 gui/THIRD-PARTY-LICENSES.md 里：");
  L.push("// 许可说明必须随软件一起到她手上（她不会去安装目录或网页里找），而前端产物");
  L.push("// 两个平台都会带上它。清单文件是给评审看的，这里是给她的。");
  L.push("//");
  L.push("// 原文按内容去重：同一份文本只存一份，条目用 textHash 指过去。");
  L.push("// textHash 为 null = 这个包没有附带可读的许可原文，我们不替它编。");
  L.push("//");
  L.push("// sources 非空 = 这个包发布时没把 LICENSE 打进包，原文是从这些链接取回的（#158）。");
  L.push("// 链接是留给法务核对的（不是给她看的句子），所以不带进界面的文案里。");
  L.push("");
  L.push("export interface ThirdPartyNotice {");
  L.push("  readonly name: string;");
  L.push("  readonly version: string;");
  L.push("  readonly license: string;");
  L.push("  /** 许可原文的索引入口（见 TEXTS）；null = 未附带原文。 */");
  L.push("  readonly textHash: string | null;");
  L.push("  /** 许可原文的来源链接：空 = 原文本来就随包（无链接可给）；非空 = 补回的原文。 */");
  L.push("  readonly sources: readonly string[];");
  L.push("}");
  L.push("");
  L.push("export const NOTICES: readonly ThirdPartyNotice[] = [");
  for (const e of list) {
    const hash = e.textHash === null ? "null" : JSON.stringify(e.textHash);
    const sources = `[${(e.sources ?? []).map((s) => JSON.stringify(s)).join(", ")}]`;
    L.push(
      `  { name: ${JSON.stringify(e.name)}, version: ${JSON.stringify(e.version)}, license: ${JSON.stringify(e.license)}, textHash: ${hash}, sources: ${sources} },`,
    );
  }
  L.push("];");
  L.push("");
  L.push("/** textHash -> 许可原文（同一份文本只存一份）。 */");
  L.push("export const TEXTS: Readonly<Record<string, string>> = {");
  for (const hash of [...TEXTS.keys()].sort(cmp)) {
    L.push(`  ${JSON.stringify(hash)}: ${JSON.stringify(TEXTS.get(hash))},`);
  }
  L.push("};");
  L.push("");
  L.push("/** 给界面用的数字：包数、不同原文份数、没附带原文的包数。 */");
  L.push("export const NOTICE_SUMMARY = {");
  L.push(`  packages: ${list.length},`);
  L.push(`  uniqueTexts: ${TEXTS.size},`);
  L.push(`  missingText: ${missingText.length},`);
  L.push("} as const;");
  L.push("");
  return L.join("\n");
}

const md = render(entries);
if (render(entries) !== md) throw new Error("内部错误：渲染结果不稳定");
const ts = renderTs(entries);
if (renderTs(entries) !== ts) throw new Error("内部错误：许可说明渲染结果不稳定");

// ---------------------------------------------------------------------------
// 模式
// ---------------------------------------------------------------------------

if (mode === "stdout") {
  process.stdout.write(md);
} else if (mode === "stdout-ts") {
  process.stdout.write(ts);
} else if (mode === "write") {
  await Bun.write(outPath, md);
  await Bun.write(tsOutPath, ts);
  console.error(
    `license-inventory: 已写出 ${outPath}（Rust ${rustCount} + npm ${npmCount} = ${entries.length} 条）`,
  );
  console.error(
    `license-inventory: 已写出 ${tsOutPath}（原文 ${TEXTS.size} 份，去重后 ${(uniqueTextBytes / 1024).toFixed(1)} KB；${missingText.length} 个包未附带原文）`,
  );
} else if (mode === "check") {
  let stale = false;

  const existingMd = (await Bun.file(outPath).exists()) ? await Bun.file(outPath).text() : "";
  if (existingMd !== md) {
    stale = true;
    if (newOut) await Bun.write(newOut, md);
    reportMarkdownStale(existingMd);
  }

  const existingTs = (await Bun.file(tsOutPath).exists()) ? await Bun.file(tsOutPath).text() : "";
  if (existingTs !== ts) {
    stale = true;
    await reportTsStale(existingTs);
  }

  // 生成物怎么被引用，也是这份清单要管的事（#157）：许可说明必须随前端产物发出去，
  // 而且必须是**点开「关于」才取**（动态 import()），不能静态 import 回主包——静态
  // 回去就是 1911.8 KB 又一次每次启动白运、白解析。有人改回去就点名。
  const aboutPath = join(gui, "src", "simple", "About.tsx");
  const aboutSrc = (await Bun.file(aboutPath).exists()) ? await Bun.file(aboutPath).text() : "";
  const staticValueImports = aboutSrc
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^import\s+type\b/.test(line))
    .filter((line) => /^import\s+.*?from\s+["'][^"']*third-party-notices\.ts["']/.test(line));
  if (!aboutSrc.includes('import("./third-party-notices.ts")') || staticValueImports.length > 0) {
    stale = true;
    console.error(
      "license-inventory: 许可说明的引用方式不对 —— gui/src/simple/About.tsx 必须用动态 import（打开「关于」时才取），不许静态 import 回主包。",
    );
  }

  if (!stale) {
    console.log(
      `license-inventory: 清单是最新的，许可说明也是最新的（Rust ${rustCount} + npm ${npmCount} = ${entries.length} 条；原文 ${TEXTS.size} 份）`,
    );
    process.exit(0);
  }
  console.error("  重新生成：bash gui/scripts/license-inventory.sh");
  process.exit(1);
} else {
  console.error(`license-inventory: 内部错误：未知模式 ${mode}`);
  process.exit(2);
}

/** 清单（markdown）过期：沿用旧写法，点名是哪些组件变了。 */
function reportMarkdownStale(existing) {
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
}

/**
 * 许可说明（third-party-notices.ts）过期：把旧文件真的 import 进来比，所以点得出
 * 名字——组件变了还是某份原文变了。
 */
async function reportTsStale(existing) {
  console.error(
    "license-inventory: 许可说明过期 —— gui/src/simple/third-party-notices.ts 与现在的依赖树对不上。",
  );
  if (!existing.trim()) {
    console.error("  文件不存在或是空的（第一次生成时正常）。");
    return;
  }
  let old;
  try {
    old = await import(pathToFileURL(tsOutPath).href);
  } catch (error) {
    console.error(`  读不出旧文件（${error?.message ?? error}），重新生成即可。`);
    return;
  }
  const oldNotices = Array.isArray(old.NOTICES) ? old.NOTICES : null;
  const oldTexts = old.TEXTS && typeof old.TEXTS === "object" ? old.TEXTS : null;
  if (!oldNotices || !oldTexts) {
    console.error("  旧文件里没有 NOTICES / TEXTS（格式变了），重新生成即可。");
    return;
  }
  const keyOf = (item) => `${item.name} ${item.version}`;
  const oldMap = new Map(oldNotices.map((item) => [keyOf(item), item]));
  const newMap = new Map(entries.map((item) => [keyOf(item), item]));
  const added = [...newMap.keys()].filter((k) => !oldMap.has(k)).sort(cmp);
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k)).sort(cmp);
  const changed = [...newMap.keys()]
    .filter((k) => {
      if (!oldMap.has(k)) return false;
      const o = oldMap.get(k);
      const n = newMap.get(k);
      return (
        o.version !== n.version ||
        o.license !== n.license ||
        o.textHash !== n.textHash ||
        JSON.stringify(o.sources ?? []) !== JSON.stringify(n.sources ?? [])
      );
    })
    .sort(cmp);
  for (const k of added.slice(0, 25)) console.error(`  + ${k}`);
  for (const k of removed.slice(0, 25)) console.error(`  - ${k}`);
  for (const k of changed.slice(0, 25)) {
    const o = oldMap.get(k);
    const n = newMap.get(k);
    const bits = [];
    if (o.version !== n.version) bits.push(`${o.version} → ${n.version}`);
    if (o.license !== n.license) bits.push(`${o.license} → ${n.license}`);
    if (o.textHash !== n.textHash) bits.push(`原文 ${o.textHash ?? "(无)"} → ${n.textHash ?? "(无)"}`);
    if (JSON.stringify(o.sources ?? []) !== JSON.stringify(n.sources ?? [])) {
      bits.push(`来源链接 ${(o.sources ?? []).length ? (o.sources ?? []).join(" ") : "(无)"} → ${(n.sources ?? []).length ? (n.sources ?? []).join(" ") : "(无)"}`);
    }
    console.error(`  ~ ${k}（${bits.join("；")}）`);
  }
  if (added.length + removed.length + changed.length === 0) {
    console.error("  条目没变，是许可原文（TEXTS）里改了字：");
  }
  const union = new Set([...Object.keys(oldTexts), ...TEXTS.keys()]);
  let shown = 0;
  for (const hash of [...union].sort(cmp)) {
    if (oldTexts[hash] === TEXTS.get(hash)) continue;
    const users = entries.filter((item) => item.textHash === hash).map((item) => item.name);
    const who = users.length
      ? `用于 ${users.slice(0, 5).join("、")}${users.length > 5 ? ` 等 ${users.length} 个包` : ""}`
      : "已不再被任何包使用";
    console.error(`  ~ 许可原文变了：${hash}（${who}）`);
    if (++shown >= 10) {
      console.error("  …（还有更多原文差异）");
      break;
    }
  }
}
INVENTORY_JS

export CARGO_META="$(to_native "$tmp/cargo-meta.json")"
export GUI_ROOT="$(to_native "$gui_root")"
export OUT_PATH="$(to_native "$out")"
export TS_OUT_PATH="$(to_native "$ts_out")"
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
