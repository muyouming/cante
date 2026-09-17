// #88 — 动手前的格式判断。
//
// 这个模块的全部价值就是：WPS / 苹果自己的格式在**跑之前**就被认出来，而不是
// 跑了一会儿才说读不了。所以测试按四种结论逐个钉住，外加大小写、无扩展名、
// 空数组这些边界（真机上这些都是她会遇到的样子）。
//
//   bun test src
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { inspectSelection, nothingReadable, pickStepLine } from "./format-check.ts";
import { FORMAT_COPY } from "./copy-capability.ts";

describe("inspectSelection：读不读得了", () => {
  test("空数组 → ok（没选文件，谈不上读不了）", () => {
    expect(inspectSelection([])).toEqual({ kind: "ok" });
  });

  test("全是能读的 → ok", () => {
    expect(inspectSelection(["C:/桌面/销售.xlsx", "C:/桌面/说明.docx", "C:/桌面/明细.csv"])).toEqual({
      kind: "ok",
    });
  });

  test("没有扩展名、或者点开头的文件 → ok（认不出来就不拦她）", () => {
    expect(inspectSelection(["C:/Users/王姐/Downloads/下载", "C:/桌面/新建文件"])).toEqual({ kind: "ok" });
  });

  test("文件名里带点但不是扩展名（文件夹）也算能读", () => {
    // 只看最后一段路径的最后一个点，别把「2024.05 报表」当成扩展名。
    expect(inspectSelection(["C:/桌面/2024.05 报表"])).toEqual({ kind: "ok" });
  });

  test("全都读不了（都是 WPS）→ convert-first，并给出另存为那一步", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/名单.ett"]);
    expect(verdict.kind).toBe("convert-first");
    if (verdict.kind !== "convert-first") return;
    expect(verdict.blocked).toEqual(["C:/桌面/销售表.et", "C:/桌面/名单.ett"]);
    expect(verdict.advice).toBe(FORMAT_COPY.wpsConvertAdvice);
    // 可操作的一步：在 WPS 里另存为 Excel。
    expect(verdict.advice).toContain("WPS");
    expect(verdict.advice).toContain("另存为");
    expect(verdict.advice).toContain(".xlsx");
    // 文件是好的，不能说她的文件坏了。
    expect(verdict.advice).not.toContain("坏了");
  });

  test("全都读不了（都是苹果）→ convert-first，给的是导出那一步", () => {
    const verdict = inspectSelection(["C:/桌面/简报.pages"]);
    expect(verdict.kind).toBe("convert-first");
    if (verdict.kind !== "convert-first") return;
    expect(verdict.advice).toBe(FORMAT_COPY.appleConvertAdvice);
    expect(verdict.advice).toContain("导出");
    expect(verdict.advice).not.toContain("坏了");
  });

  test("部分读不了 → some-unreadable：说清会跳过，其余照做", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/三月.xlsx"]);
    expect(verdict.kind).toBe("some-unreadable");
    if (verdict.kind !== "some-unreadable") return;
    // 只点读不了的那几份，能读的不在名单里。
    expect(verdict.blocked).toEqual(["C:/桌面/销售表.et"]);
    expect(verdict.advice).toBe(FORMAT_COPY.skipSomeAdvice);
    expect(verdict.advice).toContain("跳过");
  });

  test("全读不了、但 WPS 和苹果混在一起 → mixed-nothing-readable", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/简报.pages"]);
    expect(verdict.kind).toBe("mixed-nothing-readable");
    if (verdict.kind !== "mixed-nothing-readable") return;
    // 给不出一条统一的另存为，但名单照给：两个界面都要能把「是哪几份」列出来。
    expect(verdict.blocked).toEqual(["C:/桌面/销售表.et", "C:/桌面/简报.pages"]);
    expect(verdict.advice).toBe(FORMAT_COPY.mixedConvertAdvice);
    expect(verdict.advice).toContain("另存为");
    expect(verdict.advice).toContain("导出");
  });

  test("文书类任务：.wps（WPS 文字）一个都读不了 → 出路是另存为 .docx", () => {
    const verdict = inspectSelection(["C:/桌面/年度总结.wps"]);
    expect(verdict.kind).toBe("convert-first");
    if (verdict.kind !== "convert-first") return;
    expect(verdict.blocked).toEqual(["C:/桌面/年度总结.wps"]);
    expect(verdict.advice).toBe(FORMAT_COPY.wpsConvertAdvice);
    // 文书这条路上她能落地的就是 Word 文件。
    expect(verdict.advice).toContain(".docx");
  });

  test("文书类任务：.dps（WPS 演示）也算读不了，不会当成能读的文件放过去", () => {
    for (const name of ["汇报.dps", "补充.wps"]) {
      const verdict = inspectSelection([`C:/桌面/${name}`]);
      expect(verdict.kind).toBe("convert-first");
      if (verdict.kind !== "convert-first") return;
      expect(verdict.blocked).toEqual([`C:/桌面/${name}`]);
    }
  });

  test("大小写不敏感：.ET / .WPS / .Pages 都算读不了", () => {
    expect(inspectSelection(["C:/桌面/A.ET"]).kind).toBe("convert-first");
    expect(inspectSelection(["C:/桌面/B.WPS"]).kind).toBe("convert-first");
    expect(inspectSelection(["C:/桌面/C.Pages"]).kind).toBe("convert-first");
    expect(inspectSelection(["C:/桌面/D.NUMBERS"]).kind).toBe("convert-first");
  });

  test("每个读不了的格式都认：.et/.ett/.wps/.dps/.pages/.numbers", () => {
    for (const name of ["a.et", "a.ett", "a.wps", "a.dps", "a.pages", "a.numbers"]) {
      expect(inspectSelection([`C:/桌面/${name}`]).kind).not.toBe("ok");
    }
  });

  test("反斜杠路径也认（Windows 上她就是这么选的）", () => {
    const verdict = inspectSelection(["C:\\\\Users\\\\王姐\\\\Desktop\\\\销售表.et"]);
    expect(verdict.kind).toBe("convert-first");
  });
});

describe("nothingReadable：一个都读不了这件事只有一份判断", () => {
  test("一个都读不了（同一家或混着）→ true", () => {
    expect(nothingReadable(inspectSelection(["C:/桌面/销售表.et"]))).toBe(true);
    expect(nothingReadable(inspectSelection(["C:/桌面/销售表.et", "C:/桌面/简报.pages"]))).toBe(true);
  });

  test("能读、混着能读的、或者没选文件 → false", () => {
    expect(nothingReadable({ kind: "ok" })).toBe(false);
    expect(nothingReadable(inspectSelection(["C:/桌面/销售表.et", "C:/桌面/三月.xlsx"]))).toBe(false);
  });
});

describe("pickStepLine：选文件那一步的那一句话", () => {
  test("都能读（或没选）→ 一个字也不说", () => {
    expect(pickStepLine({ kind: "ok" }, 0)).toBeNull();
    expect(pickStepLine({ kind: "ok" }, 3)).toBeNull();
  });

  test("部分读不了 → 只说几份，出路留给「怎么办」那个展开", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/三月.xlsx", "C:/桌面/四月.xlsx"]);
    expect(pickStepLine(verdict, 3)).toBe(FORMAT_COPY.pickLine(1, 3));
    // 只报数：不在这里重复那一大段另存为。
    expect(pickStepLine(verdict, 3)).not.toContain("另存为");
  });

  test("一个都读不了 → 说全打不开，份数和她选的一致", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/名单.ett"]);
    expect(pickStepLine(verdict, 2)).toBe(FORMAT_COPY.pickLine(2, 2));
    expect(pickStepLine(verdict, 2)).toBe("你选的 2 份我都打不开");
  });

  test("只选了一份打不开的 → 就那一份的说法（她最常碰到的就是这种）", () => {
    const verdict = inspectSelection(["C:/桌面/年度总结.wps"]);
    expect(pickStepLine(verdict, 1)).toBe(FORMAT_COPY.pickLine(1, 1));
    expect(pickStepLine(verdict, 1)).toBe("你选的这份我打不开");
  });

  test("混着读不了的（WPS + 苹果）也算得出份数：名单不空", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et", "C:/桌面/简报.pages"]);
    expect(pickStepLine(verdict, 2)).toBe(FORMAT_COPY.pickLine(2, 2));
  });

  test("「怎么办」展开里给的就是确认页那句出路（同一份文案）", () => {
    const verdict = inspectSelection(["C:/桌面/销售表.et"]);
    expect(verdict).toEqual({
      kind: "convert-first",
      blocked: ["C:/桌面/销售表.et"],
      advice: FORMAT_COPY.wpsConvertAdvice,
    });
    expect(FORMAT_COPY.pickAdviceToggle).toBe("怎么办");
  });
});

describe("选文件处与确认页不会各说各话（#88 尾巴）", () => {
  /** 两个界面所在的组件（选文件处是 TaskRunner 的选文件那一步）。 */
  const SCREENS = ["ConfirmSheet.tsx", "TaskRunner.tsx"] as const;
  /** 读不了的扩展名只说得出一种地方：format-check.ts。 */
  const UNREADABLE = [".et", ".ett", ".wps", ".dps", ".pages", ".numbers"] as const;

  test("两处都走 inspectSelection，也共用 formatAdviceNote 那句出路", () => {
    const missing: string[] = [];
    for (const name of SCREENS) {
      const source = readFileSync(join(import.meta.dir, name), "utf8");
      if (!source.includes("inspectSelection")) missing.push(`${name} 没用 inspectSelection`);
      if (!source.includes("formatAdviceNote")) missing.push(`${name} 没共用 formatAdviceNote`);
    }
    expect(missing).toEqual([]);
  });

  test("两处都没有自己的「读不了的格式」清单", () => {
    const owned: string[] = [];
    for (const name of SCREENS) {
      const source = readFileSync(join(import.meta.dir, name), "utf8");
      for (const extension of UNREADABLE) {
        if (source.includes(`"${extension}"`)) owned.push(`${name} 自己写了 ${extension}`);
      }
    }
    expect(owned).toEqual([]);
  });
});
