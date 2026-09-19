// 「表里是什么样」的测试——她自己能核对的那三个数。
//
// 这一层最容易犯的错（也是这一轮存在的理由）：把「我查过了，内容没问题」这种自证
// 写进界面。我们给的不是判断，是**从产出文件里真读出来的三个数**（行数、列名、
// 首屏几行）。所以这里钉住三件事：
//
//   1. 数字真的跟着读回来的行变（同一个函数喂 42 行就是 42，喂 7 行就是 7）——把
//      它改成写死一个数，这条立刻红；
//   2. 读不出来时绝不报 0、也不当成空表，只说「没能读到」；
//   3. 文案里不许出现「我查过了 / 没问题 / 内容正确」这类自证。
//
// 不连桥接：真读那一步是参数，测试传假的。
//
//   bun test src
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { SHEET_PEEK } from "./copy-sheet-peek.ts";
import { PEEK_ROWS, peekFromResponse, peekSheet, readSheetPeek } from "./sheet-peek.ts";

const read = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

/** 一张「表头 + N 行」的表，行号写进第一格，方便逐行核对是照抄的。 */
function tableWith(rows: number): string[][] {
  const grid: string[][] = [["姓名", "部门", "金额"]];
  for (let index = 1; index <= rows; index += 1) {
    grid.push([`第${index}个人`, "行政", String(index * 100)]);
  }
  return grid;
}

describe("peekSheet：三个数都跟着读回来的行走", () => {
  test("42 行就是 42：行数、列名、首屏三行都对得上", () => {
    const result = peekSheet(tableWith(42));
    expect(result.kind).toBe("ok");
    expect(result.peek).not.toBeNull();
    expect(result.peek!.rows).toBe(42);
    expect(result.peek!.columnCount).toBe(3);
    expect(result.peek!.columns).toEqual(["姓名", "部门", "金额"]);
    // 只照抄头 3 行，而且是原来那三行，一个字都没动。
    expect(result.peek!.head).toEqual([
      ["第1个人", "行政", "100"],
      ["第2个人", "行政", "200"],
      ["第3个人", "行政", "300"],
    ]);
    expect(result.peek!.head).toHaveLength(PEEK_ROWS);
  });

  test("喂 7 行就是 7 行（换一份输入，数就跟着变——写死一个数这条会红）", () => {
    const seven = peekSheet(tableWith(7));
    expect(seven.peek!.rows).toBe(7);
    // 数据只有 7 行，头 3 行之外不该出现第 4 行。
    expect(seven.peek!.head).toHaveLength(PEEK_ROWS);
    const fewer = peekSheet(tableWith(2));
    expect(fewer.peek!.rows).toBe(2);
    // 只有两行数据时，首屏就两行——不补、不凑。
    expect(fewer.peek!.head).toHaveLength(2);
  });

  test("末尾整行空的不算数据行（Excel 常见的一排空行）", () => {
    const rows = tableWith(3);
    rows.push(["", "", ""], ["", "", ""]);
    expect(peekSheet(rows).peek!.rows).toBe(3);
  });

  test("单元格照抄：换行和制表符只压成空格，字一个不少", () => {
    const result = peekSheet([
      ["说明", "备注"],
      ["第一行\n第二行", "甲\t乙"],
    ]);
    expect(result.peek!.head[0]).toEqual(["第一行 第二行", "甲 乙"]);
  });

  test("中间的空格子保留（那是表原来的样子），只去掉末尾补出来的空列", () => {
    const result = peekSheet([
      ["姓名", "部门", "金额", "", ""],
      ["张三", "", "1200", "", ""],
    ]);
    expect(result.peek!.columns).toEqual(["姓名", "部门", "金额"]);
    expect(result.peek!.head[0]).toEqual(["张三", "", "1200"]);
  });

  test("只有列名、一行数据都没有：报 0 行，但要走「只有列名」那条路", () => {
    const result = peekSheet([["姓名", "金额"]]);
    expect(result.kind).toBe("ok");
    expect(result.peek!.rows).toBe(0);
    expect(result.peek!.head).toEqual([]);
  });

  test("整张表都是空的 → empty，不是 ok 0 行", () => {
    expect(peekSheet([]).kind).toBe("empty");
    expect(peekSheet([[], []]).kind).toBe("empty");
    expect(peekSheet([]).peek).toBeNull();
  });

  test("没读回来（null）→ unknown，绝不报 0、也绝不当成空表", () => {
    const result = peekSheet(null);
    expect(result.kind).toBe("unknown");
    expect(result.reason).toBe("failed");
    expect(result.peek).toBeNull();
  });
});

describe("peekFromResponse：桥接返回的形状不对就不装作读到了", () => {
  test("正常形状：读出 rows", () => {
    expect(peekFromResponse({ rows: tableWith(5) }).peek!.rows).toBe(5);
  });

  test("坏形状一律 unknown，不把坏数据当成空表", () => {
    expect(peekFromResponse(null).kind).toBe("unknown");
    expect(peekFromResponse("oops").kind).toBe("unknown");
    expect(peekFromResponse({}).kind).toBe("unknown");
    expect(peekFromResponse({ rows: "nonsense" }).kind).toBe("unknown");
    expect(peekFromResponse({ rows: 42 }).kind).toBe("unknown");
  });
});

describe("readSheetPeek：走真读那条路，读不出来就如实说", () => {
  test("把文件位置和工具位置都传给真读函数", async () => {
    const seen: Array<[string, string]> = [];
    const result = await readSheetPeek("/work/结果.xlsx", "/opt/cante-sheets", async (path, tool) => {
      seen.push([path, tool]);
      return { rows: tableWith(42) };
    });
    expect(seen).toEqual([["/work/结果.xlsx", "/opt/cante-sheets"]]);
    expect(result.peek!.rows).toBe(42);
  });

  test("这台电脑没有读表格的工具：连试都不试，说「还读不出」", async () => {
    let called = 0;
    const result = await readSheetPeek("/work/结果.xlsx", null, async () => {
      called += 1;
      return { rows: tableWith(1) };
    });
    expect(called).toBe(0);
    expect(result.kind).toBe("unknown");
    expect(result.reason).toBe("no-tool");
    expect(result.peek).toBeNull();
  });

  test("读的时候抛错 → unknown，不假装读过", async () => {
    const result = await readSheetPeek("/work/坏了.xlsx", "/opt/cante-sheets", async () => {
      throw new Error("read failed");
    });
    expect(result.kind).toBe("unknown");
    expect(result.reason).toBe("failed");
    expect(result.peek).toBeNull();
  });
});

describe("界面上这些数必须真读出来，不许写死", () => {
  test("生产路径真的调了真读函数，而且用的是探测到的工具位置", () => {
    const card = read("./ResultCard.tsx");
    expect(card).toContain("readSheetPeek");
    expect(card).toContain("sheetCapability");
    // 工具没探测到就把 null 传下去（而不是编一个位置）。
    expect(card).toMatch(/cap\.available\s*\?\s*cap\.path\s*:\s*null/);
  });

  test("文案里没有「我查过了 / 没问题」这类自证", () => {
    const self = read("./copy-sheet-peek.ts");
    for (const bad of ["我查过", "我核对过内容", "没问题", "内容正确", "内容没问题", "放心", "保证"]) {
      expect(self.includes(bad), `copy-sheet-peek.ts 出现了自证说法「${bad}」`).toBe(false);
    }
    // 但它必须真的给出「我读不到」这条出路。
    expect(SHEET_PEEK.unknown.length).toBeGreaterThan(0);
    expect(SHEET_PEEK.noTool.length).toBeGreaterThan(0);
  });
});
