// 那个「这是什么意思」的答案位。
//
// 用法：把一段她要读的文字交给 <HintText>，它把里面那几个她可能不认识的词各挂一个
// 问号入口，点一下就地把一句话摊开。它**不是**词典——词离开这句话就没有意义，所以
// 她不会去别处查；答案就贴在那个词旁边。
//
// 三条硬约束都落在这里：
//   * 入口是 44px 的按钮（typography 闸门扫按钮的高度）；
//   * 按钮有中文名字，屏幕阅读器念得出（a11y 闸门扫 button 的可访问名）；
//   * 一个字都不改她要读的原文——切分逻辑在 hints.ts，测试断言拼回去与原文一字不差。
import { For, Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { HINT_COPY } from "./copy-hints.ts";
import { explanationFor, segments } from "./hints.ts";
import type { Hint } from "./hints.ts";

/**
 * 光是那个问号入口 + 摊开的那一句，不带词本身。
 *
 * 单独拆出来，是因为有的地方词已经在别处写着（例如卡片标题在整块按钮里）——
 * 那里不能再嵌一个按钮，就把入口放在词的旁边，用 aria-label 说出它管的是哪个词。
 */
export function HintAsk(props: { hint: Hint; term: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <span class="inline-flex flex-col items-start">
      <button
        type="button"
        aria-expanded={open()}
        aria-label={open() ? HINT_COPY.hideLabel(props.term) : HINT_COPY.askLabel(props.term)}
        onClick={() => setOpen((value) => !value)}
        class="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-slate-600 text-[16px] font-semibold text-sky-300 hover:bg-slate-800"
      >
        <span aria-hidden="true">？</span>
      </button>
      <Show when={open()}>
        <span class="mt-1 max-w-[36ch] text-[16px] leading-relaxed text-sky-200" role="status">
          {explanationFor(props.hint)}
        </span>
      </Show>
    </span>
  );
}

/** 一段文字里的一个词 + 紧跟在它后面的问号入口。 */
function HintWord(props: { hint: Hint; term: string }): JSX.Element {
  return (
    <span class="inline-flex flex-wrap items-center gap-1 align-middle">
      <span>{props.term}</span>
      <HintAsk hint={props.hint} term={props.term} />
    </span>
  );
}

/**
 * 词已经写在别处（例如卡片标题/例子）时用的入口：一个 44px 的按钮，明面上就写着
 * 那个词 + 问号，点一下在下面把一句话摊开。
 *
 * 和 HintAsk 的区别只是**词写在按钮里还是按钮外**：卡片的主按钮里不能再嵌按钮，
 * 所以词的旁边放不下一个独立的小问号，就把词本身做成入口。
 */
export function HintChip(props: { hint: Hint; term: string }): JSX.Element {
  const [open, setOpen] = createSignal(false);
  return (
    <span class="inline-flex flex-col items-start">
      <button
        type="button"
        aria-expanded={open()}
        aria-label={open() ? HINT_COPY.hideLabel(props.term) : HINT_COPY.askLabel(props.term)}
        onClick={() => setOpen((value) => !value)}
        class="inline-flex min-h-[44px] items-center rounded-full border border-slate-600 px-4 text-[16px] font-semibold text-sky-300 hover:bg-slate-800"
      >
        <span aria-hidden="true">{props.term}？</span>
      </button>
      <Show when={open()}>
        <span class="mt-1 max-w-[36ch] text-[16px] leading-relaxed text-sky-200" role="status">
          {explanationFor(props.hint)}
        </span>
      </Show>
    </span>
  );
}

export interface HintTextProps {
  /** 她要读的那句话（原文一个字都不改）。 */
  text: string;
}

/**
 * 渲染一句话，给里面可解释的词各挂一个答案位。
 *
 * 没有可解释的词时，输出与原文完全一致的一段文字（不多一层包装、不多一个入口）。
 */
export default function HintText(props: HintTextProps): JSX.Element {
  return (
    <span>
      <For each={segments(props.text)}>
        {(segment) =>
          segment.kind === "plain" ? <>{segment.text}</> : <HintWord hint={segment.hint} term={segment.text} />
        }
      </For>
    </span>
  );
}
