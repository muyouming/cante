// WeChat tasks for simple mode (#51, #52).
//
// WeChat is a red line: Cante may read an exported chat log and organise it,
// but it must never send, never log in, and never quietly queue a message. Both
// tasks below are therefore read-then-write-a-new-file jobs, and their prompts
// say so explicitly — the model is told to produce a table or a draft, never an
// action on the account.
//
// `TaskDef` is declared here (rather than imported from `tasks/index.ts`) so
// this file type-checks on its own while r5-tasks builds the catalogue; the
// shape matches the frozen interface field for field, so the object literals
// stay assignable to the catalogue's own `TaskDef`.
import { DRAFT_SEND_NOTICE, WECHAT_SAFETY_NOTICE } from "../privacy.ts";

export interface TaskDef {
  id: string;
  title: string;
  example: string;
  group: "表格" | "文件" | "微信" | "文书" | "资料";
  needs: "files" | "folder" | "none" | "text";
  accept?: string[];
  plan: string[];
  prompt(files: string[], instruction: string): string;
  summaryHints: string[];
}

/** What a WeChat export looks like on Windows; kept in sync with the picker. */
export const WECHAT_ACCEPT = ["txt", "csv", "html", "json", "md", "log"];

const FILE_LIST = (files: string[]): string =>
  files.length === 0 ? "（没有选择文件）" : files.map((file) => `- ${file}`).join("\n");

const EXTRA = (instruction: string): string =>
  instruction.trim() ? `\n用户补充的要求：${instruction.trim()}` : "";

/**
 * #51 — organise a chat log into a table.
 *
 * The "原话" column is mandatory: the user must be able to check every row
 * against what was actually said, which is also why the summary asks for the
 * rows that could not be understood.
 */
export const wechatTableTask: TaskDef = {
  id: "wechat.table",
  title: "微信聊天记录整理成表格",
  example: "把这段聊天记录整理成一张表：谁、什么时候、说了什么。",
  group: "微信",
  needs: "files",
  accept: WECHAT_ACCEPT,
  plan: [
    "打开你选的聊天记录文件，只看不改，原件保持不动",
    "按时间顺序把每一句话整理成一行：时间、说话人、原话",
    "把其中要紧的事单独列出来，方便你核对",
    "另存成一张新的表格文件",
  ],
  prompt(files: string[], instruction: string): string {
    return [
      WECHAT_SAFETY_NOTICE,
      "请只做整理：读取下面的聊天记录，把内容整理成一张表格，另存为一个新的表格文件。",
      "表格至少要有这几列：时间、说话人、原话。其中「原话」必须保留聊天里的原话，方便用户逐条核对。",
      "不要发送任何消息，不要登录微信，不要修改或删除原文件。",
      "",
      "聊天记录文件：",
      FILE_LIST(files),
      EXTRA(instruction),
    ].join("\n");
  },
  summaryHints: ["整理出多少行", "表格文件放在哪个文件夹", "有没有没看懂、需要你核对的内容"],
};

/**
 * #52 — write reply drafts the user sends by hand.
 *
 * The task produces a list plus one draft per item. The product never sends;
 * the most it does is put the text where the user can copy it.
 */
export const wechatDraftTask: TaskDef = {
  id: "wechat.draft",
  title: "微信回复草稿",
  example: "帮我想几条回复，我自己复制过去发。",
  group: "微信",
  needs: "files",
  accept: WECHAT_ACCEPT,
  plan: [
    "打开你选的聊天记录文件，只看不改",
    "先列出需要你回复的消息清单",
    "再给每一条写一条回复草稿，和原话放在一起",
    "把草稿另存成一个新文件，方便你逐条复制",
  ],
  prompt(files: string[], instruction: string): string {
    return [
      WECHAT_SAFETY_NOTICE,
      DRAFT_SEND_NOTICE,
      "请只做整理和起草：读取下面的聊天记录，先列出需要回复的消息清单，再为每一条写一条回复草稿，",
      "并另存为一个新文件。草稿要和对应的原话放在一起，方便用户核对和逐条复制。",
      "不要发送任何消息，不要登录微信，不要修改或删除原文件。",
      "",
      "聊天记录文件：",
      FILE_LIST(files),
      EXTRA(instruction),
    ].join("\n");
  },
  summaryHints: ["需要回复几条", "写好多少条草稿", "草稿文件放在哪个文件夹"],
};

/**
 * #52 — the batch shape: a list plus one draft per item, still nothing sent.
 *
 * Kept separate because a batch is a different promise: the result is a
 * checklist to work through, not a single reply.
 */
export const wechatBatchTask: TaskDef = {
  id: "wechat.batch",
  title: "微信批量回复草稿",
  example: "有好几条要回，帮我列个清单，再一条条写好草稿。",
  group: "微信",
  needs: "files",
  accept: WECHAT_ACCEPT,
  plan: [
    "打开你选的聊天记录文件，只看不改",
    "先给出需要你回复的清单，一条一条列清楚",
    "再给清单上的每一条写一条回复草稿",
    "把清单和草稿放进同一个新文件，方便你逐条处理",
  ],
  prompt(files: string[], instruction: string): string {
    return [
      WECHAT_SAFETY_NOTICE,
      DRAFT_SEND_NOTICE,
      "请只做整理和起草：读取下面的聊天记录，先给出需要回复的清单，再为清单上的每一条写一条回复草稿，",
      "把清单和草稿放在同一个新文件里。每一条都要带上对应的原话，方便用户核对。",
      "不要发送任何消息，不要登录微信，不要修改或删除原文件。",
      "",
      "聊天记录文件：",
      FILE_LIST(files),
      EXTRA(instruction),
    ].join("\n");
  },
  summaryHints: ["清单上几条", "写好多少条草稿", "文件放在哪个文件夹"],
};

/** The WeChat slice of the catalogue, in the order the screen shows it. */
export const WECHAT_TASKS: TaskDef[] = [wechatTableTask, wechatDraftTask, wechatBatchTask];

/** Lowercase alias so the catalogue workstream can import whichever reads best. */
export const wechatTasks = WECHAT_TASKS;

export default WECHAT_TASKS;
