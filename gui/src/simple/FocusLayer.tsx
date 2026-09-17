// 键盘焦点层（r20）：浮层打开时焦点进得来、Tab 出不去、Esc 按约定处理。
//
// 为什么这个文件是 .tsx 而不是 .ts：本轮的改动范围只到 gui/src/simple/*.tsx，
// 所以这个没有任何 JSX 的小模块放在组件旁边。它只管键盘，不画界面。
//
// 三条规矩（focus-guard.test.ts 会逐条核对）：
//
//   1. 浮层一打开，焦点就落进来：默认落在层里第一个能按的东西上；确认页和审批卡
//      另有指定的安全答案（「取消」和「拒绝」），由调用方通过 initialFocus 指定。
//   2. Tab / Shift+Tab 只在这一层（以及和它同时开着的那几层）里循环，不会跑到浮层
//      底下那些看不见的东西上。右上角那条「排好的活」和确认页是同时开着的，所以它
//      们合成一个循环——不合并的话，那条浮层上的按钮就永远按不到了。
//   3. Esc：要能关掉的浮层必须显式给 onEscape。不给就是「必须回答」的浮层。
//
// MUST-ANSWER —— 为什么确认页和审批卡故意不响应 Esc：
//
//   这两处是破坏性动作之前唯一的门。Esc 是个「随手按」的键，按下去东西就消失，她
//   没法确认那件事到底开始了没有（这正是审批卡出现之前"窗口像卡死了"的老毛病）。
//   而安全答案（「取消」/「拒绝」）就在屏幕上，而且打开时焦点就落在它上面：按一下
//   回车和按一下 Esc 一样省事，区别只在于她看清了那是「取消」。
//   所以这不是漏了键盘支持，是故意留的一道刹车。
//
// 为什么监听挂在 document 上而不是浮层根元素上：点到浮层的背板（那一大片深色）之后
// 焦点会落到 body，那时 keydown 的路径里根本没有浮层，挂在根元素上的处理函数收不到。
// 挂在 document 上，"焦点跑到哪儿去了"这一种情况也盖得住：Tab 会把焦点拉回层里。
import { createEffect, onCleanup, onMount } from "solid-js";

/** 当前开着的浮层都带这个属性；Tab 在这些层之间循环。 */
export const FOCUS_LAYER_ATTR = "data-focus-layer";

/** 键盘能按到的东西。`tabindex="-1"` 的（只给程序移动焦点用的标题）不算。 */
const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Tab 走一步，走到头就绕回来。纯函数，没有 DOM，所以 bun test 能直接核对它。
 *
 * `index` 是当前焦点在名单里的位置；-1 表示「焦点不在这一层里」（比如刚点到背板），
 * 这时 Tab 往层里走，Shift+Tab 从层尾倒着进来。
 */
export function stepIndex(count: number, index: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return shift ? count - 1 : 0;
  return shift ? (index + count - 1) % count : (index + 1) % count;
}

/** 现在真的能按到吗：不用 disabled、没藏起来、没被 aria-hidden 划走。 */
function focusable(element: HTMLElement): boolean {
  if (element.hasAttribute("disabled")) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element.tabIndex < 0) return false;
  // display:none（含被 Show 收起但节点还在的情况）时量不到任何盒子。
  if (element.getClientRects().length === 0) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none";
}

/** 一个层里所有能按到的东西，按屏幕上的先后顺序。 */
export function focusablesIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(focusable);
}

/** 现在开着的所有焦点层（DOM 顺序）。 */
export function layerRoots(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(`[${FOCUS_LAYER_ATTR}]`)).filter(
    (element) => element.isConnected,
  );
}

/** 所有开着的层合起来的名单：Tab 就在这份名单里循环。 */
export function layerFocusables(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const root of layerRoots()) out.push(...focusablesIn(root));
  return out;
}

/**
 * 把一个元素标成焦点层，但不接管键盘。
 *
 * 给「跟着浮层一起开着的小浮层」用（确认页右上角那条排好的活）：它要和确认页合
 * 成一个 Tab 循环，但它不该在打开时抢焦点，也不该在关掉时把焦点还回去。
 */
export function markFocusLayer(element: Element): void {
  element.setAttribute(FOCUS_LAYER_ATTR, "");
}

/** 已经挂上监听的那几层。同时开着的不止一层时，靠它决定由谁管这一下 Tab。 */
interface LayerHandle {
  isOpen(): boolean;
  root(): HTMLElement | undefined;
}

const liveLayers = new Set<LayerHandle>();

/**
 * 这一下 Tab 归谁管。
 *
 * 同时开着两层时（确认页 + 审批卡、确认页 + 右上角那条）只能由一层来挪焦点，
 * 否则一次 Tab 会挪两格。规则：焦点在哪一层里就由那一层管；焦点谁都不在（点到
 * 背板之后）时，最后挂上来的那一层管。
 */
function keyboardOwner(): LayerHandle | undefined {
  const candidates = [...liveLayers].filter(
    (layer) => layer.isOpen() && layer.root()?.isConnected,
  );
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const inside = candidates.filter((layer) => layer.root()?.contains(active));
    if (inside.length > 0) return inside[inside.length - 1];
  }
  return candidates[candidates.length - 1];
}

export interface FocusLayerOptions {
  /** 这一层现在开没开——用组件自己本来就有的那个条件。 */
  open: () => boolean;
  /** 打开时焦点落在哪；不给就用层里第一个能按的东西。 */
  initialFocus?: () => HTMLElement | null | undefined;
  /** Esc 做什么。不给 = 必须回答（MUST-ANSWER，见文件头）。 */
  onEscape?: () => void;
}

/**
 * 接管一层浮层的键盘。返回值是挂到浮层根元素上的 ref：
 *
 *   const layer = useFocusLayer({ open: () => runs().length > 0, onEscape: () => props.onClose() });
 *   <div ref={layer}>…</div>
 */
export function useFocusLayer(options: FocusLayerOptions): (element: HTMLElement) => void {
  let root: HTMLElement | undefined;
  // 打开这一层之前焦点在谁身上：关掉以后还给它，她不会突然"掉到页面顶上"。
  let opener: HTMLElement | null = null;
  let open = false;

  const self: LayerHandle = { isOpen: () => open, root: () => root };

  const ref = (element: HTMLElement): void => {
    root = element;
    markFocusLayer(element);
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (!open || !root?.isConnected) return;
    // 同时开着两层时只能由一层来管，否则一次 Tab 会挪两格。
    if (keyboardOwner() !== self) return;

    if (event.key === "Tab") {
      const list = layerFocusables();
      if (list.length === 0) return;
      event.preventDefault();
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? list.indexOf(active) : -1;
      list[stepIndex(list.length, index, event.shiftKey)]?.focus();
      return;
    }

    if (event.key !== "Escape") return;
    if (!options.onEscape) return; // MUST-ANSWER：这里什么都不做是故意的
    event.preventDefault();
    options.onEscape();
  }

  function restore(): void {
    const previous = opener;
    opener = null;
    // 关掉了：这一层不再拥有键盘（onCleanup 那条路上 open 还是 true，所以要先落下来）。
    const wasOpen = open;
    open = false;
    if (!previous || !wasOpen) return;
    queueMicrotask(() => {
      if (open) return; // 又开了一层：让新的那层说了算
      const active = document.activeElement;
      // 别人已经接手（例如新的一层已经把焦点放好了）就不要抢。
      if (active instanceof HTMLElement && active !== document.body) return;
      if (previous.isConnected) previous.focus();
    });
  }

  onMount(() => {
    liveLayers.add(self);
    document.addEventListener("keydown", onKeyDown);
  });
  onCleanup(() => {
    liveLayers.delete(self);
    document.removeEventListener("keydown", onKeyDown);
    restore();
  });

  createEffect(() => {
    const now = options.open();
    if (now === open) return;
    if (!now) {
      restore();
      return;
    }
    open = true;
    const active = document.activeElement;
    // body 接不了焦点（body.focus() 什么都不会发生），所以它不算「打开之前焦点在谁身上」。
    opener = active instanceof HTMLElement && active !== document.body ? active : null;
    queueMicrotask(() => {
      if (!open) return;
      const current = document.activeElement;
      // 焦点已经在层里了（例如浮层里又弹出一个东西）：不要抢。
      if (current instanceof HTMLElement && current !== document.body && root?.contains(current)) {
        return;
      }
      const target = options.initialFocus?.() ?? (root ? focusablesIn(root)[0] : undefined);
      target?.focus();
    });
  });

  return ref;
}
