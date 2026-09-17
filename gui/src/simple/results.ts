// r17 — 「我做的结果」：结果文件按规矩留在原文件旁边，但她只记得「上次那张表」。
//
// 这个模块给那扇门配一份算得清的数据：一次做过的活产出了哪些文件、来自哪张卡
// （或者她说的哪句话）、什么时候做的、本机核对下来现在还在不在。
//
// 三条边界，一条都不让步：
//   * 数据只来自 store 已有的 runs()，不另存一份「结果清单」——两份账一定会对不上；
//   * 「还在不在」只认本机 file_facts 的说法：没核对到就说没核对到，绝不假装它还在；
//   * 搜索复用 history-search.ts 的 normalize，中文匹配不另写一套。
//
// 纯逻辑：没有 Solid，也没有桥接，所以 bun test 能直接钉住顺序、搜索和四种现状。

import { normalize } from "./history-search.ts";
import { fileName, folderName, type RunState, type TaskRun } from "./run.ts";
import type { FileFact } from "./verify.ts";

/**
 * 本机对一份结果文件的说法。四种，一种都不含糊：
 *   present    还在，而且能打开；
 *   missing    不在了（被移动或删掉）；
 *   unreadable 还在，但现在打不开（被占用、没权限）；
 *   unknown    这次没能核对——绝不当成「还在」。
 */
export type ResultPresence = "present" | "missing" | "unreadable" | "unknown";

/** 一条结果文件：面板上的一行。 */
export interface ResultEntry {
  /** 同一次做的活里的同一个文件算一条：runId + 文件位置。 */
  key: string;
  runId: string;
  /** 结果文件的完整位置，交给「打开文件 / 打开所在文件夹」。 */
  path: string;
  /** 文件名（不含文件夹）。 */
  name: string;
  /** 它所在的文件夹。 */
  folder: string;
  /** 它来自哪张卡；她自己说的一句话，卡片名就是「直接说一件事」。 */
  title: string;
  /** 她当时补的那句话（卡片任务常常是空的）。 */
  instruction: string;
  /** 做好这份结果的时间。 */
  createdAt: number;
  /** 那次做的结果：做完了 / 没做完 / 已经停下。 */
  state: RunState;
  /** 本机核对出来的现状。 */
  presence: ResultPresence;
  /** 文件字节数；核对不到时为 null。 */
  size: number | null;
}

/** 一次记录里声明的结果文件位置，去掉空值和重复，保持出现顺序。 */
function filesOf(run: TaskRun): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of run.result?.files ?? []) {
    const path = typeof file?.path === "string" ? file.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function createdOf(run: TaskRun): number {
  return typeof run.createdAt === "number" && Number.isFinite(run.createdAt) ? run.createdAt : 0;
}

/** 本机能告诉我们的事实；问不到（null）时统一按「没能核对」算。 */
function presenceOf(
  path: string,
  byPath: Map<string, FileFact> | null,
): { presence: ResultPresence; size: number | null } {
  if (!byPath) return { presence: "unknown", size: null };
  const fact = byPath.get(path);
  if (!fact) return { presence: "unknown", size: null };
  if (!fact.exists) return { presence: "missing", size: null };
  if (!fact.readable) return { presence: "unreadable", size: fact.size };
  return { presence: "present", size: fact.size };
}

/**
 * 把所有做过的东西摊成一份结果文件清单，最近的在最上面。
 *
 * 顺序用的是「哪次做的时间」，不是文件自己的修改时间：她要找的是「上礼拜做的那张
 * 表」，能对上的就是那次活的时间。同一次活里产出的文件保持原来的顺序。
 * `facts === null` 表示这次没问成本机，每一行都会如实说「没能核对」。
 */
export function collectResults(
  runs: readonly TaskRun[],
  facts: readonly FileFact[] | null,
): ResultEntry[] {
  const byPath = facts === null ? null : new Map(facts.map((fact) => [fact.path, fact]));
  const entries: ResultEntry[] = [];
  for (const run of runs) {
    for (const path of filesOf(run)) {
      const { presence, size } = presenceOf(path, byPath);
      entries.push({
        key: `${run.id}|${path}`,
        runId: run.id,
        path,
        name: fileName(path),
        folder: folderName(path),
        title: run.taskTitle,
        instruction: run.instruction,
        createdAt: createdOf(run),
        state: run.state,
        presence,
        size,
      });
    }
  }
  // 她的记录本来就从新到旧；这里再排一次，免得输入顺序变了就让最该看见的那条沉底。
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return entries;
}

/** 一共做过几份结果文件（同一次活里的同一个文件算一份）。首页入口用它显示数字。 */
export function resultCount(runs: readonly TaskRun[]): number {
  const seen = new Set<string>();
  let count = 0;
  for (const run of runs) {
    for (const path of filesOf(run)) {
      const key = `${run.id}|${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count += 1;
    }
  }
  return count;
}

/**
 * 要一次问清本机的那些文件位置（去重后按出现顺序）。
 *
 * 一次问一整批，而不是每行问一次：她可能做过几十件事，几十次往返只会让面板慢慢
 * 地亮起来。返回空数组表示还没有做过结果文件，那就不用问。
 */
export function resultPaths(runs: readonly TaskRun[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of runs) {
    for (const path of filesOf(run)) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

/**
 * 按文件名、卡片名或者她当时说的那句话找。
 *
 * 复用 history-search.ts 的 normalize（全角折半角、大小写、空白压缩），中文本身
 * 一个字都不切。空搜索词返回全部，没命中返回空数组，让界面去给出路。
 */
export function searchResults(entries: readonly ResultEntry[], query: string): ResultEntry[] {
  const needle = normalize(query);
  if (needle.length === 0) return entries.slice();
  return entries.filter((entry) =>
    [entry.name, entry.title, entry.instruction].some((text) => normalize(text).includes(needle)),
  );
}

/**
 * 这个文件现在能不能点开。
 *
 * 只有本机明确说「不在了」才把「打开文件」关掉——那时点它只会报一次错，不如直说。
 * 「没能核对」和「在但打不开」都留着按钮：她自己去点一下，比我们说一句猜的话有用。
 */
export function canOpen(entry: ResultEntry): boolean {
  return entry.presence !== "missing";
}
