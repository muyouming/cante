// 查资料卡（#54）的回归测试。
//
// 这张卡最容易出的错不是「查得慢」，是「编一个像真的数字」——对把材料交上去的
// 行政/财务来说，一个假的来源比没有答案更糟。所以这里除了常规形状检查，重点
// 钉住四件用户看得见的事：
//   1) 每条结论后面必须有来源（网页标题 + 网址，或发布单位）；
//   2) 查不到就说查不到，绝不编来源、绝不编数字；
//   3) 文件最上面必须写清是什么时候查的（政策类内容时效性极强）；
//   4) 没有联网工具时必须直接说出来，不许凭记忆答。
//
// 下面断言用的都是卡片文案里的真实句子，改文案就会让测试失败——那正是提醒
// 作者「这句话是承诺，不是装饰」。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { RESEARCH_TASKS } from "./research.ts";
import type { TaskDef } from "./types.ts";

/** 王姐不该在界面上看到的词（和 tasks.test.ts 同一份红线）。 */
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

function byId(id: string): TaskDef {
  const task = RESEARCH_TASKS.find((item) => item.id === id);
  if (!task) throw new Error(`缺少卡片：${id}`);
  return task;
}

/** 卡片里所有用户会读到的文字。 */
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

describe("查资料卡的形状", () => {
  test("只有一张卡，id 是 research.brief，落在资料组、要用户说一句话", () => {
    expect(RESEARCH_TASKS.map((task) => task.id)).toEqual(["research.brief"]);
    const task = byId("research.brief");
    expect(task.group).toBe("资料");
    expect(["text", "none"]).toContain(task.needs);
    // 她要能把自己的问题打进去，所以默认是 text；这张卡不读她的文件。
    expect(task.accept).toBeUndefined();
  });

  test("卡片编号是稳定的形态", () => {
    for (const task of RESEARCH_TASKS) {
      expect(task.id).toMatch(/^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*$/);
    }
  });

  test("写全了：plan、risks、summaryHints 都在，最后一步说结果放哪、原文件不动", () => {
    for (const task of RESEARCH_TASKS) {
      expect(task.title.length).toBeGreaterThan(3);
      expect(task.example.length).toBeGreaterThan(5);
      expect(task.plan.length).toBeGreaterThanOrEqual(3);
      expect((task.risks ?? []).length).toBeGreaterThanOrEqual(3);
      expect(task.summaryHints.length).toBeGreaterThanOrEqual(2);
      expect(task.plan.join("")).toMatch(/新文件|另存|不动|留着|不要动/);
      expect(task.plan.join("")).toMatch(/来源|出处/);
    }
  });

  test("风险条目具体到能对着结果核，不是一句免责声明", () => {
    const FILLER = ["仅供参考", "可能有误", "如有误差", "不保证", "不一定完全准确"];
    for (const task of RESEARCH_TASKS) {
      for (const risk of task.risks ?? []) {
        expect(risk.length).toBeGreaterThan(10);
        for (const word of FILLER) expect(risk).not.toContain(word);
      }
    }
  });

  test("用户读到的中文里没有技术词", () => {
    for (const task of RESEARCH_TASKS) {
      for (const { where, text } of userFacing(task)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });

  test("示例是行政/财务真会问的那句话", () => {
    const spoken = ["查一下", "帮我查", "查一查", "整理成一页"];
    expect(spoken.some((word) => byId("research.brief").example.includes(word))).toBe(true);
  });
});

describe("每条结论都要有来源", () => {
  const prompt = byId("research.brief").prompt([], "帮我查一下今年的社保缴费基数");

  test("来源和出处都写进指令，并给出写法", () => {
    expect(prompt).toContain("来源");
    expect(prompt).toContain("出处");
    // 来源要落到「网页标题 + 网址」或「发布单位的名称」这两种可核对的形式。
    expect(prompt).toContain("网页标题和网址");
    expect(prompt).toContain("单位名称");
    expect(prompt).toContain("（来源：");
  });

  test("界面文案说明每条会给出处，重要数字以官方文件为准", () => {
    const task = byId("research.brief");
    const risks = (task.risks ?? []).join("\n");
    expect(risks).toContain("查到的每一条都会告诉你出处，但重要数字请以官方文件为准");
  });

  test("存在同名文件很多、年份/地区不同的具体风险", () => {
    const risks = (byId("research.brief").risks ?? []).join("\n");
    expect(risks).toContain("同名");
    expect(risks).toContain("年份");
    // 不是笼统一句「可能有误差」。
    expect(risks).toContain("不同省市");
  });

  test("提醒搜索摘要可能过期，钱数比例以官方原文为准", () => {
    const risks = (byId("research.brief").risks ?? []).join("\n");
    expect(risks).toContain("过期");
    expect(risks).toContain("官方原文");
    expect(prompt).toContain("请以官方原文为准");
  });
});

describe("查不到就说查不到，绝不编", () => {
  const prompt = byId("research.brief").prompt([], "帮我查一下年检要交什么材料");

  test("指令里写死了「查不到就说查不到」", () => {
    expect(prompt).toContain("查不到就说查不到");
    expect(prompt).toContain("这一条没有查到官方说法");
  });

  test("明确禁止编来源、编数字，也不许拿别处的数字顶上", () => {
    expect(prompt).toContain("不要编来源");
    expect(prompt).toContain("不要编数字");
    expect(prompt).toContain("不要拿别的年份、别的省市的数字顶上");
  });

  test("宁可空着也不许编，是写在指令里的一句话", () => {
    expect(prompt).toContain("宁可空着，也不许编");
  });
});

describe("写清是什么时候查的（政策类时效性极强）", () => {
  const prompt = byId("research.brief").prompt([], "帮我查一下差旅费标准");

  test("指令要求文件最上面写查询时间", () => {
    expect(prompt).toContain("什么时候查的");
    expect(prompt).toContain("查询时间：");
    expect(prompt).toContain("时效性很强");
  });

  test("结果提示里也把查询时间列出来", () => {
    expect(byId("research.brief").summaryHints.join("")).toContain("什么时候查的");
  });
});

describe("没有联网工具时必须说出来", () => {
  const prompt = byId("research.brief").prompt([], "帮我查一下社保基数");

  test("指令要求不能上网时直接说查不了，不许凭记忆答", () => {
    expect(prompt).toContain("不能上网");
    expect(prompt).toContain("没有能上网查的工具");
    expect(prompt).toContain("我这边没有联网工具，查不到");
    expect(prompt).toContain("不要凭记忆回答");
    expect(prompt).toContain("不要假装查到了");
  });

  test("风险里也如实告诉用户可能查不了", () => {
    const risks = (byId("research.brief").risks ?? []).join("\n");
    expect(risks).toContain("不能上网");
    expect(risks).toContain("不会凭记忆给你一个像真的数字");
  });
});

describe("结果文件与公共信封的承诺", () => {
  test("结果另存为新文件、绝不覆盖，并说明放在哪", () => {
    const task = byId("research.brief");
    const prompt = task.prompt([], "查一下年检材料");
    expect(prompt).toContain("存成一个新的、能打开的文件");
    expect(prompt).toContain("不要覆盖已有文件");
    expect(prompt).toContain("桌面");
    // 结果必须是能打开的文档，不能只是聊天里的回答。
    expect(prompt).toContain(".docx");
    expect(prompt).toContain(".md");
  });

  test("先说明再动手、原文件不动、最后要一段需要核对", () => {
    const prompt = byId("research.brief").prompt([], "查一下年检材料");
    expect(prompt).toContain("先说明你打算怎么做，再动手");
    expect(prompt).toContain("结果另存为新文件，不要改原文件");
    expect(prompt).toContain("【需要你核对】");
    expect(prompt).toContain("以用户的原话为准");
  });

  test("没选文件也能生成一份能用的说明，用户原话也在", () => {
    const prompt = byId("research.brief").prompt([], "  ");
    expect(prompt).toContain("没有选文件");
    expect(prompt).toContain("（用户没有补充，按上面的做法做）");
    expect(prompt.length).toBeGreaterThan(200);

    const withWords = byId("research.brief").prompt([], "我的特殊要求：只要国家和我们省的规定");
    expect(withWords).toContain("我的特殊要求：只要国家和我们省的规定");
  });
});
