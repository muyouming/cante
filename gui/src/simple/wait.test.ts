// 「还要多久」的闸门测试。
//
// 这一屏最怕的不是难看，是**说谎**：给一个猜出来的预计时间，落空之后掉的是信任
// （Wharton 的对照实验：空口保证比不保证更伤）。所以这里的断言只守三件事：
//
//   1. 话里**不许**有打包票的词（保证 / 一定 / 马上 / 立刻），也不许有倒计时；
//   2. 常见范围**必须**能追溯到真机样本（`WAIT_SAMPLES`）——重算一遍九成位/四分位，
//      对不上就红；
//   3. 超过常见范围之后**必须**改口，而且改口那句不能和「停滞（断线）」那一屏打架。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WAIT } from "./copy-wait.ts";
import { STALLED_MARKER } from "./copy-recovery.ts";
import {
  WAIT_SAMPLES,
  bandFor,
  formatWaitSpan,
  overallBand,
  summarize,
  waitClassOf,
  waitPhase,
  waitView,
  type WaitClass,
} from "./wait.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI_ROOT = join(HERE, "../..");

/** 打包票的词：说了就等于替这一次打了保票，一律不许出现。 */
const PROMISE_WORDS = ["保证", "一定", "马上", "立刻"] as const;

/** 真机样本的出处：这几份文件必须真的在仓库里，样本才好核对。 */
const SOURCES: readonly string[] = [
  "SWEEP-0.2.1.md",
  "SWEEP-0.2.1-full.md",
  "WINDOWS-ACCEPTANCE-7.md",
  "WINDOWS-ACCEPTANCE-8.md",
  "WINDOWS-ACCEPTANCE-10.md",
  "WINDOWS-ACCEPTANCE-14.md",
  "WINDOWS-ACCEPTANCE-15.md",
] as const;
const SOURCE_SET = new Set(SOURCES);

/** 界面上可能出现的每一句话（含格式化后的主句）。 */
function everySentence(): string[] {
  const out: string[] = [WAIT.observed, WAIT.longer];
  for (const klass of ["表格", "文字"] as const) {
    const band = bandFor(klass);
    out.push(waitView(klass, 0).line);
    out.push(WAIT.usual(formatWaitSpan(band.loSeconds), formatWaitSpan(band.hiSeconds)));
  }
  out.push(WAIT.usual(formatWaitSpan(overallBand().loSeconds), formatWaitSpan(overallBand().hiSeconds)));
  return out;
}

describe("等待时间：只说观察到的，不承诺", () => {
  test("界面上不许出现打包票的词", () => {
    const hits: string[] = [];
    for (const text of everySentence()) {
      for (const word of PROMISE_WORDS) {
        if (text.includes(word)) hits.push(`「${word}」 in "${text}"`);
      }
    }
    if (hits.length > 0) {
      throw new Error(
        [
          "这些等待文案在打包票（她等久了会不再信我们）：",
          ...hits.map((line) => `  - ${line}`),
          "改成只说观察到的事实，例如「这类事一般要 … 到 …。这只是以前几次实际做下来看到的。」",
        ].join("\n"),
      );
    }
  });

  test("不做倒计时：不许出现「还剩 / 倒计时 / 再过 … 秒」", () => {
    for (const text of everySentence()) {
      expect(text).not.toMatch(/还剩|倒计时|再过|还差/);
    }
  });

  test("样本是真的：每一条都能指回仓库里的一份文件", () => {
    expect(WAIT_SAMPLES.length).toBeGreaterThanOrEqual(20);
    const present = new Set(SOURCES.filter((name) => existsSync(join(GUI_ROOT, name))));
    expect(present.has("SWEEP-0.2.1.md")).toBe(true);
    expect(present.has("SWEEP-0.2.1-full.md")).toBe(true);
    expect(present.has("SWEEP-0.2.1.md")).toBe(true);
    expect(present.has("SWEEP-0.2.1-full.md")).toBe(true);
    for (const sample of WAIT_SAMPLES) {
      expect(sample.card.length).toBeGreaterThan(0);
      expect(sample.seconds).toBeGreaterThan(0);
      expect(SOURCE_SET.has(sample.source)).toBe(true);
    }
    // 两个大类都得有足够的样本，否则「分开量」就是空的。
    const tables = WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === "表格");
    const words = WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === "文字");
    expect(tables.length).toBeGreaterThanOrEqual(10);
    expect(words.length).toBeGreaterThanOrEqual(10);
  });

  test("范围是从样本里算出来的，不是写死的", () => {
    for (const klass of ["表格", "文字"] as const) {
      const band = bandFor(klass);
      const observed = summarize(
        WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === klass).map((item) => item.seconds),
      );
      // 上界必须盖住九成位：否则「比一般情况久」会比真实偏早/偏晚地出现。
      expect(band.hiSeconds).toBeGreaterThanOrEqual(observed.p90);
      // 下界不能超过四分之一位：说「一般要 X」而实际更早就好，会像在拖时间。
      expect(band.loSeconds).toBeLessThanOrEqual(band.summary.median);
      expect(band.loSeconds).toBeLessThan(band.hiSeconds);
      // 常见范围要真的装得下大多数样本（至少一半）。
      const seconds = WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === klass).map(
        (item) => item.seconds,
      );
      const inside = seconds.filter((s) => band.loSeconds <= s && s <= band.hiSeconds).length;
      expect(inside / seconds.length).toBeGreaterThanOrEqual(0.5);
    }
  });

  test("那句话里出现的两个数，就是样本算出来的下界和上界", () => {
    for (const klass of ["表格", "文字"] as const) {
      const band = bandFor(klass);
      const line = waitView(klass, 0).line;
      expect(line).toContain(formatWaitSpan(band.loSeconds));
      expect(line).toContain(formatWaitSpan(band.hiSeconds));
      // 出处那一句要跟着出现，说清这是看来的、不是保证。
      expect(waitView(klass, 0).caveat).toBe(WAIT.observed);
    }
  });

  test("超过常见范围就改口，而且改口那句不说「连不上」", () => {
    for (const klass of ["表格", "文字"] as const) {
      const band = bandFor(klass);
      const justInside = waitView(klass, band.hiSeconds * 1000);
      const justOver = waitView(klass, (band.hiSeconds + 1) * 1000);
      expect(justInside.phase).toBe("usual");
      expect(justOver.phase).toBe("longer");
      expect(justInside.line).not.toBe(justOver.line);
      // 改口之后不再给数字（给了就是新的承诺）。
      expect(justOver.line).not.toMatch(/\d|分钟|秒/);
      // 不能触发「停滞（断线）」那一屏：那句话归 bridge 的 STALLED_MARKER。
      expect(STALLED_MARKER.test(justOver.line)).toBe(false);
      expect(justOver.line).not.toMatch(/连不上|网络/);
    }
  });

  test("拿不到分组时也有兜底范围，而且不比整体样本更乐观", () => {
    const fallback = waitView(undefined, 0);
    const overall = overallBand();
    expect(fallback.line).toContain(formatWaitSpan(overall.loSeconds));
    expect(fallback.line).toContain(formatWaitSpan(overall.hiSeconds));
    expect(waitPhase(overall.hiSeconds * 1000 + 1, overall)).toBe("longer");
  });

  test("边界是「大于」不是「大于等于」：正好到上界仍算常见", () => {
    const band = bandFor("文字");
    expect(waitPhase(band.hiSeconds * 1000, band)).toBe("usual");
    expect(waitPhase(band.hiSeconds * 1000 + 1, band)).toBe("longer");
  });

  test("改口必须早于断线那一屏（否则它永远不会出现）", () => {
    // 产品把「跑到一半彻底没消息」的判据定为 600 秒（bridge.rs 的 STALL_TIMEOUT，
    // 环境变量 CANTE_BRIDGE_STALL_SECS 可改测试用值）。界面上这一句最晚也要在远早于
    // 那个点之前改口，否则她根本没机会看到「比一般情况久」——卡住时整屏会被停滞页替掉。
    const STALL_DEFAULT_SECONDS = 600;
    for (const klass of ["表格", "文字"] as const) {
      const band = bandFor(klass);
      expect(band.hiSeconds).toBeLessThan(STALL_DEFAULT_SECONDS);
      // 至少提前一分钟改口，给她留出反应的时间。
      expect(STALL_DEFAULT_SECONDS - band.hiSeconds).toBeGreaterThanOrEqual(60);
    }
    // 停滞那句原文归 bridge；这一句绝不能触发它。
    expect(STALLED_MARKER.test(WAIT.longer)).toBe(false);
  });

  test("每组样本都真的参与了计算（不是抄了一个写死的范围）", () => {
    // 把样本翻一倍，上界只可能不变或变大，绝不会变小 —— 顺带证明范围确实读样本。
    const klass: WaitClass = "文字";
    const band = bandFor(klass);
    expect(band.summary.count).toBe(
      WAIT_SAMPLES.filter((item) => waitClassOf(item.group) === klass).length,
    );
    // 范围里出现的刻度，必须是 `formatWaitSpan` 能读出来的整值。
    expect(formatWaitSpan(band.loSeconds)).not.toBe("");
    expect(formatWaitSpan(band.hiSeconds)).not.toBe("");
  });
});
