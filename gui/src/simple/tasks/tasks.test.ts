// The task catalogue is the product surface for simple mode: one bad title or
// one missing safety line is a user-visible bug. These tests pin the shape of
// every card and, more importantly, pin the two promises every instruction must
// carry — "say what you will do first" and "never touch the originals".
//
//   bun test src
import { describe, expect, test } from "bun:test";

import {
  SAFETY_RULES,
  TASKS,
  instructionFor,
  taskById,
  taskGroups,
  type TaskDef,
  type TaskGroup,
} from "./index.ts";

const GROUPS: TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];

/** Terms a 45-year-old admin should never have to read. */
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

function everyString(task: TaskDef): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [
    { where: "title", text: task.title },
    { where: "example", text: task.example },
  ];
  task.plan.forEach((step, index) => out.push({ where: `plan[${index}]`, text: step }));
  (task.risks ?? []).forEach((risk, index) => out.push({ where: `risks[${index}]`, text: risk }));
  task.summaryHints.forEach((hint, index) => out.push({ where: `summaryHints[${index}]`, text: hint }));
  return out;
}

/** A run's worth of paths, one per extension the card accepts. */
function sampleFiles(task: TaskDef): string[] {
  if (task.needs === "folder") return ["/示例/文件夹"];
  if (task.needs === "none" || task.needs === "text") return [];
  const ext = task.accept?.[0] ?? "txt";
  return [`/示例/一.${ext}`, `/示例/二.${ext}`];
}

describe("catalogue shape", () => {
  test("every card is complete", () => {
    expect(TASKS.length).toBeGreaterThan(0);
    for (const task of TASKS) {
      expect(task.id).toMatch(/^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*$/);
      expect(task.title.length).toBeGreaterThan(3);
      expect(task.example.length).toBeGreaterThan(5);
      expect(GROUPS).toContain(task.group);
      expect(["files", "folder", "none", "text"]).toContain(task.needs);
      // The confirmation page is a promise; two lines is not a plan.
      expect(task.plan.length).toBeGreaterThanOrEqual(3);
      expect(task.summaryHints.length).toBeGreaterThanOrEqual(2);
      // The last step of every plan is about the result file, never the user's.
      expect(task.plan.join("")).toMatch(/新文件|另存|不动|留着|不要动/);
    }
  });

  test("every card admits where it can go wrong (#63)", () => {
    // A missing or filler risk line is the failure mode this test exists for:
    // the confirmation page would then show either nothing or a meaningless
    // "仅供参考". Each risk has to be a sentence about a real case.
    const FILLER = ["仅供参考", "可能有误", "如有误差", "不保证", "不一定完全准确"];
    for (const task of TASKS) {
      const risks = task.risks ?? [];
      expect(risks.length).toBeGreaterThan(0);
      for (const risk of risks) {
        expect(risk.length).toBeGreaterThan(10);
        for (const word of FILLER) expect(risk).not.toContain(word);
      }
    }
  });

  test("ids are unique and the declared file filters are sane", () => {
    const ids = TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of TASKS) {
      // Omitting `accept` means "any file" (batch renaming needs that).
      for (const ext of task.accept ?? []) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext).not.toContain(".");
      }
      if (task.needs === "folder") expect(task.accept).toBeUndefined();
    }
  });

  test("every issue in this workstream has its card", () => {
    // #45, #46, #47, #49, #50, #53
    for (const id of [
      "excel.merge",
      "excel.group",
      "excel.tidy",
      "excel.diff",
      "files.rename",
      "files.archive",
      "files.dupes",
      "pdf.merge",
      "pdf.split",
      "pdf.toword",
      "doc.notice",
      "doc.leave",
      "doc.report",
    ]) {
      expect(taskById(id)).toBeDefined();
    }
  });

  test("lookup and grouping are stable", () => {
    expect(taskById("excel.merge")?.title).toContain("合成");
    expect(taskById("没有这张卡")).toBeUndefined();
    const groups = taskGroups();
    expect(groups).toContain("表格");
    expect(groups).toContain("文件");
    expect(groups).toContain("文书");
  });

  test("no jargon leaks into anything the user reads", () => {
    for (const task of TASKS) {
      for (const { where, text } of everyString(task)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });
});

describe("the instruction handed to the assistant", () => {
  test("always states the plan first and protects the originals", () => {
    for (const task of TASKS) {
      const prompt = task.prompt(sampleFiles(task), "按我说的做");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain("结果另存为新文件，不要改原文件");
      expect(prompt).toContain("【要做的事】");
      expect(prompt).toContain("【怎么做】");
      expect(prompt).toContain("【用户的原话】");
      expect(prompt).toContain("【做完告诉我】");
      // #63 — every instruction asks for the honest self-report the result card reads back.
      expect(prompt).toContain("【需要你核对】");
    }
    // The shared rules are exported so a copy edit cannot silently drop one.
    expect(SAFETY_RULES.join("\n")).toContain("先说明你打算怎么做，再动手");
    expect(SAFETY_RULES.join("\n")).toContain("结果另存为新文件，不要改原文件");
  });

  test("carries every file, in order, and the user's own words", () => {
    for (const task of TASKS) {
      const files = sampleFiles(task);
      const prompt = task.prompt(files, "我的特殊要求：每月十日发工资");
      for (const [index, path] of files.entries()) {
        expect(prompt).toContain(path);
        // Folder cards print the folder plainly; file cards number the list.
        if (task.needs === "files") expect(prompt).toContain(`${index + 1}. ${path}`);
      }
      expect(prompt).toContain("我的特殊要求：每月十日发工资");
      // The user outranks the recipe.
      expect(prompt).toContain("以用户的原话为准");
    }
  });

  test("folder cards talk about a folder, not a list of files", () => {
    const folderCards = TASKS.filter((task) => task.needs === "folder");
    expect(folderCards.length).toBeGreaterThan(0);
    for (const task of folderCards) {
      const prompt = task.prompt(["/示例/文件夹"], "");
      expect(prompt).toContain("【要整理的文件夹】（只读）");
      expect(prompt).toContain("/示例/文件夹");
    }
  });

  test("cards that take no file survive an empty selection", () => {
    for (const task of TASKS.filter((card) => card.needs === "none" || card.needs === "text")) {
      const prompt = task.prompt([], "随便写一个");
      expect(prompt).toContain("没有选文件");
      expect(prompt).toContain("随便写一个");
    }
  });

  test("an empty one-liner still produces a usable instruction", () => {
    for (const task of TASKS) {
      const prompt = task.prompt(sampleFiles(task), "   ");
      expect(prompt).toContain("（用户没有补充，按上面的做法做）");
      expect(prompt.length).toBeGreaterThan(200);
    }
  });

  test("a finished run resolves back to its full instruction", () => {
    // This is the seam the trust layer uses at confirm time: the run holds the
    // user's sentence, `instructionFor` turns it into the real instruction.
    const files = sampleFiles(taskById("excel.merge")!);
    const prompt = instructionFor("excel.merge", files, "只留重复的");
    expect(prompt).toContain("只留重复的");
    expect(prompt).toContain(files[0]!);
    expect(prompt).toContain("先说明你打算怎么做，再动手");
    expect(instructionFor("没有这张卡", files, "随便")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #74 — 能力中心新增的四张卡片，以及每份说明都要带的一条通用规矩：
// 这台电脑缺工具时先说清楚，并给用户两条出路，不许硬做、也不许假装成功。
// ---------------------------------------------------------------------------

describe("the curated cards (#74)", () => {
  const NEW_CARDS = ["excel.filter", "excel.split", "files.by-date", "doc.summary"];

  test("each new card is in the catalogue and fully written", () => {
    for (const id of NEW_CARDS) {
      const task = taskById(id);
      expect(task).toBeDefined();
      // The ability centre shows four lines of result hints; the card owns them.
      expect(task!.summaryHints.length).toBe(4);
      expect(task!.plan.length).toBe(4);
      expect((task!.risks ?? []).length).toBeGreaterThanOrEqual(3);
    }
  });

  test("the new ids are unique", () => {
    const all = TASKS.map((task) => task.id);
    expect(new Set(all).size).toBe(all.length);
    for (const id of NEW_CARDS) {
      expect(TASKS.filter((task) => task.id === id).length).toBe(1);
    }
  });

  test("the new cards declare sane needs and file filters", () => {
    for (const id of NEW_CARDS) {
      const task = taskById(id)!;
      expect(["files", "folder", "none", "text"]).toContain(task.needs);
      for (const ext of task.accept ?? []) {
        expect(ext).toBe(ext.toLowerCase());
        expect(ext).not.toContain(".");
      }
      // A folder card never carries a per-file filter (the picker offers folders).
      if (task.needs === "folder") expect(task.accept).toBeUndefined();
    }
  });

  test("every instruction says to stop when the computer lacks a tool", () => {
    for (const task of TASKS) {
      const prompt = task.prompt(sampleFiles(task), "按我说的做");
      expect(prompt).toContain("缺少读或写这种文件的工具");
      expect(prompt).toContain("另存成能读的格式");
      expect(prompt).toContain("让我同意你装一个工具");
      expect(prompt).toContain("不要假装成功");
    }
    expect(SAFETY_RULES.join("\n")).toContain("缺少读或写这种文件的工具");
  });

  test("grouping by month never deletes and asks before overwriting", () => {
    const prompt = taskById("files.by-date")!.prompt(["/示例/文件夹"], "按月份分好");
    expect(prompt).toContain("不要删除");
    expect(prompt).toContain("不要覆盖");
    expect(prompt).toContain("重名");
  });

  test("the summary card marks where every point came from", () => {
    const prompt = taskById("doc.summary")!.prompt(["/示例/年度报告.pdf"], "总结成一页");
    expect(prompt).toContain("来自：");
  });
});

// ---------------------------------------------------------------------------
// r10 — 两族护城河任务（文件批处理、微信）真机跑过之后补的钉子。
//
// 下面每一条都对应一次真机观察：不是「按理应该这样」，而是「真机上就是这样
// 偏了一次，不能再偏回去」。真机记录见本轮提交说明。
// ---------------------------------------------------------------------------

describe("真机验过的两族任务（r10）", () => {
  const R10_CARDS = [
    "files.rename",
    "files.archive",
    "files.dupes",
    "pdf.merge",
    "pdf.split",
    "pdf.toword",
    "wechat.table",
    "wechat.draft",
    "wechat.batch",
  ];

  test("这九张卡都在目录里，而且每一张都写了风险", () => {
    for (const id of R10_CARDS) {
      const task = taskById(id);
      expect(task).toBeDefined();
      expect((task!.risks ?? []).length).toBeGreaterThan(0);
    }
  });

  test("微信三张卡都把结果放在聊天记录旁边，而且全程只读", () => {
    for (const id of ["wechat.table", "wechat.draft", "wechat.batch"]) {
      const prompt = taskById(id)!.prompt(["/示例/聊天记录.txt"], "按我说的做");
      // 真机上没写去处时，助手自己造了一个 out 文件夹，她找不到。
      expect(prompt).toContain("结果文件放在聊天记录那个文件的旁边");
      expect(prompt).toContain("不要发送任何消息");
      expect(prompt).toContain("不要登录微信");
      expect(prompt).toContain("不要改、不要删、不要覆盖");
    }
  });

  test("微信草稿的两张卡都写明发送由用户自己完成", () => {
    for (const id of ["wechat.draft", "wechat.batch"]) {
      const prompt = taskById(id)!.prompt(["/示例/聊天记录.txt"], "");
      expect(prompt).toContain("发送动作始终由你完成");
    }
  });

  test("微信整理卡要求把接龙拆成一人一行（真机上这是最容易漏的一步）", () => {
    const prompt = taskById("wechat.table")!.prompt(["/示例/聊天记录.txt"], "");
    expect(prompt).toContain("接龙");
    expect(prompt).toContain("每人一行");
    expect(taskById("wechat.table")!.risks!.join("")).toContain("接龙");
  });

  test("处理 PDF 的卡都说明了抽出来的文字可能是乱码", () => {
    // 真机上这台电脑的 PDF 工具对某些中文 PDF 会安静地吐出乱码（退出码 0，
    // 不是文档里说的 3），所以卡片本身必须要求助手把读不成句子的输出当成读不出来。
    for (const id of ["pdf.split", "pdf.toword"]) {
      const prompt = taskById(id)!.prompt(["/示例/材料.pdf"], "");
      expect(prompt).toContain("乱码");
    }
  });

  test("整理文件夹的卡：冲突不覆盖，子文件夹里的文件也会被挪出来", () => {
    const archive = taskById("files.archive")!;
    const risks = archive.risks!.join("");
    expect(risks).toContain("同名");
    expect(risks).toContain("子文件夹");
    const prompt = archive.prompt(["/示例/文件夹"], "");
    expect(prompt).toContain("不要覆盖");
    expect(prompt).toContain("子文件夹");
  });

  test("改名卡把序号顺序写成了风险（真机上这个顺序是助手自己定的）", () => {
    const risks = taskById("files.rename")!.risks!.join("");
    expect(risks).toContain("顺序");
    expect(risks).toContain("序号");
  });

  test("会挪文件的卡和计划里承诺的一致：重名加序号，绝不覆盖", () => {
    for (const id of ["files.rename", "files.archive"]) {
      expect(taskById(id)!.plan.join("")).toContain("绝不覆盖");
    }
  });

  test("微信界面那句「我不会替你发消息」放在 copy 模块里", async () => {
    const screen = await Bun.file(`${import.meta.dir}/../WechatImport.tsx`).text();
    expect(screen).toContain("WECHAT_UI");
    const copyModule = await Bun.file(`${import.meta.dir}/../copy.ts`).text();
    expect(copyModule).toContain("我不会替你发消息");
  });
});

// ---------------------------------------------------------------------------
// r12 — 粘贴入口（#89）与接龙/报名两张卡（#86）。
//
// 调研里最贵的两处恰好都不在「聪明」上，而在入口和统计上：
//
//   * 她要做的动作只有「在微信里选中、Ctrl+C」。以前每张微信卡都要求先选一个
//     文件，而「先把内容存成一个文件」对她可能比整件事还难。协议本来就只承载
//     文本，所以内容必须能整段贴进来。
//   * 群里接龙的字要变成能用的跟进表：按人合并重复提交、算清份数人数、标出来源；
//     看不懂的条目一条都不许丢，匹配靠猜的地方必须说出来。
//
// 两张新卡按仓库的约定单独成组（WECHAT_PASTE_TASKS），由集成者接进目录，所以
// 下面直接从 wechat.ts 导入，不走 taskById。
//
// 为什么 import 写在文件末尾：本文件是「追加」维护的，上面的每一行都属于别的
// 轮次，把新增的导入放在这里，改动一眼就能看出来。
// ---------------------------------------------------------------------------

import { DRAFT_SEND_NOTICE, WECHAT_SAFETY_NOTICE } from "../privacy.ts";
import {
  WECHAT_ALL_TASKS,
  WECHAT_PASTE_TASKS,
  WECHAT_TASKS,
  initialTaskId,
  offerableTasks,
  wechatMissingTask,
  wechatRollcallTask,
} from "./wechat.ts";

describe("接龙与报名两张新卡（r12）", () => {
  test("两张卡都在微信族，形状写全：四步计划、三到四条风险、四条结果提示", () => {
    expect(WECHAT_PASTE_TASKS.map((task) => task.id)).toEqual(["wechat.rollcall", "wechat.missing"]);
    for (const task of WECHAT_PASTE_TASKS) {
      expect(task.group).toBe("微信");
      expect(task.id).toMatch(/^[a-z]+(?:-[a-z]+)*\.[a-z]+(?:-[a-z]+)*$/);
      expect(task.title.length).toBeGreaterThan(3);
      expect(task.example.length).toBeGreaterThan(5);
      expect(task.plan.length).toBe(4);
      expect((task.risks ?? []).length).toBeGreaterThanOrEqual(3);
      expect((task.risks ?? []).length).toBeLessThanOrEqual(4);
      expect(task.summaryHints.length).toBe(4);
      // 最后一步永远是结果怎么放、别人的东西不动。
      expect(task.plan.join("")).toMatch(/另存/);
      expect(task.plan.join("")).toMatch(/不动|不要动/);
    }
  });

  test("新卡不和老卡撞号，老卡也一张没少", () => {
    expect(WECHAT_TASKS.map((task) => task.id)).toEqual([
      "wechat.table",
      "wechat.draft",
      "wechat.batch",
    ]);
    const ids = WECHAT_ALL_TASKS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of WECHAT_PASTE_TASKS) expect(WECHAT_TASKS).not.toContain(task);
  });

  test("两张卡都说清了结果放哪，而且全程只读、不替她发消息", () => {
    for (const task of WECHAT_PASTE_TASKS) {
      const prompt = task.prompt(["/示例/接龙记录.txt"], "按我说的做");
      expect(prompt).toContain("先说明你打算怎么做，再动手");
      expect(prompt).toContain(WECHAT_SAFETY_NOTICE);
      expect(prompt).toContain("不要发送任何消息");
      expect(prompt).toContain("不要登录微信");
      expect(prompt).toContain("不要修改或删除原文件");
      expect(prompt).toContain(DRAFT_SEND_NOTICE);
      // 结果去处写死两遍：选了文件就放它旁边，没选就放桌面（真机上助手自己造过 out）。
      expect(prompt).toContain("结果文件放在你选的");
      expect(prompt).toContain("旁边（同一个文件夹）");
      expect(prompt).toContain("文件名都以「结果_」开头");
      expect(prompt).toContain("就放在桌面");
      expect(prompt).toContain("原来的文件不要改、不要删、不要覆盖");
      // 同一件事跑第二次不能把上一次的结果盖掉。
      expect(prompt).toContain("绝不覆盖已有文件");
      // 表格格式也写死：她要的是双击就能打开的表格。
      expect(prompt).toContain("表格存成 Excel 能直接打开的格式");
    }
  });

  test("一个文件都没选也能干活：内容整段贴在话里（粘贴入口的路）", () => {
    for (const task of WECHAT_PASTE_TASKS) {
      const prompt = task.prompt([], "1. 张三 两份\n2. 李四+1");
      expect(prompt).toContain("没有选文件");
      expect(prompt).toContain("1. 张三 两份");
      expect(prompt).toContain("整段贴在【用户的原话】里");
      expect(prompt).toContain("就放在桌面");
    }
  });

  test("五张微信卡都认识「内容整段贴进来」这一路（不然贴进来会被当成随口一句）", () => {
    for (const task of WECHAT_ALL_TASKS) {
      const prompt = task.prompt([], "帮我看看");
      expect(prompt).toContain("整段贴在【用户的原话】里");
      // 没选文件的结果去处：贴进来的那一份只能放桌面。
      expect(prompt).toContain("桌面");
    }
  });

  test("接龙卡按人合并：同一人合成一行、份数相加、标出每一份来自第几条", () => {
    const prompt = wechatRollcallTask.prompt([], "按我说的做");
    expect(prompt).toContain("同一个人报了多次的合成一行");
    expect(prompt).toContain("份数相加");
    expect(prompt).toContain("来自第几条");
    expect(prompt).toContain("姓名、份数（合计）、来自第几条、原话");
    // 总人数、总份数要算出来，并且说清是怎么数出来的。
    expect(prompt).toContain("总人数与总份数");
    expect(prompt).toContain("怎么数出来的");
    // 份数写不清的不许猜。
    expect(prompt).toContain("不要自己猜人数");
    const risks = wechatRollcallTask.risks!.join("");
    expect(risks).toContain("+1");
    expect(risks).toContain("带家属");
    expect(risks).toContain("合并");
  });

  test("看不懂的行必须原样留在最后：不许丢，也不许自己猜一个名字", () => {
    const rollcall = wechatRollcallTask.prompt(["/示例/接龙记录.txt"], "");
    expect(rollcall).toContain("没看懂的原话");
    expect(rollcall).toContain("原样抄在");
    expect(rollcall).toMatch(/不许丢|不要丢掉/);
    const missing = wechatMissingTask.prompt(["/示例/花名册.xlsx"], "");
    expect(missing).toContain("原样抄在结果最后");
    expect(missing).toContain("不要丢掉");
    expect(wechatRollcallTask.risks!.join("")).toContain("猜");
  });

  test("找没交的人：比对规则必须先写出来，靠猜的地方要说清", () => {
    const prompt = wechatMissingTask.prompt(["/示例/花名册.xlsx"], "");
    expect(prompt).toContain("先用一句大白话把你要用的规则写出来");
    expect(prompt).toContain("去掉首尾空格");
    expect(prompt).toContain("全角半角");
    expect(prompt).toContain("名字后面的手机号");
    // 差集要两边都给：谁还没交，以及名单之外冒出来的人。
    expect(prompt).toContain("名单上有、接龙里没出现的");
    expect(prompt).toContain("接龙里出现、名单上没有的");
    // 像又不像的不许自己合并，也不许自己拆开。
    expect(prompt).toContain("拿不准的名字");
    expect(prompt).toContain("不要自己合并");
    const risks = wechatMissingTask.risks!.join("");
    expect(risks).toContain("差一个字");
    expect(risks).toContain("全角半角");
    expect(risks).toContain("误判成没交");
  });

  test("两张新卡给用户看的文字里没有技术词", () => {
    for (const task of WECHAT_PASTE_TASKS) {
      for (const { where, text } of everyString(task)) {
        for (const word of JARGON) {
          expect(`${where}: ${text}`).not.toContain(word);
        }
      }
    }
  });

  test("粘贴入口只摆目录里真的有的卡（P0 的教训：卡不在目录里，规矩就发不出去）", () => {
    const legacyOnly = offerableTasks(WECHAT_ALL_TASKS, WECHAT_TASKS.map((task) => task.id));
    expect(legacyOnly.map((task) => task.id)).toEqual(WECHAT_TASKS.map((task) => task.id));
    const wired = offerableTasks(WECHAT_ALL_TASKS, WECHAT_ALL_TASKS.map((task) => task.id));
    expect(wired.map((task) => task.id)).toEqual(WECHAT_ALL_TASKS.map((task) => task.id));
    // 目录里换一张别的卡，也只会摆那一张。
    expect(offerableTasks(WECHAT_ALL_TASKS, ["excel.merge"]).map((task) => task.id)).toEqual([]);
  });

  test("从首页点进来时预选的是那一张卡；那张卡摆不出来就落到第一张", () => {
    const ids = WECHAT_ALL_TASKS.map((task) => task.id);
    expect(initialTaskId(WECHAT_ALL_TASKS, "wechat.rollcall")).toBe("wechat.rollcall");
    // 目录里还没有这张卡时（集成者接线前），不要选中一张摆不出来的。
    expect(initialTaskId(WECHAT_ALL_TASKS, "excel.merge")).toBe(ids[0]);
    expect(initialTaskId(WECHAT_ALL_TASKS)).toBe(ids[0]);
    expect(initialTaskId([], "wechat.rollcall")).toBe("");
  });

  test("微信这一屏：有能贴内容的大框，留着选文件的入口，也没有替她发消息的按钮", async () => {
    const screen = await Bun.file(`${import.meta.dir}/../WechatImport.tsx`).text();
    // 粘贴入口本身。
    expect(screen).toContain("WECHAT_PASTE");
    expect(screen).toContain("min-h-[240px]");
    // 卡片清单来自目录，而不是直接摆全部。
    expect(screen).toContain("offerableTasks");
    // 从首页点进来的那一张卡要能预选。
    expect(screen).toContain("initialTaskId");
    // 点「开始整理」只把活摆到确认页；这一屏必须把确认页摆出来，
    // 否则她点完就一直停在「正在处理」，什么也不会开始。
    expect(screen).toContain("ConfirmSheet");
    // 文件入口还在。
    expect(screen).toContain("pickFiles");
    // 那句字号最大的「我不会替你发消息。」还在，而且没有发消息的动作。
    expect(screen).toContain("WECHAT_UI.noSend");
    expect(screen).not.toContain("自动发送");
  });

  test("粘贴入口如实说了代价：只在这台电脑上用，太长就用文件", async () => {
    const copyModule = await Bun.file(`${import.meta.dir}/../copy.ts`).text();
    expect(copyModule).toContain("只在这台电脑上用");
    expect(copyModule).toContain("只用来做你选的这件事");
    expect(copyModule).toContain("存成文件再选进来更稳");
  });
});

// ---------------------------------------------------------------------------
// r21 — 风险巡查：不是空话还不够，还要有出路。
//
// 上面那条 #63 的测试只挡住了「仅供参考」这类填充话。但一条风险仍可能只描述现象、
// 不告诉她出了事会怎样——她看完还是不知道该干什么。这一轮把三条判据里能机器化的
// 两条写下来：
//
//   1. 具体：一条风险得说清这张卡、这种数据上真会发生的事（长度下界 + 不用兜底话，
//      这两条只是底线；「说的是不是这张卡」由人来评审，见本轮报告）；
//   2. 有出路：要么写清助手会怎么处置（停下来问、留空、跳过、标出来、单独列、
//      写明），要么把判断交回给她（请你核对、由你决定、按原样留着）。两者都没有的，
//      她读完不知道下一步做什么。
//
// 只扫本轮的卡片。excel.ts 的四张归另一个 workstream，等它落地再一起接进来。
// ---------------------------------------------------------------------------

import { ADMIN_TASKS } from "./admin.ts";
import { BY_MONTH_TASKS } from "./bymonth.ts";
import { CHECK_TASKS } from "./check.ts";
import { DOCUMENT_TASKS } from "./document.ts";
import { FILE_TASKS } from "./files.ts";
import { INVOICE_TASKS } from "./invoice.ts";
import { RESEARCH_TASKS } from "./research.ts";
import { SHEET_TASKS } from "./sheet.ts";
import { SUMMARY_TASKS } from "./summary.ts";
import { VISION_TASKS } from "./vision.ts";

const R21_CARDS: TaskDef[] = [
  ...SHEET_TASKS,
  ...FILE_TASKS,
  ...BY_MONTH_TASKS,
  ...DOCUMENT_TASKS,
  ...SUMMARY_TASKS,
  ...CHECK_TASKS,
  ...INVOICE_TASKS,
  ...ADMIN_TASKS,
  ...VISION_TASKS,
  ...RESEARCH_TASKS,
  ...WECHAT_ALL_TASKS,
];

/**
 * 一条风险必须带出路。只认两种写法：
 *   * 助手会做的处置——停下来问、留空、跳过、标出来、单独列、写明；
 *   * 交回给她判断——请你核对、由你决定、按原样留着。
 * 这张清单只许加长（发现新的正当写法），不许缩短来放一条现象描述过关。
 */
const DISPOSITION = [
  // 助手会做的处置
  "停下来",
  "先停",
  "留空",
  "留出",
  "留成",
  "跳过",
  "标出",
  "标黄",
  "标注",
  "点出",
  "单独列",
  "单独提醒",
  "列在",
  "列成",
  "列进",
  "列出来",
  "写出来",
  "写清",
  "写明",
  "说明",
  "提醒",
  "告诉你",
  "问你",
  "跟你确认",
  // 按原样保住，不替她做决定
  "按原样",
  "照原样",
  "原样抄",
  "照抄",
  "原样保留",
  "不会替你",
  "不替你",
  "不会硬",
  // 交回给她判断
  "由你决定",
  "留给你",
  "你自己",
  "请你",
  "让你",
  "先说一声",
  "可以直接改",
];

describe("风险巡查（r21）：每一条都要具体、能核对、有出路", () => {
  test("这一轮的卡片都还在目录里，没有被漏接线", () => {
    for (const task of R21_CARDS) {
      expect(TASKS.filter((item) => item.id === task.id)).toHaveLength(1);
    }
    // 卡片 id 在这一组里唯一。
    const ids = R21_CARDS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("每条风险都带一条出路，而且不是一句兜底话", () => {
    const FILLER = ["仅供参考", "可能有误", "如有误差", "不保证", "不一定完全准确"];
    for (const task of R21_CARDS) {
      const risks = task.risks ?? [];
      expect(risks.length).toBeGreaterThan(0);
      for (const risk of risks) {
        // 短到一句话说不清的情况，多半是把「仅供参考」换了个说法。
        expect(risk.length).toBeGreaterThanOrEqual(15);
        for (const word of FILLER) expect(risk).not.toContain(word);
        // 出了事会怎样、或者她能怎么做——两条至少写到一条。
        expect(DISPOSITION.some((word) => risk.includes(word))).toBe(true);
      }
    }
  });

  test("会挪文件的卡把「挪走就回原来那里找不到了」说出来", () => {
    // 真实风险，不是免责声明：整理文件夹是「移动」，和改名卡（复制）不是一回事。
    for (const id of ["files.archive", "files.by-date"]) {
      const risks = (taskById(id)?.risks ?? []).join("");
      expect(risks).toContain("挪");
      expect(risks).toContain("撤销");
    }
  });

  test("改名卡说清是复制一份新的，原来那份还在", () => {
    const risks = (taskById("files.rename")?.risks ?? []).join("");
    expect(risks).toContain("复制");
    expect(risks).toContain("多出一份");
  });
});
