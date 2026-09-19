// 文案红线（copy guard）。
//
// 产品只有一个界面，用户是行政/财务，不认识「模型 / token / 路径 / 会话」这类词。
// 在此之前这条约束只活在文档和每个人的 brief 里，所以返工过一次：技术词漏进了
// 用户界面。这个文件把它变成机器能挡的东西——用 bun test 就能跑，不需要 DOM：
//
//   范围 A  gui/src/simple/copy*.ts（面向用户的文案模块，排除 copy-capability.ts）
//           里的字符串字面量不得含黑名单词。注释和正则不算文案，所以不扫。
//   范围 B  gui/src/simple/**/*.tsx 里的 JSX 文本节点与字符串字面量。
//           另外报一类「文案位置不当」：组件内联的中文文案本该搬到 copy 模块。
//
// 扫描方式：手写一个很小的词法器，把注释和字符串字面量切出来（顺带把模板字符串
// 里的 ${...} 变量挖掉——变量不是文案），这样既不会把注释里的例子当成文案，也
// 不会把 /provider/ 这种正则误报成泄漏。失败信息固定成
//
//   文件:行号 -> 「命中的词」 in "命中的那句话"
//
// 这样报错本身就告诉她（其实是告诉改代码的人）该改哪一句。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 展示路径时以 gui/ 为根，写成 src/simple/copy.ts:12 这种形式。 */
const GUI_ROOT = resolve(HERE, "../..");

// ---------------------------------------------------------------------------
// 黑名单：王姐不该在界面上看到的词。
//
// 每条都写清理由，理由比词本身重要——下次有人想往界面上加一个「熟悉的技术词」时，
// 应该先来读这里的 why，而不是把词从数组里删掉。
// ---------------------------------------------------------------------------

interface Term {
  /** 报告里显示的词。 */
  label: string;
  /** 命中规则：中文按子串，英文按整词（\b），一律不区分大小写。 */
  pattern: RegExp;
  /** 为什么这个词不能让王姐看到。 */
  why: string;
}

const BLACKLIST: readonly Term[] = [
  {
    label: "大模型",
    pattern: /大模型/,
    why: "她不需要知道背后是什么东西在干活，只需要知道这件事能不能做成",
  },
  {
    label: "模型",
    pattern: /模型/,
    why: "同上；「模型」对她是一句没有信息量的外语，换成「做这件事的能力」她才知道在说什么",
  },
  {
    label: "provider",
    pattern: /\bprovider\b/i,
    why: "服务方的英文名，她既读不懂也没得选；界面只说「联网时会发给帮你整理的服务方」",
  },
  {
    label: "token",
    pattern: /\btoken\b/i,
    why: "计量单位的黑话；她要的是「这次花了多少」而不是 token 数",
  },
  {
    label: "prompt",
    pattern: /\bprompt\b/i,
    why: "她输入的就是「一句话」，界面该说「你说的事情」，不该说 prompt",
  },
  {
    label: "会话",
    pattern: /会话/,
    why: "她的心智里没有「会话」这个东西；要继续的就是「上个月那件事」，用「记录」或「做过的事」",
  },
  {
    label: "上下文",
    pattern: /上下文/,
    why: "同上，纯术语；要说清楚「它还记不记得前面说过的话」，而不是「上下文」",
  },
  {
    label: "权限模式",
    pattern: /权限模式/,
    why: "「模式」这个词只有在知道有几种模式时才成立，她只知道「允不允许」",
  },
  {
    label: "工具调用",
    pattern: /工具调用/,
    why: "她要判断的是「要动哪些文件」，不是「调用了什么工具」",
  },
  {
    label: "diff",
    pattern: /\bdiff\b/i,
    why: "对比结果对她是「改了哪几处」，英文缩写只会让她不敢点",
  },
  {
    label: "worktree",
    pattern: /\bworktree\b/i,
    why: "Git 概念，和她的工作没有任何关系",
  },
  {
    label: "API key",
    pattern: /api[\s_-]*key/i,
    why: "要填的是「账号」，而且是找懂电脑的同事填，不该让她看到 key 这个词",
  },
  {
    label: "apikey",
    pattern: /\bapikey\b/i,
    why: "同上，连写的写法也要挡住",
  },
  {
    label: "终端",
    pattern: /终端/,
    why: "她一辈子没打开过终端；出错时的出口是「复制详情发给懂电脑的同事」",
  },
  {
    label: "命令行",
    pattern: /命令行/,
    why: "同上，界面里不存在需要她敲命令的操作",
  },
  {
    label: "环境变量",
    pattern: /环境变量/,
    why: "配置层面的东西，出问题时应写成「请找配置这台电脑的同事」",
  },
  {
    label: "缓存",
    pattern: /缓存/,
    why: "她不会清缓存；该说「先把 Cante 关掉重新打开」",
  },
  {
    label: "线程",
    pattern: /线程/,
    why: "程序内部的概念，对她是纯粹的噪音",
  },
  {
    label: "轮询",
    pattern: /轮询/,
    why: "实现细节；她要看到的是「正在做，请稍等」",
  },
  {
    label: "接口",
    pattern: /接口/,
    why: "开发者的说法；用户能看见的只有「按钮」和「窗口」",
  },
  {
    label: "配置项",
    pattern: /配置项/,
    why: "「配置」本身已经是黑话，加上「项」更像一份她填不动的表",
  },
  {
    label: "日志",
    pattern: /日志/,
    why: "她不会读日志；技术原文走「复制详情」，界面只说发生了什么",
  },
  {
    label: "报错码",
    pattern: /报错码/,
    why: "把一串数字丢给她没有意义；要给出「你可以怎么做」",
  },
  {
    label: "路径",
    pattern: /路径/,
    why: "她要的是「文件夹」和「文件在哪」；「路径」是只有开发者会用的词。注意只扫文案，代码注释与给助手的信封不在此列",
  },
];

// ---------------------------------------------------------------------------
// 白名单：确实必须留在界面上的词，逐条写明原因。
//
// 这是「被审过的例外」，不是消音器：每条都要有人解释为什么这个词对王姐是必要的；
// 而且如果某条白名单已经不再命中任何东西，测试会要求删掉它，免得例外越攒越多。
// ---------------------------------------------------------------------------

interface Allowance {
  /** 文件名，例如 "copy.ts"。 */
  file: string;
  /** 必须和 BLACKLIST 里的 label 完全一致。 */
  term: string;
  /** 为什么这条例外是审过的、必须留着的。 */
  why: string;
}

const ALLOW: readonly Allowance[] = [
  // 目前为空：范围 A 的文案模块和组件里的中文文案都没有命中黑名单。
  // 需要开口子时，在上面加一条 { file, term, why }，why 必须写清用户为什么需要它。
];

// ---------------------------------------------------------------------------
// 范围 B 的债务台账：组件内联的中文文案。
//
// 正确做法是从 copy*.ts 导入（范围 A 才是文案的归宿）。但这些文件现在归别的
// workstream，本轮无权改动，所以这里不把它们伪装成「白名单」——黑名单扫描依旧是
// 零容忍，下面这份台账只记录「位置不对」的数量，而且只能减不能增：
// 谁把文案搬进 copy 模块，就顺手把这里的数字改小；新增一处内联文案会让测试失败，
// 那是提醒作者去 copy 模块加一句话，而不是让他来改这个大数字。
// ---------------------------------------------------------------------------

const INLINE_COPY_BUDGET: Readonly<Record<string, number>> = {
  // 归别的 workstream：ResultCard / TaskRunner / ConfirmSheet / History /
  // WechatImport / PrivacyPanel 的按钮、标题、状态词。数字是 2026-09 扫描
  // 出来的现状（按“一段中文算一处”统计）。
  // #192 A：原「先试跑给我看（只看不动）」那一句已搬进 copy.ts 的 TRY_FIRST，
  // 所以这一格从 21 减到 20（台账只减不增）。
  // P0：两处文件名后的「在 …」搬进了 copy-files.ts 的 CONFIRM_FILES.fileInFolder，
  // 所以再减到 19（同一句话一处，文件列表和「已经去掉的」共用）。
  "ConfirmSheet.tsx": 19,
  // History.tsx 的 22 处已经全部搬进 copy-history.ts（#57 那一轮），从台账里退场。
  "PrivacyPanel.tsx": 13,
  "ResultCard.tsx": 18,
  "TaskRunner.tsx": 52,
  "WechatImport.tsx": 21,
};

// ---------------------------------------------------------------------------
// 词法器：把注释与字符串字面量切出来。
// ---------------------------------------------------------------------------

interface Span {
  kind: "string" | "comment";
  /** 在源文件里的 [start, end)，用于把这段替换成空格。 */
  start: number;
  end: number;
  /** 起始行号，1 起。 */
  line: number;
  /** 字符串内容（模板插值已挖成空格）；注释内容不参与扫描。 */
  text: string;
}

function scanSpans(source: string): Span[] {
  const spans: Span[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const readQuoted = (quote: string): void => {
    const start = i;
    const startLine = line;
    i += 1;
    let text = "";
    while (i < n && source[i] !== quote) {
      const c = source[i] as string;
      if (c === "\\") {
        text += c + (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "\n") line += 1;
      text += c;
      i += 1;
    }
    i += 1;
    spans.push({ kind: "string", start, end: Math.min(i, n), line: startLine, text });
  };

  const readTemplate = (): void => {
    const start = i;
    const startLine = line;
    i += 1;
    let text = "";
    while (i < n && source[i] !== "`") {
      const c = source[i] as string;
      if (c === "\\") {
        text += c + (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        // ${...} 里的东西是代码（变量名、函数调用），不是给用户看的话。
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const inner = source[i] as string;
          if (inner === "\n") line += 1;
          else if (inner === "{") depth += 1;
          else if (inner === "}") depth -= 1;
          i += 1;
        }
        text += " ";
        continue;
      }
      if (c === "\n") line += 1;
      text += c;
      i += 1;
    }
    i += 1;
    spans.push({ kind: "string", start, end: Math.min(i, n), line: startLine, text });
  };

  while (i < n) {
    const c = source[i] as string;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const start = i;
      const startLine = line;
      while (i < n && source[i] !== "\n") i += 1;
      spans.push({ kind: "comment", start, end: i, line: startLine, text: "" });
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = i;
      const startLine = line;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i = Math.min(n, i + 2);
      spans.push({ kind: "comment", start, end: i, line: startLine, text: "" });
      continue;
    }
    if (c === '"' || c === "'") {
      readQuoted(c);
      continue;
    }
    if (c === "`") {
      readTemplate();
      continue;
    }
    i += 1;
  }
  return spans;
}

/** 把注释与字符串内容换成空格（换行保留），剩下的就是 JSX 文本节点。 */
function maskSpans(source: string, spans: readonly Span[]): string {
  const chars = source.split("");
  for (const span of spans) {
    for (let i = span.start; i < span.end; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

const HAS_CJK = /[\u3400-\u9fff]/;

// ---------------------------------------------------------------------------
// 文件与命中
// ---------------------------------------------------------------------------

interface Hit {
  /** 相对 gui/ 的路径，例如 src/simple/copy.ts。 */
  file: string;
  line: number;
  term: string;
  /** 命中的那一句话（已压平空白）。 */
  sentence: string;
  /** 命中原因，给报告里的建议用。 */
  why: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function display(path: string): string {
  return relative(GUI_ROOT, path).split("\\").join("/");
}

/** 字符串字面量里的命中：每个命中的词各报一次，行号是命中词所在的行。 */
function hitsInLiteral(text: string, span: Span, file: string): Hit[] {
  const out: Hit[] = [];
  for (const term of BLACKLIST) {
    const index = text.search(term.pattern);
    if (index < 0) continue;
    const newlines = (text.slice(0, index).match(/\n/g) ?? []).length;
    out.push({
      file,
      line: span.line + newlines,
      term: term.label,
      sentence: text.replace(/\s+/g, " ").trim(),
      why: term.why,
    });
  }
  return out;
}

/** JSX 文本节点里的命中。 */
function hitsInText(text: string, line: number, file: string): Hit[] {
  const out: Hit[] = [];
  for (const term of BLACKLIST) {
    if (!term.pattern.test(text)) continue;
    out.push({ file, line, term: term.label, sentence: text.replace(/\s+/g, " ").trim(), why: term.why });
  }
  return out;
}

function allowed(file: string, term: string): boolean {
  const name = basename(file);
  return ALLOW.some((entry) => entry.file === name && entry.term === term);
}

/** 失败信息固定成「文件:行号 -> 「词」 in "那句话"」，可直接照着改。 */
function report(title: string, hits: readonly Hit[]): string {
  const lines = hits.map((hit) => `${hit.file}:${hit.line} -> 「${hit.term}」 in "${hit.sentence}"`);
  const advice = [...new Set(hits.map((hit) => `  - 「${hit.term}」：${hit.why}`))];
  return [title, ...lines, "", "为什么要改：", ...advice].join("\n");
}

// ---------------------------------------------------------------------------
// 收集
// ---------------------------------------------------------------------------

const ALL_FILES = walk(HERE);
const ALL_SOURCES = ALL_FILES.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
/** 找 import 时排除测试文件：只有测试引用的文案模块，对界面来说仍是死的。 */
const IMPORTABLE_SOURCES = ALL_SOURCES.filter((file) => !file.endsWith(".test.ts"));

/** copy*.ts，但不含测试自己和别的 agent 的 copy-capability.ts。 */
const COPY_MODULES = ALL_FILES.filter((file) => {
  const name = basename(file);
  return /^copy.*\.ts$/.test(name) && !name.endsWith(".test.ts") && name !== "copy-capability.ts";
});

const COMPONENTS = ALL_FILES.filter((file) => file.endsWith(".tsx"));

/** 范围 A：面向用户的文案模块，只扫字符串字面量（注释和正则不算）。 */
function scopeAHits(options: { applyAllow?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const file of COPY_MODULES) {
    const source = read(file);
    for (const span of scanSpans(source)) {
      if (span.kind !== "string") continue;
      for (const hit of hitsInLiteral(span.text, span, display(file))) {
        if (options.applyAllow === false || !allowed(file, hit.term)) hits.push(hit);
      }
    }
  }
  return hits;
}

/** 范围 B：组件里的裸文案，扫 JSX 文本节点与字符串字面量。 */
function scopeBHits(options: { applyAllow?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const file of COMPONENTS) {
    const source = read(file);
    const shown = display(file);
    const spans = scanSpans(source);
    for (const span of spans) {
      if (span.kind !== "string" || !HAS_CJK.test(span.text)) continue;
      for (const hit of hitsInLiteral(span.text, span, shown)) {
        if (options.applyAllow === false || !allowed(file, hit.term)) hits.push(hit);
      }
    }
    const masked = maskSpans(source, spans);
    for (const run of masked.matchAll(/[^\n<>{}]+/g)) {
      const text = run[0];
      if (!HAS_CJK.test(text)) continue;
      const offset = (run.index ?? 0) + text.search(/\S/);
      const line = lineAt(masked, offset);
      for (const hit of hitsInText(text, line, shown)) {
        if (options.applyAllow === false || !allowed(file, hit.term)) hits.push(hit);
      }
    }
  }
  return hits;
}

interface InlineCopy {
  file: string;
  line: number;
  text: string;
}

/** 范围 B 的「位置不当」清单：组件里内联的中文文案（没有走 copy 模块）。 */
function inlineCopy(): InlineCopy[] {
  const out: InlineCopy[] = [];
  for (const file of COMPONENTS) {
    const source = read(file);
    const shown = display(file);
    const spans = scanSpans(source);
    for (const span of spans) {
      if (span.kind !== "string" || !HAS_CJK.test(span.text)) continue;
      out.push({ file: shown, line: span.line, text: span.text.replace(/\s+/g, " ").trim() });
    }
    const masked = maskSpans(source, spans);
    for (const run of masked.matchAll(/[^\n<>{}]+/g)) {
      const text = run[0];
      if (!HAS_CJK.test(text)) continue;
      const offset = (run.index ?? 0) + text.search(/\S/);
      out.push({ file: shown, line: lineAt(masked, offset), text: text.replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

function inlineCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of inlineCopy()) {
    const name = basename(item.file);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** 某个模块被谁 import 了（比较文件名，支持 ./x.ts 与 ../x.ts 两种写法）。 */
function importers(name: string): string[] {
  const pattern = /(?:from|import)\s*["']([^"']+)["']/g;
  const out: string[] = [];
  for (const file of IMPORTABLE_SOURCES) {
    if (basename(file) === name) continue;
    const source = read(file);
    const comments = scanSpans(source).filter((span) => span.kind === "comment");
    for (const match of source.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (comments.some((span) => index >= span.start && index < span.end)) continue;
      const spec = match[1] ?? "";
      if (basename(spec) === name) out.push(display(file));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("文案红线：面向用户的界面里不能有技术词", () => {
  test("范围 A：copy 模块的字符串里没有黑名单词", () => {
    expect(COPY_MODULES.length).toBeGreaterThan(0);
    const hits = scopeAHits();
    if (hits.length > 0) {
      throw new Error(
        report(
          "这些用户文案里出现了技术词（改成平实中文；确实必须留的，去 copy-guard.test.ts 的 ALLOW 里写明原因）：",
          hits,
        ),
      );
    }
  });

  test("范围 B：组件里的 JSX 文本与字符串里没有黑名单词", () => {
    expect(COMPONENTS.length).toBeGreaterThan(0);
    const hits = scopeBHits();
    if (hits.length > 0) {
      throw new Error(
        report(
          "这些组件里的裸文案出现了技术词（先搬到 copy 模块，再改成平实中文）：",
          hits,
        ),
      );
    }
  });

  test("范围 B：内联的中文文案只能减少，不能增加", () => {
    const counts = inlineCounts();
    const grown: string[] = [];
    for (const [name, count] of Object.entries(counts)) {
      const budget = INLINE_COPY_BUDGET[name] ?? 0;
      if (count > budget) grown.push(`${name}：现在 ${count} 处，台账 ${budget} 处`);
    }
    const removed = Object.entries(INLINE_COPY_BUDGET)
      .filter(([name]) => (counts[name] ?? 0) < INLINE_COPY_BUDGET[name])
      .map(([name]) => `${name}：台账 ${INLINE_COPY_BUDGET[name]} 处，现在 ${(counts[name] ?? 0)} 处`);
    if (grown.length > 0) {
      throw new Error(
        [
          "组件里新增了内联的中文文案（正确做法是加进 copy*.ts，再 import 进来）：",
          ...grown.map((line) => `  - ${line}`),
          "",
          "如果这一处确实临时无法搬走，请把 INLINE_COPY_BUDGET 的数字改大，",
          "并在提交信息里说明原因——这个台账只应该缩小。",
        ].join("\n"),
      );
    }
    if (removed.length > 0) {
      throw new Error(
        [
          "有文案已经搬进 copy 模块了，把台账顺手改小（别让债务数字虚高）：",
          ...removed.map((line) => `  - ${line}`),
        ].join("\n"),
      );
    }
  });

  test("每个 copy 文案模块都至少被一个组件或模块导入（没有死文案）", () => {
    const orphans: string[] = [];
    for (const file of COPY_MODULES) {
      const name = basename(file);
      if (importers(name).length === 0) {
        orphans.push(`${display(file)}：没有任何地方 import，要么接上界面，要么删掉`);
      }
    }
    if (orphans.length > 0) {
      throw new Error(["这些文案文件是死代码：", ...orphans.map((line) => `  - ${line}`)].join("\n"));
    }
  });

  test("黑名单自己是有效的：词条能命中自己，英文按整词匹配", () => {
    for (const term of BLACKLIST) {
      // 有人把正则改废了（比如删掉 \\b）时，这条会先报出来。
      expect(term.pattern.test(term.label)).toBe(true);
      expect(term.why.trim().length).toBeGreaterThan(8);
    }
    // 「prompt」按整词匹配，不该命中 prompter 这种无关词——这正是用 \\b 的理由。
    const prompt = BLACKLIST.find((term) => term.label === "prompt");
    expect(prompt?.pattern.test("prompter")).toBe(false);
    expect(prompt?.pattern.test("你的 prompt 太长")).toBe(true);
  });

  test("白名单是审过的：每条都写了原因，也没有过期的条目", () => {
    for (const entry of ALLOW) {
      expect(BLACKLIST.some((term) => term.label === entry.term)).toBe(true);
      expect(entry.why.trim().length).toBeGreaterThan(10);
      expect(COPY_MODULES.some((file) => basename(file) === entry.file) || COMPONENTS.some((file) => basename(file) === entry.file)).toBe(true);
    }
    // 一条白名单如果已经不再命中任何东西，就该删掉，免得例外越来越多。
    // 这里用不过滤白名单的原始命中，才能看出哪条例外真的在挡东西。
    const raw = scopeAHits({ applyAllow: false }).concat(scopeBHits({ applyAllow: false }));
    const stale = ALLOW.filter(
      (entry) => !raw.some((hit) => hit.term === entry.term && basename(hit.file) === entry.file),
    ).map((entry) => `${entry.file} 的「${entry.term}」`);
    if (stale.length > 0) {
      throw new Error(
        ["这些白名单条目已经用不上了，请删掉（避免例外只增不减）：", ...stale.map((line) => `  - ${line}`)].join("\n"),
      );
    }
  });
});
