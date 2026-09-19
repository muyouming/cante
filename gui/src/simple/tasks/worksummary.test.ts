// 个人工作总结 / 述职这张变体卡（#192 B）。
//
// 调研里「怎么写日常琐事才不显得碎」是真实搜索，所以这张卡的重点只有两个：
//   * **不许编数字**——流水账里没写的成绩不许补，交上去她担责；
//   * **必须归并成几条**——把几十条琐事原样罗列，比不写还乱。
// 这两条是这张卡存在的理由，所以下面单独钉住，别让一次文案改动悄悄把它们弄丢。
//
//   bun test src
import { describe, expect, test } from "bun:test";

import { TASKS, instructionFor, taskById } from "./index.ts";
import { WORK_SUMMARY_TASKS } from "./worksummary.ts";
import type { TaskDef } from "./types.ts";

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

const card = taskById("doc.worksummary")!;
const prompt = card.prompt([], "把我今年的流水账写成一份述职总结");

describe("个人工作总结卡的目录形状（#192 B）", () => {
  test("只有这一张卡，id 固定", () => {
    expect(WORK_SUMMARY_TASKS.map((item) => item.id)).toEqual(["doc.worksummary"]);
  });

  test("这张卡真的接进了目录（没接线就发不出去）", () => {
    expect(TASKS.filter((item) => item.id === "doc.worksummary")).toHaveLength(1);
  });

  test("归在文书族，不用先选文件：流水账贴进来就能做", () => {
    expect(card.group).toBe("文书");
    expect(card.needs).toBe("text");
  });

  test("形状完整：标题够长、例子够长、四步计划、三到四条风险、四条结果提示", () => {
    expect(card.title.length).toBeGreaterThan(3);
    expect(card.example.length).toBeGreaterThan(5);
    expect(card.plan.length).toBe(4);
    expect((card.risks ?? []).length).toBeGreaterThanOrEqual(3);
    expect((card.risks ?? []).length).toBeLessThanOrEqual(4);
    expect(card.summaryHints.length).toBe(4);
    // 最后一步永远是在说结果另存，不碰原件。
    expect(card.plan.join("")).toMatch(/新文件|另存|不动/);
  });

  test("标题是她会说的话，不是功能名", () => {
    expect(card.title).toContain("总结");
    expect(card.title).toMatch(/写成/);
  });

  test("面向用户的文字里没有技术词", () => {
    for (const { where, text } of userFacing(card)) {
      for (const word of JARGON) {
        expect(`${where}: ${text}`).not.toContain(word);
      }
    }
  });
});

describe("总结的说明走公共信封", () => {
  test("公共承诺一条不少，她说的话原样带上", () => {
    expect(prompt).toContain("先说明你打算怎么做，再动手");
    expect(prompt).toContain("结果另存为新文件，不要改原文件");
    expect(prompt).toContain("【要做的事】");
    expect(prompt).toContain("【怎么做】");
    expect(prompt).toContain("【用户的原话】");
    expect(prompt).toContain("【做完告诉我】");
    expect(prompt).toContain("【需要你核对】");
    expect(prompt).toContain("把我今年的流水账写成一份述职总结");
    // 缺工具时必须先停，不许硬做。
    expect(prompt).toContain("缺少读或写这种文件的工具");
  });

  test("一个文件都没选也能干活：流水账贴在话里", () => {
    expect(prompt).toContain("没有选文件");
    expect(prompt).toContain("整段贴在");
    expect(prompt).toContain("不要因为没选文件就不做");
  });

  test("选过文件时文件真的进指令，结果放在它旁边", () => {
    const withFile = card.prompt(["/示例/流水账.txt"], "按我说的做");
    expect(withFile).toContain("1. /示例/流水账.txt");
    expect(withFile).toContain("放在那个文件旁边");
  });

  test("成品走产品真正会走的那条路（instructionFor），不是 task.prompt 单跑", () => {
    const composed = instructionFor("doc.worksummary", [], "写成一份述职");
    expect(composed).toContain("写成一份述职");
    expect(composed).toContain("归并成一条");
    expect(composed).toContain("不要补");
  });
});

describe("红线一：不许编数字（流水账里没写的量化结果一律不写）", () => {
  test("明确列出不许补的东西：数字、金额、比例、名次、人数", () => {
    expect(prompt).toContain("一律不要补");
    expect(prompt).toContain("不要估");
    for (const field of ["数字", "金额", "比例", "名次", "人数"]) {
      expect(prompt).toContain(field);
    }
  });

  test("需要数字的地方留空，并提醒她填", () => {
    expect(prompt).toContain("（请补充）");
    expect(prompt).toContain("留空");
    expect(prompt).toContain("提醒用户填");
  });

  test("不许编的来源写在指令里，而不是只写在界面上", () => {
    const line = prompt.split("\n").find((text) => text.includes("数字和成绩只能照用户给的内容写"));
    expect(line).toBeDefined();
    expect(line!).toContain("不要用常见的数字顶上");
  });
});

describe("红线二：必须归并成几条，不能罗列几十条", () => {
  test("同一件事分几次记的归并成一条，不逐条罗列", () => {
    expect(prompt).toContain("归并成一条");
    expect(prompt).toContain("不要逐条罗列");
  });

  test("整篇落在几条主要事情上，按分量轻重排", () => {
    expect(prompt).toContain("几条主要事情");
    expect(prompt).toContain("先说重要的");
  });

  test("不许为了显得多，把一件小事拆成好几条", () => {
    expect(prompt).toContain("不要为了显得多，把一件小事拆成好几条");
  });

  test("每条要能对回流水账：标出来自哪几条", () => {
    expect(prompt).toContain("来自你流水账里的哪几条");
  });

  test("空话挡掉：不要只写「认真完成」「积极配合」", () => {
    expect(prompt).toContain("不要全是");
    expect(prompt).toContain("认真完成");
    expect(prompt).toContain("有什么结果");
  });
});

describe("哪几件算重点，先问她", () => {
  test("她没说清楚就先停下来问，不要自己定了就当数", () => {
    expect(prompt).toContain("哪几件算重点");
    expect(prompt).toContain("先停下来问一句");
    expect(prompt).toContain("不要自己定了就当数");
  });

  test("读不懂的条目原样留着，不丢也不猜", () => {
    expect(prompt).toContain("不要丢掉");
    expect(prompt).toContain("也不要自己猜");
  });
});

describe("风险：具体、能对着自己的流水账核对、带出路", () => {
  test("每条风险都点名一个真实且能核对的情况", () => {
    const risks = card.risks!.join("\n");
    // 编数字、重点判断、归并可能并错、口吻不一定合单位要求。
    expect(risks).toContain("数字");
    expect(risks).toContain("重点");
    expect(risks).toContain("并成一条");
    expect(risks).toContain("口吻");
  });

  test("每条风险都带出路（留空 / 请你核对 / 交回给她）", () => {
    for (const risk of card.risks!) {
      expect(risk).toMatch(/留空|请你|告诉你|直接改|再调/);
    }
  });

  test("结果提示四条，直接对得上指令里报的那几件事", () => {
    expect(card.summaryHints).toEqual([
      "一共归并成几条",
      "哪几条被当成重点",
      "哪些地方需要你补充",
      "结果文件在哪个位置",
    ]);
  });
});
