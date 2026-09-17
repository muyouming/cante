// 「动手前先定好这几件事」的守卫（把已知的追问挪到前面）。
//
// 真机普查里 26 次运行有 6 次助手停下来问用户，问的是同一类判断（列名对不上按哪张算、
// 这一行算不算合计）——而她动手前就能答。这个文件盯住三件事：
//
//   ① 登记的每一道题都真的能被回答：恰好一个默认值、排在第一条、每条都有「选它会怎样」
//      的一行小字，而且真正发出去的那句话里写着「不要再为这件事停下来问她」；
//   ② 她选什么，指令里就是什么：一律走 `instructionFor()`（`store.composedInstruction`
//      用的就是这条线），绝不直接调 `task.prompt()`——上一轮 P0 正是被这条线漏掉的；
//   ③ 没有对应判断的卡片既不出这一节，也没有这一段文字。
//
// 「哪张卡有哪几道题」只有一处：`tasks/prompt.ts` 里的映射。这里通过
// `preAnswerTaskIds()` / `preAnswerDecisions()` 读它，不另抄一份清单。
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRE_ANSWER_COPY } from "./copy-preanswer.ts";
import { TASKS, instructionFor, taskById } from "./tasks/index.ts";
import {
  PRE_ANSWER_HEADING,
  PRE_ANSWER_LEAD,
  clearPreAnswers,
  defaultPreAnswerIndex,
  hasPreAnswers,
  preAnswerBlock,
  preAnswerDecisions,
  preAnswerTaskIds,
  setPreAnswers,
} from "./tasks/prompt.ts";

/** 她原话里的一句话；预答是另一回事，但两段都得在。 */
const HER_SENTENCE = "把这些表按我要的样子弄好";
const FILES = ["在文档/一月.xlsx", "在文档/二月.xlsx"];

/** 生产路径拼出来的指令。 */
function composed(taskId: string): string {
  const text = instructionFor(taskId, FILES, HER_SENTENCE);
  expect(text, `${taskId} 拼不出指令`).not.toBeNull();
  return text ?? "";
}

afterEach(() => {
  clearPreAnswers();
});

describe("登记的问题本身要能答", () => {
  test("每一条都挂在一张真的卡片上", () => {
    const ids = preAnswerTaskIds();
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const taskId of ids) {
      expect(taskById(taskId), `${taskId} 不是目录里的卡片`).toBeDefined();
      const decisions = preAnswerDecisions(taskId);
      expect(decisions.length).toBeGreaterThan(0);
      // 一张卡最多两道题：再多就成了又一张表，她不会看。
      expect(decisions.length).toBeLessThanOrEqual(2);
    }
  });

  test("同一道题不会登记两次", () => {
    const ids = preAnswerTaskIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("每题恰好一个默认值，而且排在第一条（不改就是它）", () => {
    for (const taskId of preAnswerTaskIds()) {
      for (const decision of preAnswerDecisions(taskId)) {
        const defaults = decision.options.filter((option) => option.isDefault);
        expect(defaults.length, `${taskId}/${decision.id} 的默认值不是一个`).toBe(1);
        expect(defaultPreAnswerIndex(decision), `${taskId}/${decision.id} 的默认值不在第一条`).toBe(0);
        // 至少两条可选项：只有一条的话，问她也等于没问。
        expect(decision.options.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("每条选项都有解释：选了它会怎样（小字不能空）", () => {
    for (const taskId of preAnswerTaskIds()) {
      for (const decision of preAnswerDecisions(taskId)) {
        expect(decision.question.length, `${taskId}/${decision.id} 的问题太短`).toBeGreaterThan(8);
        for (const option of decision.options) {
          expect(option.label.length, `${taskId}/${decision.id} 的选项名太短`).toBeGreaterThan(3);
          // 只给结论不给解释，她没法判断——所以这行小字有长度下界。
          expect(option.note.length, `${taskId}/${decision.id} 的选项解释太短`).toBeGreaterThan(10);
          // 真正发出去的那一句必须是完整的话，而且明确交代「别再问她」。
          expect(option.envelope.length, `${taskId}/${decision.id} 的指令句子太短`).toBeGreaterThan(20);
          expect(option.envelope, `${taskId}/${decision.id} 没写「不要再停下来问」`).toContain(
            "不要再为这件事停下来问她",
          );
        }
      }
    }
  });

  test("决定编号不重样，都是稳定的短编号", () => {
    const seen = new Set<string>();
    for (const taskId of preAnswerTaskIds()) {
      for (const decision of preAnswerDecisions(taskId)) {
        expect(seen.has(decision.id), `决定编号重复：${decision.id}`).toBe(false);
        seen.add(decision.id);
        // 编号是状态用的键：重样会让别的卡收到不该收到的问题。
        expect(decision.id, `${decision.id} 不是稳定的短编号`).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      }
    }
  });

  test("界面上这一节的标题、小字、默认标记都在", () => {
    expect(PRE_ANSWER_COPY.heading.length).toBeGreaterThan(3);
    expect(PRE_ANSWER_COPY.hint).toContain("不改也能直接开始");
    expect(PRE_ANSWER_COPY.defaultTag).toContain("默认");
  });

  // 文案和指令都对了，但确认页上根本没画出来，也等于零。这里照仓库里其他守卫的
  // 做法把组件当文本读一遍：接线断了一行就能看出来。
  test("确认页真的把这一节画出来，选项也点得到", () => {
    const sheet = readFileSync(join(import.meta.dir, "ConfirmSheet.tsx"), "utf8");
    // 文案从 copy 模块来，不在组件里另写一份。
    expect(sheet).toContain('from "./copy-preanswer.ts"');
    expect(sheet).toContain("PRE_ANSWER_COPY.heading");
    expect(sheet).toContain("PRE_ANSWER_COPY.hint");
    expect(sheet).toContain("PRE_ANSWER_COPY.defaultTag");
    // 问题与选项逐条画出来，默认那一条有标记。
    expect(sheet).toContain("preAnswerDecisions(");
    expect(sheet).toContain("decision.question");
    expect(sheet).toContain("option.label");
    expect(sheet).toContain("option.note");
    expect(sheet).toContain("option.isDefault");
    // 她改了以后要回写进指令（不然界面问了也是白问）。
    expect(sheet).toContain("setPreAnswers(");
    expect(sheet).toContain("defaultPreAnswerIndex(");
    // 选项是能点的整行（45 岁的人不用去戳那个小圆点）。
    expect(sheet).toContain('type="radio"');
    expect(sheet).toContain("min-h-[44px]");
  });
});

describe("她选的东西必须真的进指令", () => {
  test("一个字都不改时，指令里就是默认那一句（她可以直接开始）", () => {
    for (const taskId of preAnswerTaskIds()) {
      const text = composed(taskId);
      expect(text, `${taskId} 的指令里没有【她事先说过】`).toContain(PRE_ANSWER_HEADING);
      expect(text).toContain(PRE_ANSWER_LEAD);
      for (const decision of preAnswerDecisions(taskId)) {
        const chosen = decision.options[defaultPreAnswerIndex(decision)]!;
        expect(text, `${taskId}/${decision.id} 的默认句子没进指令`).toContain(chosen.envelope);
        // 没选的那一条不能混进去：否则助手会拿到两个互相矛盾的说法。
        for (const other of decision.options) {
          if (other === chosen) continue;
          expect(text, `${taskId}/${decision.id} 把没选的句子也发了出来`).not.toContain(other.envelope);
        }
      }
    }
  });

  test("她改了以后，指令里换成她选的那一句", () => {
    for (const taskId of preAnswerTaskIds()) {
      for (const decision of preAnswerDecisions(taskId)) {
        const picked = decision.options[1]!;
        const dropped = decision.options[defaultPreAnswerIndex(decision)]!;
        setPreAnswers(taskId, { [decision.id]: 1 });
        const text = composed(taskId);
        expect(text, `${taskId}/${decision.id} 没跟着她的选择走`).toContain(picked.envelope);
        expect(text, `${taskId}/${decision.id} 还留着默认那一句`).not.toContain(dropped.envelope);
        // 同一张卡的另一道题不受影响：她还是可以只改其中一道。
        for (const other of preAnswerDecisions(taskId)) {
          if (other.id === decision.id) continue;
          const untouched = other.options[defaultPreAnswerIndex(other)]!;
          expect(text, `${taskId} 改了 ${decision.id} 却把 ${other.id} 也带偏了`).toContain(
            untouched.envelope,
          );
        }
        clearPreAnswers();
      }
    }
  });

  test("改第一道题不会把第二道题整段吃掉", () => {
    // 默认值是「两条都留下」，她改成「算同一条」以后，两道题的句子都要在。
    const decisions = preAnswerDecisions("excel.merge");
    expect(decisions.length).toBe(2);
    setPreAnswers("excel.merge", { [decisions[1]!.id]: 1 });
    const text = composed("excel.merge");
    expect(text).toContain(decisions[0]!.options[0]!.envelope);
    expect(text).toContain(decisions[1]!.options[1]!.envelope);
    expect(text).toContain("【她事先说过】");
  });

  test("别的卡的选择进不了这张卡的指令（状态串号会被挡掉）", () => {
    // 往 excel.merge 的状态里塞一张别的卡的决定编号。
    setPreAnswers("excel.merge", { "hidden-rows": 1, spaces: 1 });
    const merge = composed("excel.merge");
    // 她自己选的这一条进去。
    expect(merge).toContain(preAnswerDecisions("excel.merge")[1]!.options[1]!.envelope);
    // 别的卡的那一条不许进来。
    expect(merge).not.toContain(preAnswerDecisions("excel.group")[0]!.options[1]!.envelope);
  });

  test("越界的选择退回默认值，不会拼出半截指令", () => {
    setPreAnswers("excel.tidy", { "header-row": 99 });
    const text = composed("excel.tidy");
    const decision = preAnswerDecisions("excel.tidy")[0]!;
    expect(text).toContain(decision.options[0]!.envelope);
    // 没有空着一行「- 」这种东西。
    expect(text).not.toContain("- \n");
  });

  test("预答和卡片自己的规矩是并存关系：原文件只读、结果另存，一句都不能少", () => {
    const text = composed("excel.merge");
    expect(text).toContain(PRE_ANSWER_HEADING);
    expect(text).toContain("不要改");
    expect(text).toContain("另存");
    // 她自己的原话也在。
    expect(text).toContain(HER_SENTENCE);
  });
});

describe("没有对应判断的卡片不显示这一节", () => {
  test("只有登记过的卡片才有【她事先说过】，别的卡片这段文字一个字都没有", () => {
    const registered = new Set(preAnswerTaskIds());
    const shown: string[] = [];
    for (const task of TASKS) {
      const text = composed(task.id);
      const hasHeading = text.includes(PRE_ANSWER_HEADING);
      const hasBlock = preAnswerBlock(task.id) !== null;
      // 界面（preAnswerDecisions / hasPreAnswers）和指令必须一致：显示了的就一定写进去，
      // 写进去的一定显示过——只显示不进指令，等于她白答一次。
      expect(hasHeading, `${task.id}：界面与指令不一致`).toBe(hasBlock);
      expect(hasHeading, `${task.id}：有这一节但没登记`).toBe(registered.has(task.id));
      expect(hasPreAnswers(task.id)).toBe(registered.has(task.id));
      if (hasHeading) shown.push(task.id);
    }
    expect(shown.sort()).toEqual([...registered].sort());
    expect(shown.length).toBeGreaterThan(0);
    // 卡片总数远多于登记数：这一节是少数卡片才有的东西。
    expect(shown.length).toBeLessThan(TASKS.length);
  });

  test("几张明确不该有的卡：一问都没有", () => {
    for (const taskId of ["doc.notice", "doc.leave", "files.dupes", "wechat.draft", "invoice.dupes"]) {
      expect(preAnswerDecisions(taskId), `${taskId} 不该有问题集`).toEqual([]);
      expect(preAnswerBlock(taskId)).toBeNull();
      expect(composed(taskId)).not.toContain(PRE_ANSWER_HEADING);
    }
  });

  test("找不到的卡片：没有这一节，也不会凭空编一段", () => {
    expect(preAnswerDecisions("没有这张卡")).toEqual([]);
    expect(preAnswerBlock("没有这张卡")).toBeNull();
    expect(preAnswerBlock("")).toBeNull();
    expect(hasPreAnswers("没有这张卡")).toBe(false);
  });
});
