// #103 — 「这台电脑还缺一个组件」这条探测的前端行为。
//
// 上游 cante/ante 只有 macOS 与 Linux 构建，Windows 上没有原生守护进程；界面却
// 以前什么都不说。这个文件钉住三件事：
//
//   * 后端说「不在」时，向导那一节确实给出说明、一步可执行的动作和「复制详情」
//     按钮，里面是找过哪些位置、缺的是什么；
//   * 后端说「在」、或者根本问不到答案（浏览器预览 / 探测报错）时，不显示这一节；
//   * 任务真跑不起来（底层报「找不到那个程序」）时，出错界面落到同一句话 + 同一个
//     出路，而不是被当成「文件找不到」让她一遍遍重选文件。
//
// 真后端解析逻辑在 Rust 侧单测（commands.rs 的 resolve_daemon_bin）。这里 mock 掉
// 桥，只测前端把答案翻译成什么。
//
//   bun test src
import { describe, expect, mock, test } from "bun:test";

import { DAEMON } from "./copy-daemon.ts";

let reply: unknown = null;
let boom = false;

mock.module("../tauri.ts", () => ({
  invoke: async () => {
    if (boom) throw new Error("desktop bridge unavailable");
    return reply;
  },
  isBridgeAvailable: () => true,
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  BridgeUnavailable: class BridgeUnavailable extends Error {},
  CommandRejected: class CommandRejected extends Error {},
}));

const { copyDaemonDetails, daemonDetails, daemonNotice, normalizeDaemon, probeDaemon } =
  await import("./daemon.ts");
const { explainError } = await import("./copy.ts");
const { actionsFor } = await import("./recovery.ts");

describe("normalizeDaemon", () => {
  test("可用时保留程序位置，别的字段不带过来", () => {
    const cap = normalizeDaemon({
      available: true,
      path: "/usr/local/bin/cante",
      why: "不该出现",
      searched: ["不该出现"],
    });
    expect(cap).toEqual({
      available: true,
      path: "/usr/local/bin/cante",
      why: null,
      searched: [],
    });
  });

  test("不可用时保留 why 和找过的位置", () => {
    const cap = normalizeDaemon({ available: false, why: "缺组件", searched: ["/opt/cante"] });
    expect(cap.available).toBe(false);
    expect(cap.path).toBeNull();
    expect(cap.why).toBe("缺组件");
    expect(cap.searched).toEqual(["/opt/cante"]);
  });

  test("null / 缺字段一律按不可用处理，不抛异常", () => {
    expect(normalizeDaemon(null)).toEqual({
      available: false,
      path: null,
      why: null,
      searched: [],
    });
    expect(normalizeDaemon(undefined).available).toBe(false);
  });
});

describe("probeDaemon", () => {
  test("后端说可用时原样带回来", async () => {
    boom = false;
    reply = { available: true, path: "C:\\Cante\\cante.exe" };
    const cap = await probeDaemon();
    expect(cap?.available).toBe(true);
    expect(cap?.path).toBe("C:\\Cante\\cante.exe");
  });

  test("后端说不可用时带 why 和找过的地方", async () => {
    boom = false;
    reply = {
      available: false,
      why: DAEMON.what,
      searched: ["程序旁边", "系统里登记的每个文件夹"],
    };
    const cap = await probeDaemon();
    expect(cap?.available).toBe(false);
    expect(cap?.why).toBe(DAEMON.what);
    expect(cap?.searched).toEqual(["程序旁边", "系统里登记的每个文件夹"]);
  });

  test("探测失败返回 null：这是没答案，不是缺组件", async () => {
    boom = true;
    expect(await probeDaemon()).toBeNull();
  });
});

describe("daemonNotice：向导「检查电脑」该显示什么", () => {
  test("不可用时给出说明、一步动作，以及复制详情的按钮", () => {
    const notice = daemonNotice({
      available: false,
      why: DAEMON.what,
      searched: ["C:\\Cante\\cante", "系统里登记的每个文件夹"],
    });
    expect(notice).not.toBeNull();
    expect(notice?.title).toContain("组件");
    // 一步就能执行：她自己装不了，让技术同事装一次。
    expect(notice?.action).toContain("技术同事");
    expect(notice?.action).toContain("组件");
    expect(notice?.action).toContain("重新检查");
    // 给技术同事看的按钮。
    expect(notice?.copyLabel).toContain("复制详情");
    expect(notice?.details).toContain("C:\\Cante\\cante");
  });

  test("可用时不显示这一节", () => {
    expect(daemonNotice({ available: true, path: "/usr/local/bin/cante" })).toBeNull();
  });

  test("没答案（探测失败）时也不显示：别把网络问题说成缺组件", () => {
    expect(daemonNotice(null)).toBeNull();
  });
});

describe("daemonDetails：给技术同事看的事实", () => {
  test("说清缺的是什么，并逐条列出找过哪些位置", () => {
    const text = daemonDetails({
      available: false,
      why: DAEMON.what,
      searched: ["程序旁边：C:\\Cante\\cante", "系统里登记的每个文件夹"],
    });
    expect(text).toContain("缺的是");
    expect(text).toContain("已经找过这些位置");
    expect(text).toContain("程序旁边：C:\\Cante\\cante");
    expect(text).toContain("系统里登记的每个文件夹");
  });

  test("一处位置都没记下来时给一句兜底，而不是空着", () => {
    expect(daemonDetails({ available: false })).toContain("没有记录到具体找过哪里");
  });

  test("拿不到剪贴板时不抛异常，老实返回 false", async () => {
    // 测试环境里没有 document / navigator 的写剪贴板能力，必须安全退化。
    expect(await copyDaemonDetails({ available: false })).toBe(false);
  });
});

describe("出错界面：任务起不来时落到同一句话 + 同一个出路", () => {
  test("底层说 could not start … serve 时识别为缺组件，把详情交给同事", () => {
    const human = explainError(
      "could not start `cante serve`: No such file or directory (os error 2)",
    );
    // 同一句话：不是泛泛的「出了点问题」。
    expect(human.what).toBe(DAEMON.what);
    const actions = actionsFor(human);
    expect(actions.map((item) => item.kind)).toEqual(["copy-detail"]);
    expect(actions[0]?.label).toContain("同事");
    expect(actions[0]?.why).toContain("组件");
  });

  test("Windows 原生的「不是内部或外部命令」也认得出来", () => {
    const actions = actionsFor({
      what: "",
      how: "",
      detail: "'cante' 不是内部或外部命令，也不是可运行的程序或批处理文件。",
    });
    expect(actions[0]?.kind).toBe("copy-detail");
    expect(actions[0]?.label).toContain("同事");
  });

  test("普通的「找不到文件」仍是重新选文件，不被误判成缺组件", () => {
    const actions = actionsFor(
      explainError("ENOENT: no such file or directory, open 'C:\\报表.xlsx'"),
    );
    expect(actions[0]?.kind).toBe("pick-files");
  });

  test("任务对象里的兜底说明也会被换成同一句话（原因只在 detail 里）", () => {
    const human = explainError({
      what: "这件事没有做完。",
      how: "原来的文件都还在。",
      detail: "could not start `cante serve`: No such file or directory (os error 2)",
    });
    expect(human.what).toBe(DAEMON.what);
    expect(actionsFor(human)).toEqual([
      expect.objectContaining({ kind: "copy-detail" }),
    ]);
  });

  test("任务自己写好的说明不会被宽泛的 command not found 覆盖", () => {
    // 任务里某个命令没找到，不是这台电脑缺组件：原来那两句要留着。
    const human = explainError({
      what: "这张表打不开。",
      how: "换一份再试。",
      detail: "bash: foo: command not found",
    });
    expect(human.what).toBe("这张表打不开。");
    expect(human.how).toBe("换一份再试。");
  });
});
