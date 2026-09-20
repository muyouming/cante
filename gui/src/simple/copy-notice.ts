// 界面上「提示」那句话的唯一出口（#140）。
//
// store 里的 `notice` 原本是一条只写不读的许诺：撤销成功、撤销失败、出错、选文件
// 窗口打不开，这四条活路径都会写它——我们对她说「会告诉她」，话却从来没说出口。
//
// 这个模块负责把那条原话翻成界面上真能显示的两句：
//
//   发生了什么（what） + 你可以怎么做（how）
//
// 只认 store.ts 里真实写过的那几个开头（见 store.ts 的 setNotice）。认不出来的原话
// 一律返回 null：出错页自己会用平实中文说一遍，这里不重复；程序的英文原文也不端到
// 她面前（那属于「技术详情」）。哪一屏显示哪几类由 `visibleNotice` 决定。

import { ERRORS, explainError } from "./copy.ts";

/** store.notice() 里那四条许诺各是哪一类。 */
export type NoticeKind =
  | "undo-ok"
  | "undo-partial"
  | "undo-failed"
  | "undo-nothing"
  | "pick-files"
  | "pick-folder"
  | "error";

export interface NoticeView {
  kind: NoticeKind;
  /** 发生了什么（中文；撤销成功那条会带上恢复的个数）。 */
  what: string;
  /** 你可以怎么做。 */
  how: string;
  /** store 里的原话，只给去重和测试用；界面不直接显示它。 */
  source: string;
}

/** 结果卡片上「撤销」的四种结果（多的那种是「根本没有可恢复的记录」）。 */
export const UNDO_KINDS: readonly NoticeKind[] = [
  "undo-ok",
  "undo-partial",
  "undo-failed",
  "undo-nothing",
];
/** 选文件那一步「窗口打不开」。 */
export const PICK_KINDS: readonly NoticeKind[] = ["pick-files", "pick-folder"];
/** 出错页。 */
export const ERROR_KINDS: readonly NoticeKind[] = ["error"];

// store 里真实写过的开头，逐字对齐（谁改 store 的措辞，这里会先红）。
const PICK_FILES_PREFIX = "打不开选择文件的窗口。";
const PICK_FOLDER_PREFIX = "打不开选择文件夹的窗口。";
const UNDO_OK_PREFIX = "已经放回去了";
const UNDO_PARTIAL_PREFIX = "放回去了 ";
const UNDO_FAILED_PREFIX = "没能撤销。";
// 「根本没有可恢复的记录」这一句：store 逐字写它，这里按前缀认回来。
export const UNDO_NOTHING_WHAT = "这次的文件我没有留下可以放回去的记录。";
const UNDO_NOTHING_PREFIX = UNDO_NOTHING_WHAT;

export const NOTICE = {
  /** 撤销成功之后她还能做的一件事。 */
  undoOkHow: "文件已经恢复成动手前的样子，你可以打开看一下。",
  /** 只放回去一部分：剩下的要她自己动手，说清去哪儿、做什么。 */
  undoPartialHow:
    "没能自动放回去的那几个，需要你打开文件所在的文件夹，把它们放回原来的地方。也可以把这件事交给懂电脑的同事。",
  /** 一个都没放回去：不许说「已撤回」，要给她一条再试的路。 */
  undoFailedHow: "原来的文件没有被改动，都还在。你可以过一会儿再点一次「撤销这次操作」。",
  /**
   * 没有可恢复的记录：撤销什么也没做。这里**不许**说「已经放回去了」，
   * 也**不许**让她「再点一次」——记录不在，再点多少次结果都一样。
   * 给的两条出路都是真有的：去「我做的结果」看现在的文件；备份可能还在这台
   * 电脑的私有目录里（有没有要看当时有没有建备份），可以请懂电脑的同事来帮忙。
   */
  undoNothingHow:
    "你可以打开「我做的结果」，看一眼这次做出来的文件还在不在、是不是你要的。想变回动手前的样子，可以请懂电脑的同事来帮忙。让他看看这台电脑里有没有备份。",
  /** 选文件的窗口没打开：告诉她还能怎么选，而不是只说「发生错误」。 */
  pickHowFiles:
    "你可以再点一次「选择文件」；也可以把文件直接拖进这个窗口。要是还打不开，把 Cante 关掉再重新打开一次。",
  pickHowFolder:
    "你可以再点一次「选择文件夹」；也可以把文件夹直接拖进这个窗口。要是还打不开，把 Cante 关掉再重新打开一次。",
} as const;

/**
 * 把 store.notice() 的原话翻成界面上的 what / how。
 *
 * 认不出来的句子返回 null：宁可不说，也不硬编一句像模像样的「原因」，更不把程序
 * 的英文原文端给她看。
 */
export function noticeView(text: string | null | undefined): NoticeView | null {
  const source = typeof text === "string" ? text : "";
  if (source === "") return null;
  if (source.startsWith(PICK_FILES_PREFIX)) {
    return { kind: "pick-files", what: PICK_FILES_PREFIX, how: NOTICE.pickHowFiles, source };
  }
  if (source.startsWith(PICK_FOLDER_PREFIX)) {
    return { kind: "pick-folder", what: PICK_FOLDER_PREFIX, how: NOTICE.pickHowFolder, source };
  }
  if (source.startsWith(UNDO_OK_PREFIX)) {
    return { kind: "undo-ok", what: source, how: NOTICE.undoOkHow, source };
  }
  if (source.startsWith(UNDO_PARTIAL_PREFIX)) {
    return { kind: "undo-partial", what: source, how: NOTICE.undoPartialHow, source };
  }
  if (source.startsWith(UNDO_FAILED_PREFIX)) {
    return { kind: "undo-failed", what: UNDO_FAILED_PREFIX, how: NOTICE.undoFailedHow, source };
  }
  if (source.startsWith(UNDO_NOTHING_PREFIX)) {
    return { kind: "undo-nothing", what: UNDO_NOTHING_WHAT, how: NOTICE.undoNothingHow, source };
  }
  // 其余都归「出错」：只有能认出具体原因（正被占用、没权限、没空间……）时才说。
  // 泛泛的「出了点问题」由出错页自己说，不在这里重复第二遍。
  const human = explainError(source);
  if (human.what === ERRORS.genericWhat) return null;
  return { kind: "error", what: human.what, how: human.how, source };
}

/**
 * 这一屏该不该显示、显示哪一条。
 *
 * `kinds` 是「这一屏只说自己那一类」（结果卡片只认撤销、出错页只认出错……）；
 * `alreadySaid` 是屏幕上已经出现过的句子，避免同一件事说两遍。
 */
export function visibleNotice(
  text: string | null | undefined,
  kinds?: readonly NoticeKind[],
  alreadySaid?: readonly string[],
): NoticeView | null {
  const view = noticeView(text);
  if (!view) return null;
  if (kinds && !kinds.includes(view.kind)) return null;
  if (alreadySaid && alreadySaid.includes(view.what)) return null;
  return view;
}
