// 「她手里刚拿到一个文件，不知道能用它做什么」——按文件类型给出最可能要做的那几件事。
//
// 任务库是**按任务名**组织的（「把几张表合成一张」），而她的处境常常相反：微信
// 发来的报名表就在手上，她不知道该选哪张卡。所以这一步放在**选完文件之后**：文件
// 已经在她手里了，我们按文件类型把最可能要做的事摆出来，点一句就等于选了那张卡。
//
// 三条规矩：
//   * **复用现有卡**：这里的每一个 id 都是目录里真的存在的一张卡，绝不新造任务；
//     拼不出指令的 id 一律丢掉（`byId` 说了算）。
//   * **不许多**：最多 `MAX_PICK_SUGGESTIONS` 条（她选不出来时，多给一条都是负担）。
//   * **认不出就如实说**：没有扩展名、或者不是我们认识的那几类时，返回空数组，
//     界面照 `copy-pick.ts` 的 `noIdea` 说明现在没有现成能做的事——**不假装知道**。
//
// 「一种文件算哪一类」不在这里另抄一份后缀表，而是**问卡片自己**：`accept` 里收这
// 个后缀的代表卡是哪一张。这样后缀清单只有一处真相（卡片），不会和卡片悄悄漂移；
// `pick.test.ts` 也据此断言「每一条建议指向的卡真的接受这种文件」。
//
// 纯函数，不碰界面、不碰后台，所以可以单独测。
import { PICK_SENTENCES } from "./copy-pick.ts";
import { TASKS, taskById, type TaskDef } from "./tasks/index.ts";

/** 最多给几条。她选不出来时，多给一条都是负担。 */
export const MAX_PICK_SUGGESTIONS = 5;

/** 我们按文件类型分的那几类。`unknown` 是"认不出来"，不是一种文件。 */
export type FileKind = "spreadsheet" | "pdf" | "image" | "unknown";

/** 一条建议：要选的那张卡 + 给她的那一句人话。 */
export interface PickSuggestion {
  task: TaskDef;
  sentence: string;
}

/**
 * 每一类的**代表卡**：它 `accept` 里的后缀就是这一类认的后缀。
 *
 * 取代表卡而不是自己写一份后缀表：后缀清单只有一处真相（卡片自己），改卡片的
 * `accept` 时这里跟着变，不会漂移。
 */
const REPRESENTATIVE: Readonly<Record<Exclude<FileKind, "unknown">, string>> = {
  spreadsheet: "excel.merge",
  pdf: "pdf.merge",
  image: "vision.table",
};

/**
 * 每一类文件最可能要做的那几件事（就是卡片 id），按想做的先后排。
 *
 * 这是**精选**，不是目录的镜像：只放"拿到这种文件的人十有八九想做的那几件"。
 * `unknown` 故意没有条目——认不出来时给通用出路，不硬凑。
 */
const BY_KIND: Readonly<Record<Exclude<FileKind, "unknown">, readonly string[]>> = {
  spreadsheet: ["excel.merge", "excel.group", "check.totals", "check.reconcile", "excel.filter"],
  pdf: ["invoice.ledger", "pdf.split", "pdf.merge", "pdf.toword", "doc.summary"],
  image: ["vision.table"],
};

/** 先出哪一类（一批文件里混着好几类时，按这个顺序轮流取）。 */
const KIND_ORDER: readonly Exclude<FileKind, "unknown">[] = ["spreadsheet", "pdf", "image"];

/**
 * 取路径最后一段的扩展名（小写，不带点）；没有就返回 null。
 *
 * 只取最后一段：文件夹名里也可能有点（「2024.05 报表」），整条路径上找最后一个点
 * 会把它当成扩展名。末尾常见的逗号、分号、句号一并去掉（她手滑打的）。
 */
function extensionOf(path: string): string | null {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1).trim().replace(/[，,;；。\s]+$/u, "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** 这张卡收不收这种后缀（`accept` 没写的卡一律算不收）。 */
function accepts(task: TaskDef | undefined, extension: string): boolean {
  return (task?.accept ?? []).some((item) => item.toLowerCase() === extension);
}

/**
 * 一个文件属于哪一类：**问代表卡收不收这个后缀**。
 *
 * 认不出来（没有后缀、或者谁都不收）就是 `unknown`——不硬凑一个类型出来。
 */
export function kindOf(path: string): FileKind {
  const extension = extensionOf(path);
  if (!extension) return "unknown";
  for (const kind of KIND_ORDER) {
    if (accepts(taskById(REPRESENTATIVE[kind]), extension)) return kind;
  }
  return "unknown";
}

/**
 * 这批文件里有哪几类（去重、按 KIND_ORDER 排、不含 unknown）。
 *
 * 混着好几类时（一张 xlsx + 一份 pdf），两类都算数：建议按类型轮流取，别让
 * 先出现的那一类把名额占满。
 */
export function kindsOf(paths: readonly string[]): Exclude<FileKind, "unknown">[] {
  const seen = new Set(paths.map(kindOf));
  return KIND_ORDER.filter((kind) => seen.has(kind));
}

/**
 * 「手里这些文件，最可能要做的是这几件」。
 *
 *   * 空选择、或者全是认不出来的类型 → 空数组（界面据此如实说没有现成能做的事）；
 *   * 混着好几类时，按类型轮流取，最多 `limit` 条；
 *   * 每一张卡都必须在传入的 `tasks` 里真的存在、而且 `PICK_SENTENCES` 里有一句
 *     人话——找不到就跳过，绝不凭空造一句。
 */
export function suggestFromFiles(
  paths: readonly string[],
  tasks: readonly TaskDef[] = TASKS,
  limit: number = MAX_PICK_SUGGESTIONS,
): PickSuggestion[] {
  const kinds = kindsOf(paths);
  if (kinds.length === 0) return [];

  const byId = new Map(tasks.map((task) => [task.id, task] as const));

  // 每一类的候选先按卡片 id 翻成 {task, sentence}，翻不出来的（卡没了、没有一句
  // 人话）当场丢掉，别把空占位排进结果。
  const queues = kinds.map((kind) =>
    BY_KIND[kind]
      .map((id) => {
        const task = byId.get(id);
        const sentence = PICK_SENTENCES[id];
        if (!task || !sentence) return null;
        return { task, sentence } satisfies PickSuggestion;
      })
      .filter((item): item is PickSuggestion => item !== null),
  );

  // 轮流从每一类里取一条：混着好几类时，谁也不会把名额占满。
  const out: PickSuggestion[] = [];
  const picked = new Set<string>();
  for (let round = 0; out.length < limit; round += 1) {
    let added = false;
    for (const queue of queues) {
      const item = queue[round];
      if (!item) continue;
      added = true;
      if (picked.has(item.task.id)) continue;
      picked.add(item.task.id);
      out.push(item);
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}
