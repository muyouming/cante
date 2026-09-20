// 文档与代码的一致性守卫（r8 订正后新增）。
//
// 为什么要有它：`REVIEW-round7.md` 第 3 节核出「文档写 32 张卡，而
// `src/simple/tasks/index.ts` 的 `TASKS.length` 是 33」——多出来的那张
// （`doc.worksummary`）是 #196 加的，没登记进文档。这类漂移靠人肉核一遍，
// 下次加卡还会再犯。所以这里把「现状类文档里出现的卡数」钉到 `TASKS` 上：
// 谁往目录里加一张卡却忘了改文档（或反过来把文档写成别的数），这条测试就红，
// 并点名「文件:行 —— 写的数 ≠ TASKS.length」，附上该怎么改。
//
// 扫的是**现状类**文档（写今天的目录规模）：
//   gui/CONTRACT.md、gui/README.md、gui/ROADMAP.md、gui/OPPORTUNITIES-*.md、
//   仓库根 README.md、docs-site/**/*.{md,mdx}
//
// **故意不扫**：
//   * `AGENTS.md` —— 它第 11 行也写着卡数，但它不在本轮的允许改动清单里
//     （见任务硬约束）；扫进来这条测试会一直红。集成者改掉它之后，把
//     `AGENTS.md` 加进 `livingDocs()` 即可（第 11 行是产品描述，改一处）。
//   * `SWEEP-*.md` / `WINDOWS-ACCEPTANCE-*.md` / `CHANGELOG.md` / `docs/REVIEW-*.md`
//     / `docs/DECISION-*.md` —— 它们记的是**某一次运行 / 某一天的快照**
//     （`AGENTS.md` §4「记录文件是证据」），当时的目录确实可能是 32 张；
//     把历史改成今天才是造假。
//
// 只认两种**明确的目录规模**写法（都在下面的自检里钉住）：
//   `N 张卡` / `N 张卡片` / `N 张固定卡片` / `N 张任务卡`
//     （必须有「卡」字；中文数字「三张卡」说的是某一次场景，不是目录规模，不算）
//   `N cards`
//
// 记录类行（「第一次跑完 26 张卡」）说的是一次普查跑了多少张，不是目录规模，
// 用 RUN_CONTEXT 排掉——那次 26 次运行 = 20 张卡 + 6 个补充场景。
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { TASKS } from "./simple/tasks/index.ts";

const SRC_DIR = import.meta.dir; // gui/src
const GUI_ROOT = join(SRC_DIR, ".."); // gui
const REPO_ROOT = join(GUI_ROOT, "..");

/** 一个「目录规模」写法：正则里第一个捕获组是那个数。 */
interface CountPattern {
  label: string;
  pattern: RegExp;
}

const COUNT_PATTERNS: readonly CountPattern[] = [
  { label: "N 张卡", pattern: /(\d+)\s*张(?:固定|任务)?卡片?/g },
  { label: "N cards", pattern: /(\d+)\s+cards?\b/g },
];

/**
 * 记录类行：说的是一次普查/一次运行跑了几张卡，不是目录规模。
 * 例：`ROADMAP.md` 的「第一次跑完 **26 张卡**：19 通过 / 6 停下问问题 / 1 超时」。
 * 改它们会把历史改成今天，才是造假。
 */
const RUN_CONTEXT = /跑完|跑过|跑了|次运行|试跑|这一轮跑/;

/** 一条命中：哪个文件的哪一行写了多少张卡。 */
interface Hit {
  file: string;
  line: number;
  pattern: string;
  number: number;
  text: string;
}

/** 一段文字里的命中（行号由 hitsInDoc 补）。 */
function hitsInText(text: string): Hit[] {
  const hits: Hit[] = [];
  if (RUN_CONTEXT.test(text)) return hits;
  for (const { label, pattern } of COUNT_PATTERNS) {
    // 每个 pattern 带 g，逐段重扫前必须复位 lastIndex（否则会丢命中）。
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      hits.push({ file: "<text>", line: 0, pattern: label, number: Number(match[1]), text });
    }
  }
  return hits;
}

function hitsInDoc(file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((text, index) => {
    for (const hit of hitsInText(text)) {
      hits.push({ ...hit, file, line: index + 1, text: text.trim() });
    }
  });
  return hits;
}

/** 该文件在不在（不在就跳过，比如部署时裁掉了 docs-site）。 */
function exists(path: string): boolean {
  try {
    return statSync(path) !== null;
  } catch {
    return false;
  }
}

/** 递归收集一个目录下的 .md / .mdx。 */
function docsUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...docsUnder(full));
    else if (/\.mdx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 本轮要盯住的现状类文档。 */
function livingDocs(): string[] {
  const fixed = [
    join(GUI_ROOT, "CONTRACT.md"),
    join(GUI_ROOT, "README.md"),
    join(GUI_ROOT, "ROADMAP.md"),
    join(REPO_ROOT, "README.md"),
  ].filter(exists);

  const opportunities = readdirSync(GUI_ROOT)
    .filter((name) => /^OPPORTUNITIES-.*\.md$/.test(name))
    .map((name) => join(GUI_ROOT, name))
    .sort();

  const docsSite = join(REPO_ROOT, "docs-site");
  const siteDocs = exists(docsSite) ? docsUnder(docsSite).sort() : [];

  return [...fixed, ...opportunities, ...siteDocs];
}

function display(path: string): string {
  return relative(REPO_ROOT, path);
}

describe("文档里的卡数与 TASKS 一致", () => {
  test("自检：两种写法抓得到，中文数字与运行记录不误伤", () => {
    const probes: ReadonlyArray<readonly [string, number]> = [
      ["简单界面只有 32 张固定卡片这一个入口", 32],
      ["一共 33 张卡", 33],
      ["首页 33 张任务卡", 33],
      ["for 33 cards with one selected file", 33],
    ];
    for (const [text, expected] of probes) {
      const found = hitsInText(text).some((hit) => hit.number === expected);
      expect(found, `自检：这条应该被抓到（${expected}）：${text}`).toBe(true);
    }

    const ignored = [
      "一次给三张卡怎么选", // 中文数字：说的是某一次动作，不是目录规模
      "把最像的 2–3 张在她输入那句话之后摆出来", // 「张」后面不是「卡」
      "一次选 10 个文件",
      "张量加载",
      "第一次跑完 26 张卡：19 通过 / 6 停下问问题 / 1 超时", // 一次运行跑了多少张
    ];
    for (const text of ignored) {
      const found = hitsInText(text).length > 0;
      expect(found, `自检：这条不该被抓到：${text}`).toBe(false);
    }
  });

  test("现状类文档写出的卡数就是 TASKS.length，或者干脆不写死", () => {
    const docs = livingDocs();
    expect(docs.length, "没扫到任何文档——多半是路径写错了").toBeGreaterThan(3);

    const expected = TASKS.length;
    const wrong: string[] = [];
    for (const file of docs) {
      for (const hit of hitsInDoc(file)) {
        if (hit.number !== expected) {
          wrong.push(
            `${display(hit.file)}:${hit.line} —— ${hit.pattern} 写的是 ${hit.number}，` +
              `src/simple/tasks/index.ts 的 TASKS 里是 ${expected}`,
          );
        }
      }
    }

    expect(
      wrong,
      [
        "现状类文档里写的卡数与 src/simple/tasks/index.ts 的 TASKS 不一致：",
        ...wrong,
        "",
        "改法：把数字改成 TASKS.length（或在文档里不写死数字，改成「每张卡都…」）。",
        "加卡时顺手看一眼引用目录规模的文档；记录类文件（SWEEP-*、WINDOWS-ACCEPTANCE-*、",
        "CHANGELOG、docs/REVIEW-*、docs/DECISION-*）记的是历史快照，不改。",
      ].join("\n"),
    ).toEqual([]);
  });
});
