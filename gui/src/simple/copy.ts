// Every user-facing string of the simple (plain-language) UI lives here.
//
// The people this screen is for do not work in IT. So the rules are strict:
// all text is Chinese, no jargon (no 模型 / provider / token / 会话 / 上下文 /
// 路径 …), and a failure always answers two questions — 发生了什么 and
// 你可以怎么做. Keeping the strings in one module makes the whole surface
// reviewable at a glance instead of hunting through JSX.

export const APP_NAME = "Cante";

/** Shared controls; anything with the same meaning reads the same everywhere. */
export const COMMON = {
  back: "返回",
  retry: "重试",
  alternative: "换个方法",
  copyDetail: "复制详情",
  copied: "已复制",
  copyFailed: "复制失败，请手动选中下面的文字复制",
  proMode: "专业模式",
  simpleMode: "简单模式",
  retryHint: "再试一次",
  alternativeHint: "换一种做法",
  copyHint: "把这段文字发给懂电脑的人",
} as const;

// ---------------------------------------------------------------------------
// Task groups — the home page groups cards by these headings, in this order.
// The keys are the literal group names `TaskDef.group` uses (frozen in the
// round-5 interface), so a new task only has to pick one of them.
// ---------------------------------------------------------------------------

export interface TaskGroupDef {
  key: string;
  label: string;
  hint: string;
}

export const TASK_GROUPS: readonly TaskGroupDef[] = [
  { key: "表格", label: "表格", hint: "合并、拆分、汇总、去重" },
  { key: "文件", label: "文件", hint: "整理、改名、转换、压缩" },
  { key: "微信", label: "微信", hint: "整理聊天记录、写草稿（绝不自动发送）" },
  { key: "文书", label: "文书", hint: "写通知、总结、汇报" },
  { key: "资料", label: "资料", hint: "找文件、看内容、提取信息" },
];

export function taskGroupRank(key: string): number {
  const index = TASK_GROUPS.findIndex((group) => group.key === key);
  return index === -1 ? TASK_GROUPS.length : index;
}

// ---------------------------------------------------------------------------
// Home (#38)
// ---------------------------------------------------------------------------

export const HOME = {
  greeting: "你好，需要我帮你做什么？",
  intro: "点一张卡片，或者直接在下面说一句话。",
  emptyTitle: "任务清单正在准备中",
  emptyBody: "你可以直接在下面用一句话告诉我你要做什么，我照样能帮你。",
  inputLabel: "直接说一句话",
  inputPlaceholder: "例如：把这几张表合成一张，重复的行只留一条",
  inputSend: "开始处理",
  inputEmpty: "请先用一句话说说你要做什么",
  offlineHint: "现在连不上干活的程序，你可以先看看要做什么，稍后再试。",
} as const;

// ---------------------------------------------------------------------------
// First-run wizard (#39)
// ---------------------------------------------------------------------------

export const WIZARD = {
  stepLabels: ["欢迎", "检查电脑", "开始使用"],
  progressLabel: "进度",
  welcomeTitle: "欢迎使用 Cante",
  welcomeBody:
    "我帮你把表格、文件这些麻烦事做完。原文件我不会乱动，动手前会先让你确认。先花十秒钟检查一下你的电脑，好吗？",
  welcomeButton: "开始检查",
  checkTitle: "检查你的电脑",
  checking: "正在检查，请稍等……",
  readyTitle: "已经就绪",
  readyBody: "电脑这边都准备好了，可以开始干活。",
  readyButton: "下一步",
  notReadyTitle: "还差一步",
  notReadyBody: "现在还差一点点，最快的方法是打开 Cante 桌面程序再检查一次。",
  recheckButton: "重新检查",
  skipButton: "先看看界面",
  doneTitle: "准备好了",
  doneBody: "以后想做什么，点一张卡片或者直接说一句话就行。出问题我会用大白话告诉你。",
  doneButton: "开始使用",
} as const;

/** Copy for each way `health` can come back unready. */
export const WIZARD_HEALTH = {
  bridge:
    "现在打开的是浏览器里的预览，不是桌面程序。请找到并打开电脑上的「Cante」程序，再回来检查。",
  engine:
    "干活需要的组件还没装好。请找配置这台电脑的同事或管理员装一下，装好后点「重新检查」。",
  unknown: "检查时出了点小问题。请点「重新检查」；如果一直不行，找懂电脑的同事看一下。",
} as const;

// ---------------------------------------------------------------------------
// Task-entry seam — the screen shown right after a card or a sentence is
// picked, until r5-tasks' TaskRunner takes the flow over.
// ---------------------------------------------------------------------------

export const TASK_FLOW = {
  /** Title when the person typed a sentence instead of picking a card. */
  saidTitle: "你说的事情",
  /** Heading over the plan read back from the card. */
  planTitle: "将要做什么",
  /** The promise that nothing happens before the person agrees. */
  previewNote: "动手之前会先把要做什么、会动哪些文件给你看清楚，你同意了才会继续。",
} as const;

// ---------------------------------------------------------------------------
// Error view (#44)
// ---------------------------------------------------------------------------

export const ERROR_VIEW = {
  title: "这次没能做完",
  whatTitle: "发生了什么",
  howTitle: "你可以怎么做",
  detailTitle: "技术详情（给懂电脑的人看）",
  detailToggle: "展开技术详情",
  detailHint: "下面的英文是程序给的原始说明，复制给别人排查时用得上。",
} as const;

export const ERRORS = {
  genericWhat: "出了点问题，这次没能完成。",
  genericHow:
    "点「重试」再试一次；如果还是不行，点「换个方法」，或者点「复制详情」发给懂电脑的同事。",
  bridgeWhat: "桌面程序没有连上，现在还不能干活。",
  bridgeHow:
    "确认你打开的是「Cante」桌面程序，而不是浏览器里的网页。把它关掉重新打开一次，再点「重试」。",
  notFoundWhat: "电脑上找不到这个文件，它可能被移走、改名或者删掉了。",
  notFoundHow: "点「重试」再看一次；如果还是找不到，点「换个方法」重新选一次文件。",
  permissionWhat: "系统拦住了这次操作，当前没有权限改动它。",
  permissionHow:
    "先关掉可能正打开它的程序（例如 Excel），再点「重试」；还不行就把它复制到桌面，换个位置再试。",
  busyWhat: "这个文件正被别的程序占用着，现在改不了。",
  busyHow: "先关掉打开它的程序（例如 Excel 或微信），再点「重试」。",
  spaceWhat: "电脑的磁盘空间不够了，写不下新的文件。",
  spaceHow: "清理一下「下载」或「桌面」上不用的文件，再点「重试」。",
  timeoutWhat: "处理的时间太长，等不到结果了。",
  timeoutHow: "点「重试」再来一次；如果还是不行，少选几个文件，或者点「换个方法」。",
  networkWhat: "连不上网上的服务，可能是网络断了，或者公司的网络挡住了。",
  networkHow: "先用浏览器看看能不能打开网页，确认网络正常后，再点「重试」。",
  authWhat: "账号还没配置好，暂时用不了需要联网的功能。",
  authHow:
    "请找配置这台电脑的同事或管理员帮你配好账号，然后点「重试」。这期间可以先用不需要联网的功能。",
  modelWhat: "这次要用的能力还没准备好。",
  modelHow: "点「重试」；如果一直这样，请找管理员确认这台电脑的配置。",
  formatWhat: "这个文件的格式看不懂，或者文件已经损坏。",
  formatHow:
    "确认选的是正确的文件；如果是别人发来的，请对方重新发一份，再点「重试」。",
  tableWhat: "这张表格打不开，可能格式不对，或者内容已经损坏。",
  tableHow:
    "确认文件能在 Excel 里正常打开；如果 Excel 都打不开，请对方重新发一份，再点「重试」。",
  pdfWhat: "这份 PDF 打不开，可能文件已经损坏。",
  pdfHow: "确认文件能正常打开；如果打不开，请对方重新发一份，再点「重试」。",
  stoppedWhat: "任务被停下了，没有做完。",
  stoppedHow: "没关系，原来的文件没有被改动。点「重试」可以重新开始。",
  daemonWhat: "后台干活的程序意外退出了。",
  daemonHow: "点「重试」会自动把它重新启动；如果反复出现，请把 Cante 关掉重新打开。",
  tooBigWhat: "这个文件太大了，一次处理不完。",
  tooBigHow: "先试试只选其中一部分，或者点「换个方法」分批处理。",
} as const;

interface ErrorRule {
  test: RegExp;
  what: string;
  how: string;
}

/**
 * Ordered dictionary: the first rule that matches wins. Patterns lean on the
 * wording Rust, the daemon and the OS actually produce, plus a few Chinese
 * fragments in case a lower layer already localised the message.
 */
const DICTIONARY: readonly ErrorRule[] = [
  {
    test: /desktop bridge unavailable|bridge unavailable|__TAURI_INTERNALS__|not running inside tauri/i,
    what: ERRORS.bridgeWhat,
    how: ERRORS.bridgeHow,
  },
  {
    test: /permission denied|access is denied|operation not permitted|\bEACCES\b|\bEPERM\b|os error 1\b|os error 13\b|拒绝访问|没有权限|权限不足/i,
    what: ERRORS.permissionWhat,
    how: ERRORS.permissionHow,
  },
  {
    test: /no such file|file not found|cannot find the (file|path)|path not found|\bENOENT\b|os error 2\b|找不到(该)?文件|文件不存在/i,
    what: ERRORS.notFoundWhat,
    how: ERRORS.notFoundHow,
  },
  {
    test: /being used by another|resource busy|\bEBUSY\b|file is locked|locked by|正被(其他|别的)?程序占用|另一个程序正在使用/i,
    what: ERRORS.busyWhat,
    how: ERRORS.busyHow,
  },
  {
    test: /no space left|disk full|\bENOSPC\b|not enough space|磁盘空间|空间不足/i,
    what: ERRORS.spaceWhat,
    how: ERRORS.spaceHow,
  },
  {
    test: /file (is )?too large|exceeds the (maximum|size)|\bEFBIG\b|too big to|文件太大/i,
    what: ERRORS.tooBigWhat,
    how: ERRORS.tooBigHow,
  },
  {
    test: /timed? ?out|timeout|deadline exceeded|took too long|超时/i,
    what: ERRORS.timeoutWhat,
    how: ERRORS.timeoutHow,
  },
  {
    test: /interrupt|cancell?ed|aborted|stopped by|user stop|已停止|已取消/i,
    what: ERRORS.stoppedWhat,
    how: ERRORS.stoppedHow,
  },
  {
    test: /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|connection refused|network (is )?unreachable|fetch failed|socket hang ?up|dns|getaddrinfo|offline|网络|连不上/i,
    what: ERRORS.networkWhat,
    how: ERRORS.networkHow,
  },
  {
    test: /api[-_ ]?key|unauthorized|unauthenticated|\b401\b|\b403\b|authentication|invalid (token|credential)|missing credential|no credentials|密钥|未授权|登录失效/i,
    what: ERRORS.authWhat,
    how: ERRORS.authHow,
  },
  {
    test: /unknown (model|provider)|model .*not found|no such model|provider .*not (found|configured)|未配置.*(模型|服务)/i,
    what: ERRORS.modelWhat,
    how: ERRORS.modelHow,
  },
  {
    test: /\.xlsx?\b|\.csv\b|\.xlsm\b|openpyxl|worksheet|spreadsheet|workbook|表格/i,
    what: ERRORS.tableWhat,
    how: ERRORS.tableHow,
  },
  {
    test: /\.pdf\b|\bpdf\b/i,
    what: ERRORS.pdfWhat,
    how: ERRORS.pdfHow,
  },
  {
    test: /unsupported (file )?(format|type)|invalid file|not a valid|corrupt|malformed|cannot (read|parse) (the )?file|格式(不对|不支持)|文件已损坏/i,
    what: ERRORS.formatWhat,
    how: ERRORS.formatHow,
  },
  {
    test: /daemon (exited|died|crashed)|exited with code|process (exited|terminated)|后台.*退出/i,
    what: ERRORS.daemonWhat,
    how: ERRORS.daemonHow,
  },
];

/** A failure a non-technical person can act on. */
export interface HumanError {
  /** What happened, in plain Chinese. */
  what: string;
  /** What the person can do next, in plain Chinese. */
  how: string;
  /** The raw message, kept for the “复制详情” exit. */
  detail: string;
}

function rawDetail(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof Error) return input.message;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record.message === "string" && record.message) return record.message;
  }
  if (input === null || input === undefined) return "";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * Turn anything a layer below threw into 发生了什么 + 你可以怎么做 + 原始详情.
 *
 * An object that already carries Chinese `what`/`how` (a `TaskRun.error`, or a
 * previous call to this function) is passed through so a re-render cannot
 * re-classify a message that was already explained.
 */
export function explainError(input: unknown): HumanError {
  const detail = rawDetail(input);
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const what = typeof record.what === "string" ? record.what.trim() : "";
    if (what) {
      const how = typeof record.how === "string" ? record.how.trim() : "";
      return { what, how: how || ERRORS.genericHow, detail };
    }
  }
  for (const rule of DICTIONARY) {
    if (rule.test.test(detail)) return { what: rule.what, how: rule.how, detail };
  }
  return { what: ERRORS.genericWhat, how: ERRORS.genericHow, detail };
}

/** True when a failure reads as “you can just press 重试”. */
export function isRetryable(input: unknown): boolean {
  const { what } = explainError(input);
  return what !== ERRORS.formatWhat && what !== ERRORS.authWhat && what !== ERRORS.modelWhat;
}
