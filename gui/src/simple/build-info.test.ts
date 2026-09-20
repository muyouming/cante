// 「你手上的这一份是哪一个程序」——版本号 + 哪一天做好的（#261）。
//
// 为什么要有这个文件：我们两次拿**装着的旧版本**当验收对象，结论作废（#247 那
// 一轮量出 0/12，量的是旧界面）。根因不是我们没量，而是「我在验哪一份产物」在
// 界面上、在流程里都没有一处能一眼看出来。这个文件把判据钉成三条，其中后两条
// 才是重点：**差得明显必须报「旧产物」**，**读不出来必须说「核不出来」且不算过**。
//
// 三条都走同一个纯函数 judgeFreshness()（真机脚本 verify-modern-build.ps1 是它的
// 移植版），所以「界面自报的时间」和「脚本读到的产物时间」用的是同一套判定。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BUILD_INFO,
  BUILD_STAMP_MARKER,
  buildStamp,
  buildStampValue,
  DEFAULT_TOLERANCE_MINUTES,
  findBuildStamps,
  injectedBuildStamp,
  judgeFreshness,
  parseBuildStamp,
  parseStampTime,
  STALE_NOTICE,
} from "./copy-build.ts";

const HERE = import.meta.dir;
const GUI_ROOT = join(HERE, "..", "..");

/** 本地时间的毫秒数，测试里造时间用（不依赖运行机器的时区偏移写法）。 */
function localMs(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe("构建标记：拼得出来，也解得回去", () => {
  test("版本号取自 package.json，不是写死的", () => {
    const pkg = JSON.parse(readFileSync(join(GUI_ROOT, "package.json"), "utf8")) as { version: string };
    const stamp = buildStampValue("2026-09-20 14:36", pkg.version);
    expect(stamp).toContain(pkg.version);
    expect(parseBuildStamp(stamp)?.version).toBe(pkg.version);
  });

  test("标记串能被解成时间和版本", () => {
    const parsed = parseBuildStamp(buildStampValue("2026-09-20 14:36", "0.2.3"));
    expect(parsed).toEqual({ time: "2026-09-20 14:36", version: "0.2.3" });
  });

  test("格式不对 / 空串都解不出来，不猜", () => {
    expect(parseBuildStamp("")).toBeNull();
    expect(parseBuildStamp("随便一句什么")).toBeNull();
    expect(parseBuildStamp("CANTE-BUILD|2026/09/20|0.2.3")).toBeNull();
    expect(parseBuildStamp("CANTE-BUILD|2026-09-20|0.2.3")).toBeNull();
  });

  test("时间文字能解成本地时间的毫秒数，非法值返回 null", () => {
    expect(parseStampTime("2026-09-20 14:36")).toBe(localMs(2026, 9, 20, 14, 36));
    expect(parseStampTime("2026-13-01 00:00")).toBeNull();
    expect(parseStampTime("2026-09-20")).toBeNull();
  });

  test("标记的拼法只有一处：脚本按同一个常量找", () => {
    // 脚本 grep 的是这个标记；两边各写一份就会漂移，所以这里盯住它。
    expect(BUILD_STAMP_MARKER).toBe("CANTE-BUILD");
    expect(buildStampValue("2026-09-20 14:36", "0.2.3")).toMatch(
      new RegExp(`^${BUILD_STAMP_MARKER}\\|`),
    );
  });

  test("打包后的正文里能扫出标记，版本号不被后面的代码吞掉", () => {
    // 打包后标记前后都是代码（压缩成一行），所以扫描器必须能在正文里找，
    // 且版本号的字符集不能用 \S+ —— 那会把 `"}function` 一起吞进来。
    const bundled = `...x="CANTE-BUILD|2026-09-20 14:36|0.2.3"}function y(){...`;
    expect(findBuildStamps(bundled)).toEqual([{ time: "2026-09-20 14:36", version: "0.2.3" }]);
    // 验收脚本的 $stampPattern 是同一个字符集（这里盯住它没被放宽回 \S+）。
    const ps1 = readFileSync(join(GUI_ROOT, "scripts", "windows", "verify-modern-build.ps1"), "utf8");
    expect(ps1).toContain(
      'CANTE-BUILD\\|(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})\\|([0-9A-Za-z][0-9A-Za-z.+-]*)',
    );
  });
});

describe("判定一：两个时间对得上 → 过", () => {
  test("应用自报时间与 dist / exe 同在一小段里 → fresh", () => {
    const app = localMs(2026, 9, 20, 14, 36);
    const verdict = judgeFreshness({
      appStamp: buildStampValue("2026-09-20 14:36", "0.2.3"),
      // dist 比 exe 早几分钟是正常先后。
      distMs: app + 3 * 60_000,
      exeMs: app + 8 * 60_000,
    });
    expect(verdict.kind).toBe("fresh");
  });

  test("容差以内的先后不会误判成旧产物", () => {
    const app = localMs(2026, 9, 20, 14, 36);
    const within = (DEFAULT_TOLERANCE_MINUTES - 1) * 60_000;
    expect(
      judgeFreshness({
        appStamp: buildStampValue("2026-09-20 14:36", "0.2.3"),
        distMs: app - within,
        exeMs: app + within,
      }).kind,
    ).toBe("fresh");
  });
});

describe("判定二：差得明显（她装的是旧版）→ 必须报「旧产物」", () => {
  test("#261 真机那一幕：装着的 02:27 vs 刚编出来的 14:36 → stale，且点名「旧的产物」", () => {
    const installed = localMs(2026, 9, 20, 2, 27);
    const fresh = localMs(2026, 9, 20, 14, 36);
    // 应用自报的是**装着的那一份**（02:27），而产物是刚编的（14:36）。
    const verdict = judgeFreshness({
      appStamp: buildStampValue("2026-09-20 02:27", "0.2.2"),
      distMs: fresh,
      exeMs: fresh,
    });
    expect(verdict.kind).toBe("stale");
    if (verdict.kind !== "stale") return;
    expect(verdict.why).toContain(STALE_NOTICE);
    expect(verdict.why).toContain("旧");
  });

  test("exe 比应用自报的时间还老（没重新打包就换了前端）也算 stale", () => {
    const app = localMs(2026, 9, 20, 14, 36);
    const verdict = judgeFreshness({
      appStamp: buildStampValue("2026-09-20 14:36", "0.2.3"),
      distMs: app,
      exeMs: app - 40 * 60_000,
    });
    expect(verdict.kind).toBe("stale");
  });

  test("stale 绝不会是 fresh —— 它不许静默通过", () => {
    const verdict = judgeFreshness({
      appStamp: buildStampValue("2026-09-20 02:27", "0.2.2"),
      distMs: localMs(2026, 9, 20, 14, 36),
      exeMs: localMs(2026, 9, 20, 14, 36),
    });
    expect(verdict.kind).not.toBe("fresh");
    expect(verdict.kind).toBe("stale");
  });
});

describe("判定三：时间缺失 / 读不出 → 「核不出来」，不算通过", () => {
  test("没注入（自报串为空）→ unknown，不是 fresh", () => {
    const verdict = judgeFreshness({
      appStamp: "",
      distMs: localMs(2026, 9, 20, 14, 36),
      exeMs: localMs(2026, 9, 20, 14, 36),
    });
    expect(verdict.kind).toBe("unknown");
    expect(verdict.kind).not.toBe("fresh");
  });

  test("自报串格式坏了 → unknown", () => {
    const verdict = judgeFreshness({
      appStamp: "CANTE-BUILD|???|0.2.3",
      distMs: localMs(2026, 9, 20, 14, 36),
      exeMs: localMs(2026, 9, 20, 14, 36),
    });
    expect(verdict.kind).toBe("unknown");
  });

  test("产物时间读不到 → unknown（不许当成通过）", () => {
    for (const [distMs, exeMs] of [
      [null, localMs(2026, 9, 20, 14, 36)],
      [localMs(2026, 9, 20, 14, 36), null],
      [null, null],
    ] as const) {
      const verdict = judgeFreshness({
        appStamp: buildStampValue("2026-09-20 14:36", "0.2.3"),
        distMs,
        exeMs,
      });
      expect(verdict.kind).toBe("unknown");
      expect(verdict.kind).not.toBe("fresh");
    }
  });

  test("unknown 的那句话是「核不出来」，与「确认没有」分开写", () => {
    const verdict = judgeFreshness({ appStamp: "", distMs: null, exeMs: null });
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind !== "unknown") return;
    expect(verdict.why).toContain("核不出来");
  });
});

describe("生产路径：这次构建真的注入了标记", () => {
  test("injectedBuildStamp() 在构建里读得到；在测试里读不到就退回空串（不崩）", () => {
    const raw = injectedBuildStamp();
    // bun test 没有 vite 的 define 替换，这里必然读不到 → 空串，而不是抛错。
    expect(typeof raw).toBe("string");
    expect(raw).toBe("");
  });

  test("读不到注入串时，界面退回那句诚实的话（不假装知道）", () => {
    expect(buildStamp("")).toBeNull();
    expect(BUILD_INFO.unknown).toContain("没记住");
    expect(BUILD_INFO.unknown).toContain("同事");
  });

  test("来源是 package.json 的 version（现成的，没有新造版本机制）", () => {
    const pkg = JSON.parse(readFileSync(join(GUI_ROOT, "package.json"), "utf8")) as { version: string };
    expect(BUILD_INFO.versionLine(pkg.version)).toBe(`版本 ${pkg.version}`);
  });
});

describe("接线：这一块真的显示在「关于」页上，且零术语", () => {
  const about = readFileSync(join(HERE, "About.tsx"), "utf8");

  test("About.tsx 用了构建信息（不是只写了文件）", () => {
    expect(about).toContain("BUILD_INFO.heading");
    expect(about).toContain("BUILD_INFO.madeLine");
    expect(about).toContain("BUILD_INFO.versionLine");
    expect(about).toContain("buildStamp()");
  });

  test("它不管许可说明取没取回来都在（她在等许可时就该能核对）", () => {
    const block = about.indexOf("BUILD_INFO.heading");
    const loading = about.indexOf("{ABOUT.loading}");
    expect(block).toBeGreaterThan(0);
    expect(block).toBeLessThan(loading);
  });

  test("给用户看的句子没有技术词（build / commit / hash / 构建时间）", () => {
    const userFacing = [
      BUILD_INFO.heading,
      BUILD_INFO.versionLine("0.2.3"),
      BUILD_INFO.madeLine("2026-09-20 14:36"),
      BUILD_INFO.unknown,
    ].join("\n");
    expect(userFacing).not.toMatch(/build|commit|hash/i);
    expect(userFacing).not.toMatch(/模型|provider|token|会话|上下文|路径/);
  });

  test("用人话说「哪一天做好的」，不做成机器串", () => {
    expect(BUILD_INFO.madeLine("2026-09-20 14:36")).toBe("这个程序是 2026-09-20 14:36 做好的。");
  });
});
