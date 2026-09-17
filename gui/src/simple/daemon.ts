// 这台电脑有没有那个「真正干活」的组件（#103）。
//
// 上游 cante / ante 只有 macOS 与 Linux 构建；Windows 上装完界面能开、任务却全跑
// 不了，而界面以前什么都不说。这个模块只做三件事：
//
//   * 问一次后端「组件在不在」（后端是可单测的纯函数，见 commands.rs 的
//     resolve_daemon_bin），问不到就当没答案，绝不猜；
//   * 把答案规范化，并把「找过哪些位置、缺的是什么」拼成一段给技术同事看的文字；
//   * 给向导「检查电脑」那一节算出该显示什么（不在时才有这一节）。
//
// 文案全部来自 copy-daemon.ts，这里不写中文。
import { DAEMON, DAEMON_REINSTALL } from "./copy-daemon.ts";
import { invoke } from "../tauri.ts";

/** 后端 `daemon_capability` 的返回形状。 */
export interface DaemonCapability {
  available: boolean;
  path?: string | null;
  why?: string | null;
  /** 探测时实际找过的位置；不可用时才有，给「复制详情」凑事实。 */
  searched?: string[] | null;
  /** #150 —— 出路是不是「把这个软件重新装一次」；缺随包发的那一块时才是 true。 */
  reinstall?: boolean | null;
}

/** 向导「检查电脑」里这一节的内容。 */
export interface DaemonNotice {
  title: string;
  what: string;
  body: string;
  action: string;
  copyLabel: string;
  copyFailed: string;
  details: string;
}

/** 把后端返回的原始形状规范成前端内部形状；缺字段一律按「不可用」处理。 */
export function normalizeDaemon(raw: DaemonCapability | null | undefined): DaemonCapability {
  if (!raw || !raw.available) {
    const searched = Array.isArray(raw?.searched)
      ? (raw?.searched ?? []).filter((item): item is string => typeof item === "string" && !!item.trim())
      : [];
    return {
      available: false,
      path: null,
      why: raw?.why ?? null,
      searched,
      reinstall: raw?.reinstall === true,
    };
  }
  return { available: true, path: raw.path ?? null, why: null, searched: [], reinstall: false };
}

/**
 * 问一次后端：组件在不在。
 *
 * 每次调用都真的去问（「重新检查」必须能看到刚装好的组件，所以不能像表格能力那
 * 样缓存）。探测本身失败（浏览器预览、后端报错）返回 null——那是「没答案」，不是
 * 「缺组件」，界面据此不显示这一节。
 */
export async function probeDaemon(): Promise<DaemonCapability | null> {
  try {
    const ask = invoke as unknown as (name: string) => Promise<DaemonCapability | null>;
    return normalizeDaemon(await ask("daemon_capability"));
  } catch {
    return null;
  }
}

/**
 * 向导那个绿勾的**唯一**判据（#177）。
 *
 * 只认后端 `daemon_capability` 的答案（它走 `program.rs` 那条查找线，桥在、动手的
 * 组件不在时就是「不在」）。以前的绿勾看的是桥的 `--version`：随包的动手组件被挪走
 * 之后桥照样报得出版本号，界面仍然说「已经就绪」——先告诉她准备好了，她一动手就失败。
 *
 * `null`（探测失败 / 浏览器预览）不是「就绪」：没问出答案就不能替她打包票。
 */
export function daemonReady(cap: DaemonCapability | null): boolean {
  return cap?.available === true;
}

/**
 * 探测成功、但组件不在时，向导该显示的那一节；否则 null。
 *
 * `null`（探测失败）和「可用」都不显示：前者是没答案，后者不用她操心。
 */
export function daemonNotice(cap: DaemonCapability | null): DaemonNotice | null {
  if (!cap || cap.available) return null;
  return {
    title: DAEMON.title,
    what: cap.why ?? DAEMON.what,
    body: DAEMON.body,
    // #150 —— 缺的是随包发的那一块时，她自己重装一次就行，不绕技术同事那一步。
    action: cap.reinstall ? DAEMON_REINSTALL.action : DAEMON.action,
    copyLabel: DAEMON.copy,
    copyFailed: DAEMON.copyFailed,
    details: daemonDetails(cap),
  };
}

/**
 * 给技术同事看的可核对事实：缺的是什么、找过哪些位置（有就逐条列出）。
 *
 * 只拼事实，不编原因——`searched` 是后端探测时真的看过的地方。
 */
export function daemonDetails(cap: DaemonCapability | null): string {
  const lines: string[] = [DAEMON.detailMissing, ""];
  const searched = (cap?.searched ?? []).filter(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
  if (searched.length > 0) {
    lines.push(DAEMON.detailSearched);
    for (const item of searched) lines.push(`- ${item}`);
  } else {
    lines.push(DAEMON.detailNothing);
  }
  if (cap?.path) lines.push("", `${DAEMON.detailUsing}${cap.path}`);
  return lines.join("\n");
}

/** 复制详情；拿不到剪贴板时退回「选中再复制」，和界面别处一样的兜底。 */
export async function copyDaemonDetails(cap: DaemonCapability | null): Promise<boolean> {
  const text = daemonDetails(cap);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the selection copy */
    }
  }
  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = typeof document.execCommand === "function" && document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
