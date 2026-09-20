// 「你手上的这一份是哪一个程序」——版本号 + 它是哪一天做好的。
//
// 为什么要有这一页要说清这件事（#261）：我们两次拿**装着的旧版本**当验收对象，
// 量出来的结论作废（#247 那一轮 0/12；量的是旧界面）。根因是「我在验哪一份产物」
// 在界面上根本看不出来——桌面上的图标、窗口标题都不说她手上是 02:27 还是 14:36
// 那份。所以在「关于」页放一句话，让**应用自己**报出它是哪一份。
//
// 数据从哪来：**不新造机制**。版本号本来就有（gui/package.json 的 version）；
// 构建时间由 vite 的一个 define 在打包前端时注入（见 vite.config.ts）。注入的值
// 不是给人看的文案，而是一个带标记的机器串：
//
//   CANTE-BUILD|2026-09-20 14:36|0.2.3
//
// 前端资源在 dist 里是明文，验收脚本（gui/scripts/windows/verify-modern-build.ps1）
// 就是靠这个标记把「应用自报的时间」读出来，与 exe / dist 的文件时间对：
// 对不上就说明她在验一个旧的产物（那正是它该拦住的错）。
//
// 零术语：给用户看的只有「版本 0.2.3」和「这个程序是 … 做好的」两句，没有
// build / commit / hash 这些词；机器串里的 CANTE-BUILD 标记永远不会被渲染出来。
//
// 为什么注入的值由 __CANTE_BUILD_STAMP__ 这个声明读取，而不是 import 一个模块：
// vite 的 define 是**文本替换**——打包时 `__CANTE_BUILD_STAMP__` 会被换成一个字符串
// 字面量。bun test / tsc 里没有这层替换，所以这里用 `typeof` 保护它（对未声明的
// 名字做 typeof 不会抛错），读不到就退回一句诚实的话，而不是崩掉整个「关于」页。

/** vite define 注入的原始标记串；不在构建里时（测试 / 类型检查）为空串。 */
declare const __CANTE_BUILD_STAMP__: string;

/** 机器串的固定标记：验收脚本按它找，不写死时间（时间每次构建都不一样）。 */
export const BUILD_STAMP_MARKER = "CANTE-BUILD";

/** 拼出要注入的机器串。给 vite.config.ts 用，保证标记只有一处定义。 */
export function buildStampValue(time: string, version: string): string {
  return `${BUILD_STAMP_MARKER}|${time}|${version}`;
}

export interface BuildStamp {
  /** 构建时间，本地时间，形如 2026-09-20 14:36。 */
  readonly time: string;
  /** 版本号，来自 gui/package.json。 */
  readonly version: string;
}

const STAMP_PATTERN = /^CANTE-BUILD\|(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\|([0-9A-Za-z][0-9A-Za-z.+-]*)$/;

/**
 * 从一段文字里找出所有标记（打包后的 .js 里标记前后都是代码，所以要能在正文里扫）。
 * 版本号用受限字符集，免得在压缩过的一行代码里把后面的 `"}function` 一起吞进来。
 * verify-modern-build.ps1 里的 $stampPattern 是它的移植版，两边的字符集必须一致。
 */
export function findBuildStamps(text: string): BuildStamp[] {
  const out: BuildStamp[] = [];
  const pattern = /CANTE-BUILD\|(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\|([0-9A-Za-z][0-9A-Za-z.+-]*)/g;
  for (const match of text.matchAll(pattern)) {
    out.push({ time: match[1] as string, version: match[2] as string });
  }
  return out;
}

/** 把机器串解成时间和版本；格式不对（或者根本没注入）返回 null，不编。 */
export function parseBuildStamp(raw: string): BuildStamp | null {
  const match = STAMP_PATTERN.exec(raw.trim());
  if (!match) return null;
  return { time: match[1] as string, version: match[2] as string };
}

/** 生产路径上读注入串的唯一入口。 */
export function injectedBuildStamp(): string {
  return typeof __CANTE_BUILD_STAMP__ === "string" ? __CANTE_BUILD_STAMP__ : "";
}

/** 这一次构建的标记；读不出来就是 null。 */
export function buildStamp(raw: string = injectedBuildStamp()): BuildStamp | null {
  return parseBuildStamp(raw);
}

/** 给用户看的两句话。机器串里的标记不在这里，永远渲染不到界面上。 */
export const BUILD_INFO = {
  /** 「关于」页上那一段的小标题。 */
  heading: "你手上的这一份",
  /** 版本号那行。 */
  versionLine: (version: string) => `版本 ${version}`,
  /** 什么时候做好的那行——用人话说，不用「构建」这种词。 */
  madeLine: (time: string) => `这个程序是 ${time} 做好的。`,
  /** 读不出来时照实说，并给她一条出路（产品律 3），不假装知道。 */
  unknown: "这个程序没记住自己是哪一天做好的。请找懂电脑的同事看看。",
} as const;

// ---------------------------------------------------------------------------
// 「你验的是不是这一轮的产物」——验收脚本与这里的断言共用同一套判定。
//
// 脚本（PowerShell）是这套判定的移植：Windows 上没有 bun，而「应用自报时间 vs
// 产物时间」这条核对必须能在真机上跑。这里把它写成纯函数，测试就能逐条钉住三种
// 结论（对得上 / 明显是旧的 / 核不出来），不必依赖 Windows。
// ---------------------------------------------------------------------------

/** 判定要用的三样东西：应用自报串、dist 时间、exe 时间（都是 epoch 毫秒，没有就是 null）。 */
export interface ArtifactTimes {
  readonly appStamp: string;
  readonly distMs: number | null;
  readonly exeMs: number | null;
}

export type Freshness =
  | { readonly kind: "fresh"; readonly appTime: string }
  | { readonly kind: "stale"; readonly appTime: string; readonly why: string }
  | { readonly kind: "unknown"; readonly why: string };

/**
 * 容差（分钟）。构建把前端打进 dist 再到 exe 落盘有先后，差几分钟是正常的；
 * 而「装着的旧版本」和「刚编出来的」差的是几小时（#261 实测 02:27 对 14:36），
 * 所以 30 分钟既能容下正常先后，又能稳稳抓住旧产物。
 */
export const DEFAULT_TOLERANCE_MINUTES = 30;

/** 把 2026-09-20 14:36 解成本地时间的毫秒数；解不出返回 null。 */
export function parseStampTime(time: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** 明确说清「旧产物」的那句话：脚本和测试都认它。 */
export const STALE_NOTICE = "你在验一个旧的产物。";

/** 核不出来时那句（不写进用户文案：这是给验收脚本与测试看的）。 */
export const UNKNOWN_NO_STAMP = "核不出来：没读到应用自报的构建时间。";
export const UNKNOWN_BAD_STAMP = "核不出来：应用自报的时间格式不对。";
export const UNKNOWN_NO_ARTIFACT = "核不出来：产物时间读不到。";
export const STALE_MISMATCH = "应用自报的时间与产物时间对不上。";

/**
 * 三选一，没有「大概没问题」这一档：
 *   fresh   —— 应用自报的时间与 dist / exe 对得上；
 *   stale   —— 差得明显（她在验旧的那一份）；
 *   unknown —— 时间缺失 / 读不出（**不算通过**，脚本要当红处理）。
 */
export function judgeFreshness(
  input: ArtifactTimes,
  toleranceMinutes: number = DEFAULT_TOLERANCE_MINUTES,
): Freshness {
  const stamp = parseBuildStamp(input.appStamp);
  if (stamp === null) {
    return { kind: "unknown", why: UNKNOWN_NO_STAMP };
  }
  const app = parseStampTime(stamp.time);
  if (app === null) {
    return { kind: "unknown", why: UNKNOWN_BAD_STAMP };
  }
  if (input.distMs === null || input.exeMs === null) {
    return { kind: "unknown", why: UNKNOWN_NO_ARTIFACT };
  }
  const tolerance = toleranceMinutes * 60_000;
  const distFar = Math.abs(input.distMs - app) > tolerance;
  const exeBehind = input.exeMs < app - tolerance;
  if (distFar || exeBehind) {
    return {
      kind: "stale",
      appTime: stamp.time,
      why: `${STALE_NOTICE}${STALE_MISMATCH}`,
    };
  }
  return { kind: "fresh", appTime: stamp.time };
}
