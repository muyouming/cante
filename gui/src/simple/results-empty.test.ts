// 一份结果都没有时，她看到什么。
//
// 这一面以前**没人验过**（WINDOWS-ACCEPTANCE-19.md §6：面板只在有历史运行时才有内容，
// 那台机器上本来就有）。可她是新用户：第一次点开「我做的结果」时里面一份都没有，
// 那正是她最需要一句人话 + 一个出路的时候。
//
// 这个文件只钉两件事，都来自那一屏的原始渲染（不是"看起来接好了"）：
//
//   1. 说清了「你还没做过东西」，而且**在卡片里**就有一个 44px 的出路（「去看看能
//      做什么」→ 开卡片库）。不能只靠右上角那个关闭键：它离这段话隔着一整个屏。
//   2. 那个出路**真的接到 onExplore 上**（不是复制错了 onClose）。这条特别要钉：
//      一个按钮画出来、名字也对，但点下去什么都不发生，是最难看出来的一种坏。
//
// 判据为什么这么定（照 results-names.test.ts 的路子）：
//   * 文案与"有没有那个 <button>"用**真的 SSR 渲染**证明，不看"意图"；
//   * "点下去干什么"文本扫描证明不了，只能扫源码里那个按钮的 onClick —— 这也是
//     try-first.test.ts 验「先看一眼点的是 dryRun 不是 confirmRun」用的同一条路。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";
import solidPlugin from "vite-plugin-solid";

import type { TaskRun } from "./run.ts";
import type { Store } from "../store.ts";
import { RESULTS } from "./copy-results.ts";

/** 用 babel-preset-solid 把 .tsx 编成 Solid 的服务端渲染代码。 */
const transformTsx = (() => {
  const pluginInstance = solidPlugin({ ssr: true, solid: { hydratable: false } }) as any;
  return async (path: string): Promise<string> => {
    const source = await Bun.file(path).text();
    const context = {
      environment: { config: { consumer: "server" } },
      error: (error: unknown): never => {
        throw error;
      },
      warn: (): void => {},
      addWatchFile: (): void => {},
      meta: {},
    };
    const result = await pluginInstance.transform.call(context, source, path, { ssr: true });
    if (!result || typeof result.code !== "string") {
      throw new Error(`vite-plugin-solid 没有把 ${path} 编出代码`);
    }
    return result.code;
  };
})();

plugin({
  name: "cante-results-empty-ssr",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformTsx(args.path),
      loader: "ts",
    }));
  },
});

/** 空态渲染用的 store：一条记录都没有，和真机上第一次打开时一模一样。 */
function stubStore(runs: TaskRun[]): Store {
  return {
    runs: () => runs,
    openPath: async () => {},
    revealPath: async () => {},
  } as unknown as Store;
}

/** 真的把面板渲染一遍（空 runs），返回它产出的 HTML。 */
async function renderEmpty(): Promise<string> {
  const { renderToString } = await import("solid-js/web");
  const { default: ResultsPanel } = await import("./ResultsPanel.tsx");
  const scope = globalThis as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  scope.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    const html = renderToString(() =>
      ResultsPanel({ store: stubStore([]), onClose: () => {}, onExplore: () => {} }),
    );
    // FocusLayer 关掉时把「把焦点还回去」排进一个微任务；等它跑完再撤 document。
    await new Promise((resolve) => setTimeout(resolve, 0));
    return html;
  } finally {
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

/** 面板源码：用来核对「点下去干什么」。 */
const PANEL = readFileSync(join(import.meta.dir, "ResultsPanel.tsx"), "utf8");

/** 第 index 个 <button> 的开标签（从 <button 到它自己的 >）。 */
function buttonTagAt(index: number): string {
  let from = 0;
  for (let i = 0; i <= index; i += 1) {
    const open = PANEL.indexOf("<button", from);
    if (open < 0) throw new Error(`源码里没有第 ${index + 1} 个 <button>`);
    from = open + 1;
    if (i === index) {
      const depth = (() => {
        // 找到这个开标签真正的 '>'：跳过 {...} 里的箭头函数与引号。
        let brace = 0;
        let quote: string | null = null;
        for (let j = open; j < PANEL.length; j += 1) {
          const ch = PANEL[j]!;
          if (quote) {
            if (ch === "\\") j += 1;
            else if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") quote = ch;
          else if (ch === "{") brace += 1;
          else if (ch === "}") brace = Math.max(0, brace - 1);
          else if (ch === ">" && brace === 0) return j;
        }
        return PANEL.length;
      })();
      return PANEL.slice(open, depth + 1);
    }
  }
  throw new Error("unreachable");
}

/** 空态那个出路的开标签：按它渲染出来的文案定位，而不是数下标。 */
function exploreButtonTag(): string {
  const buttons = [...PANEL.matchAll(/<button[\s\S]*?<\/button>/g)].map((m) => m[0]);
  const found = buttons.filter((block) => block.includes("RESULTS.empty.explore"));
  if (found.length !== 1) {
    throw new Error(`源码里应恰好有一个渲染 RESULTS.empty.explore 的按钮，实际 ${found.length} 个`);
  }
  return found[0]!;
}

describe("一份结果都没有时：她看到一句人话和一个能按的出路", () => {
  test("说清了「还没做过东西」，并在卡片里给出路", async () => {
    const html = await renderEmpty();
    // 说清了她现在的处境。
    expect(html).toContain(RESULTS.empty.title);
    expect(html).toContain(RESULTS.empty.body);
    // 出路是真的 <button>（不是只是看着像按钮的一段字），而且带着那句文案。
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
      (m[1] ?? "").replace(/<[^>]*>/g, "").trim(),
    );
    expect(buttons).toContain(RESULTS.empty.explore);
    // 空态里不渲染搜索框（搜索要有东西可搜才成立）。
    expect(html).not.toContain("cante-results-search");
  });

  test("出路点的是 onExplore（开卡片库），不是 onClose（只是关掉）", () => {
    const tag = exploreButtonTag();
    expect(tag).toContain("props.onExplore()");
    expect(tag).not.toContain("props.onClose()");
  });

  test("出路的按钮够高（>= 44px），她能按得中", () => {
    const tag = exploreButtonTag();
    const heights = [...tag.matchAll(/min-h-\[(\d*\.?\d+)px\]/g)].map((m) =>
      Number.parseFloat(m[1]!),
    );
    expect(heights.some((px) => px >= 44)).toBe(true);
  });

  test("首页把 onExplore 接上了：关掉结果、打开卡片库", () => {
    // 少了这根线，空态里的按钮就是死的（画得出来却什么都不发生）。
    const home = readFileSync(join(import.meta.dir, "Home.tsx"), "utf8");
    expect(home).toContain("onExplore={() => {");
    expect(home).toContain("setResultsOpen(false);");
    expect(home).toContain("setLibraryOpen(true);");
  });

  test("扫描器真的看到按钮：空态里也有可 Tab 的东西", () => {
    // 这条是防「测试自己瞎了」的烟雾报警器：上面几条都基于"能匹配到按钮"，
    // 如果解析器坏了，全都会静默变绿。
    expect(PANEL.match(/<button/g)?.length ?? 0).toBeGreaterThan(0);
    expect(buttonTagAt(0)).toContain("<button");
  });
});
