// 可读性红线（readability guard）。
//
// copy-guard 挡的是**黑名单词**（模型 / token / 路径 ……），tone 挡的是**语气**
// （卖萌 / 夸张 / 免责）。但王姐看不懂一句中文，常常不是因为它含某个词，而是因为
// **句子本身难读**：
//
//   * 一句话套三层从句（「如果你想在保留原文件的同时把结果放到另一个位置，请选择…」）；
//   * 用被动 + 抽象名词（「该操作已完成」/「我们的处理流程已终止」）；
//   * 代词指代不清（「它已经准备好了」——什么准备好了？）；
//   * 一句话堆一串并列，读的人不知道先看哪半句。
//
// 这个文件把「她能不能看懂」拆成**机器能数的几个数**，并对现状记一份只许减少的
// 预算（照 copy-guard 的做法）：句子多长、中间断了几次、有没有被动、有没有抽象名词
// 堆叠、有没有一个动作。数本身不是目的——它是让「这句变难读了」在 CI 上停下来的闸门。
//
// **它不假装能证明「她看懂了」。** 数字只能挡明显难读的句子（长、绕、没动作、
// 公文腔）；一句短而清楚的话到底好不好懂，只有真人测试能给答案。这条边界写在
// gui/docs/READABILITY.md 里，改这里之前先读那篇。
//
// 扫描范围
//   gui/src/simple/copy*.ts 里的字符串字面量（排除测试自己）。
//   这里刻意**比 copy-guard 多扫一个 copy-capability.ts**（copy-guard 当年因为
//   workstream 归属把它排除了）：它是一个面向用户的文案模块（表格 / PDF / 图片
//   读不了时给她看的那几句），而现状里最长的几句恰好在它里面——少扫它就等于把
//   最难读的句子排除在闸门之外。
//
//   只扫**给用户看**的句子：属性名是 `envelope` 的字符串是发给助手的指令、
//   `new RegExp(...)` 的模板是给程序看的特征，都不算。
//
// 每条命中固定打印成
//
//   文件:行号 -> 「命中的规则」 in "那句话"
//
// 报错本身就是一份改稿说明：看到的人知道该改哪一句、为什么。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 展示路径时以 gui/ 为根，写成 src/simple/copy.ts:12 这种形式。 */
const GUI_ROOT = resolve(HERE, "../..");

// ---------------------------------------------------------------------------
// 数字阈值：都写成常量，因为报告里要说清「为什么是这个数」。
// ---------------------------------------------------------------------------

/** 一句话超过这么多字就要拆开：一条微信大约 30–40 字，屏幕上还要换行。 */
const MAX_CHARS = 40;
/** 中间断句（，、；：）到这么多次，就是在把几件事塞进一句。 */
const MAX_PAUSES = 4;
/** 「整句只有名词」的最小长度：再短就是标签，不构成一句读不动的话。 */
const MIN_CHARS_FOR_NOUN_PILE = 24;
/** 抽象名词叠到这么多个，就是「字都认识、读完不知道在说什么」。 */
const MAX_ABSTRACT_NOUNS = 2;

/**
 * 抽象名词后缀。单个出现未必有问题（「联网配置」），堆叠才是名词压名词。
 */
const ABSTRACT_NOUNS = ["流程", "机制", "状态", "信息", "数据", "操作", "参数", "配置"] as const;

/**
 * 动作词表：只用来数「这句里她认得出几个动作」。
 *
 * **只收多字词**（≥ 2 字），这是有意为之：中文没有词边界，单字动词会到处误命中
 * ——「关」会命中「关于」、「说」会命中「说明」，于是「关于数据状态的说明」反而
 * 被算成有两个动作。收单字的结果是**既误报又漏报**，不如只收多字短语，宁可把
 * 一个便宜的单字动词算成没动作。
 *
 * 也不追求语言学上的完整：它就服务一件事——把「整句都是名词、没有一个动作」的
 * 句子挑出来（配合下面的 `noun-pile` 规则）。中文动词名词同形（整理 / 保存），
 * 所以同形常用词都收；多算只会漏判，不会把一个有动作的好句子误判成没动作。
 */
const ACTION_VERBS: readonly string[] = [
  "告诉", "交给", "打开", "关闭", "删除", "改动", "移动", "选中", "保存", "另存",
  "复制", "粘贴", "确认", "核对", "整理", "合并", "合成", "转换", "压缩", "撤销",
  "恢复", "处理", "生成", "查看", "显示", "出现", "发生", "开始", "完成", "继续",
  "做完", "重新", "碰到", "遇到", "动手", "点击", "选择", "填写", "放到", "存到",
  "发给", "装好", "填进", "删掉", "移走", "改掉", "换掉", "留下", "记下", "说出",
  "找出", "取出", "分开", "导出", "导入", "取走", "看一眼", "看一下", "点一下",
  "找一找", "准备好", "换一句", "回一句", "放回去", "加起来", "列出来", "写下来",
  "念一遍", "接龙", "拖到", "按住", "展开", "收起", "跳过", "去掉", "加上", "拆开",
  "分成", "排好", "对齐", "填好", "改好", "照做", "重做", "再做", "点开", "回到",
  "过来", "下去", "装一次", "运行一次", "打一遍", "选一遍", "贴进来", "复制成", "保存成",
];

interface Rule {
  id: string;
  /** 报告里显示的规则名。 */
  label: string;
  /** 为什么这种写法会让她卡住。 */
  why: string;
  /** 怎么改。 */
  advice: string;
}

const RULES: readonly Rule[] = [
  {
    id: "long",
    label: "太长",
    why: `超过 ${MAX_CHARS} 个字的一句，她要来回读两遍才知道在说什么；屏幕上一行放不下，她会漏掉后半句。`,
    advice: `拆成两三句，一句只说一件事；每句不超过 ${MAX_CHARS} 字。`,
  },
  {
    id: "pauses",
    label: "断句太多",
    why: `一句里断到 ${MAX_PAUSES} 次，等于把好几件事塞进一句；她读到中间就忘了开头在说什么。`,
    advice: "把并列的几件事拆成几条，或者只留下她这一步真要做的那一件。",
  },
  {
    id: "noun-pile",
    label: "整句只有名词",
    why: `超过 ${MIN_CHARS_FOR_NOUN_PILE} 个字、叠了 ${MAX_ABSTRACT_NOUNS} 个以上抽象名词（流程 / 状态 / 信息…），却一个动作都没有——她读不出「谁做什么」，这就是「字都认识、读完不知道在说什么」。`,
    advice: "把名词拆成她能做的动作：把「操作流程已完成」改成「已经做完了」，把「配置信息」改成「要填的东西」。",
  },
  {
    id: "bureaucratic",
    label: "公文体",
    why: "「该操作已被执行」「处理流程已终止」这类公文腔，是制度文件里才有的说法；她不会这样说话，也就读不顺。",
    advice: "改成主动、说人话：把「该操作流程已终止」改成「这件事已经停下了」。",
  },
  {
    id: "vague-pronoun",
    label: "指代不明",
    why: "句首的「它 / 该 / 此 / 其」如果在上一句里没有明确的那个人或东西，她不知道到底是谁准备好了、谁要动手。",
    advice: "把指代换成具体的名字：把「它已经准备好了」改成「电脑已经准备好了」。",
  },
  {
    id: "passive",
    label: "被动句",
    why: "被动句（「文件已被改动」）不点明是谁做的，她要多想一步；主动句（「别人动过这个文件」）一眼就懂。",
    advice: "尽量改成主动句；确实必须用被动的，去下面 PASSIVE_ALLOW 里写明原因。",
  },
];

const byId = (id: string): Rule => {
  const rule = RULES.find((item) => item.id === id);
  if (!rule) throw new Error(`未知规则：${id}`);
  return rule;
};

/** 绝对挡下的规则：出现一次就红，不记预算。 */
const ABSOLUTE_RULES: readonly string[] = ["bureaucratic", "vague-pronoun"];

/**
 * 被动句白名单：确实必须用被动的句子，逐条写明原因。
 *
 * 「被 …」在王姐的场景里有几处是**唯一准确**的说法：文件被别的程序占着、文件被
 * 移走，都是她看不见「谁」做了什么，主动句反而要点出一个她找不到的人；而「原来的
 * 文件没有被改动」是产品承诺的原话。这种时候被动是对的，不该为了数字好看去改。
 *
 * 条目一旦不再命中任何句子，测试会要求删掉，免得例外只增不减。
 */
interface PassiveAllowance {
  /** 文件名，例如 "copy.ts"。 */
  file: string;
  /** 这句里被动的那个成分；包含它才算命中这条例外。 */
  contains: string;
  /** 为什么这句必须用被动。 */
  why: string;
}

const PASSIVE_ALLOW: readonly PassiveAllowance[] = [
  {
    file: "copy.ts",
    contains: "正被别的程序占用",
    why: "占用她文件的是哪个程序，我们看不见；说「别的程序占着它」比编一个具体的程序名准确。",
  },
  {
    file: "copy.ts",
    contains: "可能被移走、改名或者删掉了",
    why: "文件是被谁挪走的我们不知道；她需要知道的是「它不在了」，而不是一个猜出来的人。",
  },
  {
    file: "copy.ts",
    contains: "任务被停下了",
    why: "停下可能是她点的、也可能是程序自己停的；这里说的是「这件事停了」这个结果。",
  },
  {
    file: "copy.ts",
    contains: "没有被改动",
    why: "「原文件没被改动」是产品对文件的承诺原话（产品律 2）；改成主动会丢掉「我们没动它」这层保证。",
  },
  {
    file: "copy.ts",
    contains: "不会被改动",
    why: "同上：这是「动手前先确认」这条承诺的另一半，不能说软，也不能改成让她以为有人在动它。",
  },
  {
    file: "copy-recovery.ts",
    contains: "正被 Excel 或 WPS 打开",
    why: "文件被哪个程序开着，正是她要去关的那个窗口；主动句没有更清楚的说法。",
  },
  {
    file: "copy-recovery.ts",
    contains: "可能被移走、改名或者删掉了",
    why: "谁挪走的不知道，她要做的是重新选一次文件。",
  },
  {
    file: "copy-results.ts",
    contains: "可能被移动或删掉了",
    why: "结果文件找不到了，原因不明，只能如实说它被移动过。",
  },
  {
    file: "copy-results.ts",
    contains: "可能被别的程序占着",
    why: "占用者未知，说出来也没用；她要的是「关掉别的程序再试」。",
  },
  {
    file: "copy-notice.ts",
    contains: "没有被改动",
    why: "撤销失败时的承诺原话：原文件没被动过。改成主动会改变这句保证的意思。",
  },
  {
    file: "copy-queue.ts",
    contains: "不会被打断",
    why: "正在做的那件事会不会中断取决于我们，不取决于她；说的是「它不会中断」这个结果。",
  },
  {
    file: "copy-preanswer.ts",
    contains: "会被当成同一个人",
    why: "说的是识别规则的结果（重名会被算作同一人），不是某个人的动作。",
  },
];

// ---------------------------------------------------------------------------
// 词法器：把字符串字面量切出来，并标出哪些不是给用户看的。
// 这一段和 copy-guard.test.ts 是同一套做法，刻意各自留一份：两个测试的扫描范围
// 不同，共用一个模块反而会把「谁扫什么」这件事藏起来。
// ---------------------------------------------------------------------------

interface Span {
  /** 起始行号，1 起。 */
  line: number;
  /** 字符串内容（模板插值已挖成空格）。 */
  text: string;
  /** 非用户文案：发给助手的 `envelope`，或 `new RegExp(...)` 的特征串。 */
  machine: boolean;
}

function stringSpans(source: string): Span[] {
  const spans: Span[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  /** 最近一个属性名，用来认 `envelope:` 那一条。 */
  let key: string | null = null;

  const readQuoted = (quote: string): void => {
    const startLine = line;
    const machine = key === "envelope" || /new RegExp\(\s*$/.test(source.slice(0, i));
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
    spans.push({ line: startLine, text, machine });
    key = null;
  };

  const readTemplate = (): void => {
    const startLine = line;
    const machine = key === "envelope" || /new RegExp\(\s*$/.test(source.slice(0, i));
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
    spans.push({ line: startLine, text, machine });
    key = null;
  };

  while (i < n) {
    const c = source[i] as string;
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i = Math.min(n, i + 2);
      continue;
    }
    // 正则字面量不是文案；跳过它，免得把 /providers?/ 里的中文当成句子。
    if (c === "/") {
      const prev = source[i - 1] ?? "";
      if (!/[\w)\]"'`]/.test(prev)) {
        let j = i + 1;
        let closed = false;
        while (j < n && source[j] !== "\n") {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === "/") {
            closed = true;
            break;
          }
          j += 1;
        }
        if (closed) {
          i = j + 1;
          continue;
        }
      }
    }
    if (c === '"' || c === "'") {
      readQuoted(c);
      continue;
    }
    if (c === "`") {
      readTemplate();
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const match = /^([A-Za-z_$][\w$]*)\s*:/.exec(source.slice(i, i + 60));
      if (match) {
        key = match[1] as string;
        i += (match[1] as string).length;
        continue;
      }
    }
    i += 1;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// 计数与判定
// ---------------------------------------------------------------------------

const HAS_CJK = /[\u3400-\u9fff]/;
const PAUSES = /[，、；：]/g;
const ABSTRACT_PATTERN = new RegExp(`(${ABSTRACT_NOUNS.join("|")})`, "g");

/** 把一句里出现过的动作词数出来；长词优先，且不重复计数。 */
function countVerbs(text: string): number {
  let count = 0;
  const used: boolean[] = new Array(text.length).fill(false);
  const lexicon = [...ACTION_VERBS].sort((a, b) => b.length - a.length);
  for (const verb of lexicon) {
    let index = text.indexOf(verb);
    while (index >= 0) {
      let free = true;
      for (let k = index; k < index + verb.length; k += 1) if (used[k]) free = false;
      if (free) {
        for (let k = index; k < index + verb.length; k += 1) used[k] = true;
        count += 1;
      }
      index = text.indexOf(verb, index + 1);
    }
  }
  return count;
}

/** 按中文句末标点断句；返回每句和它前面有几个换行（用来回到源码行号）。 */
function sentences(text: string): { text: string; lineOffset: number }[] {
  const out: { text: string; lineOffset: number }[] = [];
  const newlinesBefore = (end: number): number => (text.slice(0, end).match(/\n/g) ?? []).length;
  let start = 0;
  const push = (end: number): void => {
    out.push({ text: text.slice(start, end), lineOffset: newlinesBefore(start) });
    start = end;
  };
  for (let i = 0; i < text.length; i += 1) {
    if ("。！？".includes(text[i] as string)) push(i + 1);
  }
  if (start < text.length) out.push({ text: text.slice(start), lineOffset: newlinesBefore(start) });
  return out.filter((item) => HAS_CJK.test(item.text));
}

/** 官腔：公文里才有的被动与指代。 */
function bureaucraticHit(text: string): string | null {
  const patterns: readonly [RegExp, string][] = [
    [/^(已被|已由|受到|予以|加以|遭到)/, "以公文腔被动开头"],
    [/^(该|上述|下述)(操作|流程|机制|状态|信息|数据|参数|配置|功能|事项|请求|指令)/, "「该操作」这种公文指代"],
    [
      /(流程|机制|状态|信息|数据|操作|参数|配置)(已被|已|被)(完成|终止|执行|启动|关闭|进行|处理|提交|取消|中止)/,
      "抽象名词 + 被动 + 动作（「流程已终止」）",
    ],
    [/(处理|操作|业务|工作)流程/, "「处理流程」这种制度词"],
  ];
  for (const [pattern, why] of patterns) {
    const match = pattern.exec(text);
    if (match) return `${why}：${match[0]}`;
  }
  return null;
}

/** 指代不明：句首的它 / 该 / 此 / 其 + 状态，上一句又没点明是什么。 */
function vaguePronounHit(text: string): string | null {
  const match = /^(它|该|此|其)(已经|已|正在|就要|将要|会|是)/.exec(text);
  return match ? `${match[1]}${match[2]}` : null;
}

interface Sentence {
  /** 相对 gui/ 的路径，例如 src/simple/copy.ts。 */
  file: string;
  /** 展示位置，例如 src/simple/copy.ts:78。 */
  where: string;
  /** 句子（已压平空白、去掉句末标点）。 */
  text: string;
  chars: number;
  pauses: number;
  abstracts: string[];
  verbs: number;
  rules: Rule[];
  /** bureaucratic / vague-pronoun 命中的具体证据。 */
  evidence: string[];
}

const COPY_MODULES = readdirSync(HERE)
  .filter((name) => /^copy.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
  .map((name) => join(HERE, name))
  .sort();

function display(path: string): string {
  return relative(GUI_ROOT, path).split("\\").join("/");
}

interface Evaluated {
  chars: number;
  pauses: number;
  abstracts: string[];
  verbs: number;
  ruleIds: string[];
  evidence: string[];
}

/**
 * 对一句话算一遍所有数，并给出命中哪几条规则。
 *
 * 单独抽成纯函数，是为了让「规则真的能红」可以被直接断言：把一句明显难读的
 * 反例（「该操作流程已终止，如需继续请重新发起」）喂进来，必须命中公文体。
 */
function evaluate(text: string): Evaluated {
  const flat = text.replace(/\s+/g, " ").trim().replace(/[。！？]+$/u, "");
  const chars = [...flat].length;
  const pauses = (flat.match(PAUSES) ?? []).length;
  const abstracts = [...new Set(flat.match(ABSTRACT_PATTERN) ?? [])];
  const verbs = countVerbs(flat);
  const ruleIds: string[] = [];
  const evidence: string[] = [];
  if (chars > MAX_CHARS) ruleIds.push("long");
  if (pauses >= MAX_PAUSES) ruleIds.push("pauses");
  if (chars >= MIN_CHARS_FOR_NOUN_PILE && abstracts.length >= MAX_ABSTRACT_NOUNS && verbs === 0) {
    ruleIds.push("noun-pile");
  }
  const bureau = bureaucraticHit(flat);
  if (bureau) {
    ruleIds.push("bureaucratic");
    evidence.push(bureau);
  }
  const pronoun = vaguePronounHit(flat);
  if (pronoun) {
    ruleIds.push("vague-pronoun");
    evidence.push(`以「${pronoun}」开头指代不清`);
  }
  if (/被/u.test(flat)) ruleIds.push("passive");
  return { chars, pauses, abstracts, verbs, ruleIds, evidence };
}

function analyze(): Sentence[] {
  const out: Sentence[] = [];
  for (const file of COPY_MODULES) {
    const source = readFileSync(file, "utf8");
    const shown = display(file);
    for (const span of stringSpans(source)) {
      if (span.machine) continue;
      for (const item of sentences(span.text)) {
        const flat = item.text.replace(/\s+/g, " ").trim().replace(/[。！？]+$/u, "");
        const chars = [...flat].length;
        if (chars < 4) continue;
        const verdict = evaluate(flat);
        out.push({
          file,
          where: `${shown}:${span.line + item.lineOffset}`,
          text: flat,
          chars: verdict.chars,
          pauses: verdict.pauses,
          abstracts: verdict.abstracts,
          verbs: verdict.verbs,
          rules: verdict.ruleIds.map(byId),
          evidence: verdict.evidence,
        });
      }
    }
  }
  return out;
}

function allowedPassive(sentence: Sentence): boolean {
  const name = basename(sentence.file);
  return PASSIVE_ALLOW.some((entry) => entry.file === name && sentence.text.includes(entry.contains));
}

/** 去掉白名单后真正该报红的句子。 */
function problemSentences(): Sentence[] {
  return analyze().filter((sentence) => {
    const relevant = sentence.rules.filter((rule) => !(rule.id === "passive" && allowedPassive(sentence)));
    return relevant.length > 0;
  });
}

function report(title: string, hits: readonly Sentence[]): string {
  const lines = hits.map((hit) => {
    const flags = hit.rules.map((rule) => rule.label).join("+");
    const detail = hit.evidence.length > 0 ? `  [${hit.evidence.join("；")}]` : "";
    return (
      `${hit.where} -> 「${flags}」 in "${hit.text}"` +
      `  （${hit.chars} 字 / 断 ${hit.pauses} 次 / 动作 ${hit.verbs} 个）${detail}`
    );
  });
  const ids = new Set(hits.flatMap((hit) => hit.rules.map((rule) => rule.id)));
  const advice = [...ids].flatMap((id) => {
    const rule = byId(id);
    return [`  - 「${rule.label}」为什么难读：${rule.why}`, `    怎么改：${rule.advice}`];
  });
  return [title, ...lines, "", "为什么这些句子难读：", ...advice].join("\n");
}

// ---------------------------------------------------------------------------
// 预算表：只许减不许增。
//
// 数字是 2026-09 对现状扫描出来的。它**不是**「这些句子可以留」的许可，而是
// 「把难读的句子数量冻结在现状」的闸门：谁改文案时让某一格涨上去，CI 就红，他要
// 先说明为什么。往下降就顺手把数字改小。
//
// 每格写清它数的是什么、为什么是现在这个数。
// ---------------------------------------------------------------------------

interface Budget {
  file: string;
  rule: string;
  count: number;
  why: string;
}

const BUDGETS: readonly Budget[] = [
  // ---- 长句（> 40 字）----------------------------------------------------
  // 这四句都是「在别的软件里另存为」的逐步说明，本身就长：步骤加上文件格式名
  // （Excel 文件（.xlsx））就占掉一半。它们只在「这个文件我打不开」时出现，
  // 她照着一句做一步；拆成多条反而丢了「导成什么格式」那一段。
  { file: "copy-capability.ts", rule: "long", count: 4, why: "WPS / Pages 另存为的分步说明，格式名占掉一半长度" },
  // 出错页的长句，是她最该读懂的一屏 —— 也是现状里最该优先再拆的。
  { file: "copy.ts", rule: "long", count: 4, why: "出错时的「你可以怎么做」；出路本身就有两三步" },
  // 确认页上「选它会怎样」的解释；她要拿它判断（结果里会不会多几列、会不会合并），
  // 所以信息量必须够。
  { file: "copy-preanswer.ts", rule: "long", count: 2, why: "「选它会怎样」的解释，要够她判断" },
  { file: "copy-privacy-audit.ts", rule: "long", count: 1, why: "说清「发出去的到底是哪一段」，如实讲代价" },
  { file: "copy-daemon.ts", rule: "long", count: 1, why: "缺组件时她自己能做的动作（把安装包再运行一次）" },

  // ---- 断句太多（>= 4 次）----------------------------------------------
  { file: "copy-capability.ts", rule: "pauses", count: 1, why: "WPS 和苹果两种格式混在一起，只能一句说清" },
  { file: "copy-preanswer.ts", rule: "pauses", count: 1, why: "「优先用编号；没有编号再按整行比」两个分支连着" },

  // ---- 整句只有名词（> 24 字 + 抽象名词叠 2 个以上 + 无动作）----------------
  // 不列预算：现状一条都没有。任何一格没在预算表里的难读句子都会报红，所以
  // 以后新写的「名词套餐」会直接失败，不需要一个 0 的占位。

  // ---- 被动句 ------------------------------------------------------------
  // 现状里每句「被 …」都在 PASSIVE_ALLOW 里（说不出是谁做的 / 产品承诺原话），
  // 所以没有需要预算的被动句。这里写 0：出现一条**没进白名单**的被动句就会红。
  { file: "copy.ts", rule: "passive", count: 0, why: "出错页的被动句都在白名单里，这一格应为 0" },
];

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("可读性红线：她读一句就能知道该做什么", () => {
  test("扫描器真的扫到了东西", () => {
    expect(COPY_MODULES.length).toBeGreaterThan(0);
    expect(analyze().length).toBeGreaterThan(100);
  });

  test("发给助手的指令与程序特征不算文案", () => {
    // copy.ts 里那条组件缺失的特征串很长（`is not recognized …`），如果扫描器
    // 没把 `new RegExp(...)` 排除掉，它会被当成一句 80 字的“难读文案”报红。
    // copy-preanswer.ts 的 `envelope:` 是发给助手的指令，同理。
    const texts = analyze().map((sentence) => sentence.text).join("\n");
    expect(texts).not.toContain("is not recognized");
    expect(texts).not.toContain("不要再为这件事停下来问她");
    // 但真正的用户句子必须在：
    expect(texts).toContain("点「重试」再试一次");
  });

  test("公文腔与指代不明：出现一次就红（不记预算）", () => {
    const hits = problemSentences().filter((sentence) =>
      sentence.rules.some((rule) => ABSOLUTE_RULES.includes(rule.id)),
    );
    if (hits.length > 0) {
      throw new Error(report("这些句子是公文腔或指代不清（她读不懂「谁做了什么」）：", hits));
    }
  });

  test("难读的句子数量只许减不许增（预算表）", () => {
    const counts = new Map<string, number>();
    for (const sentence of analyze()) {
      for (const rule of sentence.rules) {
        if (rule.id === "passive" && allowedPassive(sentence)) continue;
        const key = `${basename(sentence.file)}|${rule.id}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const grown: string[] = [];
    const shrunk: string[] = [];
    const grownKeys = new Set<string>();
    for (const [key, count] of counts) {
      const budget = BUDGETS.find((entry) => `${entry.file}|${entry.rule}` === key);
      const label = key.replace("|", " 的 ");
      if (!budget) {
        grown.push(`  - ${label}：现在 ${count} 处，预算表里没有这一格`);
        grownKeys.add(key);
      } else if (count > budget.count) {
        grown.push(`  - ${label}：现在 ${count} 处，预算 ${budget.count} 处`);
        grownKeys.add(key);
      }
    }
    for (const budget of BUDGETS) {
      const count = counts.get(`${budget.file}|${budget.rule}`) ?? 0;
      if (count < budget.count) {
        shrunk.push(`  - ${budget.file} 的 ${budget.rule}：预算 ${budget.count} 处，现在 ${count} 处`);
      }
    }
    if (grown.length > 0) {
      // 把超出的那几句直接列出来：报告本身就是改稿说明，不让人再去猜是哪句。
      const offenders = analyze()
        .filter((sentence) =>
          sentence.rules.some(
            (rule) =>
              !(rule.id === "passive" && allowedPassive(sentence)) &&
              grownKeys.has(`${basename(sentence.file)}|${rule.id}`),
          ),
        )
        .map((sentence) => {
          const flags = sentence.rules.map((rule) => rule.label).join("+");
          return `      ${sentence.where} -> 「${flags}」 in "${sentence.text}"`;
        });
      throw new Error(
        [
          "这些文案变难读了（新增了长句 / 断句 / 名词堆叠 / 被动句，超出了只许减少的预算）：",
          ...grown,
          "",
          "超出预算的句子是：",
          ...offenders,
          "",
          "改法有两种，任选其一：",
          "  1. 把那句改短、改成主动、拆成两句 —— 首选；",
          "  2. 确实必须这么长（例如分步说明 / 产品承诺的原话），在 readability.test.ts 的 BUDGETS 里",
          "     把数字改大，并在提交信息里写清为什么（这个表只应该缩小）。",
          "",
          "也可以看 gui/docs/READABILITY.md 里的现状表。",
        ].join("\n"),
      );
    }
    if (shrunk.length > 0) {
      throw new Error(["有文案已经改好了，把预算顺手改小（别让债务数字虚高）：", ...shrunk].join("\n"));
    }
  });

  test("被动句白名单是审过的：写了原因，也没有过期的条目", () => {
    for (const entry of PASSIVE_ALLOW) {
      expect(COPY_MODULES.some((file) => basename(file) === entry.file)).toBe(true);
      expect(entry.why.trim().length).toBeGreaterThan(8);
    }
    const all = analyze().filter((sentence) => sentence.rules.some((rule) => rule.id === "passive"));
    const stale = PASSIVE_ALLOW.filter(
      (entry) => !all.some((sentence) => basename(sentence.file) === entry.file && sentence.text.includes(entry.contains)),
    ).map((entry) => `${entry.file} 的「${entry.contains}」`);
    if (stale.length > 0) {
      throw new Error(
        ["这些被动白名单条目已经用不上了，请删掉（避免例外只增不减）：", ...stale.map((line) => `  - ${line}`)].join("\n"),
      );
    }
  });

  test("规则和数字自己是有效的，也不误伤正常中文", () => {
    for (const rule of RULES) {
      expect(rule.why.trim().length).toBeGreaterThan(10);
      expect(rule.advice.trim().length).toBeGreaterThan(8);
    }
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);

    // 该抓的：
    expect(bureaucraticHit("该操作已被执行")).not.toBeNull();
    expect(bureaucraticHit("我们的处理流程已终止")).not.toBeNull();
    expect(vaguePronounHit("它已经准备好了。")).toBe("它已经");
    // 不该抓的（中文的正常用法 / 必要的被动）：
    expect(bureaucraticHit("这件事已经停下了。")).toBeNull();
    expect(bureaucraticHit("原来的文件没有被改动。")).toBeNull();
    expect(vaguePronounHit("它想先做一件事，需要你点头。")).toBeNull(); // 「想做」是动作，不是状态
    expect(vaguePronounHit("它有一件事想问你。")).toBeNull();
    expect(countVerbs("把这两张表合并成一张")).toBeGreaterThan(0);
    expect(countVerbs("流程机制状态信息")).toBe(0);

    // 每一条规则都必须真的能红 —— 拿一句明显难读的反例喂进 evaluate()，
    // 逐条确认命中。否则一条写坏了的规则（正则改废、阈值调错）会静静地放行。
    const bad = evaluate("该操作流程已终止，如需继续请重新发起这个处理流程。");
    expect(bad.ruleIds).toContain("bureaucratic");
    expect(
      evaluate("如果你想在保留原文件的同时把结果放到另一个位置，请先在设置里选择你想要的那种保存方式。").ruleIds,
    ).toContain("long");
    expect(evaluate("一、二、三、四、五对应五个按钮，请先看第一个。").ruleIds).toContain("pauses");
    expect(
      evaluate("关于各类数据的状态、配置信息与操作机制的说明文档以及相关注意事项的汇总材料清单的完整版本。").ruleIds,
    ).toContain("noun-pile");
    expect(evaluate("它已经准备好了。").ruleIds).toContain("vague-pronoun");
    expect(evaluate("这个文件已经被改动过了。").ruleIds).toContain("passive");
  });
});
