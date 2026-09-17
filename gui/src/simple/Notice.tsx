// 界面上「提示」那句话的渲染（#140）。
//
// 它是 store.notice() 的唯一读方：把四条许诺（撤销成功 / 撤销失败 / 出错 / 选文件
// 窗口打不开）翻成两句平实中文，画在她当时正看的那一屏上。分类和文案都在
// copy-notice.ts，这里只排版——不新开浮层、不弹窗，也不冒充一条助手消息。
import { Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";

import { visibleNotice, type NoticeKind, type NoticeView } from "./copy-notice.ts";

export interface NoticeProps {
  /** 要说的原话，通常来自 `store.notice()`。 */
  text: string | null | undefined;
  /** 这一屏只显示哪几类；不给就是全都显示。 */
  kinds?: readonly NoticeKind[];
  /** 屏幕上已经说过的句子（例如出错页的 what），避免同一件事说两遍。 */
  alreadySaid?: readonly string[];
  /** 排版用的额外类名（例如上边距）。 */
  class?: string;
}

export default function Notice(props: NoticeProps): JSX.Element {
  const view = createMemo<NoticeView | null>(() =>
    visibleNotice(props.text, props.kinds, props.alreadySaid),
  );
  return (
    <Show when={view()}>
      {(item) => (
        <div
          class={`rounded-2xl border border-sky-700 bg-sky-950/40 px-4 py-3 ${props.class ?? ""}`}
          role="status"
        >
          <p class="text-[16px] leading-relaxed font-semibold text-sky-100">{item().what}</p>
          <p class="mt-1 text-[16px] leading-relaxed text-sky-100/90">{item().how}</p>
        </div>
      )}
    </Show>
  );
}
