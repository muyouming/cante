// 「文件在哪、怎么打印」的纯逻辑测试。
//
// 这里盯住两件她真会问的事：
//   * 文件到底在哪儿 —— 界面不能说机器路径（「路径」是黑名单词），要把桌面、
//     下载、文档这些她认得的位置认出来；认不出来就照实说「原来那个文件夹」，
//     绝不猜、也绝不把 C:\Users\... 丢给她；
//   * 打印怎么做 —— 我们不替她按打印（会浪费纸），只给一句她能照做的话。
//
// 判断是纯的，不需要浏览器；文案单独在 copy-print.ts。

import { describe, expect, test } from "bun:test";

import { LOCATION, PRINT } from "./copy-print.ts";
import { placeOf } from "./location.ts";

describe("placeOf：把她熟悉的位置认出来", () => {
  test("桌面 / 下载 / 文档 / 图片 / 微信，中英文都认，Windows 与苹果分隔符都认", () => {
    expect(placeOf("C:\\Users\\用户名\\Desktop\\汇总表.xlsx")).toBe("desktop");
    expect(placeOf("C:\\Users\\用户名\\桌面\\汇总表.xlsx")).toBe("desktop");
    expect(placeOf("/home/user/Desktop/汇总表.xlsx")).toBe("desktop");
    expect(placeOf("C:\\Users\\用户名\\Downloads\\汇总表.xlsx")).toBe("downloads");
    expect(placeOf("C:\\Users\\用户名\\下载\\汇总表.xlsx")).toBe("downloads");
    expect(placeOf("C:\\Users\\用户名\\Documents\\汇总表.xlsx")).toBe("documents");
    expect(placeOf("C:\\Users\\用户名\\我的文档\\汇总表.xlsx")).toBe("documents");
    expect(placeOf("C:\\Users\\用户名\\Pictures\\照片.jpg")).toBe("pictures");
    expect(placeOf("C:\\WeChat Files\\汇总表.xlsx")).toBe("wechat");
    expect(placeOf("C:\\Users\\用户名\\微信\\汇总表.xlsx")).toBe("wechat");
  });

  test("大小写与正反斜杠混用都认", () => {
    expect(placeOf("C:/Users/username/DESKTOP/汇总表.xlsx")).toBe("desktop");
    expect(placeOf("C:\\Users\\username\\Desktop/汇总表.xlsx")).toBe("desktop");
  });

  test("认不出来就说认不出来，绝不猜", () => {
    expect(placeOf("C:\\项目资料\\2026\\汇总表.xlsx")).toBe("other");
    expect(placeOf("汇总表.xlsx")).toBe("other");
    // 桌面下面的子文件夹不是桌面：说成桌面会让她去错地方。
    expect(placeOf("C:\\Users\\用户名\\Desktop\\备份\\汇总表.xlsx")).toBe("other");
  });

  test("只是名字里带「桌面」两字、实际不是桌面的，不算桌面", () => {
    // 末段是「桌面备份」，不是「桌面」。
    expect(placeOf("D:\\资料\\桌面备份\\汇总表.xlsx")).toBe("other");
  });
});

describe("打印那句话", () => {
  test("说清先打开、再按 Ctrl+P，且不替她打印", () => {
    expect(PRINT.hint).toContain("打开文件");
    expect(PRINT.hint).toContain("Ctrl+P");
    expect(PRINT.hint).toContain("打印");
    // 我们不替她按打印：这句话是教她按，不是承诺我们按。
    expect(PRINT.hint).not.toContain("我帮你打印");
  });

  test("每个位置的说明都是完整的一句中文，且不含机器路径写法", () => {
    for (const text of Object.values(LOCATION)) {
      expect(text.length).toBeGreaterThan(4);
      expect(text).not.toContain("\\");
      expect(text).not.toContain("/Users/");
      expect(text).not.toContain("C:");
    }
    // 认不出来时一定要给出路（按钮名字要说得出）。
    expect(LOCATION.other).toContain("打开所在文件夹");
  });
});
