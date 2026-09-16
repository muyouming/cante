// 把表格变成微信文字的纯逻辑测试。
//
// 这些测试盯的是「贴出去会不会乱」：列有没有对齐（中文按两个宽度算）、长格有没有
// 截断、列多时有没有换成「名称：值」、行多了有没有分段、空值有没有变成 undefined、
// 换行有没有被压平。全都是算出来的东西，不需要浏览器。
import { describe, expect, test } from "bun:test";

import {
  ALIGNED_COLUMN_LIMIT,
  CHAT_ROWS_PER_SEGMENT,
  chatTextSummary,
  displayWidth,
  isTablePath,
  tableToChatText,
} from "./share.ts";

describe("displayWidth：中文按两个宽度算", () => {
  test("半角、全角、emoji", () => {
    expect(displayWidth("")).toBe(0);
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("a中")).toBe(3);
    expect(displayWidth("，")).toBe(2);
    expect(displayWidth("🙂")).toBe(2);
  });
});

describe("tableToChatText：列少时按列对齐", () => {
  const rows = [
    ["姓名", "部门", "金额"],
    ["张三", "行政部", "1200"],
    ["李四", "财务部", "800"],
  ];

  test("表头与每行的列都落在同一竖线上", () => {
    const text = tableToChatText(rows);
    const lines = text.split("\n");
    expect(lines).toEqual(["姓名  部门    金额", "张三  行政部  1200", "李四  财务部  800"]);
  });

  test("每一行的显示宽度相等（对齐的算术没走样）", () => {
    // 最后一列不补空格，所以这里让每个格子的宽度都相等：三列的起点就该在同一条
    // 竖线上，整行宽度也应当完全一致。
    const equal = [
      ["姓名", "部门", "金额"],
      ["张三", "行政部", "1200"],
      ["李四", "财务部", "8000"],
    ];
    const lines = tableToChatText(equal).split("\n");
    const widths = lines.map(displayWidth);
    expect(new Set(widths).size).toBe(1);
  });

  test("末尾没有多余空格（粘出去不会拖一条看不见的尾巴）", () => {
    for (const line of tableToChatText(rows).split("\n")) {
      expect(line).toBe(line.replace(/\s+$/, ""));
    }
  });
});

describe("tableToChatText：长格截断", () => {
  test("超宽的格子截断并补「…」，整行不超过给定的宽度", () => {
    const rows = [["说明"], ["这是一个非常长的说明文字需要被截断"]];
    const text = tableToChatText(rows, { maxWidth: 10 });
    const line = text.split("\n")[1]!;
    expect(line.endsWith("…")).toBe(true);
    expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(line.startsWith("这是一个")).toBe(true);
  });

  test("能装下就不截断，也不加「…」", () => {
    const text = tableToChatText([["说明"], ["短"]], { maxWidth: 20 });
    expect(text).toBe("说明\n短");
  });

  test("多列总宽超限时削最宽的列，仍不超过目标宽度", () => {
    const rows = [
      ["姓名", "备注"],
      ["张三", "这是一段很长的备注内容用来撑爆行宽"],
    ];
    const text = tableToChatText(rows, { maxWidth: 16 });
    for (const line of text.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(16);
    }
    expect(text).toContain("…");
  });
});

describe("tableToChatText：空值写成空", () => {
  test("null / undefined / 空白 都不产生 undefined 这种字样", () => {
    const rows = [
      ["姓名", "备注"],
      ["张三", null],
      ["李四", undefined],
      ["王五", "   "],
    ];
    const text = tableToChatText(rows);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(text.split("\n")).toEqual(["姓名  备注", "张三", "李四", "王五"]);
  });

  test("列多时，空的字段不占一行", () => {
    const rows = [
      ["姓名", "部门", "月份", "金额", "备注"],
      ["张三", "", "", "", ""],
    ];
    const text = tableToChatText(rows);
    expect(text).toBe("姓名：张三");
  });
});

describe("tableToChatText：表头必须保留", () => {
  test("只有表头时也输出表头", () => {
    expect(tableToChatText([["姓名", "金额"]])).toBe("姓名  金额");
  });

  test("数据行再多，每段第一行都是表头", () => {
    const rows = [
      ["姓名", "金额"],
      ["张三", "1"],
      ["李四", "2"],
      ["王五", "3"],
    ];
    const text = tableToChatText(rows, { rowsPerSegment: 2 });
    for (const segment of text.split("\n\n")) {
      expect(segment.split("\n")[0]).toBe("姓名  金额");
    }
  });
});

describe("tableToChatText：列多时改成「名称：值」", () => {
  const rows = [
    ["姓名", "部门", "月份", "金额", "备注"],
    ["张三", "行政部", "1月", "1200", "已发"],
    ["李四", "财务部", "2月", "800", "待发"],
  ];

  test("每条记录一段，一行一项", () => {
    const text = tableToChatText(rows);
    expect(text).toContain("姓名：张三");
    expect(text).toContain("部门：行政部");
    expect(text).toContain("金额：1200");
    expect(text).toContain("备注：已发");
    expect(text).not.toContain("姓名  部门");
  });

  test("记录之间空一行，两条互不粘连", () => {
    const text = tableToChatText(rows);
    expect(text.split("\n\n")).toHaveLength(2);
  });

  test("正好 4 列仍然对齐（边界）", () => {
    const four = [
      ["一", "二", "三", "四"],
      ["1", "2", "3", "4"],
    ];
    const text = tableToChatText(four);
    expect(text).not.toContain("一：1");
    expect(ALIGNED_COLUMN_LIMIT).toBe(4);
  });
});

describe("tableToChatText：行多时按 N 行分段", () => {
  const header = ["姓名", "金额"];
  const body = Array.from({ length: 5 }, (_, index) => [`人${index + 1}`, String(index + 1)]);
  const rows = [header, ...body];

  test("默认每段 CHAT_ROWS_PER_SEGMENT 行，段间空行、每段重报表头", () => {
    const text = tableToChatText(rows, { rowsPerSegment: 2 });
    const segments = text.split("\n\n");
    expect(segments).toHaveLength(3); // 2 + 2 + 1
    expect(segments[0]!.split("\n")).toHaveLength(3); // 表头 + 2 行
    expect(segments[2]!.split("\n")).toHaveLength(2); // 表头 + 1 行
    expect(CHAT_ROWS_PER_SEGMENT).toBeGreaterThan(2);
  });

  test("行数没超时只有一段", () => {
    const text = tableToChatText(rows, { rowsPerSegment: 10 });
    expect(text.split("\n\n")).toHaveLength(1);
  });
});

describe("tableToChatText：换行与制表符压成空格，粘出去不串行", () => {
  test("格子里的换行不会把一条记录拆成两行", () => {
    const text = tableToChatText([["备注"], ["第一行\n第二行"]]);
    expect(text).toBe("备注\n第一行 第二行");
  });

  test("制表符也一样", () => {
    expect(tableToChatText([["备注"], ["甲\t乙"]])).toBe("备注\n甲 乙");
  });
});

describe("tableToChatText：没有内容", () => {
  test("空表返回空字符串", () => {
    expect(tableToChatText([])).toBe("");
  });

  test("末尾整行全空会被去掉（Excel 常带的空行）", () => {
    const text = tableToChatText([
      ["姓名"],
      ["张三"],
      ["", ""],
      ["", ""],
    ]);
    expect(text).toBe("姓名\n张三");
  });
});

describe("chatTextSummary：给用户的一句说明", () => {
  test("说清几行几列和贴出来的样子", () => {
    const rows = [
      ["姓名", "部门", "金额"],
      ["张三", "行政部", "1200"],
      ["李四", "财务部", "800"],
    ];
    const text = tableToChatText(rows);
    const summary = chatTextSummary("销售汇总.xlsx", rows, text);
    expect(summary).toContain("销售汇总.xlsx");
    expect(summary).toContain("2 行");
    expect(summary).toContain("3 列");
    expect(summary).toContain("对齐");
  });

  test("列多时说「名称：内容」的样子", () => {
    const rows = [
      ["姓名", "部门", "月份", "金额", "备注"],
      ["张三", "行政部", "1月", "1200", "已发"],
    ];
    const summary = chatTextSummary("明细.xlsx", rows, tableToChatText(rows));
    expect(summary).toContain("名称：内容");
  });

  test("行多时提醒分成几条发", () => {
    const rows = [["一"], ...Array.from({ length: 45 }, (_, index) => [String(index)])];
    const summary = chatTextSummary("长表.xlsx", rows, tableToChatText(rows));
    expect(summary).toContain("分成 3 条发");
  });

  test("空表不假装准备好了", () => {
    const summary = chatTextSummary("空表.xlsx", [], "");
    expect(summary).toContain("没有可以贴进微信的内容");
  });

  test("没有文件名也能说人话", () => {
    const summary = chatTextSummary("", [["一"], ["1"]], "一\n1");
    expect(summary).toContain("这张表");
  });
});

describe("isTablePath：哪些结果能按表格读出来", () => {
  test("xlsx / xls / csv 算表格，大小写都认", () => {
    expect(isTablePath("/tmp/销售.xlsx")).toBe(true);
    expect(isTablePath("/tmp/表.XLS")).toBe(true);
    expect(isTablePath("/tmp/名单.csv")).toBe(true);
  });

  test("别的类型不算", () => {
    expect(isTablePath("/tmp/说明.pdf")).toBe(false);
    expect(isTablePath("/tmp/通知.docx")).toBe(false);
    expect(isTablePath("/tmp/照片.jpg")).toBe(false);
    expect(isTablePath("/tmp/没有扩展名")).toBe(false);
  });
});
