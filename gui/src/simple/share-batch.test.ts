// 「一批结果一次交出去」的纯逻辑测试。
//
// 这些测试盯的是「一段文字里能不能一眼分辨出是一份一份」：总起那句在不在、每份
// 有没有它自己的名字、段与段之间有没有空行、一份都没拼出来时会不会硬凑一段空话。
// 还有两条回归：单份的行为不能因为加了批量而变样，以及这段文字里绝不能出现她
// 本机的完整位置。
//
// 全是算出来的东西，不需要浏览器，也不需要磁盘（share.ts 不碰剪贴板）。
import { describe, expect, test } from "bun:test";

import { BATCH } from "./copy-batch.ts";
import { fileName } from "./run.ts";
import { batchChatText, canShareBatch, tableToChatText, type BatchEntry } from "./share.ts";

/** 三份真表格：名字各不相同，内容也各不相同。 */
const three: BatchEntry[] = [
  {
    name: "一月汇总.xlsx",
    rows: [
      ["姓名", "金额"],
      ["张三", "1200"],
      ["李四", "800"],
    ],
  },
  {
    name: "二月汇总.xlsx",
    rows: [
      ["姓名", "金额"],
      ["王五", "300"],
    ],
  },
  {
    name: "三月汇总.xlsx",
    rows: [
      ["部门", "人数"],
      ["行政部", "4"],
    ],
  },
];

describe("batchChatText：三份拼成一段，但一眼能分辨", () => {
  test("总起那句在最前面，份数是真的", () => {
    const { text, included } = batchChatText(three);
    expect(included).toBe(3);
    expect(text.startsWith(BATCH.heading(3))).toBe(true);
  });

  test("每份都含它自己的名字", () => {
    const { text } = batchChatText(three);
    for (const entry of three) {
      expect(text).toContain(entry.name);
    }
  });

  test("三段各自成段：除总起外，空行分隔的块数正好是份数", () => {
    const { text } = batchChatText(three);
    // 总起与第一份之间也空一行，所以「总起 + 三份」一共 4 块。
    const blocks = text.split("\n\n");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toBe(BATCH.heading(3));
  });

  test("每份的正文就是它单独复制时会贴出去的那段（沿用同一套排版）", () => {
    const { text } = batchChatText(three);
    for (const entry of three) {
      expect(text).toContain(tableToChatText(entry.rows));
    }
  });

  test("不是五份拼成一坨：每份前面都有一句「第 N 份」", () => {
    const { text } = batchChatText(three);
    for (let index = 1; index <= 3; index += 1) {
      expect(text).toContain(`第 ${index} 份`);
    }
  });
});

describe("batchChatText：单份的行为与现在一致（回归）", () => {
  test("一份时也有总起，正文与单独复制逐字相同", () => {
    const entry = three[0]!;
    const { text, included, skipped } = batchChatText([entry]);
    expect(included).toBe(1);
    expect(skipped).toBe(0);
    expect(text.startsWith(BATCH.heading(1))).toBe(true);
    // 正文必须和 ResultCard 里那份单份复制用的函数给出的一模一样。
    expect(text).toContain(tableToChatText(entry.rows));
  });
});

describe("batchChatText：空表与读不出来如实交代", () => {
  test("空表不占段，只计入 skipped", () => {
    const entries: BatchEntry[] = [
      three[0]!,
      { name: "空的.xlsx", rows: [] },
    ];
    const { text, included, skipped } = batchChatText(entries);
    expect(included).toBe(1);
    expect(skipped).toBe(1);
    expect(text).not.toContain("空的.xlsx");
    expect(text).toContain("一月汇总.xlsx");
  });

  test("一份都拼不出来时给空字符串，不硬凑一段空话", () => {
    const { text, included, skipped } = batchChatText([
      { name: "甲.xlsx", rows: [] },
      { name: "乙.xlsx", rows: [] },
    ]);
    expect(text).toBe("");
    expect(included).toBe(0);
    expect(skipped).toBe(2);
  });

  test("没有份数时也是空字符串", () => {
    expect(batchChatText([])).toEqual({ text: "", included: 0, skipped: 0 });
  });
});

describe("batchChatText：把她本机的完整位置挡在外面", () => {
  test("段首只写名字：就算结果来自一个深目录，那段文字里也没有她电脑上的位置", () => {
    // 面板就是这么取的：ResultEntry.name 已经是 fileName(path)，位置根本不进
    // BatchEntry（类型里没有这一项）。这里用带家目录前缀的路径过一遍，钉住这个结果。
    // 用户名用文档占位写法（不是真机器），但前缀是真的 —— 泄露的话断言会红。
    const where = "/Users/用户名/Desktop/八月报表";
    const path = `${where}/汇总.xlsx`;
    const { text } = batchChatText([{ name: fileName(path), rows: [["姓名"], ["张三"]] }]);
    expect(text).toContain("汇总.xlsx");
    expect(text).not.toContain(where);
    expect(text).not.toContain("/Users/");
  });

  test("三段都通了：总起、每段标题、表头里都没有位置", () => {
    const where = "C:\\Users\\用户名\\Documents";
    const entries: BatchEntry[] = ["一.xlsx", "二.xlsx"].map((name) => ({
      name: fileName(`${where}\\${name}`),
      rows: [["姓名"], ["张三"]],
    }));
    const { text } = batchChatText(entries);
    expect(text).not.toContain(where);
    expect(text).not.toContain("C:\\Users\\");
    expect(text).toContain("一.xlsx");
    expect(text).toContain("二.xlsx");
  });
});

describe("canShareBatch：空的时候不给按钮", () => {
  test("一份都没有时不给出口", () => {
    expect(canShareBatch(0)).toBe(false);
    expect(canShareBatch(-1)).toBe(false);
    expect(canShareBatch(Number.NaN)).toBe(false);
  });

  test("有一份以上才给", () => {
    expect(canShareBatch(1)).toBe(true);
    expect(canShareBatch(5)).toBe(true);
  });
});
