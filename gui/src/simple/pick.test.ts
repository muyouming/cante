// 「她手里刚拿到一个文件，不知道能用它做什么」这一步的断言。
//
// 这一步最怕两件事，也正是这里钉住的：
//   1. **张冠李戴**：拿一个 .xlsx 却给出一堆 PDF 的事，或者图片给出表格的事；
//   2. **假装知道**：认不出来的文件也硬凑几条建议出来，让她以为这是对的。
//
// 另外两条是产品约束：建议**只能指向真的存在的卡**（复用现有卡，绝不新造任务），
// 以及**最多 5 条**（她选不出来时，多给一条都是负担）。
//
// 这里不替代真机上点一下的效果——那由界面（ConfirmSheet）与 dom-smoke 覆盖，
// 见本轮报告「没能验证什么」。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MAX_PICK_SUGGESTIONS, kindOf, kindsOf, suggestFromFiles } from "./pick.ts";
import { PICK_FROM_FILE, PICK_SENTENCES } from "./copy-pick.ts";
import { taskById } from "./tasks/index.ts";

const XLSX = "C:/桌面/报名表.xlsx";
const PDF = "C:/桌面/发票.pdf";
const IMAGE = "C:/桌面/照片.jpg";

/** 一组建议的卡 id。 */
const idsOf = (paths: string[]): string[] => suggestFromFiles(paths).map((item) => item.task.id);

describe("按文件类型给建议：不许张冠李戴", () => {
  test("xlsx / pdf / 图片 各给出不同的建议", () => {
    const sheet = idsOf([XLSX]);
    const pdf = idsOf([PDF]);
    const image = idsOf([IMAGE]);
    for (const [label, list] of [
      ["表格", sheet],
      ["PDF", pdf],
      ["图片", image],
    ] as const) {
      expect(list.length, `${label} 一条建议都没有`).toBeGreaterThan(0);
    }
    // 三类的建议集合两两不相交：拿表格却给 PDF 的事，就是张冠李戴。
    expect(new Set([sheet, pdf, image].flat()).size).toBe(
      sheet.length + pdf.length + image.length,
    );
  });

  test("表格类只推表格该做的事，不推 PDF / 图片的事", () => {
    const sheet = idsOf([XLSX]);
    expect(sheet).toContain("excel.merge");
    expect(sheet).not.toContain("pdf.merge");
    expect(sheet).not.toContain("vision.table");
  });

  test("PDF 类只推 PDF 该做的事，不推表格 / 图片的事", () => {
    const pdf = idsOf([PDF]);
    expect(pdf).toContain("pdf.merge");
    expect(pdf).not.toContain("excel.merge");
    expect(pdf).not.toContain("vision.table");
  });

  test("图片类只推「图片变成表格」，不推别的", () => {
    expect(idsOf([IMAGE])).toEqual(["vision.table"]);
  });

  test("混着好几类时，两类的事都在，谁也不会把名额占满", () => {
    const mixed = idsOf([XLSX, PDF]);
    expect(mixed.some((id) => id.startsWith("excel."))).toBe(true);
    expect(mixed.some((id) => id.startsWith("pdf."))).toBe(true);
    expect(mixed.length).toBeLessThanOrEqual(MAX_PICK_SUGGESTIONS);
  });

  test("多看几个后缀也对得上：xls / csv 算表格，png / heic 算图片", () => {
    expect(kindOf("C:/桌面/一月.xls")).toBe("spreadsheet");
    expect(kindOf("C:/桌面/一月.csv")).toBe("spreadsheet");
    expect(kindOf("C:/桌面/截图.PNG")).toBe("image");
    expect(kindOf("C:\\桌面\\照片.HEIC")).toBe("image");
    expect(kindOf("C:/桌面/材料.pdf")).toBe("pdf");
  });

  test("分类跟着卡片自己的 accept 走：谁收这个后缀，它就属于哪一类", () => {
    // 后缀清单只有一处真相（卡片）。认出来是某一类时，这一类代表卡必须真的收它。
    for (const [path, kind] of [
      ["C:/桌面/一月.xlsx", "spreadsheet"],
      ["C:/桌面/一月.xls", "spreadsheet"],
      ["C:/桌面/一月.csv", "spreadsheet"],
      ["C:/桌面/材料.pdf", "pdf"],
      ["C:/桌面/照片.jpg", "image"],
      ["C:/桌面/截图.png", "image"],
      ["C:/桌面/照片.heic", "image"],
    ] as const) {
      expect(kindOf(path), `${path} 应该是 ${kind}`).toBe(kind);
    }
    // vision.table 的 accept 里没有 gif，所以 .gif 认不出来——这是对的，不许硬说它是图片。
    expect(kindOf("C:/桌面/动图.gif")).toBe("unknown");
  });
});

describe("认不出的类型：给通用出路，不许假装知道", () => {
  test("认不出的后缀、没有后缀、空选择：一条建议都不给", () => {
    expect(suggestFromFiles(["C:/桌面/程序.exe"])).toEqual([]);
    expect(suggestFromFiles(["C:/桌面/没有后缀的文件"])).toEqual([]);
    expect(suggestFromFiles([])).toEqual([]);
    expect(kindsOf(["C:/桌面/程序.exe"])).toEqual([]);
  });

  test("通用出路是「用一句话说给我听」，写在文案模块里", () => {
    // 界面上认不出来时显示的就是这一句（不是空白，也不是编出来的建议）。
    expect(PICK_FROM_FILE.noIdea).toContain("一句");
    expect(PICK_FROM_FILE.noIdea.trim().length).toBeGreaterThan(0);
  });

  test("文件夹名里的点不算后缀（「2024.05 报表」不是一类文件）", () => {
    expect(kindOf("C:/桌面/2024.05 报表/一月")).toBe("unknown");
    // 但真的带后缀的还是认得出来。
    expect(kindOf("C:/桌面/2024.05 报表/一月.xlsx")).toBe("spreadsheet");
  });
});

describe("每条建议都指向一张真卡、都是一句人话、最多 5 条", () => {
  const ALL_PATHS = [
    XLSX,
    "C:/桌面/一月.xls",
    "C:/桌面/一月.csv",
    PDF,
    IMAGE,
    "C:/桌面/截图.png",
  ];

  test("每一条都能用 taskById 取到那张卡（复用现有卡，不新造任务）", () => {
    for (const path of ALL_PATHS) {
      for (const item of suggestFromFiles([path])) {
        expect(taskById(item.task.id), `${path} 指向了不存在的卡 ${item.task.id}`).toBeDefined();
      }
    }
  });

  test("每一条都有一句人话，而且不是照抄卡名（卡名是给「按名字找卡」用的）", () => {
    for (const path of ALL_PATHS) {
      for (const item of suggestFromFiles([path])) {
        expect(item.sentence.trim().length, `${item.task.id} 没有一句人话`).toBeGreaterThan(0);
        expect(item.sentence).not.toBe(item.task.title);
      }
    }
  });

  test("每一类都给不超过 5 条", () => {
    for (const path of ALL_PATHS) {
      expect(suggestFromFiles([path]).length).toBeLessThanOrEqual(MAX_PICK_SUGGESTIONS);
    }
  });

  test("PICK_SENTENCES 里的每个 id 都是真的卡（没有指向不存在的东西的死句子）", () => {
    for (const id of Object.keys(PICK_SENTENCES)) {
      expect(taskById(id), `PICK_SENTENCES 里的 ${id} 不是一张真的卡`).toBeDefined();
    }
  });

  test("同一批文件里不重复推同一张卡", () => {
    const ids = idsOf([XLSX, "C:/桌面/一月.xls", "C:/桌面/一月.csv"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// 判断和文案都对了，确认页上没画出来也等于零。照仓库里其他守卫的做法把组件当
// 文本读一遍：接线断了一行就能看出来。（替换卡的路子必须是 store.startRun——
// 和生产路径同一条，而不是只把标题改一下。）
describe("确认页真的把这一块画出来，点一句就换成那张卡", () => {
  const sheet = readFileSync(join(import.meta.dir, "ConfirmSheet.tsx"), "utf8");

  test("文案与判断都从 pick / copy-pick 来，不在组件里另写一份", () => {
    expect(sheet).toContain('from "./pick.ts"');
    expect(sheet).toContain('from "./copy-pick.ts"');
    expect(sheet).toContain("suggestFromFiles(");
    expect(sheet).toContain("PICK_FROM_FILE.heading");
    expect(sheet).toContain("PICK_FROM_FILE.noIdea");
    expect(sheet).toContain("PICK_FROM_FILE.hint");
  });

  test("点一句走 store.startRun（换乘那张卡），不是只改个显示", () => {
    // useIdea 处理函数里必须真的调 startRun，而且用的是那张卡的 id / 标题 / 计划。
    const at = sheet.indexOf("function useIdea(");
    expect(at).toBeGreaterThan(-1);
    const body = sheet.slice(at, sheet.indexOf("\n  }", at));
    expect(body).toContain("props.store.startRun(");
    expect(body).toContain("item.task.id");
    expect(body).toContain("item.task.plan");
    // 换卡时把她选的文件带过去（不是清空重来）。
    expect(body).toContain("current.files");
  });

  test("每一条建议都是能点的 button，而且够高（≥44px）", () => {
    const at = sheet.indexOf("PICK_FROM_FILE.hint");
    expect(at).toBeGreaterThan(-1);
    const open = sheet.lastIndexOf("<button", at);
    const close = sheet.indexOf("</button>", at);
    const tag = sheet.slice(open, close);
    expect(tag).toContain("min-h-[44px]");
    expect(tag).toContain("useIdea(item)");
  });

  test("只给「真要文件、手里真有文件」的事看：不需要文件的卡、微信那族都不出现", () => {
    const at = sheet.indexOf("const showFileIdeas");
    expect(at).toBeGreaterThan(-1);
    const body = sheet.slice(at, sheet.indexOf(";", at) + 1);
    expect(body).toContain("ideasApply()");
    const apply = sheet.indexOf("const ideasApply");
    const applyBody = sheet.slice(apply, sheet.indexOf(";", sheet.indexOf("=>", apply)) + 1);
    expect(applyBody).toContain("needsFiles()");
    expect(applyBody).toContain("!needsFolder()");
    expect(applyBody).toContain("!pastesContent()");
    expect(applyBody).toContain("files().length > 0");
  });
});
