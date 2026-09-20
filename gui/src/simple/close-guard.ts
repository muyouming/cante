// 关窗口前那一下确认：判定逻辑（纯函数，可单测）+ 一个很小的接线 hook。
//
// 她正在做的时候点右上角关掉，应用会直接没掉、手里那件活也停了——此前没有任何提示
// （全仓库 grep beforeunload / onCloseRequested / ExitRequested 全空）。这一步只做
// 最小的一件事：**正在做**的时候拦一下，问一句；其余时候照旧直接关。
//
// 为什么判定在前端、真正的关在 Rust：
//   * 手里有没有活，只有前端 store 知道（那条 run 还没落盘，Rust 看不见）。
//   * 这个应用的 core:default **没有** allow-destroy / allow-close，网页侧自己关不掉
//     窗口（会被 ACL 拒绝）。而只要网页侧存在 close-requested 的监听，Rust 就会自动
//     拦下这一次原生关闭。所以网页侧只负责拦住 + 亮浮层，真正的关由 Rust 执行
//     （见 lib.rs 里 cante://close-confirmed 的那一个 handler）。
//
// 判定收敛成一个三态：request（她点了 X）→ 正在做就 asking（问她），否则 closing
// （放行）；keep（她说继续做）→ idle；leave（她说关掉）→ closing（放行，不再弹第二遍）。
import { createSignal, onCleanup, onMount } from "solid-js";

import type { RunState, TaskRun } from "./run.ts";
import { useFocusLayer } from "./FocusLayer.tsx";

/** 「正在做」的两种状态：真的在跑（running），或停在确认页等她点头（preview）。 */
export function isWorking(state: RunState | null | undefined): boolean {
  return state === "running" || state === "preview";
}

/** 这一次关闭请求要不要先问她。手里没活（或者根本没有那一件）就不拦。 */
export function needsCloseConfirm(run: TaskRun | null | undefined): boolean {
  return run != null && isWorking(run.state);
}

/** 她能对这一次关闭请求做的三件事。 */
export type CloseAction = "request" | "keep" | "leave";
/** 这一下该落到哪儿：idle（什么都不做）/ asking（亮浮层问她）/ closing（放行）。 */
export type CloseOutcome = "idle" | "asking" | "closing";

/**
 * 这一下该落到哪儿。纯函数：浮层、键盘和测试看的是同一个答案。
 *
 * leave 一定收敛到 closing（不再弹第二次）——她点了「关掉」就是放行，不许再问一遍。
 */
export function closeOutcome(run: TaskRun | null | undefined, action: CloseAction): CloseOutcome {
  if (action === "keep") return "idle";
  if (action === "leave") return "closing";
  return needsCloseConfirm(run) ? "asking" : "closing";
}

/** 她确认要关：告诉 Rust 真的关（网页侧关不了，原因见文件头）。 */
export const CLOSE_CONFIRMED = "cante://close-confirmed";

/** 她选了「关掉」时发给 Rust 的那一下（动态导入，纯逻辑测试碰不到 Tauri）。 */
export async function confirmClose(): Promise<void> {
  const { isBridgeAvailable } = await import("../tauri.ts");
  if (!isBridgeAvailable()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(CLOSE_CONFIRMED);
}

export interface CloseGuardHooks {
  /** 现在手里有没有活（读 store 的当前那一次）。 */
  current(): TaskRun | null;
  /** 手里有活：请她确认，把浮层亮出来。 */
  onAsk(): void;
}

/** 接管窗口的关闭请求。返回取消订阅的函数（组件卸载时调）。 */
export async function installCloseGuard(hooks: CloseGuardHooks): Promise<() => void> {
  const { isBridgeAvailable } = await import("../tauri.ts");
  if (!isBridgeAvailable()) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  // 只要存在这个监听，Rust 就会自动拦下原生关闭；这里再显式 preventDefault 一次，
  // 免得落到 Window 包装器那条「不阻止就 destroy」的默认路上（destroy 会被 ACL 拒绝）。
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    if (closeOutcome(hooks.current(), "request") === "asking") {
      hooks.onAsk();
      return;
    }
    void confirmClose();
  });
}

/**
 * 把确认浮层的状态和键盘接线打包成一个 hook。
 *
 * 放在这里而不是 App.tsx：浮层本身在 App.tsx 里渲染，但「什么时候亮、Tab 怎么走、
 * Esc 干什么、装了谁」这几件事是纯接线，收在一处，App.tsx 只剩一行。
 *
 * Esc 的约定跟审批卡 / 确认页一致（MUST-ANSWER，原因写在 FocusLayer.tsx 的文件头）：
 * 这三处都是「一个动作之前唯一的门」，Esc 是个「随手按」的键，按下去不该让这一屏
 * 直接消失。所以**不传 onEscape**，Esc 什么都不做——这是故意的，不是漏了。
 * 安全答案「继续做」就在屏幕上，而且打开时焦点落在它上面：按一下回车和按一下 Esc
 * 一样省事，区别只在于她看清了那是「继续做」。
 *
 * （这张卡不是「点背板就关」的那种：背板也不响应点击。要关这个窗口，她点「关掉」。）
 */
export interface CloseSheet {
  /** 浮层现在开没开。 */
  open: () => boolean;
  /** 挂到浮层根元素上的 ref（接管 Tab / Esc）。 */
  layer: (element: HTMLElement) => void;
  /** 挂到「继续做」那颗按钮上：打开时焦点落在它上面（安全答案）。 */
  keepRef: (element: HTMLButtonElement) => void;
  /** 她点「继续做」（或按 Esc）：窗继续开着。 */
  keep(): void;
  /** 她点「关掉」：放行，告诉 Rust 关掉窗口，不再问第二遍。 */
  leave(): void;
}

export function useCloseSheet(current: () => TaskRun | null): CloseSheet {
  const [open, setOpen] = createSignal(false);
  let keep: HTMLButtonElement | undefined;
  // MUST-ANSWER：不传 onEscape（原因见本文件上方与 FocusLayer.tsx 的文件头）。
  const layer = useFocusLayer({
    open,
    initialFocus: () => keep,
  });

  let disposed = false;
  onMount(() => {
    let stop: (() => void) | undefined;
    void installCloseGuard({ current, onAsk: () => setOpen(true) }).then((unlisten) => {
      // 卸载可能发生在订阅就绪之前：那时直接退掉，别留下一个收不回的监听。
      if (disposed) unlisten();
      else stop = unlisten;
    });
    onCleanup(() => {
      disposed = true;
      stop?.();
    });
  });

  return {
    open,
    layer,
    keepRef: (element) => (keep = element),
    keep: () => setOpen(false),
    leave: () => {
      setOpen(false);
      void confirmClose();
    },
  };
}
