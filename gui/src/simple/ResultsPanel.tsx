// r17 — 「我做的结果」面板：她做过的结果文件都在这儿，最近的在最上面。
//
// 结果文件不搬家（规矩是留在原文件旁边），所以这里只做一件事：把散在桌面、微信
// 下载和各种文件夹里的结果汇总成一份能搜的清单，并且如实标出它现在还在不在。
//
// r30 — 除了搜索（要她先想起文件名里有什么），再按时间分组：「今天 / 这周 / 更早」。
// 她记的是「我那天做的月报」，所以不搜的时候分组显示，每组一个真标题；一搜索就把
// 结果摊平（来的是哪一份本来就没几条，再切小组反而碍事）。
//
// 几件事分别归几个地方，互不越界：
//   * 排序、搜索、四种现状的判断在 results.ts（纯逻辑，有单测）；
//   * 今天/这周/更早的边界在 results-when.ts（纯逻辑，有单测）；
//   * 面向用户的中文在 copy-results.ts；
//   * 这个文件只负责渲染，以及从本机问一次 file_facts。
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "solid-js";

import type { Store } from "../store.ts";
// 「把这批结果一次复制成微信能贴的文字」的话，和别的面向用户中文一样单放一个模块。
import { BATCH } from "./copy-batch.ts";
import { RESULTS, pathForClipboard } from "./copy-results.ts";
// 一段文字里读不出来的那份，用同一句「这次读不出来」的说法（单份复制也是这句）。
import { shareReadFailed } from "./copy-share.ts";
import { sheetCapability } from "./capabilities.ts";
import { useFocusLayer } from "./FocusLayer.tsx";
import { canOpen, collectResults, resultPaths, searchResults, type ResultEntry } from "./results.ts";
import { groupResults } from "./results-when.ts";
import { formatSize, formatWhen } from "./run.ts";
import {
  canShareBatch,
  CHAT_MAX_WIDTH,
  batchChatText,
  isTablePath,
  type BatchEntry,
  type TableRow,
} from "./share.ts";
import { fetchFileFacts, normalizeFacts, type FileFact } from "./verify.ts";
import { errorText, invoke } from "../tauri.ts";

export interface ResultsPanelProps {
  store: Store;
  onClose(): void;
  /**
   * 一份结果都没有时，卡片里那个出路要干的事：关掉这一层、开卡片库（「你要做
   * 什么」）。这里不直接开库：面板只渲染，开哪一层由首页决定（和 onClose 一样）。
   * 故意做成**必填**——少接一根线应该是编译错误，而不是空态里悄悄少一个出路。
   */
  onExplore(): void;
}

/** 一行结果文件的现状，用颜色分清楚：还在是绿的，不在是红的，说不清是中性的。 */
function presenceClass(entry: ResultEntry): string {
  switch (entry.presence) {
    case "present":
      return "text-emerald-200";
    case "missing":
      return "text-rose-200";
    case "unreadable":
      return "text-amber-200";
    default:
      return "text-slate-300";
  }
}

/**
 * 把一段文字放进剪贴板（和结果卡片上那份单份复制同一套退路）。
 *
 * 先走系统剪贴板；在不让用的环境（例如真渲染里没有权限）退回选中复制。
 * 复制不是发送：这里只把文字放到她的剪贴板，发不发她自己决定。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回下面的选中复制 */
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

export default function ResultsPanel(props: ResultsPanelProps): JSX.Element {
  const [query, setQuery] = createSignal("");
  // null 表示「这次没能核对」——不是「文件都不在」，两者在界面上说得很不一样。
  const [facts, setFacts] = createSignal<FileFact[] | null>(null);
  let searchInput: HTMLInputElement | undefined;
  let closeButton: HTMLButtonElement | undefined;

  // 「把这批结果一次交出去」的现场：正在读、读完之后的那句话、以及没能放进去几份。
  // 读表要走后端，所以这里要有一个进行中的状态，免得她连点两次。
  const [batch, setBatch] = createSignal<{ note: string; skipped: number } | null>(null);
  const [batching, setBatching] = createSignal(false);

  // 「复制位置」的现场：复制成了没有，以及是**哪一份**（一屏可能有好几行，不记着就
  // 会在别人那行下面报喜）。和结果卡片上那份是同一个形状、同一句话。
  const [locationNote, setLocationNote] = createSignal<{ path: string; note: string } | null>(null);

  const entries = createMemo(() => collectResults(props.store.runs(), facts()));
  const shown = createMemo(() => searchResults(entries(), query()));
  const searching = () => query().trim().length > 0;
  // 分组看的是「今天/这周」，以打开这个面板的那一刻算一次；面板开着的时候跨过
  // 午夜也不重算，免得一份结果在她眼皮底下突然换组。
  const openedAt = Date.now();

  // 一行结果文件的全部样子。搜索时和分好组时都走这里——同一条结果在两种排法下
  // 长得必须一模一样，否则她换个方式看会以为换了一份东西。
  function row(entry: ResultEntry): JSX.Element {
    return (
      <li class="rounded-2xl border border-slate-700 bg-slate-900 p-4">
        {/* 这一份的名字是**真的标题**（h3）：读屏能按标题跳到「下一份」，也才知道
            自己现在在第几份。视觉不变 —— Tailwind 的 preflight 把 h1-h6 的字号与
            字重重置成 inherit、外边距归零，所以这里的类与原来的 <p> 逐字一致。 */}
        <h3 class="truncate text-[20px] font-semibold text-slate-100" title={entry.name}>
          {entry.name}
        </h3>
        <p
          class="mt-1 truncate text-[16px] leading-relaxed text-slate-400"
          title={entry.instruction}
        >
          {RESULTS.from(entry.title, entry.instruction)}
        </p>
        <p class="mt-1 text-[16px] text-slate-500">
          {RESULTS.when(formatWhen(entry.createdAt))}
          <Show when={entry.presence === "present" || entry.presence === "unreadable"}>
            <Show when={entry.size !== null}>
              {" · "}
              {RESULTS.size(formatSize(entry.size ?? 0))}
            </Show>
          </Show>
        </p>

        {/* 现在还在不在：本机说什么就说什么，核对没做成也照实说。 */}
        <p class={`mt-2 text-[16px] leading-relaxed ${presenceClass(entry)}`}>
          {RESULTS.presence[entry.presence]}
        </p>
        <Show when={!canOpen(entry)}>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">
            {RESULTS.actions.goneDisabled}
          </p>
        </Show>

        <div class="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={!canOpen(entry)}
            onClick={() => void props.store.openPath(entry.path)}
            aria-label={RESULTS.actions.ariaOpen(entry.name)}
            class="min-h-[48px] rounded-xl bg-sky-500 px-5 text-[16px] font-bold text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {RESULTS.actions.open}
          </button>
          <button
            type="button"
            onClick={() => void props.store.revealPath(entry.path)}
            aria-label={RESULTS.actions.ariaOpenFolder(entry.name)}
            class="min-h-[48px] rounded-xl border border-slate-600 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
          >
            {RESULTS.actions.openFolder}
          </button>
          {/* 事后从这儿找回来的时候，比刚做完那会儿更常需要把位置交给别人（微信上、
              电话里）——那串位置又长又绕，念不清，所以给她一步能做完的动作：整条复制走。
              和结果卡片上那个「复制位置」是同一件事、同一句话、同一个转换
              （copy-results.ts 的 pathForClipboard），不另写一份。
              复制不是发送：只放到她的剪贴板，粘到哪儿、发给谁，她自己定。 */}
          <button
            type="button"
            onClick={() => void copyLocation(entry)}
            aria-label={RESULTS.actions.ariaCopyLocation(entry.name)}
            class="min-h-[48px] rounded-xl border border-slate-600 px-5 text-[16px] font-semibold text-slate-100 hover:bg-slate-800"
          >
            {RESULTS.actions.copyLocation}
          </button>
        </div>
        {/* 复制成没成一句话就够；它自己占一行（不塞进上面那排），因为这句话有二十
            多个字，挤在按钮之间在窄窗口里会被压成一条竖缝。 */}
        <Show when={locationNote()?.path === entry.path}>
          <p class="mt-2 text-[16px] leading-relaxed text-slate-300" role="status">
            {locationNote()?.note}
          </p>
        </Show>
      </li>
    );
  }

  // 打开就落在搜索框上：这个面板的意义就是「用一句话把上次那张表找回来」；一个结果
  // 都还没有的时候搜索框根本不渲染，焦点就落在「回到首页」上（空态里除了它还有
  // 「去看看能做什么」，两个都够得着、读屏也都念得出，落在关闭键上是安全答案）。
  // 焦点进得来、Tab 在这一层里循环、Esc 关掉——三件事都在 FocusLayer 里做
  // （别的浮层走同一条路）。
  const layer = useFocusLayer({
    open: () => true,
    initialFocus: () => searchInput ?? closeButton,
    onEscape: () => props.onClose(),
  });

  // 问本机一次：这些结果文件现在还在不在。问不到就保持 null，绝不假装它们还在。
  createEffect(() => {
    const paths = resultPaths(props.store.runs());
    if (paths.length === 0) {
      setFacts(null);
      return;
    }
    let alive = true;
    void fetchFileFacts(paths)
      .then((raw) => {
        if (alive) setFacts(normalizeFacts(raw));
      })
      .catch(() => {
        // 桥接不在（比如浏览器预览）：如实说「没能核对」。
        if (alive) setFacts(null);
      });
    return () => {
      alive = false;
    };
  });

  // 把这一份的完整位置放进她的剪贴板（写法和结果卡片上那份一样：完整位置、
  // Windows 的反斜杠、成功/失败都是同一句话）。文件已经不在了也照样能复制——
  // 那时候她更要把位置给别人，让人帮忙找。
  async function copyLocation(entry: ResultEntry): Promise<void> {
    const copied = await copyText(pathForClipboard(entry.path));
    setLocationNote({
      path: entry.path,
      note: copied ? RESULTS.actions.copied : RESULTS.actions.copyFailed,
    });
  }

  function clearSearch(): void {
    setQuery("");
    searchInput?.focus();
  }

  // 把**屏幕上正列着的这几份**读成表格、拼成一段文字，放进她的剪贴板。
  //
  // 走的是和单份复制同一条真读路径（read_result_sheet → cante-sheets read），
  // 一段文字也沿用同一套排版（tableToChatText），所以她知道「一起复制」和「单独
  // 复制一份」贴出来是同一个样子。只是复制，不是发送：Cante 不碰微信。
  //
  // 一份读不出来不影响别的份：那一份如实计入「没能放进去」，剩下的照常给她。
  async function copyBatch(): Promise<void> {
    const list = shown();
    if (list.length === 0 || batching()) return;
    const cap = sheetCapability();
    if (!cap.available || !cap.path) {
      setBatch({ note: BATCH.toolUnavailable, skipped: 0 });
      return;
    }
    setBatching(true);
    setBatch(null);
    try {
      const read = invoke as unknown as (
        name: string,
        args?: Record<string, unknown>,
      ) => Promise<{ rows?: TableRow[] }>;
      const entries: BatchEntry[] = [];
      let tables = 0;
      let readFailures = 0;
      for (const entry of list) {
        if (!isTablePath(entry.path)) continue;
        tables += 1;
        try {
          const response = await read("read_result_sheet", {
            tool: cap.path,
            path: entry.path,
          });
          entries.push({ name: entry.name, rows: response?.rows ?? [] });
        } catch {
          readFailures += 1;
        }
      }
      const result = batchChatText(entries, { maxWidth: CHAT_MAX_WIDTH });
      // 不是表格的、空表的、这次读不出来的，一起如实交代。
      const skipped = result.skipped + (list.length - tables) + readFailures;
      if (result.text.trim() === "") {
        setBatch({ note: readFailures > 0 ? BATCH.readFailed : BATCH.empty, skipped: 0 });
        return;
      }
      const copied = await copyText(result.text);
      setBatch({
        note: copied ? BATCH.copied(result.included) : BATCH.copyFailed,
        skipped,
      });
    } catch (error) {
      setBatch({ note: shareReadFailed(errorText(error)), skipped: 0 });
    } finally {
      setBatching(false);
    }
  }

  return (
    <div
      ref={layer}
      class="fixed inset-0 z-50 flex flex-col bg-[#0b0f14]"
      role="dialog"
      aria-modal="true"
      aria-label={RESULTS.ariaSection}
    >
      <header class="flex shrink-0 items-start justify-between gap-3 border-b border-slate-800 px-5 pt-5 pb-4 sm:px-8">
        <div>
          <h2 class="text-[26px] leading-tight font-bold text-slate-100">{RESULTS.title}</h2>
          <p class="mt-1 text-[16px] leading-relaxed text-slate-400">{RESULTS.subtitle}</p>
        </div>
        <button
          type="button"
          ref={(element: HTMLButtonElement) => (closeButton = element)}
          onClick={() => props.onClose()}
          class="min-h-[44px] shrink-0 rounded-xl border border-slate-600 px-4 text-[16px] font-semibold text-slate-200 hover:bg-slate-800"
        >
          {RESULTS.close}
        </button>
      </header>

      <Show when={entries().length > 0}>
        <div class="shrink-0 px-5 pt-4 pb-3 sm:px-8">
          <div class="mx-auto w-full max-w-3xl">
            <label for="cante-results-search" class="text-[16px] font-medium text-slate-300">
              {RESULTS.search.label}
            </label>
            <input
              id="cante-results-search"
              ref={searchInput}
              type="search"
              autocomplete="off"
              aria-label={RESULTS.search.ariaLabel}
              value={query()}
              placeholder={RESULTS.search.placeholder}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  // 先清掉搜索词，空了再关掉面板；这里的 Esc 到此为止（否则关掉
                  // 面板和清搜索会一起发生）。
                  event.preventDefault();
                  event.stopPropagation();
                  if (query()) clearSearch();
                  else props.onClose();
                }
                if (event.key === "Enter") event.preventDefault();
              }}
              class="mt-2 min-h-[52px] w-full rounded-xl border border-slate-700 bg-[#141b24] px-4 text-[18px] text-slate-100 placeholder:text-slate-500"
            />
          </div>

          {/* 一次交出去：她做了五份时，不用再逐个点开、逐个复制。只复制成一段
              文字，不发微信；有几份没能放进去也照实说。 */}
          <Show when={canShareBatch(shown().length)}>
            <div class="mx-auto mt-3 w-full max-w-3xl">
              <div class="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={batching()}
                  onClick={() => void copyBatch()}
                  class="min-h-[48px] rounded-xl border-2 border-sky-600 px-5 text-[16px] font-bold text-sky-100 hover:bg-sky-950/40 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {BATCH.copyButton}
                </button>
                <p class="text-[16px] leading-relaxed text-slate-400">{BATCH.hint}</p>
              </div>
              <Show when={batch()}>
                <div class="mt-2 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2" role="status">
                  <p class="text-[16px] leading-relaxed text-slate-200">{batch()!.note}</p>
                  <Show when={batch()!.skipped > 0}>
                    <p class="mt-1 text-[16px] leading-relaxed text-slate-300">
                      {BATCH.skipped(batch()!.skipped)}
                    </p>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-8 sm:px-8">
        <div class="mx-auto w-full max-w-3xl">
          <Show
            when={entries().length > 0}
            fallback={
              <div class="mt-5 rounded-2xl border border-slate-700 bg-slate-900 px-5 py-8 text-center">
                <p class="text-[20px] font-semibold text-slate-200">{RESULTS.empty.title}</p>
                <p class="mt-2 text-[16px] leading-relaxed text-slate-400">{RESULTS.empty.body}</p>
                {/* 她第一次点开这个面板时就是这一屏，而右上角那个「回到首页」离这里
                    隔着一整个屏；在卡片里直接给一个 44px 的出路，她不用先找关闭键。 */}
                <div class="mt-5 flex justify-center">
                  <button
                    type="button"
                    onClick={() => props.onExplore()}
                    class="min-h-[48px] rounded-xl bg-sky-500 px-6 text-[18px] font-bold text-slate-950 hover:bg-sky-400"
                  >
                    {RESULTS.empty.explore}
                  </button>
                </div>
              </div>
            }
          >
            <Show
              when={shown().length > 0}
              fallback={
                <div class="mt-5 rounded-2xl border border-dashed border-slate-700 bg-[#111820] px-5 py-6">
                  <p class="text-[20px] font-semibold text-slate-200">{RESULTS.noResult.title}</p>
                  <p class="mt-2 text-[16px] leading-relaxed text-slate-400">
                    {RESULTS.noResult.body}
                  </p>
                  <button
                    type="button"
                    onClick={clearSearch}
                    class="mt-4 min-h-[44px] rounded-xl bg-sky-600 px-5 text-[16px] font-semibold text-white hover:bg-sky-500"
                  >
                    {RESULTS.search.clear}
                  </button>
                </div>
              }
            >
              <Show when={searching()}>
                <p class="mt-5 text-[16px] text-slate-300" role="status">
                  {RESULTS.hits(shown().length)}
                </p>
              </Show>

              {/* 搜索时把结果摊平：她在找**那一份**，来的结果没有几条，再按时间
                  切成一堆小组反而要多跳几次标题。不搜的时候才按时间分组（每组
                  一个三级标题，读屏可以靠它一组一组跳过去）。 */}
              <Show
                when={searching()}
                fallback={
                  <For each={groupResults(shown(), openedAt)}>
                    {(group) => (
                      <section class="mt-6">
                        <h3 class="text-[20px] font-semibold text-slate-200">
                          {RESULTS.group[group.bucket]}
                        </h3>
                        <ul
                          class="mt-3 flex flex-col gap-3"
                          aria-label={RESULTS.list.ariaLabel(group.entries.length)}
                        >
                          <For each={group.entries}>{(entry) => row(entry)}</For>
                        </ul>
                      </section>
                    )}
                  </For>
                }
              >
                <ul
                  class="mt-4 flex flex-col gap-3"
                  aria-label={RESULTS.list.ariaLabel(shown().length)}
                >
                  <For each={shown()}>{(entry) => row(entry)}</For>
                </ul>
              </Show>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}
