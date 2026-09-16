// Choosing what to work on — the one step before the confirmation sheet.
//
// A 45-year-old office worker does not think in "paths" or "extensions". She
// thinks "these two Excel files" and "that folder of photos". So this picker is
// one large button that opens the *system's own* file window (the one she
// already knows from Word and Explorer), then lists what she chose in plain
// Chinese, one line per file, with a way to take one back.
//
// It is a controlled component: the parent owns the list, so the task runner
// can validate it (at least one file, right kind) before enabling 下一步.
import { For, Show } from "solid-js";
import type { JSX } from "solid-js";

import { fileName, folderName } from "./run.ts";
import type { Store } from "../store.ts";

export interface FilePickerProps {
  store: Store;
  /** The chosen paths; a folder pick is a one-element list. */
  value: string[];
  onChange(paths: string[]): void;
  /** Allow more than one file. Ignored when `folder` is set. */
  multiple?: boolean;
  /** Offer only these extensions, without the dot (e.g. ["xlsx", "csv"]). */
  extensions?: string[];
  /** Pick a folder instead of files. */
  folder?: boolean;
  /** The big line above the button. */
  label?: string;
  /** One sentence of help under the button. */
  hint?: string;
}

/** `xlsx` -> "要处理的文件"; keeps the picker's own chrome in Chinese. */
function pickerLabel(folder: boolean, multiple: boolean): string {
  if (folder) return "选择文件夹";
  return multiple ? "选择文件（可以选多个）" : "选择文件";
}

export default function FilePicker(props: FilePickerProps): JSX.Element {
  const folder = (): boolean => props.folder === true;

  async function choose(): Promise<void> {
    if (folder()) {
      const picked = await props.store.pickFolder();
      if (picked) props.onChange([picked]);
      return;
    }
    const picked = await props.store.pickFiles({
      multiple: props.multiple === true,
      extensions: props.extensions,
    });
    if (picked.length === 0) return;
    props.onChange(props.multiple === true ? picked : picked.slice(0, 1));
  }

  function remove(path: string): void {
    props.onChange(props.value.filter((item) => item !== path));
  }

  async function reveal(path: string): Promise<void> {
    await props.store.revealPath(path);
  }

  return (
    <div class="flex flex-col gap-3">
      <Show when={props.label}>
        <p class="text-lg font-semibold text-slate-100">{props.label}</p>
      </Show>

      <button
        type="button"
        onClick={() => void choose()}
        class="flex min-h-[64px] w-full items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-sky-600/70 bg-sky-950/40 px-6 py-4 text-lg font-semibold text-sky-100 hover:border-sky-400 hover:bg-sky-900/40"
      >
        <span aria-hidden="true" class="text-2xl">{folder() ? "📁" : "📄"}</span>
        <span>{pickerLabel(folder(), props.multiple === true)}</span>
      </button>

      <Show when={props.hint}>
        <p class="text-sm text-slate-400">{props.hint}</p>
      </Show>

      <Show when={props.value.length > 0}>
        <div class="rounded-2xl border border-slate-700 bg-slate-900/60">
          <p class="border-b border-slate-800 px-4 py-2 text-sm text-slate-300">
            {folder() ? "已选文件夹：" : `已选 ${props.value.length} 个文件：`}
          </p>
          <ul class="divide-y divide-slate-800">
            <For each={props.value}>
              {(path) => (
                <li class="flex items-center gap-3 px-4 py-3">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-base text-slate-100" title={path}>
                      {fileName(path)}
                    </p>
                    <Show when={folderName(path) !== path}>
                      <p class="truncate text-xs text-slate-500" title={folderName(path)}>
                        位置：{folderName(path)}
                      </p>
                    </Show>
                  </div>
                  <button
                    type="button"
                    onClick={() => void reveal(path)}
                    class="shrink-0 rounded-lg px-3 py-2 text-sm text-sky-300 hover:bg-slate-800"
                    aria-label={`打开 ${fileName(path)} 所在的文件夹`}
                  >
                    看它在哪
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(path)}
                    class="shrink-0 rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-rose-300"
                    aria-label={`不处理 ${fileName(path)}`}
                  >
                    去掉
                  </button>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  );
}
