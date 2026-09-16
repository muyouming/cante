// App state for the Cante desktop GUI.
//
// Live events arrive on `cante://event`; `events_since` hydrates the row stream
// from the Rust ring on launch and reconciles it periodically so a missed push
// (or a webview reload) cannot desync the view. Every batch is folded into the
// signals below by one reducer — the same shape the reverted bridge used.
//
// This store is the simple surface's only state. The pro shell (palette, model
// picker, density, capability panel, goal bar, terminal, catalogs) is gone; the
// remaining members are the task/run flow, the safety record and the daemon
// mirror that reducer keeps.
import { batch, createSignal, onCleanup, type Accessor } from "solid-js";

import type { Row, RowTone } from "./rows.ts";
import { persistLocalOnly, readLocalOnly, type PrivacyState } from "./simple/privacy.ts";
import {
  initialProgress,
  onAssistantText,
  onTool,
  progressView,
  type Progress,
  type RunProgressView,
} from "./simple/progress.ts";
import {
  OVERWRITE_CONSENT,
  buildResult,
  diffSnapshots,
  dryRunInstruction,
  emptyImpact,
  fallbackPlan,
  impactOf,
  newRunId,
  normalizeEntries,
  runIsOnline,
  type SnapshotDiff,
  type SnapshotEntry,
  type TaskRun,
  type TaskRunUndo,
} from "./simple/run.ts";
import {
  dueSchedules,
  newScheduleId,
  readSchedules,
  writeSchedules,
  type Schedule,
} from "./simple/schedule.ts";
import {
  eventName,
  eventPayload,
  formatTokens,
  readTurnEnd,
  textOf,
  toolResultText,
  type EventMsg,
  type PendingApproval,
  type PermissionMode,
  type ReviewDecision,
  type SessionInfo,
  type TurnEndStatus,
} from "./protocol.ts";
import {
  BridgeUnavailable,
  errorText,
  invoke,
  isBridgeAvailable,
  onCanteEvent,
  onCanteExit,
  onCanteState,
  type BridgeState,
  type DaemonStatus,
  type ToolDecision,
  type UnlistenFn,
} from "./tauri.ts";

/**
 * The bridge's reachability. The pro transcript view is gone; this type stays
 * only because `components/Transcript.tsx` still imports it.
 */
export type Connection = "connecting" | "online" | "offline";

export type { PrivacyState } from "./simple/privacy.ts";
// ---------------------------------------------------------------------------
// #41–#43 — one job a simple-mode user handed over, and how to undo it.
// The shape is frozen; `gui/src/simple/tasks/index.ts` mirrors it.
// ---------------------------------------------------------------------------

/** The only session override the simple flow uses: open cante in `Auto`. */
export interface SessionOverrides {
  permission_mode?: PermissionMode;
}

export interface Store {
  daemonStatus: Accessor<DaemonStatus>;
  session: Accessor<SessionInfo | null>;
  approval: Accessor<PendingApproval | null>;
  /**
   * The row stream. The pro transcript view is gone, but two consumers keep
   * this alive: `simple/evidence.ts` reads the last assistant row for the
   * #63「需要你核对」paragraph and the r7 question-ending check. Nothing else
   * reads rows, so the reducer stays only because those two promises do.
   */
  rows: Accessor<Row[]>;
  steps: Accessor<number>;
  /** #62 — the plan as a live checklist while a job runs, plus its clock. */
  progress: Accessor<RunProgressView>;
  notice: Accessor<string | null>;
  connect(): void;
  startSession(overrides?: SessionOverrides): Promise<void>;
  interrupt(): Promise<void>;
  respond(decisions: ReviewDecision[], message?: string): Promise<void>;
  // ---- privacy (r5-privacy) -----------------------------------------------
  /** What may leave this computer, and who receives it. */
  privacy: Accessor<PrivacyState>;
  /** The "只在本机处理" switch; remembered between launches. */
  setLocalOnly(value: boolean): Promise<void>;
  // ---- files and trust (r5-trust) -----------------------------------------
  /** Native file picker; returns the chosen absolute paths (empty on cancel). */
  pickFiles(opts?: { multiple?: boolean; extensions?: string[] }): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  /** Open a result with the system's default program. */
  openPath(path: string): Promise<void>;
  /** Show a result inside its folder. */
  revealPath(path: string): Promise<void>;
  /** The run waiting on the confirmation sheet (or the finished one on screen). */
  currentRun: Accessor<TaskRun | null>;
  /** Finished runs, newest first, restored from disk on launch. */
  runs: Accessor<TaskRun[]>;
  /** Stage a run and open the confirmation sheet. Nothing runs until `confirmRun`. */
  startRun(
    task: { id: string; title: string; plan: string[] },
    files: string[],
    instruction: string,
  ): Promise<void>;
  /** The user pressed 开始. `allowOverwrite` only after the red checkbox. */
  confirmRun(allowOverwrite?: boolean): Promise<void>;
  /** #42 "先试跑给我看": ask the assistant to explain, never to touch files. */
  dryRun(): Promise<void>;
  cancelRun(): void;
  /** Hide the finished/failed card and go back to the task list. */
  dismissRun(): void;
  /**
   * r7 — answer the question a finished run stopped on, continuing the same job.
   * Only does anything when the run has stopped (done / failed / cancelled).
   */
  replyToRun(text: string): Promise<void>;
  /** #43 — put a run back without the assistant's help. */
  undoRun(id: string): Promise<void>;
  /** Re-read the on-disk run log (also runs at launch). */
  refreshRuns(): Promise<void>;
  // ---- 定时/重复任务 (#55) -------------------------------------------------
  /** 她定下的自动任务，按定下的先后排列。 */
  schedules: Accessor<Schedule[]>;
  /** 记下一个"以后到点自动做"的活；默认就是开启的。 */
  addSchedule(input: Omit<Schedule, "id" | "createdAt" | "enabled" | "lastRunAt">): Schedule;
  /** 彻底不要了。 */
  removeSchedule(id: string): void;
  /** 暂时停掉（false）或重新打开（true），记录留着。 */
  setScheduleEnabled(id: string, enabled: boolean): void;
  /**
   * 到点了：用调度里存的那份交代去走**和手动一样的确认流程**。
   * 只有真的把它排上队才记 `lastRunAt`；当前有活在跑就什么都不做。
   */
  runScheduled(id: string): Promise<void>;
}

/**
 * The frozen bridge gained the file/trust ops (`pick_files`, `pick_folder`,
 * `open_path`, `reveal_path`, `begin_run`, `snapshot_paths`, `run_log`,
 * `save_run`, `undo_run`) after `tauri.ts` was last generated. Keep `invoke`'s
 * typed map for the original commands and widen only for those ops, so a rename
 * in the map still fails `tsc` while these forward to the snake_case wire names.
 */
type OpInvoke = (name: string, args?: Record<string, unknown>) => Promise<unknown>;
const invokeOp = invoke as unknown as OpInvoke;

const MAX_ROWS = 400;
const MAX_ROW_TEXT = 8_000;
const MAX_TOOL_DETAIL = 4_000;
/** Run-log cap in the UI; Rust keeps its own, larger cap on disk. */
const MAX_HISTORY_RUNS = 200;
const MAX_SEEN = 8_192;
const RECONCILE_MS = 2_000;
const PING_MS = 4_000;
/** #55 — 应用运行期间每分钟看一眼有没有到点的自动任务。 */
const SCHEDULE_TICK_MS = 60_000;

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

/** A finite number from the wire, or `fallback` for anything hostile. */
function safeCount(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

/** `JSON.stringify` that never throws on a hostile/circular tool argument. */
function stringifyArgs(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? "";
  } catch {
    return "";
  }
}

/**
 * A `PendingApproval` the UI can actually answer.
 *
 * The wire is trusted for shape but not for content: drop entries without a
 * usable `tool_use_id`, drop the whole approval when there is nothing to decide
 * (an `approve` with an empty `responses` batch is meaningless) and when the
 * turn id is missing (the response could never be correlated).
 */
function normalizeApproval(value: unknown): PendingApproval | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const turnId = typeof record.turn_id === "string" ? record.turn_id : "";
  if (!turnId) return null;
  const tools: PendingApproval["tools"] = [];
  for (const entry of Array.isArray(record.tools) ? record.tools : []) {
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as Record<string, unknown>;
    const id = typeof tool.id === "string" ? tool.id : tool.id == null ? "" : String(tool.id);
    if (!id) continue;
    tools.push({
      id,
      name: typeof tool.name === "string" ? tool.name : String(tool.name ?? "tool"),
      args: tool.args,
    });
  }
  if (tools.length === 0) return null;
  return {
    turn_id: turnId,
    message: typeof record.message === "string" ? record.message : "",
    tools,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function nowLabel(): string {
  const date = new Date();
  // Hosts without an RTC hand back the epoch; don't print 1970 at users.
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 2000) return "--:--";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function eventTime(message: EventMsg): string {
  if (message.timestamp) {
    const date = new Date(message.timestamp);
    if (Number.isFinite(date.getTime()) && date.getFullYear() >= 2000) {
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
  }
  return nowLabel();
}

function toneForStatus(status: string): RowTone {
  switch (status) {
    case "Completed":
      return "ok";
    case "Denied":
      return "warn";
    case "Failed":
      return "error";
    default:
      return "muted";
  }
}

export function providerLabel(session: SessionInfo | null): string {
  if (!session) return "—";
  return session.provider?.display_name || session.provider?.id || "—";
}

function describe(error: unknown): string {
  if (error instanceof BridgeUnavailable) {
    return "desktop bridge unavailable — open the Cante desktop app";
  }
  return errorText(error);
}

export function createStore(): Store {
  const [daemonStatus, setDaemonStatus] = createSignal<DaemonStatus>("offline");
  const [session, setSession] = createSignal<SessionInfo | null>(null);
  const [approval, setApproval] = createSignal<PendingApproval | null>(null);
  const [rows, setRows] = createSignal<Row[]>([]);
  const [steps, setSteps] = createSignal(0);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [localOnly, setLocalOnlySignal] = createSignal<boolean>(readLocalOnly());
  const [currentRun, setCurrentRun] = createSignal<TaskRun | null>(null);
  const [runs, setRuns] = createSignal<TaskRun[]>([]);
  // #55 — 她定下的自动任务。启动时从本地读回来，坏数据当空。
  const [schedules, setSchedules] = createSignal<Schedule[]>(readSchedules());

  // ---- #62 running progress -----------------------------------------------
  // The started-at clock is a signal so entering `running` redraws at once;
  // the cursor and the frozen elapsed time are plain values that move with the
  // event stream, and `progressTick` is what makes the elapsed seconds tick.
  const [progressStartedAt, setProgressStartedAt] = createSignal<number | null>(null);
  const [progressTick, setProgressTick] = createSignal(0);
  let runProgress: Progress = initialProgress();
  let runElapsedMs = 0;

  // Snapshot taken when a run starts, so the end-of-run diff and the persisted
  // undo metadata do not depend on the assistant cooperating.
  let pendingSnapshot: { before: SnapshotEntry[]; roots: string[]; unbacked: string[] } | null = null;
  let runFinishing = false;

  let rowSeq = 0;
  let lastUserText = "";
  const toolRows = new Map<string, string>();

  // ---- bridge lifecycle ---------------------------------------------------

  let started = false;
  let disposed = false;
  let hydrated = false;
  let cursor = 0;
  let buffered: EventMsg[] = [];
  let unlisteners: UnlistenFn[] = [];
  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let scheduleTimer: ReturnType<typeof setInterval> | undefined;
  let autoStarted = false;
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  onCleanup(() => {
    disposed = true;
    for (const off of unlisteners) off();
    if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    if (scheduleTimer !== undefined) clearInterval(scheduleTimer);
  });

  function remember(id: string | undefined): boolean {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > MAX_SEEN) {
      const drop = seenOrder.splice(0, seenOrder.length - MAX_SEEN);
      for (const old of drop) seen.delete(old);
    }
    return true;
  }

  function connect(): void {
    if (started || disposed) return;
    started = true;
    scheduleTimer = setInterval(checkDueSchedules, SCHEDULE_TICK_MS);
    // 开机先看一眼：关机时错过的那个，现在就摆到确认页等着她。
    checkDueSchedules();
    void setup();
  }

  async function setup(): Promise<void> {
    // Subscribe before hydrating so nothing emitted in between is lost; the
    // buffer is flushed in order once the ring replay has landed.
    unlisteners = await Promise.all([
      onCanteEvent(handleEvent),
      onCanteState(handleState),
      onCanteExit(handleExit),
    ]);
    if (disposed) {
      for (const off of unlisteners) off();
      return;
    }
    await hydrate();
    if (disposed) return;
    void refreshRuns();
    reconcileTimer = setInterval(() => void reconcile(), RECONCILE_MS);
    void ping();
  }

  async function hydrate(): Promise<void> {
    try {
      const response = await invoke("events_since", { cursor: 0 });
      if (disposed) return;
      batch(() => {
        if (response.truncated) {
          pushInfo("history buffer truncated — earlier events were dropped", "warn");
        }
        for (const message of response.events) applyEvent(message);
        applyState(response.state);
        cursor = response.cursor;
      });
    } catch (error) {
      // The reconcile loop and the health probe keep retrying; the banner tells
      // the user why the shell is empty.
      if (!disposed) setNotice(`events: ${describe(error)}`);
    } finally {
      hydrated = true;
      const pending = buffered;
      buffered = [];
      if (!disposed && pending.length > 0) {
        batch(() => {
          for (const message of pending) applyEvent(message);
        });
      }
    }
  }

  async function reconcile(): Promise<void> {
    if (disposed) return;
    // The existing reconcile beat doubles as the running screen's clock, so the
    // elapsed time moves without a second timer (and never on a worker thread).
    if (currentRun()?.state === "running") tickProgress();
    try {
      const response = await invoke("events_since", { cursor });
      if (disposed) return;
      batch(() => {
        for (const message of response.events) applyEvent(message);
        applyState(response.state);
        cursor = response.cursor;
      });
    } catch (error) {
      if (!disposed) setNotice(`events: ${describe(error)}`);
    }
  }

  async function ping(): Promise<void> {
    if (disposed) return;
    try {
      const health = await invoke("health");
      if (disposed) return;
      batch(() => {
        if (health.status) setDaemonStatus(health.status);
      });
      // A reachable host with no session yet: open one.
      //
      // `Auto` on purpose (#60): cante then runs everything except what it can
      // prove is dangerous, so a non-technical user is not interrupted with a
      // permission question per tool call. Her gate is the confirmation sheet
      // before the run, in her own words — and if cante still stops, the
      // approval sheet asks in plain Chinese instead of hanging.
      if (!autoStarted && session() === null) {
        autoStarted = true;
        void startSession({ permission_mode: "Auto" });
      }
    } catch {
      if (disposed) return;
      if (!isBridgeAvailable()) {
        setNotice("desktop bridge unavailable — open the Cante desktop app");
      }
    }
    if (!disposed) pingTimer = setTimeout(() => void ping(), PING_MS);
  }

  function handleEvent(message: EventMsg): void {
    if (disposed) return;
    if (!message || typeof message !== "object") return;
    if (!hydrated) {
      buffered.push(message);
      return;
    }
    applyEvent(message);
  }

  function handleState(state: BridgeState): void {
    if (disposed || !state) return;
    batch(() => applyState(state));
  }

  function handleExit(payload: { code: number | null }): void {
    if (disposed) return;
    batch(() => {
      setDaemonStatus("offline");
      setApproval(null);
      setNotice(`cante daemon exited (${payload?.code ?? "signal"})`);
    });
    if (currentRun()?.state === "running") {
      void finishRun("failed", "运行中的程序退出了。");
    }
  }

  // ---- reducer ------------------------------------------------------------

  function pushRow(row: Row): Row[] {
    const next = [...rows(), row];
    if (next.length > MAX_ROWS) next.splice(0, next.length - MAX_ROWS);
    return next;
  }

  function pushInfo(text: string, tone: RowTone = "muted", label = "info"): void {
    setRows(pushRow({
      id: `i${++rowSeq}`,
      kind: "info",
      label,
      text: clampText(text, MAX_ROW_TEXT),
      detail: "",
      tone,
      streaming: false,
      time: nowLabel(),
    }));
  }

  function applyState(state: Partial<BridgeState> | null | undefined): void {
    if (!state) return;
    if (state.status) setDaemonStatus(state.status);
    if (state.session !== undefined) setSession(state.session ?? null);
    if (state.pending_approval !== undefined) setApproval(normalizeApproval(state.pending_approval));
  }

  function transition(name: string, event: unknown): void {
    switch (name) {
      case "SessionStart":
      case "SessionUpdated": {
        setDaemonStatus("idle");
        setApproval(null);
        const info = eventPayload<SessionInfo>(event, name);
        if (info) setSession(info);
        return;
      }
      case "TurnStart":
        setDaemonStatus("thinking");
        return;
      case "Thinking":
      case "ThinkingDelta":
        if (daemonStatus() !== "awaiting") setDaemonStatus("thinking");
        return;
      case "AgentMessage":
      case "MessageDelta":
      case "ToolStart":
      case "ToolUpdate":
      case "ToolEnd":
        if (daemonStatus() !== "awaiting") setDaemonStatus("streaming");
        return;
      case "TurnResume":
        setDaemonStatus("streaming");
        setApproval(null);
        return;
      case "TurnEnd":
        if (daemonStatus() !== "error") setDaemonStatus("idle");
        return;
      case "Error":
        setDaemonStatus("error");
        return;
      case "SessionEnd":
      case "Goodbye":
        setDaemonStatus("offline");
        setSession(null);
        setApproval(null);
        return;
      default:
    }
  }

  function applyEvent(message: EventMsg, dedupe = true): void {
    if (!message || typeof message !== "object") return;
    if (dedupe && !remember(message.id)) return;
    const event = message.event;
    const name = eventName(event);
    const at = eventTime(message);
    transition(name, event);

    switch (name) {
      case "UserInput": {
        const text = textOf(event, "UserInput");
        if (text && text !== lastUserText) {
          setRows(pushRow({ id: `u${++rowSeq}`, kind: "user", label: "you", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "accent", streaming: false, time: at }));
        }
        lastUserText = "";
        return;
      }
      case "MessageDelta":
      case "AgentMessage": {
        const delta = name === "MessageDelta";
        const text = textOf(event, name);
        // #62 — only the finished message is folded in: a plan that arrives in
        // streaming pieces would otherwise look like a sequence of steps.
        if (!delta && text) noteAssistantProgress(text);
        const list = rows();
        const last = list[list.length - 1];
        if (last && last.kind === "agent" && last.streaming && delta) {
          setRows([...list.slice(0, -1), { ...last, text: clampText(last.text + text, MAX_ROW_TEXT) }]);
          return;
        }
        if (!delta && last && last.kind === "agent" && last.streaming) {
          setRows([...list.slice(0, -1), { ...last, text: clampText(text, MAX_ROW_TEXT), streaming: false, tone: "neutral" }]);
          return;
        }
        if (!text) return;
        setRows(pushRow({ id: `a${++rowSeq}`, kind: "agent", label: "cante", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "neutral", streaming: delta, time: at }));
        return;
      }
      case "Thinking":
      case "ThinkingDelta": {
        const delta = name === "ThinkingDelta";
        const text = textOf(event, name);
        const list = rows();
        const last = list[list.length - 1];
        if (last && last.kind === "thinking" && last.streaming && delta) {
          setRows([...list.slice(0, -1), { ...last, text: clampText(last.text + text, MAX_ROW_TEXT) }]);
          return;
        }
        if (!text) return;
        setRows(pushRow({ id: `t${++rowSeq}`, kind: "thinking", label: "thinking", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "muted", streaming: delta, time: at }));
        return;
      }
      case "ToolStart": {
        const tool = eventPayload<{ id?: string; name?: string; args?: unknown }>(event, "ToolStart");
        const id = String(tool?.id ?? `tool_${rowSeq}`);
        noteToolProgress(String(tool?.name ?? ""));
        const rowId = `k${++rowSeq}`;
        toolRows.set(id, rowId);
        setRows(pushRow({
          id: rowId,
          kind: "tool",
          label: clampText(String(tool?.name ?? "tool"), MAX_ROW_TEXT),
          text: clampText(stringifyArgs(tool?.args), MAX_ROW_TEXT),
          detail: "",
          tone: "accent",
          streaming: true,
          time: at,
        }));
        return;
      }
      case "ToolUpdate": {
        const update = eventPayload<{ tool_use_id?: string; message?: string }>(event, "ToolUpdate");
        const rowId = toolRows.get(String(update?.tool_use_id ?? ""));
        if (!rowId) return;
        setRows(rows().map((row) =>
          row.id === rowId
            ? { ...row, detail: clampText(`${row.detail}\n${String(update?.message ?? "")}`.trim(), MAX_TOOL_DETAIL) }
            : row,
        ));
        return;
      }
      case "ToolEnd": {
        const end = eventPayload<{ tool_use_id?: string; status?: string; result_json?: unknown }>(event, "ToolEnd");
        const rowId = toolRows.get(String(end?.tool_use_id ?? ""));
        if (!rowId) return;
        const result = toolResultText(end?.result_json);
        setRows(rows().map((row) =>
          row.id === rowId
            ? {
                ...row,
                streaming: false,
                tone: toneForStatus(String(end?.status ?? "Completed")),
                detail: clampText([row.detail, result].filter(Boolean).join("\n"), MAX_TOOL_DETAIL),
              }
            : row,
        ));
        return;
      }
      case "Info":
      case "InfoBlockStart":
      case "InfoBlockAppend": {
        const payload = eventPayload<{ header?: string; detail?: string }>(event, name);
        const text =
          name === "Info"
            ? textOf(event, "Info")
            : String(payload?.header ?? payload?.detail ?? "");
        if (!text) return;
        setRows(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "info", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "muted", streaming: false, time: at }));
        return;
      }
      case "CompactStart":
        setRows(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "compact", text: "compacting conversation history…", detail: "", tone: "muted", streaming: false, time: at }));
        return;
      case "CompactEnd": {
        const summary = eventPayload<{ summary?: string | null }>(event, "CompactEnd")?.summary ?? null;
        setRows(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "compact", text: summary ? "history compacted" : "compaction failed; history unchanged", detail: summary ? clampText(summary, 240) : "", tone: "muted", streaming: false, time: at }));
        return;
      }
      case "ContextReport": {
        const report = eventPayload<Record<string, number>>(event, "ContextReport");
        if (!report) return;
        const parts = [
          `system ${formatTokens(Number(report.system_prompt_tokens ?? 0))}`,
          `tools ${formatTokens(Number(report.system_tools_tokens ?? 0))}`,
          `mcp ${formatTokens(Number(report.mcp_tools_tokens ?? 0))}`,
          `memory ${formatTokens(Number(report.memory_tokens ?? 0))}`,
          `skills ${formatTokens(Number(report.skills_tokens ?? 0))}`,
          `messages ${formatTokens(Number(report.messages_tokens ?? 0))}`,
        ];
        setRows(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "context", text: `window ${formatTokens(Number(report.used_tokens ?? 0))} of ${formatTokens(Number(report.limit_tokens ?? 0))}`, detail: parts.join(" · "), tone: "muted", streaming: false, time: at }));
        return;
      }
      case "TurnPause": {
        const payload = eventPayload<{ turn_id?: unknown; reason?: { Approval?: unknown } }>(event, "TurnPause");
        const gate = payload?.reason?.Approval;
        if (!gate) return;
        const gateRecord = typeof gate === "object" ? (gate as Record<string, unknown>) : {};
        const pending = normalizeApproval({
          turn_id: payload?.turn_id,
          message: gateRecord.message,
          tools: gateRecord.tools,
        });
        if (!pending) return;
        setDaemonStatus("awaiting");
        setApproval(pending);
        return;
      }
      case "Error": {
        const text = textOf(event, "Error");
        const message = clampText(text || "unknown error", MAX_ROW_TEXT);
        setRows(pushRow({ id: `e${++rowSeq}`, kind: "error", label: "error", text: message, detail: "", tone: "error", streaming: false, time: at }));
        setNotice(message);
        if (currentRun()?.state === "running") void finishRun("failed", message);
        return;
      }
      case "TurnEnd": {
        const payload = eventPayload<{ status?: TurnEndStatus; steps?: unknown }>(event, "TurnEnd");
        const reason = readTurnEnd(payload?.status);
        const stepCount = safeCount(payload?.steps, steps());
        setSteps(stepCount);
        lastUserText = "";
        if (reason.kind === "ok") {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "done", text: clampText(`turn complete · ${stepCount} step(s)`, MAX_ROW_TEXT), detail: "", tone: "ok", streaming: false, time: at }));
        } else if (reason.kind === "interrupted") {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "stopped", text: clampText(reason.reason, MAX_ROW_TEXT), detail: "", tone: "warn", streaming: false, time: at }));
        } else {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "failed", text: clampText(reason.headline, MAX_ROW_TEXT), detail: clampText(reason.details.join(" · "), MAX_TOOL_DETAIL), tone: "error", streaming: false, time: at }));
          setNotice(reason.headline);
        }
        // #41/#43 — close out a simple-mode run with its own before/after diff.
        if (currentRun()?.state === "running") {
          if (reason.kind === "ok") void finishRun("done");
          else if (reason.kind === "interrupted") void finishRun("cancelled");
          else void finishRun("failed", reason.headline);
        }
        return;
      }
      case "SessionEnd":
        setNotice("session ended");
        return;
      case "Goodbye":
        setDaemonStatus("offline");
        setSession(null);
        return;
      default:
        return;
    }
  }

  // ---- actions ------------------------------------------------------------

  async function attempt(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      setNotice(null);
      return true;
    } catch (error) {
      setNotice(describe(error));
      return false;
    }
  }

  async function startSession(overrides: SessionOverrides = {}): Promise<void> {
    lastUserText = "";
    const ok = await attempt(() => invoke("start_session", { ...overrides }));
    if (ok) setNotice("starting session…");
  }

  async function interrupt(): Promise<void> {
    await attempt(() => invoke("interrupt"));
  }

  async function respond(decisions: ReviewDecision[], message?: string): Promise<void> {
    const pending = approval();
    if (!pending) return;
    const responses: ToolDecision[] = [];
    pending.tools.forEach((tool, index) => {
      if (!tool || typeof tool.id !== "string" || !tool.id) return;
      responses.push({
        tool_use_id: tool.id,
        decision: decisions[index] ?? decisions[0] ?? "Deny",
        ...(message ? { message } : {}),
      });
    });
    // An empty batch has nothing for the daemon to answer and would leave the
    // turn wedged; if sanitation emptied the list there is nothing to send.
    if (responses.length === 0) return;
    const ok = await attempt(() => invoke("approve", { turn_id: pending.turn_id, responses }));
    if (ok) setApproval(null);
  }

  // ---- #62 — what the running screen shows --------------------------------
  //
  // The store owns the clock and the cursor; `progress.ts` owns the logic. The
  // accessor is a plain function (not a memo) like the others here: `bun test`
  // resolves Solid's server build, where a memo is computed once and never
  // re-runs.

  function tickProgress(): void {
    setProgressTick((value) => value + 1);
  }

  /** A run entered `running`: start the clock on the first step. */
  function markProgressRunning(): void {
    runProgress = initialProgress();
    runElapsedMs = 0;
    setProgressStartedAt(Date.now());
    tickProgress();
  }

  /** A run left `running`: freeze the elapsed time so it cannot keep counting. */
  function markProgressFinished(): void {
    const startedAt = progressStartedAt();
    if (startedAt !== null) runElapsedMs = Math.max(0, Date.now() - startedAt);
    tickProgress();
  }

  /** A run was staged or thrown away: back to nothing. */
  function resetProgress(): void {
    runProgress = initialProgress();
    runElapsedMs = 0;
    setProgressStartedAt(null);
    tickProgress();
  }

  function noteToolProgress(name: string): void {
    const run = currentRun();
    if (!run || run.state !== "running") return;
    const next = onTool(runProgress, name, run.plan.length);
    if (next.index !== runProgress.index) {
      runProgress = next;
      tickProgress();
    }
  }

  function noteAssistantProgress(text: string): void {
    const run = currentRun();
    if (!run || run.state !== "running" || !text) return;
    const next = onAssistantText(runProgress, text, run.plan.length);
    if (next.index !== runProgress.index) {
      runProgress = next;
      tickProgress();
    }
  }

  function progress(): RunProgressView {
    // Reading the tick keeps the elapsed time moving on screen.
    progressTick();
    const run = currentRun();
    const state = run?.state;
    const running = state === "running";
    const finished =
      run !== null && state !== "running" && state !== "preview" && state !== "draft";
    return progressView({
      plan: run?.plan ?? [],
      cursor: runProgress,
      running,
      finished,
      startedAt: progressStartedAt(),
      now: Date.now(),
      elapsedMs: runElapsedMs,
    });
  }

  // ---- privacy ------------------------------------------------------------
  // One boolean answers both questions the panel asks: may content leave this
  // machine, and may the assistant search the web. `online` mirrors it, so the
  // privacy panel, the run record and the result card all read one value.
  function privacy(): PrivacyState {
    const local = localOnly();
    const provider = providerLabel(session());
    return {
      online: !local,
      provider: local || provider === "—" ? null : provider,
      localOnly: local,
    };
  }

  async function setLocalOnly(value: boolean): Promise<void> {
    setLocalOnlySignal(value);
    persistLocalOnly(value);
    setNotice(
      value
        ? "已打开「只在本机处理」：内容不会离开这台电脑，联网搜索也已关闭。"
        : "已关闭「只在本机处理」：整理内容时会联网，内容会发给帮你整理的服务方。",
    );
  }

  // ---- files and trust (#41–#43) ------------------------------------------

  /** Chinese detail for a bridge/file failure; never leaks the English banner. */
  function trustDetail(error: unknown): string {
    if (error instanceof BridgeUnavailable) return "这个功能要在 Cante 桌面版里使用。";
    return errorText(error);
  }

  function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  function normalizeRuns(value: unknown): TaskRun[] {
    if (!Array.isArray(value)) return [];
    const records: TaskRun[] = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (typeof record.id !== "string" || !record.id) continue;
      records.push(raw as unknown as TaskRun);
    }
    return records.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  async function pickFiles(opts: { multiple?: boolean; extensions?: string[] } = {}): Promise<string[]> {
    try {
      const response = (await invokeOp("pick_files", {
        multiple: opts.multiple ?? false,
        extensions: opts.extensions ?? [],
      })) as { paths?: unknown };
      return stringList(response?.paths);
    } catch (error) {
      setNotice(`打不开选择文件的窗口。${trustDetail(error)}`);
      return [];
    }
  }

  async function pickFolder(): Promise<string | null> {
    try {
      const response = (await invokeOp("pick_folder", {})) as { path?: unknown };
      return typeof response?.path === "string" && response.path ? response.path : null;
    } catch (error) {
      setNotice(`打不开选择文件夹的窗口。${trustDetail(error)}`);
      return null;
    }
  }

  async function openPath(path: string): Promise<void> {
    if (!path) return;
    try {
      await invokeOp("open_path", { path });
      setNotice(null);
    } catch (error) {
      setNotice(`打不开这个文件。你可以自己找到它再双击打开。${trustDetail(error)}`);
    }
  }

  async function revealPath(path: string): Promise<void> {
    if (!path) return;
    try {
      await invokeOp("reveal_path", { path });
      setNotice(null);
    } catch (error) {
      setNotice(`打不开它所在的文件夹。${trustDetail(error)}`);
    }
  }

  /** Snapshot the run's folders and copy the files at risk, before anything runs. */
  async function beginSnapshot(run: TaskRun): Promise<void> {
    pendingSnapshot = null;
    if (run.files.length === 0) {
      pendingSnapshot = { before: [], roots: [], unbacked: [] };
      return;
    }
    try {
      const response = (await invokeOp("begin_run", { id: run.id, paths: run.files })) as {
        entries?: unknown;
        roots?: unknown;
        unbacked?: unknown;
      };
      pendingSnapshot = {
        before: normalizeEntries(response?.entries),
        roots: stringList(response?.roots),
        unbacked: stringList(response?.unbacked),
      };
    } catch {
      // No bridge (browser preview): run anyway, with an empty before-state.
      pendingSnapshot = { before: [], roots: [], unbacked: [] };
    }
  }

  async function sendRunInstruction(text: string): Promise<void> {
    // A run can start before the host has finished opening its session (the
    // health probe and the first task run on different clocks). Open one with
    // the same `Auto` policy rather than sending a prompt the daemon rejects.
    if (session() === null) await startSession({ permission_mode: "Auto" });
    try {
      await invoke("send_input", { text, mode: "prompt" });
    } catch (error) {
      await finishRun("failed", trustDetail(error));
    }
  }

  function runError(detail: string | undefined, run: TaskRun): TaskRun["error"] {
    return {
      what: run.dryRun ? "这次试跑没能做完。" : "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: detail && detail.length > 0 ? detail : "没有更多说明。",
    };
  }

  async function persistRun(
    run: TaskRun,
    diff: SnapshotDiff,
    snapshot: { roots: string[]; unbacked: string[] } | null,
  ): Promise<void> {
    const undo: TaskRunUndo = {
      roots: snapshot?.roots ?? [],
      created: diff.created,
      modified: diff.modified,
      deleted: diff.deleted,
      unbacked: snapshot?.unbacked ?? [],
    };
    // Show it in history immediately, even if the disk write fails.
    setRuns((list) => [run, ...list.filter((item) => item.id !== run.id)].slice(0, MAX_HISTORY_RUNS));
    try {
      await invokeOp("save_run", { run: { ...run, undo } });
    } catch {
      // The record stays in memory for this launch; it just will not reload.
    }
  }

  async function refreshRuns(): Promise<void> {
    try {
      const response = (await invokeOp("run_log")) as { runs?: unknown };
      setRuns(normalizeRuns(response?.runs));
    } catch {
      // Bridge unavailable: keep whatever is already in memory.
    }
  }

  async function startRun(
    task: { id: string; title: string; plan: string[] },
    files: string[],
    instruction: string,
  ): Promise<void> {
    pendingSnapshot = null;
    setCurrentRun({
      id: newRunId(),
      taskId: task.id,
      taskTitle: task.title,
      files: [...files],
      instruction,
      state: "preview",
      plan: task.plan.length > 0 ? [...task.plan] : fallbackPlan(files),
      impact: emptyImpact(),
      result: null,
      online: runIsOnline(true),
      error: null,
      createdAt: Date.now(),
    });
    resetProgress();
  }

  async function confirmRun(allowOverwrite = false): Promise<void> {
    const run = currentRun();
    if (!run || run.state !== "preview") return;
    const next: TaskRun = { ...run, state: "running", ...(allowOverwrite ? { overwrite: true } : {}) };
    setCurrentRun(next);
    markProgressRunning();
    await beginSnapshot(next);
    await sendRunInstruction(allowOverwrite ? run.instruction + OVERWRITE_CONSENT : run.instruction);
  }

  async function dryRun(): Promise<void> {
    const run = currentRun();
    if (!run || run.state !== "preview") return;
    const next: TaskRun = { ...run, state: "running", dryRun: true };
    setCurrentRun(next);
    markProgressRunning();
    await beginSnapshot(next);
    await sendRunInstruction(dryRunInstruction(run.instruction));
  }

  function cancelRun(): void {
    const run = currentRun();
    if (!run) return;
    if (run.state === "running") {
      void attempt(() => invoke("interrupt"));
      void finishRun("cancelled");
      return;
    }
    pendingSnapshot = null;
    setCurrentRun(null);
    resetProgress();
  }

  function dismissRun(): void {
    pendingSnapshot = null;
    setCurrentRun(null);
    resetProgress();
  }

  /**
   * r7 — reply to the question a stopped run ended on.
   *
   * The task prompts deliberately tell the assistant to stop and ask when it is
   * unsure (列名不一致就先问我一句 — the #63 promise), so a run can end asking
   * instead of handing over a result. The answer box on the result card calls
   * this: the *same* run goes back to `running`, the previous error/result are
   * cleared, and the progress cursor is kept — the cursor only ever moves
   * forward, and answering a question continues the job rather than restarting
   * it.
   *
   * A fresh snapshot is taken before the reply goes out. Without it the
   * continuation's diff would compare against an empty before-state and report
   * the user's existing files as if this turn had created them; the undo record
   * built from that diff would then be able to touch her originals. Snapshotting
   * first keeps both the result and the one-click undo honest for this turn.
   */
  async function replyToRun(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const run = currentRun();
    if (!run) return;
    if (run.state !== "done" && run.state !== "failed" && run.state !== "cancelled") return;
    const next: TaskRun = { ...run, state: "running", error: null, result: null };
    setCurrentRun(next);
    await beginSnapshot(next);
    await sendRunInstruction(trimmed);
  }

  /**
   * End of a run. The metadata-only before/after diff is taken here, not from
   * the assistant's own report, so the numbers can be trusted even when the
   * assistant is confused.
   */
  async function finishRun(state: "done" | "failed" | "cancelled", detail?: string): Promise<void> {
    const run = currentRun();
    if (!run || run.state !== "running" || runFinishing) return;
    runFinishing = true;
    try {
      const snapshot = pendingSnapshot;
      let after: SnapshotEntry[] = [];
      if (run.files.length > 0) {
        try {
          const response = (await invokeOp("snapshot_paths", { paths: run.files })) as { entries?: unknown };
          after = normalizeEntries(response?.entries);
        } catch {
          after = [];
        }
      }
      const before = snapshot?.before ?? [];
      const diff = diffSnapshots(before, after);
      const result = buildResult(before, after, diff, { dryRun: run.dryRun });
      const touched = diff.created.length + diff.modified.length + diff.deleted.length;
      const failed = state === "failed";
      const next: TaskRun = {
        ...run,
        state,
        impact: impactOf(diff),
        result: failed && touched === 0 ? null : result,
        error: failed ? runError(detail, run) : null,
      };
      setCurrentRun(next);
      markProgressFinished();
      await persistRun(next, diff, snapshot);
      await refreshRuns();
    } finally {
      runFinishing = false;
      // Normally the run is over and the snapshot is done with. But a reply can
      // land while this close-out is still polishing the record; the answer
      // path has already taken its own fresh snapshot for the continuation, and
      // clearing it here would leave that turn diffing against an empty
      // before-state.
      if (currentRun()?.state !== "running") pendingSnapshot = null;
    }
  }

  async function undoRun(id: string): Promise<void> {
    try {
      const response = (await invokeOp("undo_run", { id })) as { restored?: unknown; failed?: unknown };
      const restored = stringList(response?.restored);
      const failed = stringList(response?.failed);
      if (failed.length === 0) {
        setNotice(`已经放回去了：${restored.length} 个文件恢复原样。`);
      } else {
        setNotice(
          `放回去了 ${restored.length} 个文件；还有 ${failed.length} 个没能自动还原，请按提示去文件夹里看看。`,
        );
      }
      await refreshRuns();
    } catch (error) {
      setNotice(`没能撤销。${trustDetail(error)}`);
    }
  }

  // ---- 定时/重复任务 (#55) ------------------------------------------------

  /** 已经有活在手上：等她确认，或者正在做。这时不再排新的。 */
  function activeRun(): boolean {
    const run = currentRun();
    return run !== null && (run.state === "preview" || run.state === "running");
  }

  function persistSchedules(list: Schedule[]): void {
    writeSchedules(list);
  }

  function addSchedule(
    input: Omit<Schedule, "id" | "createdAt" | "enabled" | "lastRunAt">,
  ): Schedule {
    const schedule: Schedule = {
      ...input,
      id: newScheduleId(),
      createdAt: Date.now(),
      enabled: true,
    };
    const next = [...schedules(), schedule];
    setSchedules(next);
    persistSchedules(next);
    return schedule;
  }

  function removeSchedule(id: string): void {
    const next = schedules().filter((schedule) => schedule.id !== id);
    setSchedules(next);
    persistSchedules(next);
  }

  function setScheduleEnabled(id: string, enabled: boolean): void {
    const next = schedules().map((schedule) =>
      schedule.id === id ? { ...schedule, enabled } : schedule,
    );
    setSchedules(next);
    persistSchedules(next);
  }

  function markScheduleRan(id: string, at: number): void {
    const next = schedules().map((schedule) =>
      schedule.id === id ? { ...schedule, lastRunAt: at } : schedule,
    );
    setSchedules(next);
    persistSchedules(next);
  }

  /**
   * 到点了。依然走手动那条路：`startRun` 只是把活摆到确认页，真正的动手要她
   * 点「开始」。所以微信任务也不会因为定时就自动发任何消息。
   */
  async function runScheduled(id: string): Promise<void> {
    const schedule = schedules().find((item) => item.id === id);
    if (!schedule || !schedule.enabled) return;
    // 同一时刻只跑一个：手上有活就推迟到下一分钟，不排队堆积。
    if (activeRun()) return;
    await startRun(
      { id: schedule.taskId, title: schedule.taskTitle, plan: schedule.plan },
      schedule.files,
      schedule.instruction,
    );
    // 真的摆上确认页了才记时间，避免同一个时间点反复触发。
    markScheduleRan(id, Date.now());
  }

  function checkDueSchedules(): void {
    if (disposed) return;
    if (activeRun()) return;
    const due = dueSchedules(schedules(), Date.now());
    if (due.length === 0) return;
    void runScheduled(due[0]!.id);
  }

  return {
    daemonStatus,
    session,
    approval,
    rows,
    steps,
    progress,
    notice,
    connect,
    startSession,
    interrupt,
    respond,
    privacy,
    setLocalOnly,
    pickFiles,
    pickFolder,
    openPath,
    revealPath,
    currentRun,
    runs,
    startRun,
    confirmRun,
    dryRun,
    cancelRun,
    dismissRun,
    replyToRun,
    undoRun,
    refreshRuns,
    schedules,
    addSchedule,
    removeSchedule,
    setScheduleEnabled,
    runScheduled,
  };
}

export type { TaskRun } from "./simple/run.ts";
