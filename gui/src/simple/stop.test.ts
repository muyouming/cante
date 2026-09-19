// r26 — 「她点了停下来」之后，屏幕上必须说完整的三件事。
//
// 这一轮真正修的是一个**看不见的洞**：她点「停下来」之后，任务页会把她退回「选文件」
// 那一步，一句话都不说（cancel() 里 setDismissed(true)，而且 step() 没有 cancelled
// 分支）。结果卡片里那段「已经停下」的文案**几乎永远走不到**，而且它把「新做出来的
// 结果文件」和「她原来的文件」混成一句「改动」，也没有下一步。
//
// 这里把两半都钉住：
//   * 纯逻辑：三个数从 run.impact（快照 diff）来，不新造状态；
//   * 接线：停下之后真的停在结果那一步、真的把那三句画出来，而且**不摆一个点了没用
//     的「接着做」按钮**（产品现在不支持接着跑，见 CONTRACT.md）。
//
// 扫描源码是本仓库的既有做法（没有 jsdom）：typography / try-first / notice 都是这么
// 挡回归的。它挡的是"改坏就等于往源码里写一行"的事，正是这个洞的形状。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STOPPED } from "./copy-stop.ts";
import { stoppedView } from "./stop.ts";

const HERE = import.meta.dir;
const read = (name: string): string => readFileSync(join(HERE, name), "utf8");

describe("stop.ts：三个数只从已有的事实来（run.impact 快照 diff）", () => {
  test("新做出了几个文件、原来的文件动了几个，分别数出来", () => {
    expect(stoppedView({ impact: { created: 2, modified: 0, deleted: 0, messages: 0 } })).toEqual({
      produced: 2,
      touched: 0,
    });
    // 原来的文件动过：改的和删的都算「动过」。
    expect(stoppedView({ impact: { created: 1, modified: 3, deleted: 2, messages: 0 } })).toEqual({
      produced: 1,
      touched: 5,
    });
  });

  test("什么都没做时不虚报", () => {
    expect(stoppedView({ impact: { created: 0, modified: 0, deleted: 0, messages: 0 } })).toEqual({
      produced: 0,
      touched: 0,
    });
  });

  test("坏数据当「没有」，不吐负数、不崩", () => {
    // 记录可能是从旧版本读回来的，字段缺失或为负都不该让它说胡话。
    const bad = stoppedView({ impact: { created: -1, modified: -2, deleted: -3, messages: 0 } });
    expect(bad).toEqual({ produced: 0, touched: 0 });
  });
});

describe("copy-stop.ts：三句话各自的依据", () => {
  test("1/3 做到一半的产出：有就说几个、没有就直说没有", () => {
    expect(STOPPED.partial(0)).toContain("还没有做出新文件");
    expect(STOPPED.partial(3)).toContain("3 个");
    // 不许把「没有产出」说成「做完了」。
    expect(STOPPED.partial(0)).not.toContain("做完了");
  });

  test("2/3 原来的文件：这是产品对文件的承诺原话（产品律 2）", () => {
    // 改软这句就等于把「别弄坏我的东西」这条律说没了。
    expect(STOPPED.originalsSafe).toContain("原来的文件没有被改动");
    // 真动过原名件时，必须给「一键撤销」这条出路，而不是继续保证没动。
    expect(STOPPED.originalsTouched(2)).toContain("撤销");
    expect(STOPPED.originalsTouched(2)).toContain("2");
  });

  test("3/3 下一步：只给真能走的路，绝不承诺「接着做」", () => {
    // 产品现在不支持从停下的地方接着跑：桥不会把做到一半的那一步续上
    // （CONTRACT.md 里那条说得死的说明）。所以这里只能说「从头做一遍」。
    expect(STOPPED.nextStep).toContain("再跑一次");
    expect(STOPPED.nextStep).toContain("从头");
    for (const bad of ["接着做", "接着跑", "继续做", "接着往下"]) {
      expect(STOPPED.nextStep.includes(bad), `下一步里承诺了「${bad}」，产品做不到`).toBe(false);
    }
  });

  test("说的是她的话：全中文、不说「中止 / 取消」这类系统说法", () => {
    const text = Object.values(STOPPED)
      .map((value) => (typeof value === "function" ? value(1) : value))
      .join("\n");
    for (const bad of ["中止", "取消", "进程", "会话", "任务被"]) {
      expect(text.includes(bad), `copy-stop.ts 出现了系统说法「${bad}」`).toBe(false);
    }
  });
});

describe("接线：停下之后真的停在结果那一步，并把三句画出来", () => {
  const runner = read("TaskRunner.tsx");
  const card = read("ResultCard.tsx");

  test("cancelled 映射到结果那一步 —— 不是默默退回选文件", () => {
    // 这个洞的成因就是 step() 没有 cancelled 分支：它落回 phase()，
    // 于是她点完「停下来」看见的是「选文件」。
    expect(runner).toContain('case "cancelled":');
    const cancelledCase = runner.indexOf('case "cancelled":');
    const after = runner.slice(cancelledCase, cancelledCase + 80);
    expect(after, "cancelled 没有停在结果那一步").toContain('return "result"');
  });

  test("cancel() 不再把这次运行从屏幕上拿掉（不 dismiss）", () => {
    const at = runner.indexOf("function cancel()");
    expect(at).toBeGreaterThan(-1);
    const body = runner.slice(at, runner.indexOf("\n  }", at));
    expect(body, "cancel() 还在 dismiss：停下之后屏幕上就没地方说结果了").not.toContain(
      "setDismissed(true)",
    );
    expect(body).toContain("cancelRun");
  });

  test("结果卡片把三句都画出来（拿 copy 常量，不写死）", () => {
    expect(card).toContain("import { STOPPED }");
    expect(card).toContain("STOPPED.partial(");
    expect(card).toContain("STOPPED.originalsSafe");
    expect(card).toContain("STOPPED.originalsTouched(");
    expect(card).toContain("STOPPED.nextStep");
    // 依据来自 stop.ts 的纯函数（快照事实），不是卡片里自己再数一遍。
    expect(card).toContain("stoppedView");
  });

  test("她主动停下时不摆「它有一件事想问你」那个回话框", () => {
    // 那一轮是她叫停的，不是助手在等她回话；给个问句框会让她以为自己漏看了什么。
    const at = card.indexOf("const asking = ()");
    expect(at).toBeGreaterThan(-1);
    const expr = card.slice(at, card.indexOf(";", at));
    expect(expr).toContain('state() !== "cancelled"');
  });

  test("不摆一个点了没用的「接着做」按钮", () => {
    // 只有已审过的「再跑一次」（从头做一遍）能出现；「接着做」这条路产品不支持。
    // 注释里提到「接着做」不算（r25 的下一步那段注释就说到了），所以先把注释剥掉
    // 再看真正的界面文字（字符串 + JSX 文本）。
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    expect(stripComments(card)).not.toContain("接着做");
    expect(stripComments(runner)).not.toContain("接着做");
    // 反向例：剥注释这件事本身是真的（不然上面两句可能是空断言）。
    expect(stripComments("// 接着做\nconst x = 1;")).not.toContain("接着做");
    expect(stripComments('const y = "接着做";')).toContain("接着做");
  });
});
