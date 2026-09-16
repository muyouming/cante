// 「我做过的事」的全部中文文案（#57）。
//
// 和 copy.ts、copy-library.ts 一样：这里只放面向用户的话，一条术语都没有。
// 单独一个文件，是为了不和别的 workstream 正在改的 copy.ts 抢同一行。
//
// 基调是「找得到、跑得动」：她要的是复用上个月那张表，不是读一份流水账。
// 所以搜索框的提示语举她真会说出口的词，搜不到的时候给出两条出路，而
// 「再跑一次」必须说清下一步会发生什么——先给你看一眼，确认了才动手。
import type { TaskRun } from "./run.ts";

/** 一条记录的状态，用她的话说，不用系统的说法。 */
const STATE: Record<TaskRun["state"], string> = {
  draft: "还没开始",
  preview: "等你确认",
  running: "正在做",
  done: "已完成",
  failed: "没做完",
  cancelled: "已停止",
};

export const HISTORY = {
  ariaSection: "我做过的事",

  title: "我做过的事",
  subtitle: "按时间倒序，最近的在最上面。搜一搜就能找到上个月那张表，照着再做一遍。",

  // ---- 搜索 --------------------------------------------------------------
  search: {
    label: "找一找做过的事",
    placeholder: "比如：上次那个表、微信报名、客户名单",
    ariaLabel: "搜索做过的记录",
    clear: "换个词再搜",
    ariaClear: "清空搜索词，重新搜",
  },
  /** 有搜索词时，她一眼能看到还剩几件。 */
  hits: (count: number): string => `找到 ${count} 件`,

  /** 说清「再跑一次」之后会发生什么，免得她以为文件已经被动了。 */
  rerunHint: "点「按上次的参数再跑一次」，会先给你看一眼要做什么，确认了才动手。",

  // ---- 一件都没做过 ------------------------------------------------------
  empty: {
    title: "还没有做过任何事情",
    body: "回到首页，挑一件事交给我；或者直接用一句话告诉我你要做什么。",
  },

  // ---- 搜不到（一定要给出路） -------------------------------------------
  noResult: {
    title: "没找到这一件",
    body: "可能名字和我记的不一样。换个词再搜一次；或者回到首页，用一句话重新说一遍你要做什么。",
  },

  // ---- 每一条记录 --------------------------------------------------------
  state: STATE,

  /** 「处理了 3 个文件：报名表.xlsx、名单.xlsx 等」 */
  filesLine: (count: number, names: string, truncated: boolean): string =>
    truncated ? `处理了 ${count} 个文件：${names} 等` : `处理了 ${count} 个文件：${names}`,
  noFiles: "没有选文件，内容来自你说的话",
  /** 「结果：汇总.xlsx 等 3 个」 */
  resultsLine: (names: string, total: number, truncated: boolean): string =>
    truncated ? `结果：${names} 等 ${total} 个` : `结果：${names}`,
  noResultFiles: "没有生成新文件",
  failedFiles: (count: number): string =>
    `有 ${count} 个文件没能自动还原，请按提示去文件夹里看看。`,

  // ---- 一条记录上的按钮 --------------------------------------------------
  actions: {
    openResult: "打开结果",
    ariaOpenResult: "打开这次生成的结果文件",
    openFolder: "打开所在文件夹",
    ariaOpenFolder: "打开结果文件所在的文件夹",
    rerun: "按上次的参数再跑一次",
    ariaRerun: "按上次的做法再跑一次这件事",
    undo: "一键撤销",
    ariaUndo: "撤销这件事做的改动",
    undone: "已撤销",
  },
} as const;
