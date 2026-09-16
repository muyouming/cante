// #63 / #64 — the two halves of trust that cannot be faked.
//
// #63 is the part nobody likes writing: what this job is known to get wrong.
// The task catalogue carries that text (`TaskDef.risks`); this module only
// reads back the `【需要你核对】` paragraph the assistant was asked to end with,
// so the result card can show *this run's* actual uncertainties rather than a
// generic disclaimer.
//
// #64 is the opposite: proof from this computer's own history. "Done 4 times,
// worked 4 times" is only ever computed from `store.runs()` — no history means
// no number at all, never an optimistic guess. When something failed, the
// newest plain-Chinese reason (`run.error`) is offered, collapsed, under the
// counts.
//
// Everything here is pure and framework-free so `bun test` can pin the
// arithmetic and the text extraction without a browser or a daemon.

import { formatWhen, type TaskRun } from "./run.ts";

/** The marker the assistant is told to end its reply with (see tasks/prompt.ts). */
export const CHECK_MARKER = "【需要你核对】";

/**
 * A run only counts once it is over. `draft`/`preview`/`running` are in-flight
 * records; counting them would inflate the numbers on screen.
 */
const FINISHED_STATES: ReadonlySet<TaskRun["state"]> = new Set(["done", "failed", "cancelled"]);

/**
 * Whether a run is real work rather than a rehearsal. A dry run ("先试跑给我看")
 * never touches files, so it is not evidence that the job can be done.
 */
function isCountable(run: TaskRun): boolean {
  return FINISHED_STATES.has(run.state) && run.dryRun !== true;
}

/**
 * #64 — how often *this* job (by task id) finished on this computer, and how
 * often it finished well. Returns null when there is no history, so the caller
 * renders nothing instead of a zero.
 */
export function evidenceFor(
  runs: readonly TaskRun[],
  taskId: string,
): { runs: number; ok: number } | null {
  if (!taskId) return null;
  let total = 0;
  let ok = 0;
  for (const run of runs) {
    if (run.taskId !== taskId || !isCountable(run)) continue;
    total += 1;
    if (run.state === "done") ok += 1;
  }
  return total > 0 ? { runs: total, ok } : null;
}

/** The newest failure for a task, in the user's language. */
export interface PastFailure {
  /** "今天 14:30" / "3月5日 09:05" */
  when: string;
  /** 发生了什么, from `run.error.what`. */
  what: string;
  /** 你可以怎么做, from `run.error.how`. */
  how: string;
}

/**
 * #64 — the most recent failed attempt, if there is one. Only failed runs are
 * considered: a run the user cancelled herself is not a failure to explain.
 */
export function failureFor(runs: readonly TaskRun[], taskId: string): PastFailure | null {
  if (!taskId) return null;
  let newest: TaskRun | null = null;
  for (const run of runs) {
    if (run.taskId !== taskId || run.state !== "failed" || run.dryRun === true) continue;
    if (!newest || (run.createdAt ?? 0) > (newest.createdAt ?? 0)) newest = run;
  }
  if (!newest) return null;
  const error = newest.error;
  return {
    when: formatWhen(newest.createdAt ?? 0),
    what: error?.what?.trim() || "上一次这件事没有做完。",
    how: error?.how?.trim() || "原来的文件都还在，可以再试一次。",
  };
}

/**
 * #63 — pull the `【需要你核对】` paragraph out of one assistant message.
 *
 * The instruction says the paragraph comes last, so the *last* marker wins and
 * everything after it is the body. Returns null when the marker is absent or
 * the body is empty — an absent paragraph means "nothing to show", not "show a
 * default warning".
 */
export function extractCheckNote(text: string): string | null {
  if (!text) return null;
  const index = text.lastIndexOf(CHECK_MARKER);
  if (index < 0) return null;
  let body = text.slice(index + CHECK_MARKER.length);
  // A leading colon or newline is punctuation, not content.
  body = body.replace(/^[：:\s]+/, "").trim();
  if (!body) return null;
  // If the assistant kept writing another 【…】 section on its own line
  // afterwards, the check note ends where that section starts. An inline
  // bracket (like a filename in 「【…】」) does not cut the paragraph off.
  const next = body.search(/\n\s*【[^】\n]{1,20}】/);
  if (next > 0) body = body.slice(0, next).trim();
  return body || null;
}

/** The text of the last message the assistant sent, if there is one. */
export function lastAgentText(rows: readonly { kind: string; text: string }[]): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind !== "agent") continue;
    const text = row.text?.trim();
    if (text) return text;
  }
  return null;
}

/**
 * #63 — the check note for the run on screen, read from the transcript. Null
 * whenever the assistant did not write one, so the result card stays quiet.
 */
export function checkNoteFromRows(rows: readonly { kind: string; text: string }[]): string | null {
  const text = lastAgentText(rows);
  return text ? extractCheckNote(text) : null;
}
