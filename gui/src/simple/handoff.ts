// 「能不能引导她把结果文件发出去」的纯逻辑。
//
// 结果侧原来只有「复制成微信能贴的文字」——那送的是**文字**。这一块要回答的是另一
// 个问题：这次做得的结果**文件**本身，能不能交给她自己发出去（微信那条红线允许的
// 只有引导，绝不自动发送）。判断是纯的：没有 Solid、没有磁盘、没有桥，所以 bun test
// 能把「什么时候该出这段引导、出的那几句是什么」钉死，不需要真机。
//
// 两条死规矩：
//   * **不猜路径、不造新的定位机制**：文件名用 run.ts 的 fileName()，位置用
//     location.ts 的 placeOf()——都是结果卡片上「结果在哪」已经在用的那一套；
//   * 这里**只给句子的键**，不给拼好的字符串：真正给她看的话在 copy-handoff.ts
//     （引导）、copy-print.ts（位置），界面拿键去取句。这样文案与判断各改各的，
//     不会在两处漂移。
//
// 什么时候**不**引导：这件事没真正做完就不引导——试跑（dryRun）本来就没产出、
// 失败和停下（failed / cancelled）留下的是半成品。半成品不该被当成能交出去的东西，
// 让她把半成品发出去，比什么都不说更糟。

import { placeOf, type PlaceKind } from "./location.ts";
import { fileName, type TaskRun } from "./run.ts";

/** 「怎么发」那几步的键，顺序就是她手里该做的顺序。 */
export type HandoffStep = "howOpen" | "howDrag" | "howWechat";

/** 一个可交出去的结果文件：名字 + 它在哪儿（键）。都不含机器路径。 */
export interface HandoffFile {
  /** 文件名，用 run.ts 的 fileName() 取——只留名字，不留机器位置。 */
  name: string;
  /** 「在哪儿」那句的键，界面用 copy-print.ts 的 LOCATION 取句。 */
  place: PlaceKind;
}

/** 这次结果能怎么交出去。给的是键和名字，不是拼好的话。 */
export interface HandoffPlan {
  /** 能交出去的那几个文件，保持结果里的顺序。 */
  files: HandoffFile[];
  /** 「怎么发」的步骤键（copy-handoff.ts 的 HANDOFF 里取句）。 */
  steps: readonly HandoffStep[];
}

/** 引导的固定步骤：先让文件露出来，再拖进微信（或用微信的「发送文件」）。 */
const STEPS: readonly HandoffStep[] = ["howOpen", "howDrag", "howWechat"];

/**
 * 这次的结果能不能引导她发出去。
 *
 * 有结果文件 **且这件事真做完了** → 给出引导（文件名 + 位置键 + 步骤键）；
 * 试跑 / 失败 / 停下 / 没产出任何文件 → null，界面这一块整个不出现。
 */
export function handoffFor(run: TaskRun | null | undefined): HandoffPlan | null {
  if (!run || run.state !== "done" || run.dryRun === true) return null;
  const paths = (run.result?.files ?? []).map((file) => file.path).filter((path) => path !== "");
  if (paths.length === 0) return null;
  return {
    files: paths.map((path) => ({ name: fileName(path), place: placeOf(path) })),
    steps: STEPS,
  };
}
