// r30 — 「我做的结果」按时间分组后，分组的标题必须是**真的标题**。
//
// 需求 #4：读屏要能靠标题一组一组跳过去。源码扫描只能看见「这里有个 heading
// 表达式」，证明不了渲染出来到底是 <h3> 还是一个只是看起来大的 <p>。所以这里
// 像 results-names.test.ts 一样，真的把 ResultsPanel 渲染一遍（Solid 的服务端渲染，
// 纯 JS、不碰 DOM、不碰桥接），再枚举它真正产出的标题标签。
//
// 判据：
//   1. 今天 / 这周 / 更早各是一个真的 <h3>（不是 <p> + 大字）；
//   2. 标题的顺序与文案和 copy-results.ts 一致；
//   3. 空的那一组不出现标题（没做过的时段不要凭空多一个标题让读屏跳空）。
//
// 时间用 setSystemTime 钉死，免得测试在「今天」这天跑和「明天」跑结果不一样。
import { afterEach, describe, expect, test } from "bun:test";
import { setSystemTime } from "bun:test";
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
  name: "cante-results-groups-ssr",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformTsx(args.path),
      loader: "ts",
    }));
  },
});

function local(month: number, day: number, hour = 0): number {
  return new Date(2026, month - 1, day, hour).getTime();
}

function runAt(createdAt: number, name: string): TaskRun {
  return {
    id: `run-${name}`,
    taskId: "excel.merge",
    taskTitle: "把几张表合成一张",
    files: [],
    instruction: "",
    state: "done",
    plan: ["第一步"],
    impact: {},
    result: { files: [{ path: `C:/桌面/${name}`, summary: "新增" }], summary: "新增 1 个文件" },
    online: false,
    error: null,
    createdAt,
  } as unknown as TaskRun;
}

function stubStore(runs: TaskRun[]): Store {
  return {
    runs: () => runs,
    openPath: async () => {},
    revealPath: async () => {},
  } as unknown as Store;
}

/** 渲染面板，返回它真正产出的标题：{ level, text }。 */
async function renderedHeadings(runs: TaskRun[]): Promise<Array<{ level: number; text: string }>> {
  const { renderToString } = await import("solid-js/web");
  const { default: ResultsPanel } = await import("./ResultsPanel.tsx");
  const scope = globalThis as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  scope.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    const html = renderToString(() => ResultsPanel({ store: stubStore(runs), onClose: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) => ({
      level: Number(match[1]),
      text: (match[2] ?? "").replace(/<[^>]*>/g, "").trim(),
    }));
  } finally {
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

afterEach(() => setSystemTime());

describe("我做的结果：按时间分组的标题是真的标题", () => {
  test("今天 / 这周 / 更早各是一个真的三级标题，顺序和文案都对", async () => {
    // 2026-09-16 星期三；本周一 = 09-14。
    setSystemTime(new Date(local(9, 16, 12)));
    const headings = await renderedHeadings([
      runAt(local(9, 16, 9), "今天.xlsx"),
      runAt(local(9, 15, 9), "这周.xlsx"),
      runAt(local(9, 1, 9), "更早.xlsx"),
    ]);
    const groupHeadings = headings.filter((heading) =>
      [RESULTS.group.today, RESULTS.group.week, RESULTS.group.earlier].includes(heading.text as never),
    );
    expect(groupHeadings).toEqual([
      { level: 3, text: RESULTS.group.today },
      { level: 3, text: RESULTS.group.week },
      { level: 3, text: RESULTS.group.earlier },
    ]);
  });

  test("空的那一组不出现标题", async () => {
    setSystemTime(new Date(local(9, 16, 12)));
    const headings = await renderedHeadings([runAt(local(9, 16, 9), "今天.xlsx")]);
    const texts = headings.map((heading) => heading.text);
    expect(texts).toContain(RESULTS.group.today);
    expect(texts).not.toContain(RESULTS.group.week);
    expect(texts).not.toContain(RESULTS.group.earlier);
  });
});
