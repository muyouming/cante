// #88 — 动手前就看清楚：选中的文件里有没有我根本读不了的格式。
//
// 真机教训：没有工具的能力会在**最后一步**才失败（.xlsx 就这么暴露过）。WPS 是
// 她（行政/财务，Windows）的默认办公套件，而 `.et`（WPS 表格）、`.wps`（文字）、
// `.dps`（演示）**不是 Excel / Word 格式**，装了什么工具都读不了；`.pages` /
// `.numbers`（苹果）同理。原来她只会在跑了一会儿之后才知道，等于白等一场。
//
// 这个模块只做判断，不碰文件系统、不弹任何东西：纯逻辑，好测。
//   * 空选择 → ok（没选文件就谈不上读不了）；
//   * 全是能读的 → ok；
//   * **全部**都读不了 → convert-first（这时不该开跑，给一个另存为的动作）；
//   * **部分**读不了 → some-unreadable（跳过这几份，其余照做）；
//   * 全部读不了、但 WPS 的和苹果的混在一起 → mixed-nothing-readable
//     （给不出一条统一的另存为，所以没有 blocked 名单）。
// 给用户看的话一律来自 copy-capability.ts 的 FORMAT_COPY，这里不写字面文案。
import { FORMAT_COPY } from "./copy-capability.ts";

/** 这次选择在"读不读得了"上的结论。 */
export type SelectionVerdict =
  /** 都能读，或者根本没选文件。 */
  | { kind: "ok" }
  /** 全都是读不了的格式：现在别开跑，先让她另存一份。 */
  | { kind: "convert-first"; blocked: string[]; advice: string }
  /** 混着能读的文件：跳过读不了的，其余的照做。 */
  | { kind: "some-unreadable"; blocked: string[]; advice: string }
  /** 一个都读不了，而且是好几种读不了的格式混在一起：给不出一条统一的另存为。 */
  | { kind: "mixed-nothing-readable"; advice: string };

/** WPS 自己的格式：`.et` 表格、`.ett` 表格模板、`.wps` 文字、`.dps` 演示。 */
const WPS_EXTENSIONS: readonly string[] = [".et", ".ett", ".wps", ".dps"];

/** 苹果自己的格式：`.pages` 文字、`.numbers` 表格。 */
const APPLE_EXTENSIONS: readonly string[] = [".pages", ".numbers"];

/** 读不了的格式按"另存为的路子"分两家。 */
type Family = "wps" | "apple";

/**
 * 取路径最后一段的扩展名（小写）；没有扩展名就是 null。
 *
 * 只取最后一段是因为文件夹名里也可能有点（比如「2024.05 报表」），整条路径上
 * 找最后一个点会把它当成扩展名。没有扩展名的（文件夹、无后缀文件）一律返回
 * null——看不出来就**不拦**，不能因为名字奇怪就挡着她。
 */
function extensionOf(path: string): string | null {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return base.slice(dot).toLowerCase();
}

/** 这个扩展名属于哪一家读不了的格式；能读就是 null。 */
function familyOf(extension: string | null): Family | null {
  if (!extension) return null;
  if (WPS_EXTENSIONS.includes(extension)) return "wps";
  if (APPLE_EXTENSIONS.includes(extension)) return "apple";
  return null;
}

/**
 * 看一眼这次选中的文件，给出"现在能不能开跑"的结论。
 *
 * 只看扩展名——够用，而且不会把好文件误判成坏的（认不出来的一律当能读）。
 */
export function inspectSelection(paths: string[]): SelectionVerdict {
  if (paths.length === 0) return { kind: "ok" };

  const wps: string[] = [];
  const apple: string[] = [];
  for (const path of paths) {
    const family = familyOf(extensionOf(path));
    if (family === "wps") wps.push(path);
    else if (family === "apple") apple.push(path);
  }

  const blocked = [...wps, ...apple];
  if (blocked.length === 0) return { kind: "ok" };

  // 混着能读的文件：不拦，只把要跳过的说清楚。
  if (blocked.length < paths.length) {
    return { kind: "some-unreadable", blocked, advice: FORMAT_COPY.skipSomeAdvice };
  }

  // 一个都读不了，而且混着 WPS 和苹果：没有一条统一的另存为可给。
  if (wps.length > 0 && apple.length > 0) {
    return { kind: "mixed-nothing-readable", advice: FORMAT_COPY.mixedConvertAdvice };
  }

  // 一个都读不了，但都是同一家：给一条明确的另存为。
  return {
    kind: "convert-first",
    blocked,
    advice: wps.length > 0 ? FORMAT_COPY.wpsConvertAdvice : FORMAT_COPY.appleConvertAdvice,
  };
}
