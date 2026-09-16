// #88 — 动手前的格式判断。
//
// 这个模块的全部价值就是：WPS / 苹果自己的格式在**跑之前**就被认出来，而不是
// 跑了一会儿才说读不了。所以测试按四种结论逐个钉住，外加大小写、无扩展名、
// 空数组这些边界（真机上这些都是她会遇到的样子）。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { inspectSelection } from "./format-check.ts";
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
    // 给不出一条统一的另存为，所以没有 blocked 名单。
    expect(verdict.advice).toBe(FORMAT_COPY.mixedConvertAdvice);
    expect(verdict.advice).toContain("另存为");
    expect(verdict.advice).toContain("导出");
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
