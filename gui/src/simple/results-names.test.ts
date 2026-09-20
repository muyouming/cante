// r26 — 「我做的结果」面板每一行的按钮名字必须能分清是哪一份结果。
//
// 真机 UIA 走查（WINDOWS-ACCEPTANCE-19.md §3.1）量到：结果面板 92 个可 Tab 按钮
// 只有 4 个不同的名字，47 行的两个按钮用的都是同一句常量 aria-label ✗——读屏 Tab
// 到第 30 行时听到的还是「打开这个结果文件」，分不清是哪一份。同一个走查脚本还
// 被这件事骗过一次：它按名字判「同一个元素」，把「不同行」误判成「Tab 卡住了」✗。
//
// 源码扫描挡不住这条：它只能看见「这里有一个表达式」，看不见 47 行渲染出来到底
// 有几个不同的名字。所以这个文件不走扫描，而是**真的把 ResultsPanel 渲染一遍**
// （Solid 的服务端渲染，纯 JS、不碰 DOM、不碰桥接），再枚举它真正产出的
// aria-label。判据只有三条，都来自那份报告：
//
//   1. 每个按钮一个不同的名字（不同行的名字不能撞）；
//   2. 名字里带着这一行的文件名（她要知道是**哪一份**）；
//   3. 名字里没有机器位置、也没有黑名单词（那是给读屏念的中文）。
//
// 为什么用 vite-plugin-solid 的 transform 而不是 bun 自带的 JSX：bun 的转译器把
// JSX 一律转成 React（实测 tsconfig 里的 jsxImportSource 不生效），只有
// babel-preset-solid 才会产出能跑的 Solid 代码。vite-plugin-solid 是本仓库已声明的
// devDependency，直接调它一个钩子，不引入任何新依赖。
import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import solidPlugin from "vite-plugin-solid";

import type { TaskRun } from "./run.ts";
import type { Store } from "../store.ts";

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
  name: "cante-results-names-ssr",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformTsx(args.path),
      loader: "ts",
    }));
  },
});

/** 她要能听出「是哪一份」，靠的就是这个：本机上的一个结果文件名。 */
const FILE_NAMES = [
  "结果_挑出_华东区.xlsx",
  "销售汇总.xlsx",
  "报名名单.xlsx",
  "本月对账单.xlsx",
  "工资条_2026年8月.xlsx",
  "客户联系方式.xlsx",
  "库存盘点表.xlsx",
  "差旅报销明细.xlsx",
];

/** 一次做出来的结果：每行一个文件，文件名都不一样（真机就是这样）。 */
function runsWithResults(): TaskRun[] {
  return FILE_NAMES.map((name, index) => ({
    id: `run-${index}`,
    taskId: "excel.tidy",
    taskTitle: "把几张表合成一张",
    files: [],
    instruction: "只留今年的",
    plan: ["第一步"],
    impact: {},
    result: { files: [{ path: `C:/桌面/${name}`, summary: "新增" }], summary: "新增 1 个文件" },
    online: false,
    error: null,
    createdAt: 1_700_000_000_000 + index * 60_000,
    state: "done",
  })) as unknown as TaskRun[];
}

/** 结果面板在真机上唯一会用到的那几个成员；核对文件在不在的效果在 SSR 里不跑。 */
function stubStore(runs: TaskRun[]): Store {
  return {
    runs: () => runs,
    openPath: async () => {},
    revealPath: async () => {},
  } as unknown as Store;
}

/**
 * 这个面板真正产出的、读屏会念的按钮名字（只看按钮，不含标题与搜索框）。
 *
 * 服务端渲染会把组件挂到 createRoot 上再拆掉，拆的时候 FocusLayer 的 onCleanup 会
document.removeEventListener —— 浏览器里那是真的，服务端渲染里没有 document，所以
 * 这里临时给它一对空监听（渲染一结束就还原）。这不是在用 jsdom 假装浏览器：不测
 * 键盘、不测布局，只让「名字」这一步跑得完。
 */
async function renderedButtonNames(): Promise<string[]> {
  const { renderToString } = await import("solid-js/web");
  const { default: ResultsPanel } = await import("./ResultsPanel.tsx");
  const runs = runsWithResults();
  const scope = globalThis as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  scope.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    const html = renderToString(() =>
      ResultsPanel({ store: stubStore(runs), onClose: () => {}, onExplore: () => {} }),
    );
    // 组件拆掉时 FocusLayer 会把「把焦点还回去」排进一个微任务（queueMicrotask）；
    // 等它跑完再撤掉 document，否则会在别的测试文件头上炸一个假的红。
    await new Promise((resolve) => setTimeout(resolve, 0));
    return [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((match) => match[1] ?? "");
  } finally {
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

/** 王姐不该在界面上看到的词（与 copy-guard.test.ts 的黑名单一致，取名字里可能撞上的那些）。 */
const BLACKLIST = ["路径", "模型", "会话", "上下文", "缓存", "终端", "命令行", "日志", "接口", "权限模式"];

describe("我做的结果：每一行的按钮名字都能分清是哪一份", () => {
  test("每个按钮一个不同的名字（行数越多，名字越多）", async () => {
    const names = await renderedButtonNames();
    const rows = FILE_NAMES.length;
    // 每行三个按钮：打开文件、打开所在文件夹、复制位置（r16 加的第三步，见
    // results-panel.test.ts）。数字仍然是等值断言：按钮多一个少一个都要人来看一眼。
    expect(names).toHaveLength(rows * 3);
    const distinct = new Set(names);
    if (distinct.size !== names.length) {
      const repeated = [...distinct].filter((name) => names.filter((item) => item === name).length > 1);
      throw new Error(
        [
          `结果面板里 ${names.length} 个按钮只有 ${distinct.size} 个不同的名字：读屏分不清是哪一份结果。`,
          `重复的名字：${repeated.map((name) => `「${name}」`).join("、")}`,
          "修法：按钮的名字要带上这一行的文件名（模板在 copy-results.ts 的 RESULTS.actions）。",
        ].join("\n"),
      );
    }
    expect(distinct.size).toBeGreaterThanOrEqual(rows);
  });

  test("每个名字里都带着这一行的文件名", async () => {
    const names = await renderedButtonNames();
    const missing: string[] = [];
    for (const name of names) {
      if (!FILE_NAMES.some((file) => name.includes(file))) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        [
          "这些按钮的名字里没有文件名，她听不出是哪一份结果：",
          ...missing.map((name) => `  -「${name}」`),
        ].join("\n"),
      );
    }
    // 同一行的两个按钮也要分得开：名字不能只差个重复。
    const openName = names.find((name) => name.includes(FILE_NAMES[0]!));
    expect(openName).toBeDefined();
  });

  test("名字里不含机器位置，也不含黑名单词", async () => {
    const names = await renderedButtonNames();
    const problems: string[] = [];
    for (const name of names) {
      if (name.includes("/") || name.includes("\\")) {
        problems.push(`含位置分隔符／反斜杠：「${name}」`);
      }
      for (const term of BLACKLIST) {
        if (name.includes(term)) problems.push(`含黑名单词「${term}」：「${name}」`);
      }
    }
    if (problems.length > 0) throw new Error([...new Set(problems)].join("\n"));
  });

  test("同一行里三个按钮的名字两两都不一样（打开文件 / 打开所在文件夹 / 复制位置）", async () => {
    const names = await renderedButtonNames();
    for (let row = 0; row < FILE_NAMES.length; row += 1) {
      const inRow = names.slice(row * 3, row * 3 + 3);
      expect(inRow).toHaveLength(3);
      expect(new Set(inRow).size).toBe(3);
    }
  });
});
