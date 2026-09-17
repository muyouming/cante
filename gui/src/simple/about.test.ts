// 「关于」页的测试（#151）。
//
// 这一页要证明的核心只有两件事：
//
//   1. **许可原文真的出现在渲染结果里**，而不只是列表里有个名字。仓库没有 jsdom
//      （理由写在 typography.test.ts 开头），所以这一页把「真正塞进 DOM 的那段 HTML」
//      做成了纯函数 noticesHtml(data)；这里直接断言那段字符串里含每一份原文。
//   2. **原文是点开「关于」才取的**（#157）：主包里不许再静态 import 它，取回来的
//      路必须经过 loadNotices() 这个真的会 import() 的函数。这里既做源码断言，也
//      真的调一次 loadNotices() 看它拿回来的东西对不对。
//
// 真实浏览器里「点开 → 原文出现」那一路由本轮报告里的 CDP 验收覆盖（Chrome 真点
// 真读），因为 bun test 没有 DOM。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createNoticesState, escapeHtml, loadNotices, noticesHtml, type NoticeData } from "./About.tsx";
import { ABOUT } from "./copy-about.ts";
import { NOTICES, NOTICE_SUMMARY, TEXTS } from "./third-party-notices.ts";

const HERE = import.meta.dir;

/**
 * 生成物里的数字是字面量类型（as const），toBe 会被推成「必须是 543」这种窄类型，
 * 所以先放宽成 number，再拿去和运行时算出来的数比。
 */
const SUMMARY: { packages: number; uniqueTexts: number; missingText: number } = NOTICE_SUMMARY;

/** 这一页要的那三样东西，直接从生成物里取（生成物本身另有上面的测试在管）。 */
const DATA: NoticeData = { notices: NOTICES, texts: TEXTS, summary: SUMMARY };

/** 每一项都有原文的条目（生成物里大部分是这种）。 */
const withText = NOTICES.filter((notice) => notice.textHash !== null);
const missing = NOTICES.filter((notice) => notice.textHash === null);

describe("许可数据：条目与原文对得上", () => {
  test("条目不是空的，而且确实是一个依赖树该有的规模", () => {
    expect(NOTICES.length).toBeGreaterThan(100);
    expect(withText.length).toBeGreaterThan(100);
  });

  test("每个有条目的包都能在 TEXTS 里找到一份非空原文", () => {
    const broken = withText.filter((notice) => {
      const text = notice.textHash === null ? undefined : TEXTS[notice.textHash];
      return typeof text !== "string" || text.trim().length === 0;
    });
    expect(broken.map((notice) => notice.name)).toEqual([]);
  });

  test("摘要的数字与条目对得上（不写死，跟着生成物走）", () => {
    expect(SUMMARY.packages).toBe(NOTICES.length);
    expect(SUMMARY.missingText).toBe(missing.length);
    const used = new Set(withText.map((notice) => notice.textHash));
    expect(used.size).toBe(SUMMARY.uniqueTexts);
    expect(Object.keys(TEXTS).length).toBe(SUMMARY.uniqueTexts);
  });

  test("原文确实去过重：不同文本的份数远少于条目数", () => {
    expect(SUMMARY.uniqueTexts).toBeLessThan(SUMMARY.packages);
    expect(SUMMARY.uniqueTexts).toBeGreaterThan(1);
  });

  test("没附带原文的包被如实标出来，没有被编上一份", () => {
    // 生成物允许有这种包（例如发布时没把 LICENSE 打进包里的 crate），但不许给它们
    // 编一个 textHash。这里确认它们真的就是 null，而且数量被数进了摘要。
    for (const notice of missing) expect(notice.textHash).toBeNull();
    expect(SUMMARY.missingText).toBe(missing.length);
  });
});

describe("渲染结果里真的有许可原文（不只是名字）", () => {
  const html = noticesHtml(DATA);

  test("一段可核对的原文逐字出现在渲染结果里", () => {
    // 挑一份 MIT 原文：这句话是 MIT 的正文，任何一份 MIT 都该有它。
    const mitHash = withText.find(
      (notice) =>
        notice.textHash !== null &&
        TEXTS[notice.textHash]!.includes("Permission is hereby granted, free of charge"),
    )?.textHash;
    expect(mitHash).toBeTruthy();
    const text = TEXTS[mitHash!]!;
    expect(html).toContain(escapeHtml(text));
    expect(html).toContain("Permission is hereby granted, free of charge");
  });

  test("每一条正文都在，而不是只渲染了名字", () => {
    // 数一下渲染出来的块数：有条目的都该有一个折叠块，没附带的都该有一句标记。
    // 只数名字会漏掉「列表很长、正文全空」这种假绿。
    const folds = html.split(ABOUT.showText).length - 1;
    const marks = html.split(ABOUT.missingText).length - 1;
    expect(folds).toBe(withText.length);
    expect(marks).toBe(missing.length);
    // 正文把体积撑起来了：一段只有名字的清单长不成这么大。
    expect(html.length).toBeGreaterThan(500_000);
  });

  test("名字也在（她/法务同事能对着清单核）", () => {
    const sample = NOTICES[0]!;
    expect(html).toContain(escapeHtml(sample.name));
    expect(html).toContain(escapeHtml(sample.version));
  });

  test("原文里的尖括号会被转义，不会把页面搞坏", () => {
    const rendered = noticesHtml({
      notices: [{ name: "demo", version: "1.0.0", license: "MIT", textHash: "h" }],
      texts: { h: "if (a < b) { return \"x & y\"; } </pre><script>bad()</script>" },
      summary: { packages: 1, uniqueTexts: 1, missingText: 0 },
    });
    expect(rendered).toContain("a &lt; b");
    expect(rendered).toContain("x &amp; y");
    expect(rendered).not.toContain("</pre><script>");
    expect(rendered).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  test("空清单也有一句人话，不是一片空白", () => {
    const rendered = noticesHtml({ notices: [], texts: {}, summary: { packages: 0, uniqueTexts: 0, missingText: 0 } });
    expect(rendered).toContain(escapeHtml(ABOUT.empty));
  });
});

describe("接线与键盘：这一页真的接在界面上，而且键盘走得到", () => {
  const about = readFileSync(join(HERE, "About.tsx"), "utf8");
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");

  test("About.tsx 把 noticesHtml() 的结果交给 innerHTML（测试测的就是它）", () => {
    expect(about).toContain("innerHTML={noticesHtml(data())}");
  });

  test("App.tsx 里有「关于」入口，而且是那个自包含的组件", () => {
    expect(app).toContain("import AboutEntry from \"./simple/About.tsx\"");
    expect(app).toContain("<AboutEntry />");
  });

  test("入口是按钮、够大、键盘可达（>= 44px）", () => {
    expect(about).toContain('class="min-h-[44px] rounded-lg px-3 text-[16px]');
    expect(about).toContain('class="mb-3 min-h-[44px] self-start rounded-lg pr-3 text-[16px]');
  });

  test("整页是一个焦点层：Tab 进得来、Esc 关得掉，焦点不自己发明", () => {
    expect(about).toContain("useFocusLayer({ open, onEscape: () => setOpen(false) })");
    expect(about).toContain("ref={layer}");
    expect(about).toContain('role="dialog"');
  });

  test("「查看许可原文」是原生折叠，并写 tabindex=0 让焦点层认它", () => {
    // FocusLayer 的焦点名单只认 button / a[href] / input / [tabindex] 这几类，
    // 不认 summary 这个标签名；所以 summary 必须显式带 tabindex="0"，
    // 否则键盘根本走不到「展开原文」。
    expect(html2().match(/<summary tabindex="0"/g)?.length).toBe(withText.length);
    expect(about).toContain('summary tabindex="0"');
  });

  test("标题与正文的字号不缩水（>= 20px / >= 16px）", () => {
    expect(about).toContain("text-[24px]");
    expect(about).not.toMatch(/text-xs|text-sm|text-\[1[0-5]px\]/);
  });
});

/** 渲染一次给键盘那条用（避免顶层再算一遍巨大字符串）。 */
function html2(): string {
  return noticesHtml(DATA);
}

describe("原文是点开「关于」才取的（#157）", () => {
  const about = readFileSync(join(HERE, "About.tsx"), "utf8");

  /** 逐行的 import 说明符；`import type` 单独标出（它编译后不存在）。 */
  function importSpecifiers(source: string): { spec: string; typeOnly: boolean }[] {
    const out: { spec: string; typeOnly: boolean }[] = [];
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      const match = /^import\s+.*?from\s+"([^"]+)"/.exec(trimmed);
      if (!match) continue;
      out.push({ spec: match[1] ?? "", typeOnly: /^import\s+type\b/.test(trimmed) });
    }
    return out;
  }

  test("生产代码里没有静态 import 那段原文（只许出现在 import type 里）", () => {
    const valueImports = importSpecifiers(about)
      .filter((entry) => !entry.typeOnly)
      .map((entry) => entry.spec);
    expect(valueImports).not.toContain("./third-party-notices.ts");
  });

  test("取它的唯一一条路是 loadNotices() 里的动态 import()", () => {
    expect(about.match(/import\("\.\/third-party-notices\.ts"\)/g)?.length).toBe(1);
  });

  test("loadNotices() 真的能把原文取回来（不是只写了文件名）", async () => {
    const data = await loadNotices();
    expect(data.notices.length).toBe(NOTICES.length);
    expect(Object.keys(data.texts).length).toBe(SUMMARY.uniqueTexts);
    expect(data.summary.packages).toBe(SUMMARY.packages);
    // 取回来的原文真的能渲染出一整页，而不是一个空壳。
    expect(noticesHtml(data)).toContain("Permission is hereby granted, free of charge");
  });

  test("只有打开时才 begin()；入口按钮自己不会提前把原文取进来", () => {
    expect(about).toContain("notices.begin()");
    expect(about).toContain("onClick={openAbout}");
  });

  test("等的时候有一句她看得懂的中文，不是空白也不是英文", () => {
    expect(ABOUT.loading).toMatch(/^[\u3400-\u9fff，。、「」？！…—]+$/);
    expect(ABOUT.loading.length).toBeGreaterThan(4);
  });

  test("失败的那句话也全中文，而且给了可以照做的一步", () => {
    // 「Cante」是软件自己的名字，允许出现；除它以外不许有英文。
    expect(ABOUT.loadFailed.replace(/Cante/g, "").replace(/\s+/g, "")).toMatch(/^[\u3400-\u9fff，。、「」？！…—]+$/);
    expect(ABOUT.loadFailed).toContain("重新打开");
  });
});

describe("取不回来时给她一条出路（产品律 3）", () => {
  const about = readFileSync(join(HERE, "About.tsx"), "utf8");

  test("失败会走到 failed，并给出一句她能照做的话", async () => {
    const machine = createNoticesState(() => Promise.reject(new Error("boom")));
    expect(machine.state().kind).toBe("loading");
    machine.begin();
    await flush();
    expect(machine.state().kind).toBe("failed");
    // 出路必须写得出来：不是只告诉她失败了，而是告诉她可以怎么做。
    expect(ABOUT.loadFailed).toContain("关掉再重新打开");
  });

  test("组件画的是那句话（失败文案真的接在界面上）", () => {
    expect(about).toContain("{ABOUT.loadFailed}");
  });

  test("不提供页内重试：同一页重取那个分块是注定失败的", () => {
    // 真机验过（本轮报告有原始输出）：失败的动态 import 被浏览器记在模块表里，
    // 同一页里再 import 同一个说明符仍然报一样的错；只有换一个地址（或者整页
    // 重新加载）才行。所以这里不画一个按不响的按钮（产品律 1）。
    expect(about).not.toContain("ABOUT.retry");
    // 界面上只有两个 button：入口 + 「返回」。失败态不是一个按钮。
    expect((about.match(/<button/g) ?? []).length).toBe(2);
  });

  test("取法同步抛错也算失败，不会把她永远卡在「正在打开」", async () => {
    const machine = createNoticesState(() => {
      throw new Error("sync boom");
    });
    machine.begin();
    await flush();
    expect(machine.state().kind).toBe("failed");
  });

  test("关掉再打开会真的再取一次；晚回来的旧结果不许盖掉新一次的结果", async () => {
    let releaseFirst: (() => void) | null = null;
    const slowFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const loader = () => {
      calls += 1;
      if (calls === 1) {
        return slowFirst.then(() => ({
          notices: [] as const,
          texts: {},
          summary: { packages: 0, uniqueTexts: 0, missingText: 0 },
        }));
      }
      return Promise.resolve(DATA);
    };
    const machine = createNoticesState(loader);
    machine.begin(); // 第一次（慢）
    machine.begin(); // 关掉又打开（快）
    await flush();
    expect(machine.state().kind).toBe("ready");
    releaseFirst!(); // 旧的现在才回来
    await flush();
    const state = machine.state();
    expect(state.kind).toBe("ready");
    // 仍然是新的那一份：旧的空清单没有把页面盖成空的。
    if (state.kind === "ready") expect(state.data.notices.length).toBe(NOTICES.length);
    expect(calls).toBe(2);
  });
});

/** 让已排好的微任务跑完（状态机只依赖微任务，不用等计时器）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
