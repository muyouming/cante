// r16 — 「我做的结果」面板里也要能一步复制位置。
//
// 真机挖出来的缺口（WINDOWS-ACCEPTANCE-7.md §3.2/§4 那一手证据，别重测）：面板里
// 每一行只有两个按钮 ——「打开 X.xlsx」「打开 X.xlsx 所在的文件夹」✗，`copyLocation`
// 在 ResultsPanel.tsx 里出现 0 次 ✓。可她的真实动线是**事后**从结果面板找文件、
// 再把位置告诉人 ——「上次的结果在哪」比「刚做完的在哪」更需要能把位置交出去。
//
// 这份文件钉五件事，都对着上面那份真机证据：
//
//   1. 面板每一行真的有一个「复制位置」按钮，读屏的名字里带着文件名（分得清是哪一份）；
//   2. 复制走的是**同一个转换**（copy-results.ts 的 pathForClipboard），面板里没有
//      另写一份（同字才算一个东西）；
//   3. 成功/失败是**同一句话**——和结果卡片那条同字，全仓库只有 copy-results.ts 里
//      有这两句字面量，谁在别处复制一份就红；
//   4. 原有按钮一个不少（打开文件 / 打开所在文件夹 / 一次复制成微信能贴的文字），
//      行为不变；
//   5. 复制不是发送：这条路上没有任何微信「发送」的写法。
//
// 为什么「点下去剪贴板里是什么」是源码接线检查 + 纯函数，而不是真的点一下：本仓库
// 没有 jsdom（理由写在 typography.test.ts 的开头），而这里要证的恰恰是「生产路径上
// 真的把**这一行的完整位置**交给剪贴板」——那正是卡片提示词那个 P0 的形态（写好了
// 没人用 ✗）。所以钉的是那条调用本身 `copyText(pathForClipboard(entry.path))`
// （#283 在 ResultCard 上用过的同一套写法），再加上纯函数对「完整路径 + 反斜杠」的
// 断言。真机上「按下去、粘出来」由 Windows 验收那一轮跑：本仓库的 dom-smoke 在纯
// 浏览器里没有结果数据，量不到这一行（如实写在这里，不假装它量过）。
import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import solidPlugin from "vite-plugin-solid";

import { pathForClipboard, RESULTS } from "./copy-results.ts";
import { BATCH } from "./copy-batch.ts";
import type { TaskRun } from "./run.ts";
import type { Store } from "../store.ts";

const HERE = import.meta.dir;
const PANEL = readFileSync(join(HERE, "ResultsPanel.tsx"), "utf8");
const CARD = readFileSync(join(HERE, "ResultCard.tsx"), "utf8");

/** 用 babel-preset-solid 把 .tsx 编成 Solid 的服务端渲染代码（与 results-names 同一套）。 */
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
  name: "cante-results-panel-ssr",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformTsx(args.path),
      loader: "ts",
    }));
  },
});

/**
 * 真机会给的那一串位置：盘符开头、中文文件夹、中文+空格的文件名、扩展名收尾
 * （和 path-for-her.test.ts 用的是同一种形状；用户名是文档占位写法）。
 */
const WINDOW_PATHS = [
  "C:/Users/用户名/桌面/Cante路径验收/结果_挑出华东区.xlsx",
  "C:/Users/用户名/Documents/销售汇总.xlsx",
  "D:/微信下载/报名名单.xlsx",
];
const NAMES = WINDOW_PATHS.map((path) => path.split("/").pop()!);

/** 三份结果，每份一个文件名都不一样（真机就是这样）。 */
function runs(): TaskRun[] {
  return WINDOW_PATHS.map((path, index) => ({
    id: `run-${index}`,
    taskId: "excel.tidy",
    taskTitle: "从大表里挑出想要的行",
    files: [],
    instruction: "把华东区的挑出来",
    plan: ["第一步"],
    impact: { created: 1, modified: 0, deleted: 0, messages: 0 },
    result: { files: [{ path, summary: "新增 · 5.5 KB" }], summary: "新增 1 个文件" },
    online: false,
    error: null,
    createdAt: 1_700_000_000_000 + index * 60_000,
    state: "done",
  })) as unknown as TaskRun[];
}

/** 结果面板在真机上唯一会用到的那几个成员；核对文件在不在的效果在 SSR 里不跑。 */
function stubStore(list: TaskRun[]): Store {
  return {
    runs: () => list,
    openPath: async () => {},
    revealPath: async () => {},
  } as unknown as Store;
}

/** 面板真正产出的 HTML（真的渲染一遍，不看「意图」）。 */
async function renderedPanel(): Promise<string> {
  const { renderToString } = await import("solid-js/web");
  const { default: ResultsPanel } = await import("./ResultsPanel.tsx");
  const scope = globalThis as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  // 服务端渲染没有 document；FocusLayer 拆组件时会 removeEventListener，
  // 临时给一对空的（渲染一结束就还原）。不是在用 jsdom 假装浏览器。
  scope.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    const html = renderToString(() =>
      ResultsPanel({ store: stubStore(runs()), onClose: () => {}, onExplore: () => {} }),
    );
    // 组件拆掉时 FocusLayer 把「还焦点」排进一个微任务（queueMicrotask）；
    // 等它跑完再撤掉 document，否则会在别的测试文件头上炸一个假的红。
    await new Promise((resolve) => setTimeout(resolve, 0));
    return html;
  } finally {
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

/** 渲染结果里所有按钮的 aria-label。 */
function labelsOf(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** 渲染结果里所有按钮的可见文字（去掉标签，只留字）。 */
function textsOf(html: string): string[] {
  return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((match) =>
    (match[1] ?? "").replace(/<[^>]*>/g, "").trim(),
  );
}

/** 渲染结果里渲染了 RESULTS.actions.copyLocation 的那个按钮的开标签。 */
function copyButtonTag(html: string): string {
  const found = [...html.matchAll(/<button[\s\S]*?<\/button>/g)]
    .map((match) => match[0])
    .filter((block) => block.includes(RESULTS.actions.copyLocation));
  if (found.length !== NAMES.length) {
    throw new Error(
      `应该每一行都有一个渲染「${RESULTS.actions.copyLocation}」的按钮，实际 ${found.length} 个（${NAMES.length} 行）`,
    );
  }
  return found[0]!;
}

/** 只有 copy-results.ts 该有的那两句字面量：出现在别处就是分叉了一份文案。 */
const COPY_SENTENCES = [RESULTS.actions.copied, RESULTS.actions.copyFailed];

/** gui/src 下所有 .ts/.tsx（含测试：测试里内联这两句也同样是分叉）。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("面板每一行都有「复制位置」，读屏分得清是哪一份", () => {
  test("每一行一个按钮，可见文字就是那句常量", async () => {
    const html = await renderedPanel();
    const texts = textsOf(html);
    const visible = texts.filter((text) => text === RESULTS.actions.copyLocation);
    expect(visible).toHaveLength(NAMES.length);
  });

  test("按钮的名字里带着这一行的文件名（不是所有行共用一句常量）", async () => {
    const html = await renderedPanel();
    const labels = labelsOf(html);
    for (const name of NAMES) {
      expect(labels).toContain(RESULTS.actions.ariaCopyLocation(name));
    }
    // 名字里不带机器位置（那是给读屏念的中文：她只需要听出是哪一份）。
    for (const name of NAMES) {
      const label = RESULTS.actions.ariaCopyLocation(name);
      expect(label).not.toContain("/");
      expect(label).not.toContain("\\");
      expect(label).not.toContain("路径");
    }
  });

  test("按钮够高（>=44px）、字够大（>=16px），她按得中、也看得清", async () => {
    const tag = copyButtonTag(await renderedPanel());
    const heights = [...tag.matchAll(/min-h-\[(\d*\.?\d+)px\]/g)].map((m) =>
      Number.parseFloat(m[1]!),
    );
    expect(heights.some((px) => px >= 44)).toBe(true);
    const sizes = [...tag.matchAll(/text-\[(\d*\.?\d+)px\]/g)].map((m) => Number.parseFloat(m[1]!));
    expect(sizes.some((px) => px >= 16)).toBe(true);
  });
});

describe("点它 → 剪贴板拿到的是反斜杠完整路径（照 #283 的接线检查写法）", () => {
  test("面板真的把「这一行的完整位置」交给那个转换，再交给剪贴板", () => {
    // 这一条就是判据本身：不是「面板里有个复制按钮」，而是生产路径上真的调用
    // copyText(pathForClipboard(entry.path))。少一个都红。
    expect(PANEL).toContain("copyText(pathForClipboard(entry.path))");
  });

  test("转换是从 copy-results.ts 借的，不是面板里另写的一份", () => {
    expect(PANEL).toMatch(/import \{[^}]*pathForClipboard[^}]*\} from "\.\/copy-results\.ts"/);
    // 另写一份的第一标志：自己定义同名函数，或者自己写那段替换。
    expect(PANEL).not.toContain("function pathForClipboard");
    expect(PANEL).not.toContain("replace(/[/\\\\]+/g");
    expect(PANEL).not.toContain("[A-Za-z]:[/\\\\]");
  });

  test("同一串位置，粘出来是 Windows 习惯的反斜杠，而且一个字都不少", () => {
    const copied = pathForClipboard(WINDOW_PATHS[0]!);
    expect(copied.startsWith("C:")).toBe(true);
    expect(copied.endsWith(".xlsx")).toBe(true);
    expect(copied).toContain(NAMES[0]!);
    expect(copied).not.toContain("/");
    expect(copied).toBe("C:\\Users\\用户名\\桌面\\Cante路径验收\\结果_挑出华东区.xlsx");
    // 两种分隔符在程序里指同一个东西：归一之后逐字相同（不是被截断的那一截）。
    expect(copied.replace(/\\/g, "/")).toBe(WINDOW_PATHS[0]!);
  });

  test("三行各自复制各自的位置（不是恒等于第一行）", () => {
    const copied = WINDOW_PATHS.map((path) => pathForClipboard(path));
    expect(new Set(copied).size).toBe(WINDOW_PATHS.length);
    for (const [index, text] of copied.entries()) {
      expect(text).toBe(WINDOW_PATHS[index]!.replace(/\//g, "\\"));
    }
  });
});

describe("成功/失败跟结果卡片那条是同一句（不许分叉）", () => {
  test("两句话的字面量全仓库只有 copy-results.ts 有", () => {
    const holders: string[] = [];
    for (const path of sourceFiles(join(HERE, ".."))) {
      const text = readFileSync(path, "utf8");
      if (COPY_SENTENCES.some((sentence) => text.includes(sentence))) {
        // 分隔符归一，免得在 Windows 上跑出反斜杠路径而白红一次。
        holders.push(relative(join(HERE, ".."), path).replace(/\\/g, "/"));
      }
    }
    expect(holders).toEqual(["simple/copy-results.ts"]);
  });

  test("面板和结果卡片引用的是同两个常量（不是各写一句像的话）", () => {
    for (const source of [PANEL, CARD]) {
      expect(source).toContain("RESULTS.actions.copied");
      expect(source).toContain("RESULTS.actions.copyFailed");
      expect(source).toContain("RESULTS.actions.copyLocation");
      expect(source).toContain("pathForClipboard");
    }
  });

  test("面板真的按复制结果去取那两句（接线没断）", () => {
    expect(PANEL).toContain("copied ? RESULTS.actions.copied : RESULTS.actions.copyFailed");
  });
});

describe("原有按钮一个不少，行为不变", () => {
  test("打开文件 / 打开所在文件夹 / 一次复制成微信能贴的文字 都还在", async () => {
    const html = await renderedPanel();
    const labels = labelsOf(html);
    const texts = textsOf(html);
    for (const name of NAMES) {
      expect(labels).toContain(RESULTS.actions.ariaOpen(name));
      expect(labels).toContain(RESULTS.actions.ariaOpenFolder(name));
    }
    expect(texts.filter((text) => text === RESULTS.actions.open)).toHaveLength(NAMES.length);
    expect(texts.filter((text) => text === RESULTS.actions.openFolder)).toHaveLength(NAMES.length);
    expect(texts).toContain(BATCH.copyButton);
  });

  test("那两个动作仍然按完整位置走（接线一个字没动）", () => {
    expect(PANEL).toContain("props.store.openPath(entry.path)");
    expect(PANEL).toContain("props.store.revealPath(entry.path)");
    expect(PANEL).toContain("disabled={!canOpen(entry)}");
  });

  test("一次复制成微信能贴的文字仍然走真读路径（没被这次改动碰掉）", () => {
    expect(PANEL).toContain('"read_result_sheet"');
    expect(PANEL).toContain("batchChatText(");
  });
});

describe("复制不是发送：这条路上没有发送动作", () => {
  test("面板里没有任何调用微信发送的写法", () => {
    for (const banned of [
      "sendWechat",
      "sendToWechat",
      "wxSend",
      "发送到微信",
      "发到微信",
      "微信发送",
    ]) {
      expect(PANEL).not.toContain(banned);
    }
  });

  test("复制只落到剪贴板：那两句常量说的都是「复制」，不是「发送」", () => {
    expect(RESULTS.actions.copyLocation).toContain("复制");
    expect(RESULTS.actions.copied).toContain("复制");
    expect(RESULTS.actions.copied).toContain("粘");
    expect(RESULTS.actions.copyFailed).toContain("复制");
  });
});
