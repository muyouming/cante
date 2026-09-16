// WeChat tasks for simple mode (#51, #52, #86, #89).
//
// WeChat is a red line: Cante may read an exported chat log and organise it,
// but it must never send, never log in, and never quietly queue a message. The
// tasks below are therefore read-then-write-a-new-file jobs, and their prompts
// say so explicitly — the model is told to produce a table or a draft, never an
// action on the account.
//
// #89 又加了一个入口：整段贴进来。协议本来只承载文本（UserInput(String)），
// 而她要做的动作只有「选中、Ctrl+C」——所以「先存成一个文件」这条隐形门槛被拆了。
// 来料可能是文件、也可能是她贴进来的那段话，两种都要在指令里说清楚，结果去处
// 也要多写一句「没选文件就放桌面」；否则贴进来的内容会被当成一句随口的要求。
//
// The prompts go through the same `buildPrompt` envelope as every other task
// (./prompt.ts) so the shared safety rules — state the plan first, never touch
// the originals, list every file — cannot be forgotten by a task author. The
// WeChat-specific rules ride along as `extraRule`.
//
// `TaskDef` is declared here (rather than imported from `tasks/index.ts`) so
// this file stays free of a cycle with the catalogue; the shape matches the
// frozen interface field for field, so the object literals stay assignable.
import { DRAFT_SEND_NOTICE, WECHAT_SAFETY_NOTICE } from "../privacy.ts";
import { buildPrompt } from "./prompt.ts";

export interface TaskDef {
  id: string;
  title: string;
  example: string;
  group: "表格" | "文件" | "微信" | "文书" | "资料";
  needs: "files" | "folder" | "none" | "text";
  accept?: string[];
  plan: string[];
  /** #63 — see `tasks/index.ts`: concrete, checkable limits shown before running. */
  risks?: string[];
  prompt(files: string[], instruction: string): string;
  summaryHints: string[];
}

/** What a WeChat export looks like on Windows; kept in sync with the picker. */
export const WECHAT_ACCEPT = ["txt", "csv", "html", "json", "md", "log"];

/** 名单通常是一个表格文件。找出还没交的人那张卡要读它。 */
export const ROSTER_ACCEPT = ["xlsx", "xls", "csv", "txt", "md", "html", "json", "log"];

/**
 * 结果放哪，两种入口都要说死。
 *
 * 真机上助手自己造过一个 out 文件夹，用户根本找不到（#93 记过这一条）。粘贴入口
 * 又多出一种情况：一个文件都没选，也就没有「旁边」可放，于是写死「放桌面」——
 * 桌面是王姐一定找得到的地方，文书那几张卡也是这么做的。
 */
const RESULT_PLACE_FILE =
  "结果文件放在聊天记录那个文件的旁边（同一个文件夹），文件名以「结果_」开头。原来的聊天记录不要改、不要删、不要覆盖。";
const RESULT_PLACE_PASTE =
  "如果一个文件都没选、内容整段贴在你原话里，就把结果存到桌面，文件名同样以「结果_」开头。";

/**
 * 两张新卡的结果去处：选过文件放它旁边，全部贴进来就放桌面。
 * 老的聊天记录卡说的是「聊天记录旁边」，但这两张卡手上可能是名单、也可能什么都没选，
 * 所以按它自己那份东西说话（真机上助手就是靠这句话把结果放对的）。
 */
function pasteResultPlace(what: string): string {
  return `结果文件放在你选的${what}旁边（同一个文件夹）；一个文件都没选、内容全是贴进来的，就放在桌面。文件名都以「结果_」开头，一眼能认出来；如果已经有同名的文件，就在后面加序号，绝不覆盖已有文件；原来的文件不要改、不要删、不要覆盖。`;
}

/**
 * 表格要存成她能双击打开的格式。真机上两次跑的格式不一样（一次 .xlsx、一次 .csv），
 * 所以把首选写进指令；存不了再退到 .csv（「缺工具先说」那条规矩接着管）。
 */
const TABLE_FORMAT = "表格存成 Excel 能直接打开的格式：.xlsx 最好；这台电脑存不了 .xlsx，就存 .csv。";

/**
 * 粘贴入口（#89）让同一张卡有了两种来料：选的文件，或者她直接贴进来的那段话。
 * 每张微信卡都要知道这件事，否则贴进来的内容会被当成「她随口补的一句要求」。
 */
const PASTED_CONTENT_RULE =
  "要整理的内容可能来自你选的文件，也可能整段贴在【用户的原话】里；两种都按上面的做法处理，不要因为没选文件就不做。";

/** The WeChat rule, stated twice on purpose: once as the promise the user sees,
 *  once as an imperative for the model. */
const WECHAT_RULE = [
  WECHAT_SAFETY_NOTICE,
  "不要发送任何消息",
  "不要登录微信",
  "不要修改或删除原文件",
].join("\n");

const TABLE_PLAN = [
  "打开你选的聊天记录文件（或者你贴进来的那段内容），只看不改，原件保持不动",
  "按时间顺序把每一句话整理成一行：时间、说话人、原话",
  "接龙那种一条里写了几个人的，拆成一人一行；要紧的事单独列出来",
  "另存成一张新的表格文件：选了文件就放在它旁边，没选就放在桌面",
];

const DRAFT_PLAN = [
  "打开你选的聊天记录文件（或者你贴进来的那段内容），只看不改",
  "先列出需要你回复的消息清单",
  "再给每一条写一条回复草稿，和原话放在一起",
  "把草稿另存成一个新文件，放在聊天记录旁边，方便你逐条复制",
];

const BATCH_PLAN = [
  "打开你选的聊天记录文件（或者你贴进来的那段内容），只看不改",
  "先给出需要你回复的清单，一条一条列清楚",
  "再给清单上的每一条写一条回复草稿",
  "把清单和草稿放进同一个新文件，放在聊天记录旁边，方便你逐条处理",
];

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
  plan: TABLE_PLAN,
  risks: [
    "聊天记录里缺时间的消息，我会保留下来并标「时间看不清」，不会丢掉。",
    "语音、图片、表情在导出的记录里通常没有文字，表格里不会有这些内容。",
    "同一个人改过昵称时，可能被当成两个人在问你，请你按原话核对。",
    "碰到「接龙」这种一条消息里挤了好几个人的，我会尽量按编号拆开、每人一行；拆得对不对请你对着原话核一遍。",
  ],
  prompt(files: string[], instruction: string): string {
    return buildPrompt({
      what: "只做整理：读取下面的聊天记录，把内容整理成一张表格，另存为一个新的表格文件。",
      files,
      how: [
        "表格至少要有这几列：时间、说话人、原话",
        "「原话」这一列必须保留聊天里的原话，方便用户逐条核对，不要改写",
        "时间看不清的行也要保留下来，并标注「时间看不清」，不要丢掉",
        "碰到「接龙」这类一条消息里写了好几个人的，按编号拆成一条一条，每人一行；拿不准谁是谁的先保留原话并在最后提醒用户核对",
        PASTED_CONTENT_RULE,
        RESULT_PLACE_FILE,
        RESULT_PLACE_PASTE,
        "只在回复里列出发现，不要改动或删除原文件；整理完直接写出结果文件；确实拿不准的地方才停下来问我一句，其余不要中途停下来等回复",
      ],
      extraRule: WECHAT_RULE,
      instruction,
      done: "告诉我整理出多少行、表格文件放在哪个文件夹、有没有没看懂需要用户核对的内容",
    });
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
  plan: DRAFT_PLAN,
  risks: [
    "草稿只按聊天记录里的话写；记录里没提到的价格、日期我不会编，会留出来提醒你补。",
    "语气按常见的礼貌写法，不一定是你和对方平时的说话方式，发之前请自己读一遍。",
    "这些草稿不会自动发出去，要你自己复制过去发。",
  ],
  prompt(files: string[], instruction: string): string {
    return buildPrompt({
      what: "只做整理和起草：读取下面的聊天记录，先列出需要回复的消息清单，再为每一条写一条回复草稿，另存为一个新文件。",
      files,
      how: [
        "草稿要和对应的原话放在一起，方便用户核对和逐条复制",
        "每一条草稿都要能直接复制粘贴，不要出现占位符",
        PASTED_CONTENT_RULE,
        RESULT_PLACE_FILE,
        RESULT_PLACE_PASTE,
      ],
      extraRule: `${WECHAT_RULE}\n${DRAFT_SEND_NOTICE}`,
      instruction,
      done: "告诉我需要回复几条、写好多少条草稿、草稿文件放在哪个文件夹",
    });
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
  plan: BATCH_PLAN,
  risks: [
    "清单按记录里的话列，记录里没提到的信息我不会编，会留出来提醒你补。",
    "同一个人改过昵称时，可能被当成两个人在问你，请你核对。",
    "草稿的语气按常见的礼貌写法，发之前请自己读一遍；一条都不会自动发出去。",
  ],
  prompt(files: string[], instruction: string): string {
    return buildPrompt({
      what: "只做整理和起草：读取下面的聊天记录，先给出需要回复的清单，再为清单上的每一条写一条回复草稿，把清单和草稿放在同一个新文件里。",
      files,
      how: [
        "清单要一条一条列清楚，每条都带上对应的原话，方便用户核对",
        "每条草稿都要能直接复制粘贴，不要出现占位符",
        PASTED_CONTENT_RULE,
        RESULT_PLACE_FILE,
        RESULT_PLACE_PASTE,
      ],
      extraRule: `${WECHAT_RULE}\n${DRAFT_SEND_NOTICE}`,
      instruction,
      done: "告诉我清单上几条、写好多少条草稿、文件放在哪个文件夹",
    });
  },
  summaryHints: ["清单上几条", "写好多少条草稿", "文件放在哪个文件夹"],
};

// ---------------------------------------------------------------------------
// r12 — 接龙/报名（#86）：群里贴的那串字，直接变成能用的跟进表。
//
// 调研里最贵的一步不是统计，是「先把内容存成一个文件」：她会的是选中、Ctrl+C。
// 所以这两张卡按「整段贴进来」设计（第一张 needs: "text"），文件是加法不是门槛：
// 名单是花名册就直接选进来（第二张 needs: "files"），不是文件就一起贴在话里。
//
// 这两张卡和三张老卡同属微信族，红线也一样：只读、只出表格、发送永远由她自己做。
// 它们按仓库的约定单独成组导出（见 tasks/index.ts 的接线注释），集成者把它接进
// 目录以后才会出现在界面和粘贴入口上。
// ---------------------------------------------------------------------------

/**
 * #86 — 接龙整理成跟进表。
 *
 * 核心动作是统计而不是抄写：同一人多次提交要合成一行、份数要相加、来源要写清，
 * 看不懂的条目原样留在最后。最后一条不是客套——「不许丢、不许猜」是这张卡唯一
 * 不能出错的地方，因为猜错一个名字比留一条看不懂更得罪人。
 */
export const wechatRollcallTask: TaskDef = {
  id: "wechat.rollcall",
  title: "接龙整理成跟进表",
  example: "群里接龙的内容我贴进来了，帮我整理成一张表。",
  group: "微信",
  needs: "text",
  plan: [
    "把你贴进来的接龙从头看一遍，只看不改",
    "把同一个人重复报名的合成一条，算清楚每人报了几份",
    "数出总人数和总份数，每一行都标上是接龙里的第几条",
    "看不懂的几条原样留在表最后；整张表另存成一个新文件，别的东西一动不动",
  ],
  risks: [
    "同一个人写了两种叫法时（比如「张三」和「张三 13800000000」），我有没有合并对，请你对着来源条数核一遍。",
    "只写了名字没写份数的（比如「赵六」），还有「李四+1」「王五 带家属」这种，我看不准是几份，会留空并把两种可能都写给你，不默认按 1 份算。",
    "接龙里没贴到的部分我看不见：群里往上翻还有内容、或者你少选了几条，表里就不会有。",
    "真看不懂的条目我会原样抄在表格最后，不会丢掉，也不会自己猜一个名字填上。",
  ],
  prompt(files: string[], instruction: string): string {
    return buildPrompt({
      what: "只做整理和统计：把用户贴进来的接龙内容整理成一张跟进表，另存为一个新的表格文件。",
      files,
      how: [
        "先把接龙原样抄成一份底稿：一条一行、写清是接龙里的第几条，原话不要改写，方便用户逐条核对。",
        "同一个人报了多次的合成一行：份数相加，并把每一份分别来自接龙里的第几条都写在这一行里。",
        "判断「是不是同一个人」之前，先把你的判断方式写在表格最前面：是不是去掉了首尾空格、全角半角是否当成同一个字、名字后面的手机号算不算名字的一部分。只要你用了其中任何一条，就要写出来，不要留着不说。",
        "表里至少要有这几列：姓名、份数（合计）、来自第几条、原话。",
        "份数写清楚的按它算；写不清楚的（比如「带家属」「+几个人」）不要自己猜人数，留空并标出来等用户拿主意。",
        "读不懂、看不出是谁、或者和报名无关的条目，原样抄在表格最后，单独一栏写「没看懂的原话」并写清它是第几条；一条都不许丢，也不许自己猜一个名字填上。",
        "最后给出总人数与总份数，并说明这两个数是怎么数出来的（合并后几行、加上几条没看懂的）。",
        TABLE_FORMAT,
        PASTED_CONTENT_RULE,
        pasteResultPlace("那个文件"),
      ],
      extraRule: `${WECHAT_RULE}\n${DRAFT_SEND_NOTICE}`,
      instruction,
      done: "告诉我一共几个人、一共多少份、表格文件放在哪个位置、有哪几条没看懂需要我自己判断",
    });
  },
  summaryHints: [
    "一共几个人",
    "一共多少份",
    "表格文件放在哪个位置",
    "哪几条没看懂、需要你自己判断",
  ],
};

/**
 * #86 — 找出名单里还没交、没报名的人。
 *
 * 这张卡的价值全在「匹配靠不靠得住」上。所以指令把比对规则提到最前面：先写下
 * 自己打算怎么算同一个人，再开始对；名字像又不像的不许合并也不许拆开，单独列出
 * 来让人判断。含糊的地方说出来，比一个看起来干净的结果有用。
 */
export const wechatMissingTask: TaskDef = {
  id: "wechat.missing",
  title: "找出名单里还没交的人",
  example: "这是我们班的花名册，群里接龙谁还没报名？帮我列出来。",
  group: "微信",
  needs: "files",
  accept: ROSTER_ACCEPT,
  plan: [
    "先把名单和接龙都读一遍，只看不改",
    "先写下你打算怎么算「同一个人」：一模一样、去掉空格、还是全角半角算一个字",
    "按这个规则对一遍，分出「名单里有、接龙里没有」和「接龙里有、名单里没有」两边",
    "拿不准的名字单独列出来；整张表另存成一个新文件，别的东西一动不动",
  ],
  risks: [
    "名字差一个字（「张三」和「张三丰」）、或者一个写全名一个写昵称，我不会当成同一个人，也不会替你猜，这类会在结果里单独列出来。",
    "名单里有重名、或者接龙里有人换了写法时，配对结果可能不准，请你对着名单核一遍。",
    "去掉空格、全角半角算一个字这类做法会让配对更宽松；我实际用了哪几条会写在结果最前面，你一看就知道我是怎么对的。",
    "接龙里没贴到的部分我看不见：群里往上翻还有内容、或者你少选了几条，就会有人被误判成没交。",
  ],
  prompt(files: string[], instruction: string): string {
    return buildPrompt({
      what: "只做核对：把名单和接龙内容对一遍，找出名单上有、接龙里没出现的人，另存为一个新的表格文件。",
      files,
      how: [
        "先弄清楚两样东西：名单（可能是你选的文件，也可能贴在用户原话里）和接龙内容。缺哪一样就先说一句，不要凭猜测补齐。",
        "开始对之前，先用一句大白话把你要用的规则写出来：名字要一模一样才算同一个人，还是去掉首尾空格、全角半角当成同一个字、名字后面的手机号或括号备注不算名字的一部分。只要用了宽松的规则就要写出来，让人自己判断行不行。",
        "严格按你写下来的规则配对，不要中途悄悄换规则；换过就要说清楚。",
        "结果分成两边：名单上有、接龙里没出现的（还没交/没报名）；接龙里出现、名单上没有的（名单之外的人）。两边都写出名字和它在名单或接龙里的第几条。",
        "名字像又不像的（差一个字、全名对昵称），不要自己合并，也不要自己拆开，单独列一栏写「拿不准的名字」并说明差在哪里，让用户自己决定。",
        "读不懂、看不出名字的接龙条目，原样抄在结果最后，不要丢掉。",
        "最后给出数字：名单上几个人、接龙里到了几个人、还没交几个人，并说明这几个数是怎么数出来的。",
        TABLE_FORMAT,
        PASTED_CONTENT_RULE,
        pasteResultPlace("那份名单"),
      ],
      extraRule: `${WECHAT_RULE}\n${DRAFT_SEND_NOTICE}`,
      instruction,
      done: "告诉我名单上几个人、接龙里到了几个人、还没交的是哪几个、比对用的是什么规则、文件放在哪个位置",
    });
  },
  summaryHints: [
    "名单上几个人、接龙里到了几个",
    "还有谁没交、一共几个人",
    "比对是按什么规则做的",
    "表格文件放在哪个位置",
  ],
};

/** The WeChat slice of the catalogue, in the order the screen shows it. */
export const WECHAT_TASKS: TaskDef[] = [wechatTableTask, wechatDraftTask, wechatBatchTask];

/**
 * #86 的两张卡：按约定单独成组，等 `tasks/index.ts` 接线（集成者统一接）之后
 * 才进目录。单独放也有一层用处：老的三张卡是「读一个导出的文件」，这两张卡是
 * 「把字贴进来」，能不能只读、要不要文件本来就是两回事。
 */
export const WECHAT_PASTE_TASKS: TaskDef[] = [wechatRollcallTask, wechatMissingTask];

/** 微信族的全部卡片（老卡 + 新卡），粘贴入口按目录里现有的那张名单筛选后展示。 */
export const WECHAT_ALL_TASKS: TaskDef[] = [...WECHAT_TASKS, ...WECHAT_PASTE_TASKS];

/**
 * 粘贴入口只该摆「目录里真的有的卡」。
 *
 * 这是 P0 的教训（#93）：卡片不在目录里，确认时拼出来的指令就只有她那句话，
 * 卡里写好的规矩——先说明再动手、结果放哪、不许替她发消息——一条都到不了助手。
 * 宁可这张卡先不出现，也不能让一个「名字是对的、规矩是空的」的卡被人点开。
 */
export function offerableTasks(all: readonly TaskDef[], knownIds: readonly string[]): TaskDef[] {
  const known = new Set(knownIds);
  return all.filter((task) => known.has(task.id));
}

/**
 * 从首页点一张微信卡进来时，这一屏该预选哪一张。
 * 给的那张不在能摆的清单里（目录里没有、或被管理员关掉）就落到第一张，绝不选中
 * 一张摆不出来的卡——那又回到了「卡不在目录里，规矩发不出去」那条老路。
 */
export function initialTaskId(offered: readonly TaskDef[], wanted?: string): string {
  if (wanted && offered.some((task) => task.id === wanted)) return wanted;
  return offered[0]?.id ?? "";
}

/** Lowercase alias so the catalogue workstream can import whichever reads best. */
export const wechatTasks = WECHAT_TASKS;

export default WECHAT_TASKS;
