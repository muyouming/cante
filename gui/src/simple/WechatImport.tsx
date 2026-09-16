// The WeChat screen (#51, #52, #89): paste the chat, pick a job, hand it over.
//
// Two red lines are enforced here, not just documented:
//
//   1. The screen never offers to send. There is no button that posts to
//      WeChat, and no wording that implies the product will. The draft task
//      ends with "发送动作始终由你完成".
//   2. It never logs in. It only reads what she pastes or chooses, exactly like
//      the table tasks.
//
// #89 — 她要做的动作只有「选中、Ctrl+C」，而「先把内容存成一个文件」可能比整件事
// 还难。所以大文本框排在前面（协议本来就只承载文本），选文件留在后面当加法：导出
// 的记录通常更长更完整。两条路的代价都写在界面上，不靠她自己猜。
//
// 这一屏摆哪些卡，由目录说了算（`offerableTasks`）：目录里没有的卡绝不摆上来。
// 这是 #93 那条 P0 的教训——卡不在目录里，确认时拼出来的指令只有她那句话，
// 卡里写好的规矩一条都到不了助手。
//
// 新增的说明文字全在 copy.ts（WECHAT_PASTE）。三处步骤标题沿用这一屏原有的内联
// 字符串，只改了措辞与节号：内联文案总数因此仍是 21 处，一分没多（copy-guard 的
// 台账只减不增，而搬走这三处得同时改那份台账，不在本轮可改文件里）。
//
// The file picker and the run starter belong to r5-trust; they are read through
// a local widened view so this screen compiles and renders before those land,
// and so a missing desktop bridge degrades to an explanation instead of a
// blank page.
import { For, Show, createSignal } from "solid-js";
import type { Accessor, JSX } from "solid-js";

import type { Store } from "../store.ts";
import ConfirmSheet from "./ConfirmSheet.tsx";
import ResultCard from "./ResultCard.tsx";
import { WECHAT_PASTE, WECHAT_UI } from "./copy.ts";
import { DRAFT_SEND_NOTICE, WECHAT_READONLY_HINT, WECHAT_SAFETY_NOTICE, onlineLabel } from "./privacy.ts";
import { TASKS } from "./tasks/index.ts";
import { WECHAT_ACCEPT, WECHAT_ALL_TASKS, initialTaskId, offerableTasks, type TaskDef } from "./tasks/wechat.ts";

export interface WechatImportProps {
  store: Store;
  /**
   * 从首页点某张微信卡进来时预选那一张（集成者接线用）。不传就选第一张，
   * 和以前一样，所以这一屏在没有接线时照常能用。
   */
  taskId?: string;
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

/** 这一屏能摆的卡：目录里真的有的那些（见文件头 #93 那条）。 */
const SCREEN_TASKS: TaskDef[] = offerableTasks(
  WECHAT_ALL_TASKS,
  TASKS.map((task) => task.id),
);

// 电脑版微信的实际做法，一步一句，她照着点就能做完。
const EXPORT_STEPS = [
  "打开电脑版微信，找到要整理的那个聊天。",
  "把要整理的消息选中（从第一条按住鼠标拖到最后一条），点右键选「复制」。",
  "打开电脑上的「记事本」，粘贴进去，再点「文件」→「另存为」，记下保存到哪个文件夹。",
];

/** The extensions a WeChat export (or a roster) can have, from the cards on screen. */
function acceptedExtensions(): string[] {
  const out = new Set<string>(WECHAT_ACCEPT);
  for (const task of SCREEN_TASKS) for (const ext of task.accept ?? []) out.add(ext);
  return [...out];
}

export default function WechatImport(props: WechatImportProps): JSX.Element {
  const store = props.store as WechatStore;
  const [selectedId, setSelectedId] = createSignal(initialTaskId(SCREEN_TASKS, props.taskId));
  const [files, setFiles] = createSignal<string[]>([]);
  const [pasted, setPasted] = createSignal("");
  const [note, setNote] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);

  const task = (): TaskDef | undefined => SCREEN_TASKS.find((item) => item.id === selectedId());
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
    const content = pasted().trim();
    if (content.length === 0 && files().length === 0) {
      setProblem("请先把内容贴进来，或者选一个聊天记录文件。");
      return;
    }
    if (typeof store.startRun !== "function") {
      setProblem("现在还不能开始整理。请用桌面版的 Cante 打开这个功能。");
      return;
    }
    setBusy(true);
    try {
      // 贴进来的那一段和她补的话都放进「她的话」里：卡片的提示词会把两者一起
      // 变成【用户的原话】，助手因此看得到要整理的内容。
      const instruction = [content, note().trim()].filter((part) => part.length > 0).join("\n\n");
      await store.startRun(
        { id: chosen.id, title: chosen.title, plan: chosen.plan },
        files(),
        instruction,
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
        <h2 class="text-[20px] font-bold text-amber-200">{WECHAT_UI.noSend}</h2>
        <p class="mt-1 text-[16px] leading-5 text-amber-200/80">{WECHAT_SAFETY_NOTICE}{WECHAT_READONLY_HINT}</p>
        <p class="mt-1 text-[16px] leading-5 text-amber-200/80">{WECHAT_UI.noSendHint}{DRAFT_SEND_NOTICE}</p>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <h3 class="text-[20px] font-bold tracking-widest text-slate-500">第一步：要做哪一件事</h3>
        <div class="flex flex-col gap-2" role="radiogroup" aria-label="要做哪一件事">
          <For each={SCREEN_TASKS}>
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
                <span class="text-[20px] text-slate-200">{item.title}</span>
                <span class="text-[16px] leading-4 text-slate-500">{item.example}</span>
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <h3 class="text-[20px] font-bold tracking-widest text-slate-500">第二步：把聊天内容贴进来</h3>
        <p class="text-[16px] leading-5 text-slate-400">{WECHAT_PASTE.hint}</p>
        <textarea
          class="min-h-[240px] w-full resize-y overflow-y-auto rounded-md border border-slate-800 bg-[#0e141b] px-3 py-2 text-[16px] leading-6 text-slate-200 outline-none focus:border-sky-600"
          placeholder={WECHAT_PASTE.placeholder}
          value={pasted()}
          onInput={(event) => setPasted(event.currentTarget.value)}
        />
        <p class="text-[16px] leading-5 text-slate-500">{WECHAT_PASTE.cost}</p>
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

      <div class="flex flex-col gap-2 rounded-lg border border-slate-800 bg-[#0b0f14] p-4">
        <h3 class="text-[20px] font-bold tracking-widest text-slate-500">第三步：也可以存成文件再选进来</h3>
        <p class="text-[16px] leading-5 text-slate-400">{WECHAT_PASTE.fileHint}</p>
        <ol class="flex list-decimal flex-col gap-1 pl-5 text-[16px] leading-5 text-slate-400">
          <For each={EXPORT_STEPS}>{(step) => <li>{step}</li>}</For>
        </ol>
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

      {/* 点「开始整理」只是把活摆到确认页（store.startRun 停在 preview）。
          这一屏以前没有把确认页摆出来，于是点完就一直停在「正在处理」——
          「动手前先给你看一眼」那句承诺变成了死路。确认页自己会在 preview 时
          弹出来，这里只需要把它接上。 */}
      <ConfirmSheet store={props.store} />

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
