// 「出错之后给她一条真能走的路」。
//
// 这一层是纯逻辑：把一条失败（发生了什么 + 你可以怎么做 + 原始说明）翻成**具体
// 可执行的下一条动作**——关掉 Excel 窗口再试、重新选一次文件、另存到桌面……
// 而不是三个平级的泛泛出口。它不碰界面、不碰后台，所以 `bun test` 能逐类复盘。
//
// 两条自我约束，都是从「别弄坏她的东西 / 出错能看懂」来的：
//
//   1. **只认文本里能核对的特征。** 命中 `EBUSY`、`ENOENT`、`Permission denied`、
//      「另一个程序正在使用」这类真实会出现的字眼才给具体动作。认不出来就老老实实
//      退回通用的三个出口（重试 / 换个方法 / 复制详情），绝不编一个像模像样的动作。
//   2. **动作要她真的按得下去。** 每条动作的 label 是按钮上的字，why 是「为什么先
//      做这件事」。文案在 copy-recovery.ts（copy-guard 扫得到），这里只做判断。
//
// `context.needs` 说明这件事本来需要什么，用来挑合适的那个出口：要文件就给「重新
// 选文件」，要文件夹就给「打开文件夹」，纯文字的就不硬塞一个选文件的按钮。
import { RECOVERY, STALLED_MARKER } from "./copy-recovery.ts";
import { DAEMON_RECOVERY } from "./copy-daemon.ts";

export type RecoveryKind =
  | "retry"
  | "pick-files"
  | "close-file"
  | "save-elsewhere"
  | "explain-in-words"
  | "copy-detail"
  | "open-folder";

/** 一条她能看懂、也按得下去的动作。 */
export interface RecoveryAction {
  kind: RecoveryKind;
  /** 按钮上的字。 */
  label: string;
  /** 按钮下面那行小字：为什么是它。 */
  why: string;
}

/** 出错对象里被拿来判断的几段文本（`TaskRun.error` / `explainError` 的产物）。 */
export interface RecoveryError {
  what: string;
  how: string;
  detail: string;
  /**
   * 可核对的特征文本：系统原话、错误码、被占用/找不到之类的原文。
   *
   * `TaskRun.error.cause` 会把原始说明原样带上；detail 是给技术同事看的那一份，
   * 可能已经被换成更友好的话，所以判断出路时先看 cause。这是**判断用的**，出错
   * 界面不许把它打出来。
   *
   * 旧调用方不传这一项，行为和从前一模一样（只看 what/how/detail）。
   */
  cause?: string;
}

/** 这件事本来需要什么。缺省按「需要文件」处理，也就是原来的「换个方法」。 */
export interface RecoveryContext {
  needs?: "files" | "folder" | "none" | "text";
}

/** 文案模块的公共形状，避免在两个文件里各写一遍。 */
export interface RecoveryCopy {
  label: string;
  why: string;
}

// ---------------------------------------------------------------------------
// 可核对的特征。每条都贴着真实会出现的原文：Windows 的中文提示、Rust/Python 的
// 标准错误码、以及底层已经本地化过的那几个中文片段。宁可漏判（退回通用出口），
// 也不乱判（给她一个用不上的按钮）。
// ---------------------------------------------------------------------------

/** 界面开在浏览器预览里，没连上桌面程序（App.tsx 就是这么报的）。 */
const BRIDGE =
  /desktop bridge unavailable|bridge unavailable|__TAURI_INTERNALS__|not running inside tauri/i;

/**
 * #103 — 真正干活的那个组件没装上。底层起进程失败时给的原文（daemon.rs 的包装一定
 * 是 `could not start … serve: …`），加 Windows 原生的「不是内部或外部命令」和
 * command not found。只认这些可核对的特征，不拿「找不到文件」瞎猜：那是文件的问题，
 * 出路是重新选文件，和这里不一样。
 */
const DAEMON_MISSING =
  /could not start[^\n]{0,200}serve|is not recognized as an internal or external command|不是内部或外部命令|command not found/i;

/**
 * #150 —— 桥在、但动手的那个组件不在（或起不来）。认的是桥自己给的那两句原文
 * （`bridge.rs` 的 `ASSISTANT_MISSING` / `ASSISTANT_UNSTARTABLE`），都是「动手的
 * 组件」开头那半句。这一条与 `DAEMON_MISSING` 分开：那种缺的是上游守护进程，
 * 出路是找同事；这种缺的是随包发的那一块，出路是她自己把安装包再运行一次。
 */
const ASSISTANT_MISSING = /动手的组件/;

/** 文件被人挪走 / 删掉。 */
const NOT_FOUND =
  /no such file|file not found|cannot find the (file|path|folder)|path not found|\bENOENT\b|os error 2\b|找不到(该)?文件|文件不存在|已经?被(移动|移走|删除|删掉)|被移走|被删除/i;

/** 文件正被别的程序占着。 */
const BUSY =
  /being used by another|resource busy|\bEBUSY\b|file is locked|locked by|locked for writing|another process (is )?using|另一个程序正在使用|正被.{0,30}(占用|使用)|(文件|它)已?被占用|已被.{0,20}打开/i;

/** 错误文本里点到了 Excel / WPS，或 WPS 的表格后缀。 */
const OFFICE_OPEN =
  /\bExcel\b|\bWPS\b|金山表格|电子表格程序|~\$|\.(xlsx|xlsm|xlsb|xls|ett?|wps|docx?|pptx?)\b/i;

/** 听起来就是一张表格（Excel / WPS 的表格）：按钮上可以直接写「Excel」。 */
const SPREADSHEET = /\.(xlsx|xlsm|xlsb|xls|ett?|wps)\b|\bExcel\b|\bWPS\b|金山表格|电子表格/i;

/**
 * Excel / WPS 打开表格时会在旁边留一个 `~$` 开头的临时文件。原文里出现这个记号，
 * 就说明那张表此刻正开着它——比泛泛的「文件打不开 / 格式看不懂」具体得多。
 */
const LOCK_FILE = /~\$/;

/** 系统不让写。 */
const PERMISSION =
  /permission denied|access is denied|operation not permitted|\bEACCES\b|\bEPERM\b|os error (1|13)\b|拒绝访问|没有权限|权限不足|只读|cannot write|write-protected/i;

/** 磁盘没地方了。 */
const SPACE = /no space left|disk full|\bENOSPC\b|not enough space|磁盘空间|空间不足/i;

/** 图片里的字读不出来（协议现在只送文字，送不进图片内容）。 */
const IMAGE =
  /图片|照片|截图|相片|image|\.(png|jpe?g|bmp|webp|gif|tiff?|heic|heif|avif)\b|\bocr\b|识别不出|认不出|看不清|读不出.{0,10}(字|文字)|不能读.{0,6}图片/i;

/**
 * 连不上网 / 服务方不可用。
 *
 * `connection error` 这一串是断网时真正会到这里的原文：动手的组件报的是
 * headline=Connection error.（没有 details），旧写法只认 `connection refused`，
 * 于是她拿到的是「重新选一次文件」——网络断了和她的文件毫无关系。（真机验过）
 */
const NETWORK =
  /\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNABORTED)\b|connection (refused|error|failed|reset)|cannot connect|can.?t connect|failed to connect|unable to connect|connect error|network (is )?unreachable|network error|no internet|fetch failed|socket hang ?up|getaddrinfo|\boffline\b|连接被拒绝|网络(断了|不通|异常)|连不上|服务方.{0,10}(不可用|连不上|没响应)|暂不可用|temporarily unavailable|\b50[234]\b|rate limit|quota/i;

/** 账号 / 密钥没配好。 */
const AUTH =
  /api[-_ ]?key|unauthorized|unauthenticated|\b40[13]\b|authentication|invalid (token|credential)|missing credential|no credentials|密钥|未授权|登录失效|账号.{0,8}(还没|未|没有).{0,6}(配置|配好|设置)/i;

/** 它自己说「我拿不准」，停下来等人回答。 */
const UNSURE =
  /我拿不准|拿不准|不确定|无法确定|说不准|需要你(确认|核对|决定)|请你(确认|核对)|需要(你)?确认|要我确认/i;

/** 文件格式看不懂 / 已经损坏。 */
const FORMAT =
  /unsupported (file )?(format|type)|invalid file|not a valid|corrupt|malformed|cannot (read|parse) (the )?file|openpyxl|workbook|worksheet|spreadsheet|\.xlsx?\b|\.csv\b|格式(不对|不支持|看不懂)|文件(已|已经)?损坏|(文件|表格|它)打不开/i;

// ---------------------------------------------------------------------------

function action(kind: RecoveryKind, copy: RecoveryCopy): RecoveryAction {
  return { kind, label: copy.label, why: copy.why };
}

/**
 * 从出错对象里取出可核对的特征文本。
 *
 * 只认对象上的 `cause`：抛出的是字符串 / Error 时本来就没这一段（`Error.message`
 * 会经由 `explainError` 进 detail），返回 undefined，让 `actionsFor` 退回老样子。
 */
export function causeOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const cause = (input as { cause?: unknown }).cause;
  return typeof cause === "string" && cause.trim().length > 0 ? cause : undefined;
}

/**
 * 「表格被 Excel / WPS 开着」时按钮该点哪个程序。
 *
 * 只在原文真的能听出是表格时才在按钮上写「Excel」；认不出（例如只说是某个文档）
 * 就用通用的「那个窗口」，不拿一个猜出来的程序名去误导她。
 */
function closeAction(text: string): RecoveryAction {
  return SPREADSHEET.test(text)
    ? action("close-file", RECOVERY.closeOffice)
    : action("close-file", RECOVERY.closeFile);
}

const COPY_DETAIL = action("copy-detail", RECOVERY.copyDetail);

/** 每一组动作最后都是「复制详情给懂电脑的人」。已经有就不重复加。 */
function withDetail(actions: readonly RecoveryAction[]): RecoveryAction[] {
  if (actions.some((item) => item.kind === "copy-detail")) return [...actions];
  return [...actions, COPY_DETAIL];
}

/** 认不出来时退回的通用出口：和出错界面原来那三个出口一一对应。 */
function generic(context?: RecoveryContext): RecoveryAction[] {
  const actions: RecoveryAction[] = [action("retry", RECOVERY.retry)];
  switch (context?.needs) {
    case "folder":
      actions.push(action("open-folder", RECOVERY.openFolder));
      break;
    case "text":
      actions.push(action("explain-in-words", RECOVERY.rephrase));
      break;
    case "none":
      // 这件事不要文件，硬塞「重新选文件」只会让她困惑。
      break;
    default:
      actions.push(action("pick-files", RECOVERY.pickFiles));
  }
  return actions;
}

/**
 * 把一次失败翻成她下一步真能做的按钮。
 *
 * @param error `explainError` 的产物，或 store 里 `TaskRun.error` 的原样对象。
 * @param context 这件事本来需要什么；不传就按「需要文件」处理。
 */
export function actionsFor(error: RecoveryError, context?: RecoveryContext): RecoveryAction[] {
  // cause 排在最前面：它是可以被核对的那段原文，比已经写成平实中文的 what/how
  // 更接近系统真正说过的话。旧调用方没有 cause，拼出来的文本和从前一模一样。
  const text = [causeOf(error), error?.what ?? "", error?.how ?? "", error?.detail ?? ""]
    .map((part) => String(part ?? ""))
    .join("\n");

  // 空文本 / 认不出来：通用出口。判断顺序在下面：先挑最具体的。
  let actions: RecoveryAction[];

  if (BRIDGE.test(text)) {
    // 浏览器预览里点了一张卡：出路是先打开桌面程序，别的动作都谈不上。
    actions = [action("retry", RECOVERY.retryBridge)];
  } else if (ASSISTANT_MISSING.test(text)) {
    // 东西随包发了、这台电脑上没有：她自己重装一次就行。
    actions = [action("retry", RECOVERY.reinstall)];
  } else if (DAEMON_MISSING.test(text)) {
    // 不是文件的问题：这台电脑缺一个必须的组件，她自己装不了。把可核对的事实
    // 交给技术同事，而不是让她对着「找不到文件」一遍遍重选文件。
    actions = [action("copy-detail", DAEMON_RECOVERY.installMissing)];
  } else if (UNSURE.test(text)) {
    // 它停下来问了一句，问题不在文件上。回一句话，而不是重跑。
    actions = [action("explain-in-words", RECOVERY.answerIt)];
  } else if (NOT_FOUND.test(text)) {
    actions = [action("pick-files", RECOVERY.pickFiles)];
    if (context?.needs === "folder") actions.push(action("open-folder", RECOVERY.openFolder));
  } else if (BUSY.test(text)) {
    // 表格被占用：Windows 上十有八九是 Excel / WPS 正开着它，按钮直接点那个程序。
    actions = [closeAction(text)];
  } else if (LOCK_FILE.test(text)) {
    // 原文里带着 `~$` 这种临时锁文件的记号：表格开着它。这一条要排在「格式看不懂」
    // 前面——光看 .xlsx 后缀会被归成「换一份文件再试」，那道按钮她不点也对不上。
    actions = [closeAction(text)];
  } else if (PERMISSION.test(text)) {
    // 在 Windows 上，「写不进 xlsx」最常见的原因就是 Excel/WPS 正开着它，
    // 报出来的却是 Permission denied。所以两条路都给：先关窗口，不行再换位置。
    actions = OFFICE_OPEN.test(text)
      ? [closeAction(text), action("save-elsewhere", RECOVERY.saveElsewhere)]
      : [action("save-elsewhere", RECOVERY.saveElsewhere)];
  } else if (SPACE.test(text)) {
    actions = [action("retry", RECOVERY.cleanDisk)];
  } else if (IMAGE.test(text)) {
    actions = [action("explain-in-words", RECOVERY.explainInWords)];
  } else if (STALLED_MARKER.test(text)) {
    // #173 —— 已经在做、做到一半，然后彻底没消息了。这不是「刚开始就连接被拒」，
    // 所以出路是先确认网络、再从头走一遍；文件安全那句在 `copy.ts` 的停滞文案里。
    // 这一条要排在 NETWORK 前面：两者都命中时，更具体的那条才是真的。
    actions = [action("retry", RECOVERY.stalled)];
  } else if (NETWORK.test(text)) {
    actions = [action("retry", RECOVERY.retryLater)];
  } else if (AUTH.test(text)) {
    actions = [action("copy-detail", RECOVERY.signIn)];
  } else if (FORMAT.test(text)) {
    actions = [action("pick-files", RECOVERY.pickOtherFile)];
  } else {
    actions = generic(context);
  }

  return withDetail(actions);
}
