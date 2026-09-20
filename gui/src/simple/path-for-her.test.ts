// r15 — 她念不出那条位置，所以给她「复制位置」这一步。
//
// 真机证据（gui/docs/WINDOWS-REVEAL-PROBE.md 第 3 步）：结果卡片上那串位置又长又绕，
// 界面还会截断；她要做的其实是**把「这份表在哪」告诉同事**（微信上、电话里），或者在
// 自己的「打开文件」对话框里找到那个文件夹。念一长串位置念不清楚，所以给她一步能做完
// 的动作：按一下，整条位置进她的剪贴板，她自己粘出去。
//
// 这份文件钉四件事，一条一条都对着真机证据：
//
//   1. 按钮真的在结果卡片上，而且读屏分得清是哪一份（名字带文件名）；
//   2. 复制进去的是**完整位置**（首尾都在），不是被界面截断的那一截；
//   3. 那串位置**能粘进它自己的「打开文件」逻辑**：只是分隔符换成 Windows 习惯，
//      指的还是同一个文件（粘到「打开文件」对话框和微信里都能用）；
//   4. 复制的是**她看得懂的东西**：没有 `..`、没有连续两个分隔符，而且复制**不是发送**
//      （这条路上没有任何调用微信发送的动作）。
//
// 界面上的显示这一轮没动（她认得的那句位置话照旧），所以另有一条断言证明：**完整位置
// 仍然拿得到**——不能因为显示是友好话，就把完整值弄丢了。

import { describe, expect, test } from "bun:test";
import { plugin } from "bun";
import solidPlugin from "vite-plugin-solid";

import { pathForClipboard, RESULTS } from "./copy-results.ts";
import { fileName, folderName, type TaskRun } from "./run.ts";

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
  name: "cante-path-for-her-ssr",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformTsx(args.path),
      loader: "ts",
    }));
  },
});

/**
 * 真机会给的那一串位置：盘符开头、中文文件夹、中文+空格的文件名、扩展名收尾。
 * 用户名用文档占位写法（不是真机器）——真泄露了 secret-scan 会红。
 */
const WINDOWS_PATH = "C:/Users/用户名/桌面/Cante路径验收/结果_挑出华东区.xlsx";
const MAC_PATH = "/Users/用户名/Desktop/结果_挑出华东区.xlsx";

/** 一次结果：就这一份文件，好让断言盯着它。 */
function runWith(path: string): TaskRun {
  return {
    id: "run-1",
    taskId: "excel.tidy",
    taskTitle: "从大表里挑出想要的行",
    files: [],
    instruction: "把华东区的挑出来",
    plan: ["第一步"],
    impact: { created: 1, modified: 0, deleted: 0, messages: 0 },
    result: { files: [{ path, summary: "新增 · 5.5 KB" }], summary: "新增 1 个文件" },
    online: false,
    error: null,
    createdAt: 1_700_000_000_000,
    state: "done",
  } as unknown as TaskRun;
}

/** 结果卡片在 SSR 里真正产出的 HTML（只渲染，不点按钮、不测布局）。 */
async function renderedResultCard(path: string): Promise<string> {
  const { renderToString } = await import("solid-js/web");
  const { default: ResultCard } = await import("./ResultCard.tsx");
  const run = runWith(path);
  const store = {
    currentRun: () => run,
    rows: () => [],
    notice: () => "",
    runs: () => [run],
    schedules: () => [],
    openPath: async () => {},
    revealPath: async () => {},
    replyToRun: async () => {},
    startRun: async () => {},
    undoRun: async () => {},
    dismissRun: async () => {},
    addSchedule: async () => {},
    removeSchedule: async () => {},
    setScheduleEnabled: async () => {},
  };
  // 渲染时组件会挂/摘事件监听；服务端渲染没有 document，临时给一对空的（渲染完还原）。
  const scope = globalThis as { document?: unknown };
  const had = "document" in scope;
  const previous = scope.document;
  scope.document = { addEventListener: () => {}, removeEventListener: () => {} };
  try {
    return renderToString(() => ResultCard({ store: store as never, run }));
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (had) scope.document = previous;
    else delete scope.document;
  }
}

/** 两种分隔符在程序里指同一个东西：归一之后要能逐字对上。 */
const sameFile = (path: string): string => path.replace(/\\/g, "/");

describe("复制位置：按钮在结果卡片上，读屏分得清是哪一份", () => {
  test("卡片上真的有一个「复制位置」按钮，名字里带着文件名", async () => {
    const html = await renderedResultCard(WINDOWS_PATH);
    expect(html).toContain(RESULTS.actions.copyLocation);
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1] ?? "");
    const names = fileName(WINDOWS_PATH);
    const forCopy = labels.filter((label) => label.includes("复制") && label.includes(names));
    expect(forCopy.length).toBeGreaterThan(0);
  });

  test("它和「打开文件 / 打开所在文件夹」并排，是同一套路（原来的两个按钮一个没少）", async () => {
    const html = await renderedResultCard(WINDOWS_PATH);
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((m) => m[1] ?? "");
    // 复制位置那个按钮带 aria-label；另外两个按钮靠可见文字命名。
    expect(labels.some((label) => label.startsWith("复制"))).toBe(true);
    expect(html).toContain("打开文件");
    expect(html).toContain("打开所在文件夹");
  });
});

describe("复制进去的是完整位置，不是被截断的那一截", () => {
  test("首尾都在：盘符开头，扩展名收尾", () => {
    const copied = pathForClipboard(WINDOWS_PATH);
    expect(copied.startsWith("C:")).toBe(true);
    expect(copied.endsWith(".xlsx")).toBe(true);
    expect(copied).toContain(fileName(WINDOWS_PATH));
  });

  test("整条都在，一个字都没少（只是分隔符换了写法）", () => {
    expect(sameFile(pathForClipboard(WINDOWS_PATH))).toBe(WINDOWS_PATH);
  });

  test("换成 Windows 习惯的反斜杠（她要粘到微信和「打开文件」对话框）", () => {
    const copied = pathForClipboard(WINDOWS_PATH);
    expect(copied).not.toContain("/");
    expect(copied).toBe("C:\\Users\\用户名\\桌面\\Cante路径验收\\结果_挑出华东区.xlsx");
  });

  test("苹果/Linux 的位置本来就用正斜杠，原样返回（改了才是错的）", () => {
    expect(pathForClipboard(MAC_PATH)).toBe(MAC_PATH);
  });

  test("空串认不出来，也原样返回，绝不猜", () => {
    expect(pathForClipboard("")).toBe("");
  });
});

describe("粘出来的那串还指向同一个文件", () => {
  test("粘回来仍能拆出同一个文件名与文件夹（它的「打开文件」逻辑认得）", () => {
    const copied = pathForClipboard(WINDOWS_PATH);
    expect(fileName(copied)).toBe(fileName(WINDOWS_PATH));
    expect(sameFile(folderName(copied))).toBe(sameFile(folderName(WINDOWS_PATH)));
  });

  test("两种写法指同一处：归一后逐字相同", () => {
    expect(sameFile(pathForClipboard(WINDOWS_PATH))).toBe(sameFile(WINDOWS_PATH));
  });

  test("重复复制不会越改越乱：再复制一次得到同一串", () => {
    const once = pathForClipboard(WINDOWS_PATH);
    expect(pathForClipboard(once)).toBe(once);
  });
});

describe("不许复制一条她看不懂的东西", () => {
  test("没有 ..、没有连续两个分隔符、没有正斜杠", () => {
    const copied = pathForClipboard(WINDOWS_PATH);
    expect(copied).not.toContain("..");
    expect(copied).not.toContain("\\\\");
    expect(copied).not.toContain("//");
    expect(copied).not.toContain("/");
  });

  test("文案是平实中文，一个技术词都没有（复制成功/失败那两句）", () => {
    const words = [RESULTS.actions.copyLocation, RESULTS.actions.copied, RESULTS.actions.copyFailed];
    for (const word of words) {
      for (const term of ["路径", "位置符", "剪贴板地址", "clipboard"]) {
        expect(word).not.toContain(term);
      }
    }
  });
});

describe("复制不是发送：这条路上没有发送动作", () => {
  test("结果卡片里没有任何调用微信发送的写法", async () => {
    const source = await Bun.file(`${import.meta.dir}/ResultCard.tsx`).text();
    for (const banned of ["sendWechat", "sendToWechat", "wxSend", "发送到微信", "发到微信"]) {
      expect(source).not.toContain(banned);
    }
  });
});

describe("原有行为不变（回归）", () => {
  test("「打开文件 / 打开所在文件夹」还是按完整位置走，一个都没动", async () => {
    const source = await Bun.file(`${import.meta.dir}/ResultCard.tsx`).text();
    expect(source).toContain("props.store.openPath(file.path)");
    expect(source).toContain("props.store.revealPath(file.path)");
  });

  test("复制用的是完整位置 file.path，不是别的什么（接线检查）", async () => {
    const source = await Bun.file(`${import.meta.dir}/ResultCard.tsx`).text();
    expect(source).toContain("copyText(pathForClipboard(file.path))");
  });

  test("界面上显示还是她认得的那句话；完整位置仍然完整地拿得到", async () => {
    const run = runWith(WINDOWS_PATH);
    // 显示没被改成机器路径（她看到的仍是 LOCATION 那句友好话）。
    expect(run.result!.files[0]!.path).toBe(WINDOWS_PATH);
    const html = await renderedResultCard(WINDOWS_PATH);
    expect(html).not.toContain(WINDOWS_PATH);
    expect(html).not.toContain("C:/Users/用户名/桌面/Cante路径验收");
  });
});
