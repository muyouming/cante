// 跨平台守卫（产品以 Windows 为先，而开发一直在 macOS 上）。
//
// 这个文件挡住「只在一台电脑上成立」的说法。真机上出过这种事：卡片让助手把
// PDF 转成 Word，助手在 macOS 上顺手用了 textutil 做成 .docx，可王姐的 Windows
// 上没有这个命令——卡片承诺了一个那台电脑不一定做得到的结果。所以规矩写死：
// 只用这台电脑确实有的工具；做不出来就换成通用办法，并且如实说明。
//
// 扫描范围（两条线，缺一不可）：
//   * 每一张卡在生产路径上真正发出去的完整指令（instructionFor 走的就是各卡的
//     prompt()，即 `store.composedInstruction` 用的那条线），含公共信封；
//   * 卡片给用户看的文字（title / example / plan / risks / summaryHints）。
//
// 命中就失败，并打印「文件:卡片:「命中的词」+ 应该改成什么」。黑名单只收
// 「只在一个桌面系统上才有」的命令、路径写法和界面叫法；`cante-sheets` /
// `cante-pdf` 是产品自带的跨平台工具，不在其列。
//
// 白名单默认是空的。确实必须留一条时，在 ALLOW 里写 file/term/why，why 要说明
// 为什么这个东西在目标电脑上一定可用；已经不再命中的白名单会被要求删掉。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// `import.meta.dir`（Bun 提供）在 Windows 上给的是 `D:\a\...`；而
// `new URL(import.meta.url).pathname` 会给成 `/D:/a/...`，后者在 Windows 上
// scandir 直接 ENOENT —— 跨平台守卫自己先踩了一次跨平台路径的坑（Windows CI 抓到的）。
const TASKS_DIR = import.meta.dir;

// 目录必须先加载：卡片模块是从 index.ts 反向 import 出来的（这个 worktree 还
// 没做「只依赖叶子模块」那轮整理），先 import 单张卡会把循环导入引到半初始化
// 状态。让 index.ts 先把整个目录跑完，再取各卡所在的文件。
import { TASKS, type TaskDef } from "./index.ts";

import { EXCEL_TASKS } from "./excel.ts";
import { SHEET_TASKS } from "./sheet.ts";
import { FILE_TASKS } from "./files.ts";
import { BY_MONTH_TASKS } from "./bymonth.ts";
import { DOCUMENT_TASKS } from "./document.ts";
import { WORK_SUMMARY_TASKS } from "./worksummary.ts";
import { SUMMARY_TASKS } from "./summary.ts";
import { CHECK_TASKS } from "./check.ts";
import { INVOICE_TASKS } from "./invoice.ts";
import { ADMIN_TASKS } from "./admin.ts";
import { RESEARCH_TASKS } from "./research.ts";
import { VISION_TASKS } from "./vision.ts";
import { WECHAT_ALL_TASKS } from "./wechat.ts";
import {
  CHECK_NOTE_BLOCK,
  SAFETY_RULES,
  buildPrompt,
  filesBlock,
  folderBlock,
  safetyBlock,
  setPdfHelper,
  setSheetHelper,
  userWordsBlock,
} from "./prompt.ts";

// 能力说明由启动时探测写入；测试里先清空，扫描到的就是卡片自己的文案。
setSheetHelper(null);
setPdfHelper(null);

// ---------------------------------------------------------------------------
// 黑名单：只在一个桌面系统上成立的东西。
// ---------------------------------------------------------------------------

interface PlatformTerm {
  /** 报告里显示的词。 */
  label: string;
  pattern: RegExp;
  /** 应该改成什么——报告直接照着这句话改。 */
  fix: string;
}

const PLATFORM_TERMS: readonly PlatformTerm[] = [
  // macOS 才有的命令行工具（助手真机上用过 textutil；其余同类一起挡住）。
  {
    label: "textutil",
    pattern: /\btextutil\b/i,
    fix: "macOS 专有。做不做得出 Word 要看这台电脑上到底有没有相应工具；没有就把文字直接写出来，并告诉用户怎么粘贴到 Word。",
  },
  {
    label: "sips",
    pattern: /\bsips\b/i,
    fix: "macOS 专有的图片处理命令，Windows 上没有；改成通用做法，或先问用户这台电脑上有什么工具。",
  },
  {
    label: "pbcopy",
    pattern: /\bpbcopy\b/i,
    fix: "macOS 专有的剪贴板命令；让用户自己复制，或把内容写进结果文件。",
  },
  {
    label: "pbpaste",
    pattern: /\bpbpaste\b/i,
    fix: "macOS 专有的剪贴板命令；不要依赖剪贴板，把内容写进文件或直接写出来。",
  },
  {
    label: "open -a",
    pattern: /open\s+-a\b/i,
    fix: "macOS 用 Finder 打开程序/文件的写法；改成中性说法，或让用户自己打开。",
  },
  {
    label: "open -R",
    pattern: /open\s+-R\b/,
    fix: "macOS 在 Finder 里定位文件的写法；改成「在文件夹里找到这个文件」这类中性说法。",
  },
  {
    label: "qlmanage",
    pattern: /\bqlmanage\b/i,
    fix: "macOS 专有的预览/缩略图命令；改成不依赖预览工具的通用做法。",
  },
  {
    label: "osascript",
    pattern: /\bosascript\b/i,
    fix: "macOS 专有的脚本命令；Windows 上没有，改成通用做法。",
  },
  {
    label: "mdfind",
    pattern: /\bmdfind\b/i,
    fix: "macOS Spotlight 专有搜索命令；改成在用户给的文件夹里逐个查找。",
  },
  {
    label: "mdls",
    pattern: /\bmdls\b/i,
    fix: "macOS 专有元数据命令；改成通用做法，或先问用户这台电脑上有什么工具。",
  },
  {
    label: "defaults write",
    pattern: /defaults\s+write\b/i,
    fix: "macOS 专有的偏好设置命令；不要在任务里改系统设置。",
  },
  {
    label: "diskutil",
    pattern: /\bdiskutil\b/i,
    fix: "macOS 专有的磁盘命令；任务里不要动磁盘。",
  },
  {
    label: "launchctl",
    pattern: /\blaunchctl\b/i,
    fix: "macOS 专有的服务管理命令；任务里不要动系统服务。",
  },
  {
    label: "screencapture",
    pattern: /\bscreencapture\b/i,
    fix: "macOS 专有的截图命令；改成让用户自己截图并提供文件。",
  },
  {
    label: "caffeinate",
    pattern: /\bcaffeinate\b/i,
    fix: "macOS 专有的防休眠命令；任务里不需要。",
  },
  {
    label: "afplay",
    pattern: /\bafplay\b/i,
    fix: "macOS 专有的播放声音命令；任务里不需要。",
  },
  {
    label: "sw_vers",
    pattern: /\bsw_vers\b/i,
    fix: "macOS 专有的系统版本命令；不要拿它判断这台电脑能做什么。",
  },
  {
    label: "PlistBuddy",
    pattern: /\bPlistBuddy\b/,
    fix: "macOS 专有的配置文件工具；任务里不要改系统配置。",
  },
  {
    label: "xattr",
    pattern: /\bxattr\b/i,
    fix: "macOS 专有的扩展属性命令；Windows 上没有。",
  },
  {
    label: "ditto",
    pattern: /\bditto\b/i,
    fix: "macOS 专有的复制命令；改成通用的「复制一份」说法。",
  },
  {
    label: "brew",
    pattern: /\bbrew\b/i,
    fix: "Homebrew 只在装了它的电脑上有；缺工具时应当先问用户，而不是让助手照着装。",
  },
  // POSIX / 类 Unix 才有的命令（Windows 上没有或写法不同）。
  {
    label: "chmod",
    pattern: /\bchmod\b/i,
    fix: "Unix 权限命令，Windows 上没有；不要出现在给用户的指令里。",
  },
  {
    label: "chown",
    pattern: /\bchown\b/i,
    fix: "Unix 权限命令，Windows 上没有。",
  },
  {
    label: "sed -i",
    pattern: /sed\s+-i\b/,
    fix: "macOS 与 Linux 的 sed -i 写法不同；改成不依赖它的通用做法。",
  },
  // 只在某一台机器上成立的路径写法。
  {
    label: "/tmp",
    pattern: /\/tmp\b/,
    fix: "这是类 Unix 的临时目录，Windows 上没有；结果要放在用户给的那份文件旁边（同一个文件夹）。",
  },
  {
    label: "/Users/",
    pattern: /\/Users\//,
    fix: "这是 macOS 的家目录写法，Windows 是 C:\\Users\\；不要写死路径，用用户给的文件所在的文件夹。",
  },
  {
    label: "/Applications/",
    pattern: /\/Applications\//,
    fix: "这是 macOS 的程序目录，Windows 上不存在；不要写死程序位置。",
  },
  {
    label: "~/",
    pattern: /~\//,
    fix: "这是类 Unix 的家目录写法，不保证每台电脑都成立；用用户给的文件所在的文件夹。",
  },
  // 把某一种系统的界面叫法当成通用说法。
  { label: "访达", pattern: /访达/, fix: "macOS 的文件管理器叫「访达」；改成中性的「文件夹」。" },
  { label: "Finder", pattern: /\bFinder\b/, fix: "macOS 的文件管理器；改成中性的「文件夹」。" },
  { label: "程序坞", pattern: /程序坞/, fix: "macOS 的叫法；Windows 上任务栏在旁边，改成中性的说法。" },
  { label: "Dock", pattern: /\bDock\b/, fix: "macOS 的叫法；不要出现在给用户的文案里。" },
  { label: "启动台", pattern: /启动台/, fix: "macOS 的叫法；改成中性说法，或让用户从桌面/开始菜单找。" },
  { label: "Launchpad", pattern: /\bLaunchpad\b/, fix: "macOS 的叫法；不要出现在给用户的文案里。" },
  { label: "废纸篓", pattern: /废纸篓/, fix: "macOS 的叫法；Windows 上叫「回收站」。" },
];

// ---------------------------------------------------------------------------
// 白名单：确实必须留在文案里的词，逐条写明原因。
//
// 现在为空——目录里的卡片本来就跨平台。要开口子时在这里加一条，why 要说清
// 「为什么这东西在王姐的电脑上一定可用」。
// ---------------------------------------------------------------------------

interface Allowance {
  /** 文件名，例如 "files.ts"，信封命中写 "prompt.ts"。 */
  file: string;
  /** 必须和 PLATFORM_TERMS 里的 label 完全一致。 */
  term: string;
  /** 为什么这条例外是审过的。 */
  why: string;
}

const ALLOW: readonly Allowance[] = [];

function allowed(file: string, term: string): boolean {
  return ALLOW.some((entry) => entry.file === file && entry.term === term);
}

// ---------------------------------------------------------------------------
// 每张卡属于哪个文件——报告里要能直接说「文件:卡片」。
// ---------------------------------------------------------------------------

const MODULES: readonly { file: string; tasks: readonly TaskDef[] }[] = [
  { file: "excel.ts", tasks: EXCEL_TASKS },
  { file: "sheet.ts", tasks: SHEET_TASKS },
  { file: "files.ts", tasks: FILE_TASKS },
  { file: "bymonth.ts", tasks: BY_MONTH_TASKS },
  { file: "document.ts", tasks: DOCUMENT_TASKS },
  { file: "worksummary.ts", tasks: WORK_SUMMARY_TASKS },
  { file: "summary.ts", tasks: SUMMARY_TASKS },
  { file: "check.ts", tasks: CHECK_TASKS },
  { file: "invoice.ts", tasks: INVOICE_TASKS },
  { file: "admin.ts", tasks: ADMIN_TASKS },
  { file: "vision.ts", tasks: VISION_TASKS },
  { file: "research.ts", tasks: RESEARCH_TASKS },
  { file: "wechat.ts", tasks: WECHAT_ALL_TASKS },
];

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

interface Hit {
  file: string;
  card: string;
  term: string;
  sentence: string;
  fix: string;
}

/** 和产品一致的一批示例文件：中性名字，避免把示例路径本身扫描成命中。 */
function sampleFiles(task: TaskDef): string[] {
  if (task.needs === "folder") return ["办公文件夹"];
  if (task.needs === "none" || task.needs === "text") return [];
  const ext = task.accept?.[0] ?? "txt";
  return [`办公文件夹/一.${ext}`, `办公文件夹/二.${ext}`];
}

/** 卡片在界面上给用户看的文字。 */
function cardText(task: TaskDef): string {
  return [
    task.title,
    task.example,
    ...task.plan,
    ...(task.risks ?? []),
    ...task.summaryHints,
  ].join("\n");
}

/** 公共信封的文案：安全规矩、文件清单、文件夹清单、核对提示、组装器。 */
function envelopeText(): string {
  const common = {
    what: "做一件事",
    how: ["先说明你打算怎么做，再动手"],
    instruction: "把这份东西按我要的样子弄好",
    done: "告诉我结果文件在哪里",
  };
  return [
    ...SAFETY_RULES,
    CHECK_NOTE_BLOCK,
    filesBlock([]),
    filesBlock(["办公文件夹/一.xlsx", "办公文件夹/二.pdf"]),
    folderBlock("办公文件夹"),
    userWordsBlock(common.instruction),
    safetyBlock(),
    safetyBlock("这个任务的补充规矩"),
    buildPrompt({ ...common, files: ["办公文件夹/一.xlsx"] }),
    buildPrompt({ ...common, folder: "办公文件夹" }),
  ].join("\n");
}

function snippet(text: string, index: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + 30);
  return `…${text.slice(start, end).replace(/\s+/g, " ").trim()}…`;
}

function scan(text: string): { term: PlatformTerm; sentence: string }[] {
  const out: { term: PlatformTerm; sentence: string }[] = [];
  for (const term of PLATFORM_TERMS) {
    const match = term.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    out.push({ term, sentence: snippet(text, match.index) });
  }
  return out;
}

/**
 * 全部命中。信封里的词只报一次（记在 prompt.ts:信封），不再让目录里每张卡
 * 都重复报同一条。
 */
function platformHits(options: { applyAllow?: boolean } = {}): Hit[] {
  const applyAllow = options.applyAllow !== false;
  const envelope = scan(envelopeText());
  const envelopeTerms = new Set(envelope.map((hit) => hit.term.label));

  const hits: Hit[] = [];
  const push = (hit: Hit) => {
    if (applyAllow && allowed(hit.file, hit.term)) return;
    hits.push(hit);
  };

  for (const { file, tasks } of MODULES) {
    for (const task of tasks) {
      const composed = task.prompt(sampleFiles(task), "把这份东西按我要的样子弄好");
      for (const hit of scan(`${composed}\n${cardText(task)}`)) {
        // 信封共有的词在信封那一条里报，避免刷屏。
        if (envelopeTerms.has(hit.term.label)) continue;
        push({
          file,
          card: task.id,
          term: hit.term.label,
          sentence: hit.sentence,
          fix: hit.term.fix,
        });
      }
    }
  }

  for (const hit of envelope) {
    push({
      file: "prompt.ts",
      card: "信封",
      term: hit.term.label,
      sentence: hit.sentence,
      fix: hit.term.fix,
    });
  }

  return hits;
}

/** 失败信息固定成「文件:卡片:「词」」，后面直接给改法。 */
function report(hits: readonly Hit[]): string {
  const lines = hits.map((hit) => `${hit.file}:${hit.card}:「${hit.term}」 in "${hit.sentence}"`);
  const fixes = [...new Set(hits.map((hit) => `  - 「${hit.term}」：${hit.fix}`))];
  return [
    "这些提示词/文案里有「只在一台电脑上成立」的说法（产品以 Windows 为先）：",
    ...lines,
    "",
    "应该改成：",
    ...fixes,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("跨平台守卫（Windows 优先）", () => {
  test("目录里每一张卡都在守卫的清单里（加新卡要来这里登记文件）", () => {
    const registered = MODULES.flatMap((module) => module.tasks.map((task) => task.id));
    expect(new Set(registered).size).toBe(registered.length);

    // 没登记的卡要**指名文件**：从 tasks/ 目录里自动找出"导出了 *_TASKS 的文件"，
    // 跟已登记的文件名比一比，这样失败信息直接告诉你该把哪一行加进 MODULES。
    const registeredFiles = new Set(MODULES.map((module) => module.file));
    const declaringFiles = readdirSync(TASKS_DIR)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      // index.ts 是 barrel（它只是把各族的数组拼成 TASKS），types.ts 只有类型。
      .filter((name) => name !== "index.ts" && name !== "types.ts" && name !== "prompt.ts")
      .filter((name) => /export const \w*_?TASKS\b/.test(readFileSync(join(TASKS_DIR, name), "utf8")));
    const unregistered = declaringFiles.filter((name) => !registeredFiles.has(name));

    const missing = TASKS.map((task) => task.id).filter((id) => !registered.includes(id));
    expect(
      { missing, unregistered },
      `这些卡还没登记进本文件的 MODULES（没有登记的卡不会被跨平台守卫扫到）：\n` +
        `  缺的卡：${missing.join("、") || "（无）"}\n` +
        `  该登记的文件：${unregistered.join("、") || "（无）"}`,
    ).toEqual({ missing: [], unregistered: [] });
  });

  test("任务卡与信封里没有只在一台电脑上成立的命令、路径或界面叫法", () => {
    const hits = platformHits();
    if (hits.length > 0) throw new Error(report(hits));
  });

  test("黑名单自己是有效的：每个词条都能命中自己的名字", () => {
    for (const term of PLATFORM_TERMS) {
      expect(term.pattern.test(term.label), `${term.label} 的正则匹配不到自己`).toBe(true);
      expect(term.fix.trim().length).toBeGreaterThan(8);
    }
  });

  test("白名单是审过的：每条都写了原因，也没有过期的条目", () => {
    const knownFiles = [...MODULES.map((module) => module.file), "prompt.ts"];
    for (const entry of ALLOW) {
      expect(PLATFORM_TERMS.some((term) => term.label === entry.term)).toBe(true);
      expect(entry.why.trim().length).toBeGreaterThan(10);
      expect(knownFiles).toContain(entry.file);
    }
    // 一条白名单如果已经不再命中任何东西，就该删掉，免得例外越来越多。
    const raw = platformHits({ applyAllow: false });
    const stale = ALLOW.filter(
      (entry) => !raw.some((hit) => hit.file === entry.file && hit.term === entry.term),
    );
    expect(
      stale.map((entry) => `${entry.file} 的「${entry.term}」`),
      "这些白名单条目已经用不上了，请删掉",
    ).toEqual([]);
  });

  test("代表性写法会被抓住：textutil / sips / open -a / /Users/ / 访达 都命中", () => {
    // 守卫本身别失灵：拿真机上出过的几个写法验一遍。
    const probe = [
      "用 textutil 把文字转成 Word",
      "sips -s format jpeg 图片.png",
      "open -a TextEdit 文件.txt",
      "结果放到 /Users/wang/Desktop",
      "在访达里找到这个文件",
    ].join("\n");
    const caught = new Set(scan(probe).map((hit) => hit.term.label));
    for (const label of ["textutil", "sips", "open -a", "/Users/", "访达"]) {
      expect(caught).toContain(label);
    }
  });

  test("跨平台的自带工具不算平台专有：cante-sheets / cante-pdf 不被误报", () => {
    const text = "读表用这台电脑自带的表格工具 cante-sheets；处理 PDF 用 cante-pdf。";
    expect(scan(text)).toEqual([]);
  });
});
