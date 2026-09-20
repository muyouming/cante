// 「我做的结果」的全部中文文案（r17）。
//
// 结果文件一直按规矩留在原文件旁边（结果永不覆盖原文件），这个面板只是把她做过的
// 东西汇总到一处，让她找得回来。所以这里的话只有两个任务：说清哪一个文件是什么，
// 以及如实说它现在还在不在、不在时她能怎么办。
//
// 和别的 copy 模块一样：面向用户的每一句都在这儿，全中文、零术语（没有「路径」
// 「日志」「接口」这类词）。判断逻辑在 results.ts，界面在 ResultsPanel.tsx。

export const RESULTS = {
  ariaSection: "我做的结果",

  title: "我做的结果",
  subtitle: "你做过的东西都在这里，最近的在最上面。原来的文件一直没动过，这里只是帮你找到结果。",

  // ---- 首页入口 ----------------------------------------------------------
  entryTitle: "我做的结果",
  entryBody: "上次做出来的表放在哪儿，这里都记着，随时能打开。",
  /** 有结果时带上件数，她一眼知道里面有没有东西。 */
  entryButton: (count: number): string =>
    count > 0 ? `打开我做的结果（${count} 个）` : "打开我做的结果",

  close: "回到首页",

  // ---- 按时间分组（不用回忆文件名也能找） --------------------------------
  // 她记的是「我那天做的月报」，所以除了搜索，再给她一条按时间翻的路。三个标题
  // 都是真的标题（ResultsPanel 里是 <h3>），读屏可以靠它一组一组跳过去。
  group: {
    today: "今天做的",
    week: "这周做的",
    earlier: "更早做的",
  },

  // ---- 搜索 --------------------------------------------------------------
  search: {
    label: "找一找结果文件",
    placeholder: "比如：汇总表、报名名单、上个月那张表",
    ariaLabel: "搜索做过的结果文件",
    clear: "清空搜索词，重新找",
  },
  /** 有搜索词时，她一眼能看到还剩几份。 */
  hits: (count: number): string => `找到 ${count} 个结果文件`,

  // ---- 清单本身 ----------------------------------------------------------
  /**
   * 清单容器上的可数语义：读屏进到这个列表时先听到「一共 N 份结果」，才知道
   * 自己手上是第几份、后面还有多少。视觉上不显示（只挂在列表的名字上）。
   */
  list: {
    ariaLabel: (count: number): string => `一共 ${count} 份结果`,
  },

  // ---- 一份都没有 --------------------------------------------------------
  // 她是新用户时看到的就是这一屏：第一次点开这个面板，里面一份都没有。所以这里
  // 除了说清「你还没做过东西」，还得在卡片里就给出路——不能只靠右上角那个「回到
  // 首页」关闭键（它在角落里，和这段话隔着一整个屏）。按钮开的是卡片库，即「你要
  // 做什么」那一屏：她一进去就能看到 32 件事、每件都带一句例子，挑一件就能开始。
  empty: {
    title: "还没有做过结果文件",
    body: "回到首页，挑一件事交给我；做完的结果都会记在这里，以后随时找得到。",
    /** 卡片里的出路：去卡片库看看能做什么。名字与首页那个入口同一套说法。 */
    explore: "去看看能做什么",
  },

  // ---- 搜不到（一定要给出路） -------------------------------------------
  noResult: {
    title: "没找到这个结果文件",
    body: "可能名字和我记的不一样。换个词再找一次；或者回到首页，用一句话重新说一遍你要做什么。",
  },

  // ---- 每一条 ------------------------------------------------------------
  /** 「来自「把几张表合成一张」：只留今年的客户」 */
  from: (title: string, instruction: string): string => {
    const said = instruction.trim();
    return said ? `来自「${title}」：${said}` : `来自「${title}」`;
  },
  /** 「做好的时间：今天 14:30」 */
  when: (text: string): string => `做好的时间：${text}`,
  /** 「大小 12.3 KB」 */
  size: (text: string): string => `大小 ${text}`,

  // ---- 现在还在不在（四种说法，一种都不含糊） ---------------------------
  presence: {
    present: "现在还在，能打开。",
    missing:
      "这个文件现在找不到了：它可能被移动或删掉了；原文件没受影响。可以打开所在文件夹找一找。",
    unreadable: "这个文件还在，但现在打不开；可能被别的程序占着，关掉它再试一次。",
    unknown: "这次没能核对它还在不在。可以打开所在文件夹自己看一眼。",
  },

  // ---- 每一条上的两个动作 ------------------------------------------------
  actions: {
    open: "打开文件",
    // 名字必须带上文件名：真机 UIA 走查量到 47 行的按钮共用同一句常量，读屏 Tab
    // 到第 30 行时分不清是哪一份结果（WINDOWS-ACCEPTANCE-19.md §3）。带上文件名
    // 她就能听出是哪一份；文件名她本来就认得，也不用把机器位置念出来。
    ariaOpen: (name: string): string => `打开 ${name}`,
    openFolder: "打开所在文件夹",
    ariaOpenFolder: (name: string): string => `打开 ${name} 所在的文件夹`,
    /** 文件已经不在时，「打开文件」为什么点不动。 */
    goneDisabled: "文件已经不在了，先按上面的办法找一找",
  },

  /** ResultCard 上补的一句：以后还能在哪儿找到它。 */
  keepHint: "以后也能在首页的「我做的结果」里找到它。",
} as const;

// ---------------------------------------------------------------------------
// 她点「打开文件 / 打开所在文件夹」失败时的说法。
//
// 为什么单独有这一节：这两个按钮打不开有**好几种**原因（这台电脑没有能打开它的程序、
// 文件被别的程序开着、不让打开、文件已经不在了……），而她会做的下一步**每一种都不同**。
// 把失败一股脑说成「找不到了」或者「格式不对」，她就会去重选一份本来好好的文件。
//
// 每条判断都只认系统真的会说的那串字（Windows / Rust 打印的错误码 `os error N`、
// `no application is associated`、`path doesn't exist`），认不出来就退回通用出口——
// 绝不编一个像模像样的原因。事实与依据见 gui/docs/OPEN-FILE-FAILURES.md。
// ---------------------------------------------------------------------------

export interface OpenFailureView {
  /** 发生了什么。 */
  what: string;
  /** 她真能做的下一步。 */
  how: string;
}

export const OPEN_FAILED = {
  /** 文件不在了（`open_path` 的前置检查）。 */
  missing: {
    what: "这个文件现在找不到了。",
    how: "它可能被移动或删掉了，原来的文件没受影响。点「打开所在文件夹」找一找。",
  },
  /** 这台电脑上没有任何程序认得这种文件（Windows 的错误码 1155）。 */
  noProgram: {
    what: "这台电脑上还没有能打开这种文件的程序。",
    how: "装一个能打开表格的软件（比如 WPS）再点「打开文件」。想先看看文件本身，就点「打开所在文件夹」。",
  },
  /** 文件被别的程序开着（Windows 的共享冲突，错误码 32 / 33）。 */
  busy: {
    what: "有别的程序正开着这个文件，所以现在打不开。",
    how: "在任务栏里找到那个程序，把它的窗口关掉。常见的是 Excel 或 WPS。再点「打开文件」。",
  },
  /** 系统不让打开（Windows 的错误码 5，或 EACCES）。 */
  denied: {
    what: "这台电脑不让你打开这个文件。",
    how: "可以先把文件复制到桌面，再点「打开文件」试一次。还不行，就请懂电脑的同事来看一眼。",
  },
  /** 文件夹不在了（`reveal_path` 找它所在的文件夹时）。 */
  folderMissing: {
    what: "这个文件夹现在找不到了。",
    how: "它可能被移动或删掉了。可以回到「我做的结果」里再看一眼。",
  },
  /** 系统不让打开这个文件夹。 */
  folderDenied: {
    what: "这台电脑不让打开这个文件夹。",
    how: "可以请懂电脑的同事来看一眼。文件本身没受影响。",
  },
  /** 打开文件夹失败，但认不出原因。 */
  folderUnknown: {
    what: "这个文件夹没能打开。",
    how: "可以回到「我做的结果」里再看一眼，或者请懂电脑的同事来帮忙。",
  },
  /** 打开的是浏览器里的预览，没连上桌面程序。 */
  bridge: {
    what: "这个功能要在桌面上的 Cante 程序里才能用。",
    how: "先找到并打开电脑上装的「Cante」，再从那里点「打开文件」。",
  },
  /** 认不出来的失败：只说这一句，不假装知道是哪种。 */
  unknown: {
    what: "这个文件没能打开。",
    how: "可以点「打开所在文件夹」，自己找到它再双击打开。",
  },
} as const satisfies Record<string, OpenFailureView>;

/** 桥不在时的原话（store 的 trustDetail 逐字写它）。 */
const BRIDGE_OPEN = /这个功能要在 Cante 桌面版里使用|desktop bridge unavailable|__TAURI_INTERNALS__/i;
/** 文件真的不在了：`open_path` 自己写的前缀。 */
const OPEN_MISSING = /这个文件找不到了：/;
/** 没有程序认得它（Windows 的错误码 1155）。 */
const OPEN_NO_PROGRAM =
  /no application is associated|没有关联|没有.{0,8}程序可以打开|os error 1155\b|你要怎么打开这个文件|how do you want to open/i;
/** 被别的程序占着（Windows 共享冲突 32 / 33）。 */
const OPEN_BUSY =
  /being used by another|sharing violation|resource busy|\bEBUSY\b|file is locked|正被.{0,30}(占用|使用)|已被.{0,20}打开|os error (32|33)\b/i;
/** 系统不让打开（Windows 的错误码 5 / 13，或 POSIX）。 */
const OPEN_DENIED =
  /access is denied|permission denied|operation not permitted|\bEACCES\b|\bEPERM\b|os error (5|13)\b|拒绝访问|没有权限|权限不足/i;
/** 文件夹不在了（插件在 Windows 上给的就是这一句）。 */
const OPEN_FOLDER_MISSING = /path doesn't exist|找不到(该)?文件夹/i;

/** store 里「打开文件」失败时逐字写的那两个开头（对齐 store.ts 的 setNotice）。 */
const OPEN_FILE_PREFIX = "打不开这个文件。";
const OPEN_FOLDER_PREFIX = "打不开它所在的文件夹。";

/**
 * 把 store 的「打开文件 / 打开所在文件夹」失败原话，翻成她看得懂的一句 + 下一步。
 *
 * 只认这两个开头：别处的提示（撤销成功、选文件窗口打不开、出错）原样返回 null，
 * 不抢别人的话。认得出「是这两个动作失败了」但认不出具体原因时，给通用出口——
 * 说得出发生了什么，也给得出下一步，但不假装知道是哪一种。
 */
export function openFailureView(text: string | null | undefined): OpenFailureView | null {
  const source = typeof text === "string" ? text : "";
  const opened = source.startsWith(OPEN_FILE_PREFIX);
  const revealed = source.startsWith(OPEN_FOLDER_PREFIX);
  if (!opened && !revealed) return null;

  const detail = opened
    ? source.slice(OPEN_FILE_PREFIX.length)
    : source.slice(OPEN_FOLDER_PREFIX.length);

  if (BRIDGE_OPEN.test(detail)) return OPEN_FAILED.bridge;
  if (OPEN_MISSING.test(detail)) return OPEN_FAILED.missing;
  if (OPEN_NO_PROGRAM.test(detail)) return OPEN_FAILED.noProgram;
  if (OPEN_BUSY.test(detail)) return OPEN_FAILED.busy;
  if (OPEN_DENIED.test(detail)) return revealed ? OPEN_FAILED.folderDenied : OPEN_FAILED.denied;
  if (revealed) {
    return OPEN_FOLDER_MISSING.test(detail) ? OPEN_FAILED.folderMissing : OPEN_FAILED.folderUnknown;
  }
  return OPEN_FAILED.unknown;
}
