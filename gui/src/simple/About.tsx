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
// 为什么原文要等打开才取（#157）：去重后的许可原文有 1911.8 KB，是这一页体积的
// 几乎全部，而绝大多数人一辈子不会点开「关于」。之前它静态进主包，等于每次启动都
// 把这段原文运进来、解析一遍，白花在「首页到关键元素」那条基线上。现在改成：
// 点开「关于」时才 import() 那段原文（走的是真实的那条路——生产代码里 get 它的
// 唯一入口就是 loadNotices()），加载中给她一句人话，取不回来时给她一条出路
// （说清发生了什么 + 怎么做：把软件关掉重新打开。为什么不给一个「再试一次」
// 按钮，见 copy-about.ts 里 loadFailed 的注释：同一页里重试那个分块是注定失败的，
// 真机验过）。页面外壳和入口按钮仍在主包里，
// 不然就没有东西可点。
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
import type { ThirdPartyNotice } from "./third-party-notices.ts";

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

/** 这一页要显示的全部数据：条目、去重后的原文、摘要数字。 */
export interface NoticeData {
  readonly notices: readonly ThirdPartyNotice[];
  readonly texts: Readonly<Record<string, string>>;
  readonly summary: NoticeSummary;
}

/**
 * 这一页真正显示的那段 HTML。纯函数：不碰 DOM、不读全局，测试可以直接看它。
 *
 * 每一条列出「名称 / 版本 / 许可」，许可原文折叠在下面（`<details>`）；确实没附带
 * 原文的写明「这份没有附带原文」，不替它编。
 */
export function noticesHtml(data: NoticeData): string {
  const { notices, texts, summary } = data;
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
 * 这一页的状态：等（loading）、取回来了（ready）、取不回来（failed）。
 *
 * 「等」和「失败」是两种必须分开画的东西——产品律 3：出错要有出路，不能只是
 * 停在那儿或者一片空白。为什么失败态没有「再试一次」按钮，见 copy-about.ts 里
 * loadFailed 的注释。
 */
export type AboutState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly data: NoticeData };

/** 取回来过就记住：一次会话里再打开「关于」不用重新下载、重新解析。 */
let loaded: Promise<NoticeData> | null = null;

/**
 * 去取许可说明。**这是生产路径上唯一取它的地方**：动态 import() 把
 * third-party-notices.ts 拆成独立分块，只有真的走到这一句才会下载它。
 *
 * 为什么失败不写进缓存：写进去，这一页里再打开「关于」就只会立刻看到同一个失败，
 * 连一次真正的重取都不会有；不写，至少每次打开都会真的再 import 一次（同一页里
 * 浏览器会不会再发一次请求是另一回事——真机验过不会，见 copy-about.ts）。
 */
export function loadNotices(): Promise<NoticeData> {
  if (loaded !== null) return loaded;
  const pending = import("./third-party-notices.ts").then((mod) => ({
    notices: mod.NOTICES,
    texts: mod.TEXTS,
    summary: mod.NOTICE_SUMMARY,
  }));
  pending.catch(() => {
    if (loaded === pending) loaded = null;
  });
  loaded = pending;
  return pending;
}

/**
 * 状态机。抽出来是为了能在 bun test 里注入一个「一定会失败」的取法，核对失败真的
 * 会走到 failed 那条路，而不是只核对一段文案。组件只负责把 state() 画出来。
 */
export function createNoticesState(load: () => Promise<NoticeData> = loadNotices) {
  const [state, setState] = createSignal<AboutState>({ kind: "loading" });
  /** 每次 begin 加一：晚回来的旧结果不许盖掉新一次的结果（关掉再点）。 */
  let generation = 0;

  /** 取一次。第一次打开、关掉再打开，都走这里。 */
  function begin(): void {
    generation += 1;
    const mine = generation;
    setState({ kind: "loading" });
    // Promise.resolve().then(...)：取法同步抛错也算失败，而不是把这一页卡在「正在打开」。
    Promise.resolve()
      .then(load)
      .then(
        (data) => {
          if (mine === generation) setState({ kind: "ready", data });
        },
        () => {
          if (mine === generation) setState({ kind: "failed" });
        },
      );
  }

  return { state, begin };
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
  const notices = createNoticesState();

  /** 点开入口：先把这一页亮出来（她马上看到「正在打开」），再真的去取。 */
  function openAbout(): void {
    setOpen(true);
    notices.begin();
  }

  const loading = () => notices.state().kind === "loading";
  const failed = () => notices.state().kind === "failed";
  const ready = () => {
    const current = notices.state();
    return current.kind === "ready" ? current.data : null;
  };

  return (
    <>
      <button
        type="button"
        onClick={openAbout}
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
          <div class="min-h-0 flex-1 overflow-y-auto text-[16px] leading-relaxed text-slate-300">
            <Show when={loading()}>
              <p class="text-[16px] leading-relaxed text-slate-400">{ABOUT.loading}</p>
            </Show>
            <Show when={failed()}>
              <p class="text-[16px] leading-relaxed text-slate-200">{ABOUT.loadFailed}</p>
            </Show>
            <Show when={ready()}>{(data) => <div innerHTML={noticesHtml(data())} />}</Show>
          </div>
        </div>
      </Show>
    </>
  );
}

export default AboutEntry;
