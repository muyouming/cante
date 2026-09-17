// 「关于」页的测试（#151）。
//
// 这一页要证明的核心只有一件事：**许可原文真的出现在渲染结果里**，而不只是列表
// 里有个名字。仓库没有 jsdom（理由写在 typography.test.ts 开头），所以这一页把
// 「真正塞进 DOM 的那段 HTML」做成了纯函数 noticesHtml()；这里直接断言那段字符串
// 里含每一份原文，而不是断言「数据里有原文」。界面接线（About.tsx 确实把
// noticesHtml() 交给 innerHTML）另有一条源码断言钉住，真实浏览器里的键盘操作由
// dom-smoke 那一路的证据覆盖（见本轮报告）。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeHtml, noticesHtml } from "./About.tsx";
import { ABOUT } from "./copy-about.ts";
import { NOTICES, NOTICE_SUMMARY, TEXTS } from "./third-party-notices.ts";

const HERE = import.meta.dir;

/**
 * 生成物里的数字是字面量类型（as const），toBe 会被推成「必须是 543」这种窄类型，
 * 所以先放宽成 number，再拿去和运行时算出来的数比。
 */
const SUMMARY: { packages: number; uniqueTexts: number; missingText: number } = NOTICE_SUMMARY;

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
  const html = noticesHtml();

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
    const rendered = noticesHtml(
      [{ name: "demo", version: "1.0.0", license: "MIT", textHash: "h" }],
      { h: "if (a < b) { return \"x & y\"; } </pre><script>bad()</script>" },
      { packages: 1, uniqueTexts: 1, missingText: 0 },
    );
    expect(rendered).toContain("a &lt; b");
    expect(rendered).toContain("x &amp; y");
    expect(rendered).not.toContain("</pre><script>");
    expect(rendered).toContain("&lt;/pre&gt;&lt;script&gt;");
  });

  test("空清单也有一句人话，不是一片空白", () => {
    const rendered = noticesHtml([], {}, { packages: 0, uniqueTexts: 0, missingText: 0 });
    expect(rendered).toContain(escapeHtml(ABOUT.empty));
  });
});

describe("接线与键盘：这一页真的接在界面上，而且键盘走得到", () => {
  const about = readFileSync(join(HERE, "About.tsx"), "utf8");
  const app = readFileSync(join(HERE, "..", "App.tsx"), "utf8");

  test("About.tsx 把 noticesHtml() 的结果交给 innerHTML（测试测的就是它）", () => {
    expect(about).toContain("innerHTML={noticesHtml()}");
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
  return noticesHtml();
}
