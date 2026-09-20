// 结果文件「现在找不到了」时，她看到的话是不是**真的**。
//
// 为什么值得单独钉：她的结果常常就在她自己的 U 盘 / 移动硬盘上（结果按规矩留在原
// 文件旁边）。她把盘拔了（或以为插着），屏幕上却说「它可能被移动或删掉了」——一个字
// 都没提盘。她会去重选一份本来好好的文件，甚至以为是自己弄丢了。产品律第 3 条要求
// 「出错能看懂并有出路」，这是那条红线的直接后果。
//
// 事实（能不能把「文件没了」与「整个盘不在」分开）在 gui/docs/MISSING-FILE.md 里，
// 那里记了 macOS 上的真实验（临时 dmg 卸载，五种现场）和**没核出来**的 Windows 侧。
// 本文件的判据全部**照那份事实**来定：
//
//   * 今天这个 bit（路径在不在）**分不开**「文件被删」与「盘被拔」——所以产品里
//     **不假装**能分开，`missing` 一句把两种原因**都**说出来，并给两步出路；
//   * 认不出（没能核对）→ 退回**通用出口**，不编一个原因；
//   * **不许**出现「被删了 / 弄丢了」这类**没有依据的断定**（她没做错，我们不能冤枉她）；
//   * 回归：既有的「找不到」那条行为不变，且 readability 白名单的锚点逐字还在。
//
// 这里只钉**判定与文案**，不假装能证明「她看懂了」——那句只有真人测试能给答案。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { RESULTS } from "./copy-results.ts";

const HERE = import.meta.dir;

/** 四种「还在不在」的说法，一起拿来扫「有没有冤枉她」。 */
const PRESENCE = [
  ["present", RESULTS.presence.present],
  ["missing", RESULTS.presence.missing],
  ["unreadable", RESULTS.presence.unreadable],
  ["unknown", RESULTS.presence.unknown],
] as const;

describe("三种情形各是各的说法，不混成一句", () => {
  test("找不到 / 还在但打不开 / 认不出：三句互不相同", () => {
    const distinct = new Set([RESULTS.presence.missing, RESULTS.presence.unreadable, RESULTS.presence.unknown]);
    expect(distinct.size).toBe(3);
  });

  test("文件没了：那句话**同时**把「盘没接上」说出来，不再只怪她弄丢", () => {
    // 判据来自 MISSING-FILE.md §3：今天分不开，所以两种原因都要摆出来。
    expect(RESULTS.presence.missing).toContain("找不到了");
    expect(RESULTS.presence.missing).toContain("没接上的盘");
    expect(RESULTS.presence.missing).toContain("U 盘");
    // 原本就说过的原因也在，不是把它换掉，而是**扩成包含**。
    expect(RESULTS.presence.missing).toContain("可能被移动或删掉了");
  });

  test("盘不在时她有两个具体下一步（插回那个盘 / 重新选一次文件）", () => {
    expect(RESULTS.presence.missing).toContain("插回来再点一次");
    expect(RESULTS.presence.missing).toContain("重新选一次文件");
    // 「打开所在文件夹」这条老出路也还在（盘插回来后它就是有用的）。
    expect(RESULTS.presence.missing).toContain("打开所在文件夹");
  });

  test("还在但打不开：说的是「占着」，跟「找不到」不是一回事", () => {
    expect(RESULTS.presence.unreadable).toContain("占着");
    expect(RESULTS.presence.unreadable).not.toContain("没接上的盘");
  });

  test("认不出：退回通用出口，不编一个原因，也不关掉出路", () => {
    expect(RESULTS.presence.unknown).toContain("没能核对");
    // 不假装知道是「被移动」「被删」还是「盘不在」。
    expect(RESULTS.presence.unknown).not.toContain("没接上的盘");
    expect(RESULTS.presence.unknown).not.toContain("移动");
    expect(RESULTS.presence.unknown).not.toContain("删");
    // 通用出口必须留一条她能走的路。
    expect(RESULTS.presence.unknown).toContain("打开所在文件夹");
  });
});

describe("不许没有依据的断定：她没做错，我们不冤枉她", () => {
  test("四种说法里都没有「被删了 / 弄丢了」这种把话说死的断定", () => {
    for (const [name, text] of PRESENCE) {
      // 确凿的过去时：我们根本不知道是谁做的、做没做，不许这么写。
      expect(`${name}:${text}`).not.toMatch(/被删了/);
      expect(`${name}:${text}`).not.toMatch(/弄丢了/);
      expect(`${name}:${text}`).not.toMatch(/已经被删/);
      expect(`${name}:${text}`).not.toMatch(/是你删/);
    }
  });

  test("只要提到「删掉」，就必须是带「可能」的猜测，不是断定", () => {
    for (const [name, text] of PRESENCE) {
      if (!text.includes("删")) continue;
      expect(`${name}:${text}`).toContain("可能");
    }
  });

  test("「没接上的盘」也只作为**可能**出现，不说成事实", () => {
    // 「也可能在一个现在没接上的盘上」—— 是「可能」，不是「就是」。
    expect(RESULTS.presence.missing).toContain("也可能在一个现在没接上的盘上");
  });

  test("还在（present）那句不掺任何原因，只说事实", () => {
    expect(RESULTS.presence.present).toBe("现在还在，能打开。");
  });
});

describe("回归：既有的「找不到」那条行为不变", () => {
  test("readability 白名单的锚点逐字还在（改掉它会红）", () => {
    // readability.test.ts 的 PASSIVE_ALLOW 用这句当锚点；这行是**故意的**守卫。
    expect(RESULTS.presence.missing).toContain("可能被移动或删掉了");
  });

  test("四句话都还在，一句都没被删掉", () => {
    expect(typeof RESULTS.presence.present).toBe("string");
    expect(typeof RESULTS.presence.missing).toBe("string");
    expect(typeof RESULTS.presence.unreadable).toBe("string");
    expect(typeof RESULTS.presence.unknown).toBe("string");
  });

  test("界面还是按本机给的现状去取那四句（接线没断）", () => {
    const panel = readFileSync(join(HERE, "ResultsPanel.tsx"), "utf8");
    expect(panel).toContain("RESULTS.presence[entry.presence]");
  });
});

describe("事实文档：核过的贴出来，没核出来的写明", () => {
  const doc = readFileSync(join(HERE, "../../docs/MISSING-FILE.md"), "utf8");

  test("记了 macOS 上的真实验（卸载临时 dmg 的五个现场）", () => {
    expect(doc).toContain("hdiutil detach");
    expect(doc).toContain("卷挂载根");
  });

  test("结论是「用今天这个 bit 分不开」，而不是含糊带过", () => {
    expect(doc).toContain("分不开");
  });

  test("Windows 侧如实写「没核出来」，不许猜", () => {
    expect(doc).toContain("没核出来");
    expect(doc).toContain("Windows");
  });
});
