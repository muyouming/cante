// 「关于」页（#151）：把随软件一起发的第三方许可说明摆出来。
//
// 为什么这一页必须存在：决定是**执行组件随安装包一起发**（见
// gui/docs/DECISION-windows-runtime.md §10）。MIT / BSD 这类许可要求分发时带上
// 许可文本，而她不会去网页或安装目录里找，所以说明得在界面里，跟软件一起到她手上。
//
// 为什么内容是 innerHTML 而不是一堆 JSX：这一页的正文是**数据**（几百条名字 /
// 版本 / 许可 / 原文），不是人写的句子；而 bun test 里没有 DOM（理由写在
// typography.test.ts 开头）。把「真正塞进 DOM 的那段 HTML」做成一个纯函数
// （noticesHtml），测试就能直接断言许可原文真的在渲染结果里，而不是只断言列表
// 里有个名字。界面外壳（入口按钮、返回、焦点层）仍然是 JSX。
//
// 键盘：整页是一个焦点层（走既有的 FocusLayer，不自己发明）：打开时焦点落在
// 「返回」上，Tab 在层里循环，Esc 关掉。每一条的「查看许可原文」是原生
// <details>/<summary>；<summary> 天生能用 Tab 到达、回车/空格展开，这里额外写上
// tabindex="0"，好让 FocusLayer 的焦点名单把它算进去（它的选择器只认 button /
// a[href] / [tabindex] 这几类，不认 summary 这个标签名）。
import { Show, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import { COMMON } from "./copy.ts";
import { ABOUT } from "./copy-about.ts";
import { useFocusLayer } from "./FocusLayer.tsx";
import {
  NOTICES,
  NOTICE_SUMMARY,
  TEXTS,
  type ThirdPartyNotice,
} from "./third-party-notices.ts";

/**
 * 许可原文里可能出现 `<` `>` `&`（例如 "A < B"、公司名里的 &）。原文直接塞进
 * innerHTML 会被当成标签，所以先转义。只转这三个就够：我们只把它放进元素正文，
 * 不放属性值。
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface NoticeSummary {
  readonly packages: number;
  readonly uniqueTexts: number;
  readonly missingText: number;
}

/**
 * 这一页真正显示的那段 HTML。纯函数：不碰 DOM、不读全局，测试可以直接看它。
 *
 * 每一条列出「名称 / 版本 / 许可」，许可原文折叠在下面（`<details>`）；确实没附带
 * 原文的写明「这份没有附带原文」，不替它编。
 */
export function noticesHtml(
  notices: readonly ThirdPartyNotice[] = NOTICES,
  texts: Readonly<Record<string, string>> = TEXTS,
  summary: NoticeSummary = NOTICE_SUMMARY,
): string {
  const L: string[] = [];
  L.push(`<h1 class="text-[24px] leading-tight font-bold text-slate-100">${escapeHtml(ABOUT.title)}</h1>`);
  L.push(`<p class="mt-3 text-[16px] leading-relaxed text-slate-400">${escapeHtml(ABOUT.lead)}</p>`);
  L.push(`<p class="mt-3 text-[16px] leading-relaxed text-slate-300">${escapeHtml(ABOUT.summary(summary.packages, summary.uniqueTexts))}</p>`);
  L.push(`<p class="mt-1 text-[16px] leading-relaxed text-slate-400">${escapeHtml(ABOUT.missingNote(summary.missingText))}</p>`);

  if (notices.length === 0) {
    L.push(`<p class="mt-4 text-[16px] leading-relaxed text-slate-200">${escapeHtml(ABOUT.empty)}</p>`);
    return L.join("\n");
  }

  L.push(`<h2 class="mt-5 text-[20px] font-semibold text-slate-200">${escapeHtml(ABOUT.listTitle)}</h2>`);
  L.push(`<ul class="mt-2 flex flex-col gap-3">`);
  for (const notice of notices) {
    const text = notice.textHash === null ? undefined : texts[notice.textHash];
    L.push(`<li class="rounded-xl border border-slate-800 bg-[#0e141b] px-4 py-3">`);
    L.push(`  <p class="text-[16px] font-semibold text-slate-100">${escapeHtml(notice.name)} <span class="font-normal text-slate-400">${escapeHtml(notice.version)}</span></p>`);
    L.push(`  <p class="text-[16px] text-slate-400">${escapeHtml(ABOUT.licenseColumn)}：${escapeHtml(notice.license)}</p>`);
    if (text === undefined) {
      L.push(`  <p class="mt-1 text-[16px] text-slate-500">${escapeHtml(ABOUT.missingText)}</p>`);
    } else {
      L.push(`  <details class="mt-1">`);
      L.push(`    <summary tabindex="0" class="min-h-[44px] cursor-pointer text-[16px] text-sky-300">${escapeHtml(ABOUT.showText)}</summary>`);
      L.push(`    <pre class="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-slate-700 bg-[#0b0f14] px-3 py-2 text-[16px] leading-relaxed text-slate-300">${escapeHtml(text)}</pre>`);
      L.push(`  </details>`);
    }
    L.push(`</li>`);
  }
  L.push(`</ul>`);
  return L.join("\n");
}

/**
 * 首页右上角那个安静的入口，连同它打开的整页。
 *
 * 拆成自包含的一个组件，是为了让 App.tsx 只用加一行（别的界面文件这一轮不能动）。
 * 浮层是 fixed 定位，放在页头的 flex 里不会挤到别的按钮。
 */
export function AboutEntry(): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const layer = useFocusLayer({ open, onEscape: () => setOpen(false) });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        class="min-h-[44px] rounded-lg px-3 text-[16px] text-slate-400 hover:text-slate-200"
      >
        {ABOUT.entry}
      </button>
      <Show when={open()}>
        <div
          ref={layer}
          class="fixed inset-0 z-[60] flex flex-col bg-[#0b0f14] px-5 py-4"
          role="dialog"
          aria-modal="true"
          aria-label={ABOUT.entry}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            class="mb-3 min-h-[44px] self-start rounded-lg pr-3 text-[16px] text-slate-400 hover:text-slate-200"
          >
            ← {COMMON.back}
          </button>
          <div
            class="min-h-0 flex-1 overflow-y-auto text-[16px] leading-relaxed text-slate-300"
            innerHTML={noticesHtml()}
          />
        </div>
      </Show>
    </>
  );
}

export default AboutEntry;
