// 语气红线（tone guard）。
//
// ROADMAP 里的文案基调是「平实 + 有依据，不卖萌」，依据是 Wharton 2026 的对照
// 实验：让人放心的是**能力感**（说得出自己做了什么、做不到什么），不是亲切感；
// 承认局限比吹嘘更能建立信任。在此之前这条约束只活在文档里——copy-guard 挡技术
// 词、typography 挡字号，但谁写一句「几秒钟搞定」「绝对没问题」都能过。这个文件
// 把它变成一条机器能挡的断言。
//
// 扫描范围（和 copy-guard 刻意不同，别照它的范围抄）：
//   A  gui/src/simple/copy*.ts 里的字符串字面量；
//   B  gui/src/simple/tasks/*.ts 里**真正给用户看**的字段：
//      title / example / plan / risks / summaryHints。
//
// 刻意不扫的，以及为什么：
//   * tasks/*.ts 的 prompt() —— 那是写给助手的指令，不是面向用户的文案。
//     「绝对不要覆盖已有文件」里的「绝对」是在下命令，恰恰是产品律要的；把这类
//     句子拿去扫，只会逼人把安全指令改软，那是比误报更糟的结果。
//   * 注释与正则 —— 同样不是文案。
//   * .tsx 组件 —— 不在本轮的改动范围里（copy-guard 已有的内联文案台账管着）。
//
// 每条规则都带 why（为什么不行）和 advice（建议怎么说）；命中信息固定打印成
//
//   文件:位置 -> 「命中的词/句式」 in "命中的那句话"
//     为什么不行：…
//     建议怎么说：…
//
// 报错本身就是一份改稿说明，看到的人可以直接照着改。
//
// 注意中文的正常用法，别误伤：
//   * 「哪」是疑问词（哪一列、哪个月）、「啊」是语气词（好吗、这样啊）——都正常；
//   * 「么」在「什么/怎么/这么」里是构词成分，只有叠字「么么」才算撒娇；
//   * 「一键」本身不是问题（「一键撤销」是实话：它就是一个按钮），有问题的只有
//     「一键搞定」这种把干活说没了的话；
//   * 「可能不准的地方」是让我们把具体风险摊开（产品律 3 要的东西），和
//     「仅供参考」这种把判断推回给她的免责声明是两回事，不能一起扫。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FREE_TEXT_RISKS, TASKS, freeTask } from "./tasks/index.ts";
import type { TaskDef } from "./tasks/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 展示路径时以 gui/ 为根，写成 src/simple/copy.ts:78 这种形式。 */
const GUI_ROOT = resolve(HERE, "../..");

// ---------------------------------------------------------------------------
// 规则表：每一条都是「命中即失败」，并带上为什么不行的依据。
// ---------------------------------------------------------------------------

interface ToneRule {
  /** 稳定标识，白名单按它引用。 */
  id: string;
  /** 报告里显示的「命中词/句式」。 */
  label: string;
  /** 为什么这种写法不行。 */
  why: string;
  /** 建议怎么改（不改变含义的平实说法）。 */
  advice: string;
  /** 命中返回命中的那一小段文字，没命中返回 null。 */
  find(text: string): string | null;
}

/** 大多数规则就是「文案里出现这个词」；正则不带 g，避免跨调用带状态。 */
function matchOf(pattern: RegExp): (text: string) => string | null {
  return (text) => pattern.exec(text)?.[0] ?? null;
}

const RULES: readonly ToneRule[] = [
  {
    id: "cutesy",
    label: "卖萌/撒娇",
    why:
      "「哦/呀/啦」这类语气词、亲昵称呼（小可爱/宝宝/么么）会让她觉得这是在哄小孩，不是来办事的；" +
      "靠套近乎换来的好感不牢，说清自己能做什么才是信任的来源（Wharton 2026：能力感优先于亲切感）。" +
      "中文里正常的「哪」（哪一列）和「啊」（好吗）不算，这里只抓句末/小句末的语气词。",
    advice:
      "去掉语气词，直接说这件事本身：把「检查好啦」改成「检查完成」，把「好呀」改成「可以」，" +
      "把「别急哦」改成「不用着急」。",
    find(text) {
      const word = /小可爱|宝宝|么么/.exec(text);
      if (word) return word[0];
      // 语气词出现在句末或小句末（后面是标点或行尾）。中间的「呀/啦/哦」不抓，
      // 免得误伤正常用字。
      const particle = /[哦呀啦](?=[，。！？；、!?,;\n]|$)/m.exec(text);
      if (particle) return particle[0];
      const tilde = /呢\s*[~～]/.exec(text);
      if (tilde) return tilde[0];
      return null;
    },
  },
  {
    id: "emoji",
    label: "表情符号",
    why:
      "表情符号在正式界面里既占地方又说不出信息，还会让她拿不准这软件是不是不正经；" +
      "状态该用文字说清楚，而不是画一个笑脸。",
    advice: "删掉表情符号，把那句话用文字写出来；要区分状态就用「已完成」「没做完」这种词。",
    find: matchOf(/\p{Extended_Pictographic}/u),
  },
  {
    id: "overpromise",
    label: "空口保证/夸张",
    why:
      "「绝对/百分百/万无一失/保证不会/一定不会错/完美/最强/史上」这类词没有任何依据，" +
      "一旦出错就是骗人；承认局限反而更可信。这里刻意只抓「一键搞定」，不抓「一键撤销」——" +
      "后者就是一个按钮能撤销，是实话。",
    advice:
      "只说能核对的事实：把「绝对没问题」改成「结果会另存为新文件，原来的文件不动」；" +
      "把「一键搞定」改成这件事具体会做哪几步。",
    find: matchOf(/绝对|百分百|万无一失|保证不会|一定不会错|完美|最强|史上|一键搞定/),
  },
  {
    id: "time-promise",
    label: "时间承诺",
    why:
      "给一件事承诺具体耗时（几秒钟、十秒钟、瞬间），我们保证不了：遇到大文件或慢电脑就要更久，" +
      "界面就成了吹牛。用时多久不是我们该替它打的包票。",
    advice: "说清这一步要做什么就行，不要替它数秒：把「先花十秒钟检查一下」改成「先检查一下」。",
    find: matchOf(/几秒|秒钟|瞬间/),
  },
  {
    id: "bare-success-rate",
    label: "没有数字的成功率",
    why:
      "「成功率高」既没有数字也没有来源，她没法判断能不能信；讲不出数字就不该提成功率。" +
      "本机真的跑过的统计是允许的（例如「做过 3 次，成功 2 次」），因为它可以被核对。",
    advice:
      "写上真实的本地统计（例如「在这台电脑上做过 4 次，其中 3 次做成了」），或者给出出处；" +
      "拿不出数字就把「成功率」三个字删掉。",
    find(text) {
      if (!/成功率/.test(text)) return null;
      // 带数字（次数或百分比）就算有依据；「成功率高」这种形容词句才算命中。
      if (/\d/.test(text)) return null;
      return "成功率";
    },
  },
  {
    id: "disclaimer",
    label: "推卸责任式免责声明",
    why:
      "「仅供参考/可能有误/不保证」把判断整个推回给她，等于什么也没说；" +
      "产品律要的是把风险写成她能对着自己文件核对的具体情况（比如「有合并单元格时合计可能算重」）。" +
      "注意「这个任务可能不准的地方」这种把具体风险摊开的说法不在其列。",
    advice:
      "把笼统的免责声明换成一条具体、能核对的风险，或者直接删掉：把「仅供参考」改成「有合并单元格时合计可能算重，请你核对」。",
    find: matchOf(/仅供参考|可能有误|不保证/),
  },
];

// ---------------------------------------------------------------------------
// 白名单：确实无害又改不掉的写法，逐条写原因。
//
// 这是「被审过的例外」，不是消音器：条目必须指向一条真实存在的规则、写清为什么
// 这处例外对用户是必要的，而且一旦不再命中任何东西，测试会要求删掉它。
// ---------------------------------------------------------------------------

interface Allowance {
  /** 文件名，例如 "copy.ts" 或 "files.ts"。 */
  file: string;
  /** 必须和 RULES 里的 id 完全一致。 */
  rule: string;
  /** 为什么这条例外是审过的、必须留着的。 */
  why: string;
}

const ALLOW: readonly Allowance[] = [
  // 目前为空：面向用户的文案里没有一条命中。
];

function allowed(hit: Hit): boolean {
  const name = basename(hit.file);
  return ALLOW.some((entry) => entry.file === name && entry.rule === hit.rule.id);
}

// ---------------------------------------------------------------------------
// 词法器：只把字符串字面量切出来（注释不算，模板里的 ${...} 挖掉）。
// 这一小段和 copy-guard.test.ts 是同一套做法，刻意各自留一份：两个测试的扫描
// 范围不同，共用一个模块反而会把「谁扫什么」这件事藏起来。
// ---------------------------------------------------------------------------

interface Span {
  /** 起始行号，1 起。 */
  line: number;
  /** 字符串内容（模板插值已挖成空格）。 */
  text: string;
}

function stringSpans(source: string): Span[] {
  const spans: Span[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;

  const readQuoted = (quote: string): void => {
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
    spans.push({ line: startLine, text });
  };

  const readTemplate = (): void => {
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
    spans.push({ line: startLine, text });
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

// ---------------------------------------------------------------------------
// 收集命中
// ---------------------------------------------------------------------------

interface Hit {
  /** 相对 gui/ 的路径，例如 src/simple/copy.ts。 */
  file: string;
  /** 展示用的位置，例如 src/simple/copy.ts:78。 */
  where: string;
  /** 命中的那一小段文字。 */
  match: string;
  /** 命中的那句话（已压平空白）。 */
  text: string;
  rule: ToneRule;
}

function display(path: string): string {
  return relative(GUI_ROOT, path).split("\\").join("/");
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/** 对一段文案套所有规则，命中就变成一条 Hit。 */
function scanText(options: {
  file: string;
  where: string;
  text: string;
}): Hit[] {
  const hits: Hit[] = [];
  for (const rule of RULES) {
    const match = rule.find(options.text);
    if (!match) continue;
    hits.push({
      file: options.file,
      where: options.where,
      match,
      text: flatten(options.text),
      rule,
    });
  }
  return hits;
}

/** 范围 A：copy*.ts 的字符串字面量。 */
function copyModules(): string[] {
  return readdirSync(HERE)
    .filter((name) => /^copy.*\.ts$/.test(name) && !name.endsWith(".test.ts"))
    .map((name) => join(HERE, name))
    .sort();
}

function copyHits(options: { applyAllow?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  for (const file of copyModules()) {
    const source = readFileSync(file, "utf8");
    const shown = display(file);
    for (const span of stringSpans(source)) {
      for (const hit of scanText({ file, where: shown, text: span.text })) {
        hit.where = `${shown}:${span.line}`;
        if (options.applyAllow === false || !allowed(hit)) hits.push(hit);
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// 范围 B：任务卡里给用户看的字段。
//
// 用运行时枚举（import 目录）而不是正则解析源码，是为了跟着引用走：wechat.ts 的
// TABLE_PLAN 是常量、plan 只写了一个名字，真交给用户的是展开后的每一条；按源码
// 找 `plan: [` 会漏掉它们。行号再回源码里定位，纯属指路，定位不到也不影响判红。
// ---------------------------------------------------------------------------

interface UserCopy {
  /** 展示用来源，例如 files.rename.example。 */
  label: string;
  /** 归属任务卡模块，用于回源码定位。 */
  file: string;
  text: string;
}

function everyTask(): TaskDef[] {
  // freeTask 不在 TASKS 里，但它的计划、风险同样是用户看得见的；多造一份空的。
  return [...TASKS, freeTask("")];
}

function taskFields(task: TaskDef): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [
    { field: "title", text: task.title },
    { field: "example", text: task.example },
  ];
  task.plan.forEach((text, index) => out.push({ field: `plan[${index}]`, text }));
  (task.risks ?? []).forEach((text, index) => out.push({ field: `risks[${index}]`, text }));
  task.summaryHints.forEach((text, index) => out.push({ field: `summaryHints[${index}]`, text }));
  return out;
}

function taskSources(): string[] {
  const dir = join(HERE, "tasks");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "types.ts")
    .map((name) => join(dir, name))
    .sort();
}

/** 在 tasks/*.ts 里找这段文案的位置；找不到就退回「任务字段名」，不影响判红。 */
function locate(fallback: string, text: string): { file: string; where: string } {
  for (const file of taskSources()) {
    const source = readFileSync(file, "utf8");
    const index = source.indexOf(text);
    if (index >= 0) {
      const shown = display(file);
      return { file, where: `${shown}:${lineAt(source, index)}` };
    }
  }
  return { file: join(HERE, "tasks"), where: fallback };
}

function taskHits(options: { applyAllow?: boolean } = {}): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const task of everyTask()) {
    for (const { field, text } of taskFields(task)) {
      const label = `${task.id}.${field}`;
      const place = locate(label, text);
      for (const hit of scanText({ file: place.file, where: place.where, text })) {
        const key = `${hit.where}|${hit.match}|${hit.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (options.applyAllow === false || !allowed(hit)) hits.push(hit);
      }
    }
  }
  return hits;
}

/** 失败信息固定成「文件:行号 -> 「词」 in "那句话"」+ 分组建议。 */
function report(title: string, hits: readonly Hit[]): string {
  const lines = hits.map((hit) => `${hit.where} -> 「${hit.match}」 in "${hit.text}"`);
  const advice = new Map<string, ToneRule>();
  for (const hit of hits) advice.set(hit.rule.id, hit.rule);
  const notes = [...advice.values()].flatMap((rule) => [
    `  - 「${rule.label}」为什么不行：${rule.why}`,
    `    建议怎么说：${rule.advice}`,
  ]);
  return [title, ...lines, "", "怎么改：", ...notes].join("\n");
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("语气红线：面向用户的文案要平实、有依据，不卖萌", () => {
  test("范围 A：copy 模块的文案里没有卖萌、夸张、空口保证和免责声明", () => {
    const modules = copyModules();
    expect(modules.length).toBeGreaterThan(0);
    const hits = copyHits();
    if (hits.length > 0) {
      throw new Error(
        report(
          "这些用户文案的语气不对（改成平实说法；确实无害又改不掉的，去 tone.test.ts 的 ALLOW 里写明原因）：",
          hits,
        ),
      );
    }
  });

  test("范围 B：任务卡的标题、示例、计划、风险、结果提示里也没有", () => {
    expect(TASKS.length).toBeGreaterThan(20);
    const hits = taskHits();
    if (hits.length > 0) {
      throw new Error(
        report(
          "这些任务卡的用户文案语气不对（改 title / example / plan / risks / summaryHints，不要动 prompt）：",
          hits,
        ),
      );
    }
  });

  test("规则自己是有效的，而且不误伤正常中文", () => {
    // 先确认扫描器真的扫到了东西，否则「零命中」可能只是词法器坏了。
    const strings = copyModules().flatMap((file) => stringSpans(readFileSync(file, "utf8")));
    expect(strings.length).toBeGreaterThan(100);
    expect(everyTask().flatMap(taskFields).length).toBeGreaterThan(100);

    for (const rule of RULES) {
      expect(rule.id.length).toBeGreaterThan(0);
      expect(rule.why.trim().length).toBeGreaterThan(10);
      expect(rule.advice.trim().length).toBeGreaterThan(10);
    }
    // id 不能重复，否则白名单会张冠李戴。
    expect(new Set(RULES.map((rule) => rule.id)).size).toBe(RULES.length);

    const byId = new Map(RULES.map((rule) => [rule.id, rule]));
    const hit = (id: string, text: string): string | null => byId.get(id)?.find(text) ?? null;

    // 该抓的：
    expect(hit("cutesy", "已经检查好啦")).toBe("啦");
    expect(hit("cutesy", "好呀，马上开始")).toBe("呀");
    expect(hit("cutesy", "别急哦。")).toBe("哦");
    expect(hit("cutesy", "我等你呢～")).toBe("呢～");
    expect(hit("cutesy", "么么哒")).toBe("么么");
    expect(hit("emoji", "完成了 😀")).toBe("😀");
    expect(hit("overpromise", "绝对没问题")).toBe("绝对");
    expect(hit("overpromise", "一键搞定")).toBe("一键搞定");
    expect(hit("time-promise", "先花十秒钟检查一下")).toBe("秒钟");
    expect(hit("time-promise", "瞬间就做完")).toBe("瞬间");
    expect(hit("bare-success-rate", "成功率高")).toBe("成功率");
    expect(hit("disclaimer", "结果仅供参考")).toBe("仅供参考");

    // 不该抓的（中文的正常用法）：
    expect(hit("cutesy", "哪一列是金额？")).toBeNull(); // 「哪」是疑问词
    expect(hit("cutesy", "这样啊，那我知道了")).toBeNull(); // 「啊」是正常语气词
    expect(hit("cutesy", "你想怎么做都行")).toBeNull(); // 没有叠字「么么」
    expect(hit("overpromise", "一键撤销")).toBeNull(); // 一个按钮能撤销，是实话
    expect(hit("disclaimer", "这个任务可能不准的地方")).toBeNull(); // 摊开具体风险
    expect(hit("bare-success-rate", "做过 3 次，成功 2 次")).toBeNull(); // 带数字的本地统计
    expect(hit("bare-success-rate", "成功率 85%")).toBeNull(); // 带数字
    expect(hit("emoji", "点「文件」→「另存为」")).toBeNull(); // 箭头不是表情
    expect(hit("time-promise", "把每一分钟都用上")).toBeNull(); // 不是耗时承诺
  });

  test("白名单是审过的：写清了原因，也没有过期的条目", () => {
    for (const entry of ALLOW) {
      expect(RULES.some((rule) => rule.id === entry.rule)).toBe(true);
      expect(entry.why.trim().length).toBeGreaterThan(10);
      expect(basename(entry.file)).toBe(entry.file);
    }
    // 一条白名单如果已经不再命中任何东西，就该删掉，免得例外越攒越多。
    const raw = copyHits({ applyAllow: false }).concat(taskHits({ applyAllow: false }));
    const stale = ALLOW.filter(
      (entry) =>
        !raw.some((hit) => hit.rule.id === entry.rule && basename(hit.file) === entry.file),
    ).map((entry) => `${entry.file} 的「${entry.rule}」`);
    if (stale.length > 0) {
      throw new Error(
        ["这些白名单条目已经用不上了，请删掉（避免例外只增不减）：", ...stale.map((line) => `  - ${line}`)].join(
          "\n",
        ),
      );
    }
  });
});
