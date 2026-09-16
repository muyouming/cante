// The WeChat screen (#51, #52): pick an exported chat log, choose what to do,
// hand it to the task catalogue. Two red lines are enforced here, not just
// documented:
//
//   1. The screen never offers to send. There is no button that posts to
//      WeChat, and no wording that implies the product will. The draft task
//      ends with "发送动作始终由你完成".
//   2. It never logs in. It only reads a file the user chose, exactly like the
//      table tasks.
//
// The file picker and the run starter belong to r5-trust; they are read through
// a local widened view so this screen compiles and renders before those land,
// and so a missing desktop bridge degrades to an explanation instead of a
// blank page.
import { For, Show, createSignal } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";
import ResultCard from "./ResultCard.tsx";
import { DRAFT_SEND_NOTICE, WECHAT_READONLY_HINT, WECHAT_SAFETY_NOTICE, onlineLabel } from "./privacy.ts";
import { WECHAT_ACCEPT, WECHAT_TASKS, type TaskDef } from "./tasks/wechat.ts";

export interface WechatImportProps {
  store: Store;
}

/** Just enough of a run for this screen's status line. */
export interface WechatRunView {
  id: string;
  taskId: string;
  taskTitle: string;
  online: boolean;
  state: string;
}

type WechatStore = Store & {
  pickFiles?: (opts?: { multiple?: boolean; extensions?: string[] }) => Promise<string[]>;
  startRun?: (
    task: { id: string; title: string; plan: string[] },
    files: string[],
    instruction: string,
  ) => Promise<void>;
  currentRun?: Accessor<WechatRunView | null>;
};

const EXPORT_STEPS = [
  "在电脑版微信里找到要整理的那个聊天。",
  "把要整理的聊天内容导出，或者选中后复制到一个新文件里（记事本、表格、网页文件都行）。",
  "保存好这个文件，记住它在哪个文件夹，然后在下面把它选进来。",
];

/** The extensions a WeChat export can have, unioned with each task's list. */
function acceptedExtensions(): string[] {
  const out = new Set<string>(WECHAT_ACCEPT);
  for (const task of WECHAT_TASKS) for (const ext of task.accept ?? []) out.add(ext);
  return [...out];
}

export default function WechatImport(props: WechatImportProps): JSX.Element {
  const store = props.store as WechatStore;
  const [selectedId, setSelectedId] = createSignal(WECHAT_TASKS[0]?.id ?? "");
  const [files, setFiles] = createSignal<string[]>([]);
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);

  const task = (): TaskDef | undefined => WECHAT_TASKS.find((item) => item.id === selectedId());
  const run = (): WechatRunView | null => store.currentRun?.() ?? null;

  async function chooseFiles(): Promise<void> {
    setProblem(null);
    if (typeof store.pickFiles !== "function") {
      setProblem("现在打不开选择文件的窗口。请用桌面版的 Cante 打开这个功能，再来选文件。");
      return;
    }
    setBusy(true);
    try {
      const picked = await store.pickFiles({ multiple: true, extensions: acceptedExtensions() });
      if (picked.length > 0) setFiles(picked);
    } catch {
      setProblem("没能打开你选的文件。你可以换一个文件再试一次，或者确认文件没有被移到别处。");
    } finally {
      setBusy(false);
    }
  }

  async function start(): Promise<void> {
    setProblem(null);
    const chosen = task();
    if (!chosen) return;
    if (files().length === 0) {
      setProblem("请先选一个聊天记录文件，再开始整理。");
      return;
    }
    if (typeof store.startRun !== "function") {
      setProblem("现在还不能开始整理。请用桌面版的 Cante 打开这个功能。");
      return;
    }
    setBusy(true);
    try {
      await store.startRun(
        { id: chosen.id, title: chosen.title, plan: chosen.plan },
        files(),
        note(),
      );
    } catch {
      setProblem("没能开始整理。你可以稍后再点一次；如果还是不行，先把 Cante 关掉重新打开。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="flex flex-col gap-4" aria-label="微信聊天记录整理">
      <div class="rounded-lg border border-amber-700/60 bg-amber-950/30 px-4 py-3">
        <p class="text-[18px] font-bold text-amber-200">{WECHAT_SAFETY_NOTICE}</p>
        <p class="mt-1 text-[16px] leading-5 text-amber-200/80">{WECHAT_READONLY_HINT}</p>
        <p class="mt-1 text-[16px] leading-5 text-amber-200/80">{DRAFT_SEND_NOTICE}</p>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <span class="text-[16px] font-bold tracking-widest text-slate-500">第一步：把聊天记录变成文件</span>
        <ol class="flex list-decimal flex-col gap-1 pl-5 text-[16px] leading-5 text-slate-400">
          <For each={EXPORT_STEPS}>{(step) => <li>{step}</li>}</For>
        </ol>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <span class="text-[16px] font-bold tracking-widest text-slate-500">第二步：选文件</span>
        <button
          type="button"
          class="min-h-[44px] self-start rounded-md border border-sky-700 bg-sky-900/40 px-3 py-1.5 text-[16px] font-bold text-sky-100 hover:border-sky-500 disabled:opacity-60"
          disabled={busy()}
          onClick={() => void chooseFiles()}
        >
          选择聊天记录文件
        </button>
        <Show
          when={files().length > 0}
          fallback={<span class="text-[16px] text-slate-500">还没有选文件。</span>}
        >
          <ul class="flex flex-col gap-0.5" role="list">
            <For each={files()}>
              {(file) => <li class="truncate text-[16px] text-slate-300" title={file}>{file}</li>}
            </For>
          </ul>
        </Show>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <span class="text-[16px] font-bold tracking-widest text-slate-500">第三步：要做哪一件事</span>
        <div class="flex flex-col gap-2" role="radiogroup" aria-label="要做哪一件事">
          <For each={WECHAT_TASKS}>
            {(item) => (
              <button
                type="button"
                role="radio"
                aria-checked={selectedId() === item.id}
                class={`flex min-h-[44px] flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left ${
                  selectedId() === item.id
                    ? "border-sky-600 bg-sky-950/40"
                    : "border-slate-800 bg-[#0e141b] hover:border-slate-600"
                }`}
                onClick={() => setSelectedId(item.id)}
              >
                <span class="text-[18px] text-slate-200">{item.title}</span>
                <span class="text-[16px] leading-4 text-slate-500">{item.example}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <label class="flex flex-col gap-1">
          <span class="text-[16px] font-bold tracking-widest text-slate-500">想补充的话（可不填）</span>
          <textarea
            class="min-h-[64px] resize-y rounded-md border border-slate-800 bg-[#0e141b] px-3 py-2 text-[16px] text-slate-200 outline-none focus:border-sky-600"
            placeholder="比如：只整理要紧的事"
            value={note()}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          class="min-h-[44px] self-start rounded-md border border-emerald-700 bg-emerald-900/40 px-4 py-1.5 text-[16px] font-bold text-emerald-100 hover:border-emerald-500 disabled:opacity-60"
          disabled={busy()}
          onClick={() => void start()}
        >
          开始整理
        </button>
      </div>

      <Show when={problem()}>
        <div class="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-[16px] leading-5 text-red-200" role="alert">
          {problem()}
        </div>
      </Show>

      <Show when={run()}>
        {(current) => (
          <div class="rounded-md border border-slate-800 bg-[#0e141b] px-3 py-2 text-[16px] text-slate-400" role="status">
            正在处理：{current().taskTitle}（{onlineLabel(current().online)}）
            <Show when={!current().online}>
              <span class="text-slate-500">，内容没有离开这台电脑。</span>
            </Show>
          </div>
        )}
      </Show>

      <Show when={run() && ["done", "failed", "cancelled"].includes(run()!.state)}>
        <ResultCard store={props.store} />
      </Show>

      <p class="text-[16px] leading-6 text-slate-500">
        整理结果里的草稿可以一键复制。{DRAFT_SEND_NOTICE}
      </p>
    </section>
  );
}
