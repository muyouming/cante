// 文案红线（copy guard）。
//
// 产品只有一个界面，用户是行政/财务，不认识「模型 / token / 路径 / 会话」这类词。
// 在此之前这条约束只活在文档和每个人的 brief 里，所以返工过一次：技术词漏进了
// 用户界面。这个文件把它变成机器能挡的东西——用 bun test 就能跑，不需要 DOM：
//
//   范围  整个 gui/src/ 下所有 .ts / .tsx（见下面的 SCANNED）。两类除外：
//         * *.test.ts / *.test.tsx —— 测试自己的中文不是界面文案；
//         * src/simple/tasks/** —— 那是写给助手看的提示词（instruction envelope），
//           不是给她看的界面文案。这是唯一按目录排除的例外：卡片提示词里必须能
//           出现「路径 / 会话」这类词，助手才照着干活（见 capabilities.ts 的同理
//           注释），所以把它们排除，而不是把它们塞进白名单——白名单是给「界面上
//           必须留一个词的极少数例外」用的，不是给一整类文件用的。
//   黑名单  字符串字面量与 .tsx 的 JSX 文本节点里不得含黑名单词。注释、正则、
//           导入/导出路径不算文案，所以不扫（导入路径由打包器解析，永远不会渲染）。
//
// 第 7 轮独立评审（gui/docs/REVIEW-round7.md）挖出两个盲区，本文件把它们堵上：
//   盲区 A 原来只 walk 了 src/simple，所以 src/App.tsx 与 src/components/*.tsx
//          从来没被扫过；
//   盲区 B 范围 A 只扫 copy*.ts，所以 src/simple 下非 copy 的 .ts（approval.ts、
//          catalog.ts、capabilities.ts…）里面向用户的中文也没被扫过。
// 现在扫描根是整个 gui/src，两类文件都在内。为了不再悄悄缩回去，下面专门有一条
// 测试盯着「App.tsx / 非 copy 的 .ts 在扫描范围里、tasks 提示词与测试在外」。
//
// 扫描方式：手写一个很小的词法器，把注释、正则、字符串字面量切出来（顺带把模板
// 字符串里的 ${...} 变量挖掉——变量不是文案），这样既不会把注释里的例子当成文案，
// 也不会把 /provider/ 这种正则误报成泄漏。失败信息固定成
//
//   文件:行号 -> 「命中的词」 in "命中的那句话"
//
// 这样报错本身就告诉她（其实是告诉改代码的人）该改哪一句。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 扫描根：整个 gui/src（不再只是 src/simple）。 */
const SRC_ROOT = resolve(HERE, "..");
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
// 白名单：确实必须留在代码里的黑名单词，逐条写明原因。
//
// 这是「被审过的例外」，不是消音器：每条都要有人解释为什么这个词在这里是必要的。
// 例外必须精确到「命中哪句话」——可选的 in 字段要求命中句里含有这段文字，这样
// 同一个文件里新冒出来的、真正给用户看的命中仍然会红（第 7 轮评审挖出的能力中心
// 提示词就是靠这条来区分的：它给助手看，所以放行，但只放行「文件路径」那几句）。
// 而且如果某条白名单已经不再命中任何东西，测试会要求删掉它，免得例外越攒越多。
// ---------------------------------------------------------------------------

interface Allowance {
  /** 文件名，例如 "copy.ts"。 */
  file: string;
  /** 必须和 BLACKLIST 里的 label 完全一致。 */
  term: string;
  /**
   * 命中那句话里必须包含这段文字（可选）。
   * 用来把例外钉在具体某句上：同一文件里别的命中不受这条保护。
   */
  in?: string;
  /** 为什么这条例外是审过的、必须留着的。 */
  why: string;
}

const ALLOW: readonly Allowance[] = [
  {
    file: "capabilities.ts",
    term: "路径",
    in: "文件路径",
    why: "给助手看的指令信封（sheetPromptLine / pdfPromptLine），不是界面文案：助手要照着 cante-sheets 的写法干活，命令里必须能出现「文件路径」",
  },
  {
    file: "capabilities.ts",
    term: "会话",
    in: "这个会话背后的助手",
    why: "同样是给助手看的指令信封（visionPromptLine）：它要知道当前设置看不看得懂照片，这句只发给助手，界面上她看到的是 copy-capability.ts 的 VISION_COPY",
  },
  {
    file: "wait.ts",
    term: "diff",
    in: "excel.diff",
    why: "卡片 id（普查报告里的键），内部标识、不是界面文案；界面上她看到的是卡标题，不是 excel.diff",
  },
  {
    file: "tauri.ts",
    term: "prompt",
    in: "prompt",
    why: "「桥梁」与守护进程之间的协议取值（send_input 的 mode），是机器读的，永远不会渲染给用户",
  },
  {
    file: "store.ts",
    term: "prompt",
    in: "prompt",
    why: "同上：store 把 mode 原样发给守护进程，这个字符串是协议字段值，不是文案",
  },
];

// ---------------------------------------------------------------------------
// 内联文案的债务台账：组件里内联的中文文案。
//
// 正确做法是从 copy*.ts 导入。但有些文件现在归别的 workstream，本轮无权改动，
// 所以这里不把它们伪装成「白名单」——黑名单扫描依旧是零容忍，下面这份台账只记录
// 「位置不对」的数量，而且只能减不能增：谁把文案搬进 copy 模块，就顺手把这里的
// 数字改小；新增一处内联文案会让测试失败，那是提醒作者去 copy 模块加一句话，
// 而不是让他来改这个大数字。
//
// 扫描根扩到整个 gui/src 后，src/components/*.tsx 与 src/App.tsx 也进了这套口径
// （它们此前从未被扫）。App.tsx 那唯一一处内联中文（分组判定值 "微信"）本轮改成
// 复用 copy-files.ts 里已有的 PASTES_CONTENT_GROUP（同一个微信族组名，避免两份
// 字面量各自漂移），所以它现在是 0 处，不进台账。
// src/components/*.tsx 里没有内联中文（第 7 轮评审的独立复刻也是 0 处），所以它们
// 也不进台账。
// ---------------------------------------------------------------------------

const INLINE_COPY_BUDGET: Readonly<Record<string, number>> = {
  // 归别的 workstream：ResultCard / TaskRunner / ConfirmSheet / PrivacyPanel /
  // WechatImport 的按钮、标题、状态词。数字是 2026-09 扫描出来的现状
  // （按“一段中文算一处”统计）。
  // #192 A：原「先试跑给我看（只看不动）」那一句已搬进 copy.ts 的 TRY_FIRST，
  // 所以这一格从 21 减到 20（台账只减不增）。
  // P0：两处文件名后的「在 …」搬进了 copy-files.ts 的 CONFIRM_FILES.fileInFolder，
  // 所以再减到 19（同一句话一处，文件列表和「已经去掉的」共用）。
  "ConfirmSheet.tsx": 19,
  // History.tsx 的 22 处已经全部搬进 copy-history.ts（#57 那一轮），从台账里退场。
  "PrivacyPanel.tsx": 13,
  "ResultCard.tsx": 16,
  "TaskRunner.tsx": 52,
  "WechatImport.tsx": 21,
};

// ---------------------------------------------------------------------------
// 词法器：把注释、正则与字符串字面量切出来。
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

/**
 * 这个 `/` 是不是正则字面量的开头。
 *
 * 光看 `/` 不够：`a / b` 是除号，`</div>` 是 JSX 闭合标签。判据是前一个有效字符
 * （或前一个关键字）——只有紧跟这些位置的正则才是正则。`<`、`>` 故意不算：JSX 里
 * `</div>` 的 `/` 紧跟 `<`，不能当成正则。
 */
const REGEX_AFTER = "([,=:[!&|?{};+-*%~^";
const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "delete",
  "void",
  "new",
]);

function startsRegex(source: string, at: number): boolean {
  let j = at - 1;
  while (j >= 0 && /\s/.test(source[j] as string)) j -= 1;
  if (j < 0) return true;
  const c = source[j] as string;
  if (REGEX_AFTER.includes(c)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z]/.test(source[k] as string)) k -= 1;
  return REGEX_KEYWORDS.has(source.slice(k + 1, j + 1));
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

  /** 正则字面量：整个吞掉（当注释处理，内容不参与扫描）。 */
  const readRegex = (): boolean => {
    const start = i;
    let j = i + 1;
    let cls = false;
    let closed = false;
    while (j < n) {
      const ch = source[j] as string;
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "\n") break;
      if (ch === "[") cls = true;
      else if (ch === "]") cls = false;
      else if (ch === "/" && !cls) {
        j += 1;
        closed = true;
        break;
      }
      j += 1;
    }
    if (!closed) return false;
    while (j < n && /[a-z]/i.test(source[j] as string)) j += 1;
    spans.push({ kind: "comment", start, end: j, line, text: "" });
    i = j;
    return true;
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
    if (c === "/") {
      // JSX 的自闭合 `/>`：紧跟 `>` 的 `/` 不是正则（正则也不可能是空的 `/>`）。
      if (source[i + 1] === ">" || !startsRegex(source, i) || !readRegex()) i += 1;
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

/** 把注释、正则与字符串内容换成空格（换行保留），剩下的就是 JSX 文本节点。 */
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

/** 相对 src/ 的路径，用来判断是不是 tasks 下的提示词。 */
function srcRelative(path: string): string {
  return relative(SRC_ROOT, path).split("\\").join("/");
}

/**
 * 导入/导出路径是代码，由打包器解析，永远不会渲染给用户，所以不算文案。
 * （范围扩到整个 gui/src 后才会遇到 "./tasks/prompt.ts" 这种导入路径——
 * 它不是给她看的一句话，把它当命中报出来是误报。）
 */
function isModuleSpecifier(source: string, span: Span): boolean {
  const before = source.slice(Math.max(0, span.start - 24), span.start);
  return /(?:\bfrom|\bimport|\brequire)\s*\(?\s*$/.test(before);
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

/** 这个命中是否被某条精确白名单放行。 */
function isAllowed(hit: Hit): boolean {
  const name = basename(hit.file);
  return ALLOW.some(
    (entry) =>
      entry.file === name &&
      entry.term === hit.term &&
      (entry.in === undefined || hit.sentence.includes(entry.in)),
  );
}

/** 失败信息固定成「文件:行号 -> 「词」 in "那句话"」，可直接照着改。 */
function report(title: string, hits: readonly Hit[]): string {
  const lines = hits.map((hit) => `${hit.file}:${hit.line} -> 「${hit.term}」 in "${hit.sentence}"`);
  const advice = [...new Set(hits.map((hit) => `  - 「${hit.term}」：${hit.why}`))];
  return [title, ...lines, "", "为什么要改：", ...advice].join("\n");
}

/** 有命中就抛。三条范围测试共用。 */
function failIfAny(hits: readonly Hit[], title: string): void {
  if (hits.length > 0) throw new Error(report(title, hits));
}

// ---------------------------------------------------------------------------
// 收集
// ---------------------------------------------------------------------------

const ALL_FILES = walk(SRC_ROOT);
const SOURCES = ALL_FILES.filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
const isTest = (file: string): boolean => file.endsWith(".test.ts") || file.endsWith(".test.tsx");
/** 给助手看的提示词（不是界面文案）：排除，理由见文件头。 */
const isTaskPrompt = (file: string): boolean => srcRelative(file).startsWith("simple/tasks/");

/** 真正参与扫描的文件：整个 gui/src，除去测试与 tasks 提示词。 */
const SCANNED = SOURCES.filter((file) => !isTest(file) && !isTaskPrompt(file));

/** copy*.ts，但不含测试自己和别的 agent 的 copy-capability.ts。 */
const COPY_MODULES = SCANNED.filter((file) => {
  const name = basename(file);
  return /^copy.*\.ts$/.test(name) && name !== "copy-capability.ts";
});

/** 所有组件（含 src/App.tsx 与 src/components/*.tsx —— 此前从未被扫）。 */
const COMPONENTS = SCANNED.filter((file) => file.endsWith(".tsx"));

/** 非 copy、非组件的 .ts 模块：第 7 轮评审的盲区 B（approval.ts / catalog.ts…）。 */
const NON_COPY_MODULES = SCANNED.filter(
  (file) => !file.endsWith(".tsx") && !COPY_MODULES.includes(file),
);

/** 找 import 时排除测试文件：只有测试引用的文案模块，对界面来说仍是死的。 */
const IMPORTABLE_SOURCES = SOURCES.filter((file) => !isTest(file));

/**
 * 一组文件里的黑名单命中。
 *
 * 字符串字面量与（.tsx 的）JSX 文本节点都扫；导入路径按代码处理，不扫。
 * applyAllow=false 时不套白名单——「白名单是否过期」那条测试要看原始命中。
 */
function scopeHits(files: readonly string[], options: { applyAllow?: boolean } = {}): Hit[] {
  const out: Hit[] = [];
  for (const file of files) {
    const source = read(file);
    const shown = display(file);
    const spans = scanSpans(source);
    for (const span of spans) {
      if (span.kind !== "string") continue;
      if (isModuleSpecifier(source, span)) continue;
      for (const hit of hitsInLiteral(span.text, span, shown)) {
        if (options.applyAllow === false || !isAllowed(hit)) out.push(hit);
      }
    }
    if (!file.endsWith(".tsx")) continue;
    const masked = maskSpans(source, spans);
    for (const run of masked.matchAll(/[^\n<>{}]+/g)) {
      const text = run[0];
      if (!HAS_CJK.test(text)) continue;
      const offset = (run.index ?? 0) + text.search(/\S/);
      const line = lineAt(masked, offset);
      for (const hit of hitsInText(text, line, shown)) {
        if (options.applyAllow === false || !isAllowed(hit)) out.push(hit);
      }
    }
  }
  return out;
}

/** 所有被扫文件里的命中（套白名单）。 */
function scannedHits(options: { applyAllow?: boolean } = {}): Hit[] {
  return scopeHits(SCANNED, options);
}

interface InlineCopy {
  file: string;
  line: number;
  text: string;
}

/** 组件里内联的中文文案（没有走 copy 模块）。 */
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
    failIfAny(
      scopeHits(COPY_MODULES),
      "这些用户文案里出现了技术词（改成平实中文；确实必须留的，去 copy-guard.test.ts 的 ALLOW 里写明原因）：",
    );
  });

  test("范围 B：所有组件（含 App.tsx 与 src/components）里没有黑名单词", () => {
    expect(COMPONENTS.length).toBeGreaterThan(0);
    failIfAny(
      scopeHits(COMPONENTS),
      "这些组件里的裸文案出现了技术词（先搬到 copy 模块，再改成平实中文）：",
    );
  });

  test("范围 C：非 copy 的 .ts 模块里也没有黑名单词（第 7 轮评审的盲区 B）", () => {
    expect(NON_COPY_MODULES.length).toBeGreaterThan(0);
    failIfAny(
      scopeHits(NON_COPY_MODULES),
      "这些模块里有面向用户的中文出现了技术词（界面文案搬到 copy 模块；确实是给助手看的，去 ALLOW 里写明原因）：",
    );
  });

  test("扫描范围覆盖整个 gui/src：盲区 A/B 的文件在内，tasks 提示词与测试在外", () => {
    // 这条盯着「范围被悄悄缩回去」：第 7 轮评审就是因为这里只 walk src/simple
    // 才漏了 App.tsx 和一堆非 copy 模块。名字写死，缩回去就红。
    const names = SCANNED.map(display);
    expect(names).toContain("src/App.tsx");
    expect(names).toContain("src/simple/catalog.ts");
    expect(names).toContain("src/simple/approval.ts");
    expect(names).toContain("src/simple/capabilities.ts");
    expect(names).toContain("src/transcript.ts");
    expect(names).toContain("src/components/Transcript.tsx");
    expect(names.some((name) => name.startsWith("src/simple/tasks/"))).toBe(false);
    expect(names.some((name) => name.endsWith(".test.ts"))).toBe(false);
    expect(names.some((name) => name.endsWith(".test.tsx"))).toBe(false);
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

  test("白名单是审过的：每条都写了原因、能精确命中，也没有过期的条目", () => {
    for (const entry of ALLOW) {
      expect(BLACKLIST.some((term) => term.label === entry.term)).toBe(true);
      expect(entry.why.trim().length).toBeGreaterThan(10);
      expect(SCANNED.some((file) => basename(file) === entry.file)).toBe(true);
      if (entry.in !== undefined) expect(entry.in.length).toBeGreaterThan(0);
    }
    // 一条白名单如果已经不再命中任何东西，就该删掉，免得例外越来越多。
    // 这里用不过滤白名单的原始命中，才能看出哪条例外真的在挡东西。
    const raw = scannedHits({ applyAllow: false });
    const stale = ALLOW.filter(
      (entry) =>
        !raw.some(
          (hit) =>
            hit.term === entry.term &&
            basename(hit.file) === entry.file &&
            (entry.in === undefined || hit.sentence.includes(entry.in)),
        ),
    ).map((entry) => `${entry.file} 的「${entry.term}」${entry.in ? ` in "${entry.in}"` : ""}`);
    if (stale.length > 0) {
      throw new Error(
        ["这些白名单条目已经用不上了，请删掉（避免例外只增不减）：", ...stale.map((line) => `  - ${line}`)].join("\n"),
      );
    }
  });
});
