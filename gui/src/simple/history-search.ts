// #57 — history search and "再跑一次".
//
// 王姐's work repeats by the month: "上个月那张表，再给我弄一遍". So the history
// list is not a ledger to scroll, it is the entrance to reusing work she already
// handed over once. This module is the pure half — no Solid, no DOM — so
// `bun test` can pin the matching rules without a browser.
//
// Two deliberate choices:
//
//   * Search is a plain substring match, not a tokenizer. Chinese has no word
//     boundaries, and a dictionary would only add new ways to be wrong for a
//     list that holds at most a couple of hundred rows. We match the four things
//     she can actually remember: the card title, her own sentence, the files she
//     picked, and the files the job produced.
//   * `normalize` folds full-width digits, letters and punctuation to half-width
//     before comparing, because she types on a Windows IME where 「（报表）」and
//     「(报表)」are the same thought. Whitespace is collapsed, never inserted, so
//     Chinese is never split apart.
//
// Rerun has to work for records from older versions too: an id whose card is
// gone falls back to the free-sentence task, so nothing in her history becomes
// dead weight.

import { fileName, type TaskRun } from "./run.ts";
import { TASKS, freeTask } from "./tasks/index.ts";

/** What `startRun` needs for the card: the same shape TaskRunner builds. */
export interface RerunTask {
  id: string;
  title: string;
  plan: string[];
}

/** Everything needed to stage an old run again, ready for `store.startRun`. */
export interface RerunInput {
  task: RerunTask;
  files: string[];
  instruction: string;
}

const IDEOGRAPHIC_SPACE = 0x3000;
const FULL_WIDTH_FIRST = 0xff01;
const FULL_WIDTH_LAST = 0xff5e;
const HALF_WIDTH_OFFSET = 0xfee0;

/** Fold one character: 全角 → 半角, and the wide space → a normal space. */
function fold(code: number): string | null {
  if (code === IDEOGRAPHIC_SPACE) return " ";
  if (code >= FULL_WIDTH_FIRST && code <= FULL_WIDTH_LAST) {
    return String.fromCodePoint(code - HALF_WIDTH_OFFSET);
  }
  return null;
}

/**
 * The comparison form of any text: full-width folded to half-width, lowercased,
 * trimmed, and with every run of whitespace squeezed to a single space.
 *
 * Chinese characters pass through untouched and no spaces are added, so
 * 「客户名单」stays one word; only the whitespace she typed herself is collapsed.
 */
export function normalize(text: string): string {
  let folded = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    folded += fold(code) ?? character;
  }
  return folded.trim().toLowerCase().replace(/\s+/g, " ").trim();
}

/** The file names a run mentions, without their folders. */
function namesIn(run: TaskRun): string[] {
  const names: string[] = [run.taskTitle, run.instruction];
  for (const path of run.files) names.push(fileName(path));
  for (const file of run.result?.files ?? []) names.push(fileName(file.path));
  return names;
}

/**
 * The runs whose title, instruction or file names contain `query`.
 *
 * An empty (or whitespace-only) query returns every run in its original order —
 * newest first, exactly as the store hands them over. No match returns an empty
 * array, so the caller can offer a way out instead of a blank list.
 */
export function searchRuns(runs: readonly TaskRun[], query: string): TaskRun[] {
  const needle = normalize(query);
  if (needle.length === 0) return runs.slice();
  return runs.filter((run) => namesIn(run).some((name) => normalize(name).includes(needle)));
}

/**
 * Turn one history row back into the input `store.startRun` takes.
 *
 * A known card is reused as it is today, so a job that learned new steps gets
 * them. A run whose card is gone (an older version, or something she described
 * in her own words) becomes a free-sentence job that still carries the title she
 * remembers and the sentence she typed — old records never become unrunnable.
 * Her files and her own sentence are passed through unchanged either way.
 */
export function rerunInput(run: TaskRun): RerunInput {
  const definition = TASKS.find((task) => task.id === run.taskId);
  if (definition) {
    return {
      task: { id: definition.id, title: definition.title, plan: [...definition.plan] },
      files: [...run.files],
      instruction: run.instruction,
    };
  }
  const fallback = freeTask(run.instruction);
  return {
    task: {
      id: fallback.id,
      title: run.taskTitle.trim() || fallback.title,
      plan: [...fallback.plan],
    },
    files: [...run.files],
    instruction: run.instruction,
  };
}
