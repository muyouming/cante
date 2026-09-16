// 行政月度例事三张卡（#85）。
//
// 这三张卡的服务对象是行政/财务：把考勤、花名册、工资按人合起来；把两张
// 名单的差别列成变化清单；把台账里快到期的合同证照挑出来。三条底线必须
// 一直留在指令里，所以单独守住：
//   * 靠猜才能对上的地方要单独列成「需要你确认」，不许硬塞进结果；
//   * 日期写法不统一时先说明是怎么理解的，空值和坏值不许猜；
//   * 结果一律另存为新文件，原来的表只读。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { ADMIN_TASKS } from "./admin.ts";
import { TASKS, type TaskDef } from "./index.ts";

/** 王姐不该在卡片上读到的词。 */
const JARGON = [
  "模型",
  "令牌",
  "会话",
  "上下文",
  "权限",
  "路径",
  "工具调用",
  "提示词",
  "token",
  "provider",
  "prompt",
  "diff",
  "worktree",
  "json",
  "api",
  "agent",
];

function userFacing(task: TaskDef): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: "title", text: task.title },
    { where: "example", text: task.example },
  ];
  task.plan.forEach((step, index) => out.push({ where: `plan[${index}]`, text: step }));
  (task.risks ?? []).forEach((risk, index) => out.push({ where: `risks[${index}]`, text: risk }));
  task.summaryHints.forEach((hint, index) => out.push({ where: `summaryHints[${index}]`, text: hint }));
  return out;
}

function task(id: string): TaskDef {
  const found = ADMIN_TASKS.find((item) => item.id === id);
  expect(found).toBeDefined();
  return found!;
}

const SHEETS = ["/示例/考勤.xlsx", "/示例/花名册.xlsx", "/示例/工资.xlsx"];

describe("行政月度例事三张卡的目录形状（#85）", () => {
  test("三张卡片都在，id 和顺序固定", () => {
    expect(ADMIN_TASKS.map((item) => item.id)).toEqual([
      "admin.byperson",
      "admin.changes",
      "admin.expiry",
    ]);
  });

  test("每张卡都完整：表格组、要文件、4 步计划、3-4 条风险、4 条结果提示", () => {
    for (const item of ADMIN_TASKS) {
      expect(item.group).toBe("表格");
      expect(item.needs).toBe("files");
      expect(item.title.length).toBeGreaterThan(3);
      expect(item.example.length).toBeGreaterThan(5);
      expect(item.plan.length).toBe(4);
      expect((item.risks ?? []).length).toBeGreaterThanOrEqual(3);
      expect((item.risks ?? []).length).toBeLessThanOrEqual(4);
      expect(item.summaryHints.length).toBe(4);
      // 最后一步永远是在说结果另存，不碰原件。
      expect(item.plan.join("")).toMatch(/新文件|另存|不动|不删/);
    }
  });

  test("三张卡都读表格，后缀合法", () => {
    for (const item of ADMIN_TASKS) {
      expect(item.accept).toContain("xlsx");
      expect(item.accept).toContain("csv");
      for (const ext of item.accept ?? []) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext).not.toContain(".");
      }
    }
  });

  test("三张卡的说明都走公共信封，文件一个不少", () => {
    for (const item of ADMIN_TASKS) {
      const prompt = item.prompt(SHEETS, "我的特殊要求：结果里加一列备注");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain("结果另存为新文件，不要改原文件");
      expect(prompt).toContain("【要做的事】");
      expect(prompt).toContain("【怎么做】");
      expect(prompt).toContain("【用户的原话】");
      expect(prompt).toContain("【做完告诉我】");
      expect(prompt).toContain("【需要你核对】");
      expect(prompt).toContain("我的特殊要求：结果里加一列备注");
      for (const [index, path] of SHEETS.entries()) {
        expect(prompt).toContain(`${index + 1}. ${path}`);
      }
      // 缺工具时必须先停，不许硬做。
      expect(prompt).toContain("缺少读或写这种文件的工具");
      // 原表只读：信封里的规矩 + 卡片自己再写一遍。
      expect(prompt).toContain("原来的文件只能读");
      expect(prompt).toContain("不要改、不要删、不要覆盖");
    }
  });

  test("三张卡的 id 在本族里唯一，并且都真的进了目录（各一次）", () => {
    const ids = ADMIN_TASKS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 接线由集成者负责：这三张卡必须出现在 `TASKS` 里，而且**只出现一次**
    // （漏接线 → 用户看不到；重复接线 → 首页出现两张一样的卡）。
    for (const id of ids) {
      expect(TASKS.filter((item) => item.id === id)).toHaveLength(1);
    }
  });

  test("风险都是具体可核对的一句话，不是空话", () => {
    const FILLER = ["仅供参考", "可能有误", "如有误差", "不保证", "不一定完全准确"];
    for (const item of ADMIN_TASKS) {
      for (const risk of item.risks ?? []) {
        expect(risk.length).toBeGreaterThan(10);
        for (const word of FILLER) expect(risk).not.toContain(word);
      }
    }
  });

  test("面向用户的文字里没有技术词", () => {
    for (const item of ADMIN_TASKS) {
      for (const { where, text } of userFacing(item)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });
});

describe("按人合并多张表", () => {
  const prompt = task("admin.byperson").prompt(SHEETS, "");

  test("名字对不上、只能靠猜的地方要单独列成「需要你确认」，不许硬塞", () => {
    expect(prompt).toContain("需要你确认");
    expect(prompt).toContain("不要硬塞");
    // 风险里也把「靠猜要说明」写成可核对的一条。
    expect((task("admin.byperson").risks ?? []).join("")).toContain("需要你确认");
  });

  test("姓名匹配要容忍空格与全半角，但统一过什么要说出来", () => {
    expect(prompt).toContain("前后的空格、名字中间的空格、全角半角");
    expect(prompt).toContain("把统一过哪些写法说出来");
    expect((task("admin.byperson").risks ?? []).join("")).toContain("全角半角");
  });

  test("一人多行怎么并，先问用户再动手", () => {
    expect(prompt).toContain("先问我两件事");
    expect(prompt).toContain("一个人占好几行的");
    expect(prompt).toContain("还是原样保留多行");
    expect(prompt).toContain("没答就不要自己定");
    expect((task("admin.byperson").risks ?? []).join("")).toContain("先停下来问你");
  });

  test("工人编号优先，编号前面的 0 按原样保留", () => {
    expect(prompt).toContain("优先用它们认人");
    expect((task("admin.byperson").risks ?? []).join("")).toContain("001、0755");
  });

  test("结果另存为新文件，原表只读", () => {
    expect(prompt).toContain("结果_按人合并");
    expect(prompt).toContain("原来的表只能读");
  });
});

describe("找出两张表之间的变化", () => {
  const prompt = task("admin.changes").prompt(SHEETS, "");

  test("固定三类：新增、离职、信息变更", () => {
    expect(prompt).toContain("新增（只在第二张表里）、离职（只在第一张表里）、信息变更");
  });

  test("每条变化写清是谁、哪一项、旧值改成什么、来自第几行", () => {
    expect(prompt).toContain("改之前是什么、改之后是什么");
    expect(prompt).toContain("第一张表第几行、第二张表第几行");
    expect(prompt).toContain("一行里改了多项就分成多条");
  });

  test("靠哪一列认人，先问用户确认，没确认不动手", () => {
    expect(prompt).toContain("先问我确认按哪一列认人");
    expect(prompt).toContain("没确认就先停在这里");
    expect((task("admin.changes").risks ?? []).join("")).toContain("重名");
  });

  test("写法差一点点的单独列出来确认，不直接算成一进一出", () => {
    expect(prompt).toContain("需要你确认");
    expect((task("admin.changes").risks ?? []).join("")).toContain("不直接算成新增和离职");
  });

  test("只写表上看得见的差别，不下人事结论", () => {
    expect(prompt).toContain("不要下「谁被辞退了」「谁跳槽了」这类结论");
    expect(prompt).toContain("结果_变化清单");
  });
});

describe("到期提醒", () => {
  const prompt = task("admin.expiry").prompt(SHEETS, "");
  const risks = (task("admin.expiry").risks ?? []).join("");

  test("默认按 30 天算，并在结果里说明取了多少天", () => {
    expect(prompt).toContain("未来 30 天内到期");
    expect(prompt).toContain("期限默认按 30 天算");
    expect(prompt).toContain("这一次取的是多少天");
  });

  test("日期写法不统一时先说明怎么理解，空值和坏值不许猜", () => {
    expect(prompt).toContain("2026.7.1」当成 2026 年 7 月 1 日");
    expect(prompt).toContain("逐种说明你是怎么理解的");
    expect(prompt).toContain("日期看不清");
    expect(prompt).toContain("不要猜一个日期填上");
    // 风险里把混格式和坏值都写成可核对的一条。
    expect(risks).toContain("2026年7月1日");
    expect(risks).toContain("无固定期限");
  });

  test("已经过期的单独列一份，不和「快到期」混在一起", () => {
    expect(prompt).toContain("已经过期");
    expect(prompt).toContain("不要和快到期混在一起");
    expect(risks).toContain("这一份往往最要紧");
  });

  test("结果另存为新文件，原台账只读", () => {
    expect(prompt).toContain("结果_到期提醒");
    expect(prompt).toContain("原来的台账只能读");
  });
});
