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
  type TaskError,
  type TaskRun,
  type TaskRunUndo,
} from "./simple/run.ts";
// 卡片提示词（`instructionFor`）：卡片里写好的步骤与安全规矩必须真的发出去，
// 见 `composedInstruction`。曾经因为漏了这条导入路径，卡片的规矩从未到达助手。
import { instructionFor } from "./simple/tasks/index.ts";
// r25 — 结构化提问：协议载荷 → 可渲染的题目 → `Op::QuestionResponse`。
import { readPendingQuestion, readQuestionSpecs } from "./simple/question.ts";
import {
  dueSchedules,
  newScheduleId,
  readSchedules,
  writeSchedules,
  type Schedule,
} from "./simple/schedule.ts";
// r13 — 队列的账（下一件是谁、还剩几件）在纯逻辑里，store 只负责存和推进。
import {
  appendJob,
  jobFor,
  makeJob as makeQueuedJob,
  nextWaiting,
  prependJob,
  sameJob,
  withJobState,
  withoutJob,
  type QueueInput,
  type QueuedJob,
  type QueuedState,
} from "./simple/queue.ts";
import {
  eventName,
  eventPayload,
  formatTokens,
  readTurnEnd,
  textOf,
  toolResultText,
  type EventMsg,
  type PendingApproval,
  type PendingQuestion,
  type PermissionMode,
  type QuestionReply,
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
   * r25 — 助手停下来问的那几件事（`TurnPause{reason:Question}`）。
   * 有它时，回答优先用按钮（`QuestionSheet`）；回答框是文本兜底。
   * `TurnResume` 与 `TurnEnd` 都会清掉它：被取消的回合可能不发 resume。
   */
  question: Accessor<PendingQuestion | null>;
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
  /**
   * r25 — 把界面上的回答翻成 `Op::QuestionResponse` 发出去。
   * `turn_id` / `tool_use_id` 从那条暂停里**原样带回**（协议要求：对不上的回复会被丢掉）。
   * 界面用 `simple/question.ts` 把按钮翻成 `reply`，store 只负责带上暂停的标识。
   */
  answerQuestion(reply: QuestionReply): Promise<void>;
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
  /**
   * r20 — 这次到底把我的什么内容发出去了。真正发出去的那段文字 = 卡片里写好的
   * 提示词 + 她的那一句话，由 `instructionFor` 在**本机**拼出来，完全可展示。
   * 暴露它只为隐私面板如实展示；不改发送行为，也不读任何本地文件内容。
   */
  composedInstruction(run: TaskRun): string;
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
  // ---- r13 队列（一次说好几件事，一件件来） -------------------------------
  /** 排好的活，按她说好的先后。放内存里就够：关掉程序重排一遍也只是一句话的事。 */
  queue: Accessor<QueuedJob[]>;
  /**
   * 把一件活排到队尾（卡片、文件、她那句话都齐了）。
   * 只是排上，**不会开始做**：轮到它时会先摆到确认页等她点头。
   * 同一件事已经在排队里就不再排第二遍，返回队里那一条。
   */
  enqueue(input: QueueInput): QueuedJob | null;
  /**
   * 把一件从队里拿掉。拿掉的如果正是停在确认页那件，就是**跳过**它：
   * 下一件会被摆到确认页（仍然要她点头才会动手）。
   */
  removeFromQueue(id: string): void;
  /** 停掉剩下的。正在做的这件不打断——那是任务页自己的「停」。 */
  clearQueue(): void;
  /**
   * 把排在头一件摆到确认页；手上已经有活时什么都不做，返回 null。
   * 队列只在"上一件做完了"或者她主动点进来时才往前走，绝不自己连跑到底。
   */
  startNextQueued(): QueuedJob | null;
  /**
   * 确认页上的「先做这件」：把手里这件插到最前面，其它往后排。
   * 它已经在队首（正常情况）时什么都不用变。
   */
  keepStagedFirst(): void;
  /**
   * 刚做完、结果还没给她看到的那一件。
   *
   * 队列把下一件摆到确认页的时候，她会先看到这一件的结果——不然结果卡片会
   * 被下一件的确认页盖住，做完了什么她根本看不见。看过之后清掉（`dismissRun`）。
   */
  lastFinished: Accessor<TaskRun | null>;
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

/**
 * 事件归约里**有意忽略**的协议事件（#107 的定论）。
 *
 * 单列一份，是为了让「忽略」是一条有理由的决定，而不是被 reducer 那个 `default:`
 * 顺手吞掉的东西——`default:` 挡的是还没见过的新事件，这里挡的是**已经见过、也
 * 想清楚了不用**的：
 *
 *   * `ExtensionRefreshed`：带的是 skills / subagents / MCP 清单（crates/protocol-shape/src/msg.rs
 *     的 ExtensionRefreshed）。简单界面没有技能或命令入口（pro 的命令面板已删，见本文件
 *     顶部注释），`src/simple/**` 与本文件都没有任何一处读 `SessionInfo.skills`；它也不带
 *     model / provider，刷新不了简单界面唯一会读的会话字段（`support_vision`，见
 *     simple/capabilities.ts 的 visionAvailable）。2026-09 真机 sweep excel.merge 两轮各
 *     见过 1 次，所以这是「见过、决定不接」，不是「没见过」。
 *   * `ShellOutput`：命令的 stdout / stderr / 退出码。产品没有终端、也没有命令面板，
 *     `send_input` 只以 `mode: "prompt"` 发过一次（见 sendRunInstruction），因此永远不会
 *     触发 shell 命令；把命令原文摆给用户，等于把「终端 / 路径」这类黑名单词端到界面上
 *     （gui/src/simple/copy-guard.test.ts），而且没有可操作的去处。
 *   * `Ambient`：思考短语或输入建议，要先由前端发 AmbientPhrase / AmbientSuggestion 去问
 *     才有回包；tauri.ts 的 Commands 里没有这两个 op，简单界面也没有状态栏短语或输入提示
 *     的位置，所以它只会是没人要的回包。
 *
 * 什么时候重开这些决定：简单界面第一次出现「按名字调用一项技能 / 命令」的入口时，第一条
 * 必须重开（那时也要处理「起步 skills 为空、稍后由刷新补齐」）；出现终端或命令行入口时，
 * 第二条必须重开。store.test.ts 里对应的断言会先红。
 */
const IGNORED_EVENTS: ReadonlySet<string> = new Set([
  "ExtensionRefreshed",
  "ShellOutput",
  "Ambient",
]);

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

/**
 * r25 — 从 `cante://state` 里的 `pending_question` 读出一份可回答的提问。
 * 形状与 `TurnPause{reason:Question}` 一致（`turn_id` + `tool_use_id` + `questions`），
 * 一样在缺件时返回 null：读不出来的提问不该弹一个空的提问框。
 */
function questionFromState(value: unknown): PendingQuestion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const turnId = typeof record.turn_id === "string" ? record.turn_id : "";
  const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : "";
  if (!turnId || !toolUseId) return null;
  const questions = readQuestionSpecs(record.questions);
  if (questions.length === 0) return null;
  return { turn_id: turnId, tool_use_id: toolUseId, questions };
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
  const [question, setQuestion] = createSignal<PendingQuestion | null>(null);
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
      setQuestion(null);
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
    // `pending_question` 是 r25 新增的字段，`tauri.ts` 的 `BridgeState` 还没带上它
    // （那一份归冻结的桥，本轮不动）；这里只做一次带类型的局部拓宽。
    const questionState = state as Partial<BridgeState> & { pending_question?: unknown };
    if (questionState.pending_question !== undefined) {
      setQuestion(questionFromState(questionState.pending_question));
    }
  }

  function transition(name: string, event: unknown): void {
    switch (name) {
      case "SessionStart":
      case "SessionUpdated": {
        setDaemonStatus("idle");
        setApproval(null);
        setQuestion(null);
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
        // 协议：提问 UI 必须在 resume 上清掉。
        setQuestion(null);
        return;
      case "TurnEnd":
        if (daemonStatus() !== "error") setDaemonStatus("idle");
        // 协议：也要在 end 上清掉——被取消的回合可能**不发** resume。
        setQuestion(null);
        return;
      case "Error":
        setDaemonStatus("error");
        return;
      case "SessionEnd":
      case "Goodbye":
        setDaemonStatus("offline");
        setSession(null);
        setApproval(null);
        setQuestion(null);
        return;
      default:
    }
  }

  function applyEvent(message: EventMsg, dedupe = true): void {
    if (!message || typeof message !== "object") return;
    if (dedupe && !remember(message.id)) return;
    const event = message.event;
    const name = eventName(event);
    // #107 —— 有意忽略的事件：协议里真实存在（真机会发），但简单界面没有对应的入口
    // 或位置。丢掉它们是**决定**，写进了 CONTRACT.md 的「没人验的能力：逐条定论（#107）」，
    // 由 store.test.ts 与 fixture-parity.test.ts 钉住；不是漏了处理，所以也不进状态机、
    // 不出行。
    if (IGNORED_EVENTS.has(name)) return;
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
        const payload = eventPayload<{
          turn_id?: unknown;
          reason?: { Approval?: unknown; Question?: unknown };
        }>(event, "TurnPause");
        // r25 — 结构化提问：和审批是同一个暂停事件的两个理由。先看它：
        // 有题目就摆按钮，没题目才回到审批。两者不会同时挂在一个 reason 上。
        const asked = readPendingQuestion(payload);
        if (asked) {
          setDaemonStatus("awaiting");
          setQuestion(asked);
          return;
        }
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
          else void finishRun("failed", turnFailureText(reason));
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

  /**
   * r25 — 回答一次结构化提问，走协议的一等公民 `Op::QuestionResponse`。
   *
   * 与 `respond` 的分工写在意图里：这条路径对应界面上那排大按钮（`QuestionSheet`），
   * `turn_id` / `tool_use_id` 一律从**那条暂停**里原样带回，`reply` 由
   * `simple/question.ts` 从她的勾选和自由文字翻出来（`selected` 用选项 label，`note`
   * 装自由文本）。
   *
   * 我们已有的回答框（`replyToRun`）**保留**：它是文本兜底（没有结构化选项、或者
   * 她想直接说一句话时走它）。有结构化提问时按钮优先。
   *
   * 注意：`question_response` 这条命令要由桥（`bridge.rs` / `commands.rs` / `daemon.rs`）
   * 接住，本轮无权改那几个文件，所以这里只做到"按正确的形状发出去"这一步；
   * 真机上它还到不了会话（见本轮报告「我没验证什么」）。
   */
  async function answerQuestion(reply: QuestionReply): Promise<void> {
    const pending = question();
    if (!pending) return;
    const ok = await attempt(() =>
      invokeOp("question_response", {
        turn_id: pending.turn_id,
        tool_use_id: pending.tool_use_id,
        reply,
      }),
    );
    if (ok) setQuestion(null);
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

  /**
   * 真正发出去的指令 = **卡片里写好的提示词** + 用户那一句话。
   *
   * 这是一条曾经断掉的线：卡片（`tasks/*.ts`）里写满了"以第一张表的列名为准""原表
   * 一张都不要动""结果另存新文件"这类规矩，`instructionFor()` 会把它们拼成完整指令，
   * 但生产路径只发了用户那句话——也就是说**卡片的规矩从来没到过助手那里**，界面上
   * 承诺的安全动作全靠运气。（真机上发现：我的验收脚本用的是 `task.prompt()`，所以
   * 一直看着像对的。）
   *
   * 找不到卡片（历史记录里的旧任务、或者"直接说一件事"的自由任务）就退回原话。
   */
  function composedInstruction(run: TaskRun): string {
    const composed = instructionFor(run.taskId, run.files, run.instruction);
    return composed && composed.trim().length > 0 ? composed : run.instruction;
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

  /**
   * 记进运行记录的失败原文 = 标题 + 底下的原始说明。
   *
   * 只留下 headline 会把「为什么」洗掉：headline 常常只是笼统的一句（例如
   * 「turn failed」），真正可核对的事实在 details 里。出错页要据此给出具体出路，
   * 所以两层都要留，而不是只给她一句「没有做完」。
   */
  function turnFailureText(reason: { headline: string; details: string[] }): string {
    const parts = [reason.headline, ...reason.details]
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return clampText(parts.join("\n"), MAX_TOOL_DETAIL);
  }

  /**
   * 失败记录的形状在 run.ts 里是冻结的（`TaskError`：what/how/detail），这一层
   * 额外带上 `cause`：系统原话、错误码、「正被占用 / 找不到」之类的**可核对原文**。
   *
   * 它只给判断出路的人（`simple/recovery.ts`）用，**不许出现在界面上**——给用户看
   * 的仍然是 what/how 那两句平实中文。之所以不跟着 detail 走：detail 是给技术同事
   * 看的那一份，可能被换成更友好的说法，而「这一步到底该怎么办」必须拿得到原文。
   */
  type RunError = TaskError & { cause?: string };

  function runError(detail: string | undefined, run: TaskRun): RunError {
    const raw = typeof detail === "string" ? detail.trim() : "";
    return {
      what: run.dryRun ? "这次试跑没能做完。" : "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: raw.length > 0 ? raw : "没有更多说明。",
      // 没有原文时就不填 cause：让出错页老老实实退回通用出口，
      // 而不是拿一句我们自己写的兜底话去冒充「原因」。
      ...(raw.length > 0 ? { cause: raw } : {}),
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
    // 换一件来做：上一件还停在确认页上（比如她点了「再跑一次」）就先退回队里
    // 等着，不丢掉；上一次的结果也不该再挂在屏幕上。
    releaseStaged();
    setLastFinished(null);
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
    const instruction = composedInstruction(run);
    await sendRunInstruction(allowOverwrite ? instruction + OVERWRITE_CONSENT : instruction);
  }

  async function dryRun(): Promise<void> {
    const run = currentRun();
    if (!run || run.state !== "preview") return;
    const next: TaskRun = { ...run, state: "running", dryRun: true };
    setCurrentRun(next);
    markProgressRunning();
    await beginSnapshot(next);
    await sendRunInstruction(dryRunInstruction(composedInstruction(run)));
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
    setLastFinished(null);
    // 停在确认页的那件退回队里等着（她在首页还能「去做这一件」），不丢。
    releaseStaged();
    setCurrentRun(null);
    resetProgress();
  }

  function dismissRun(): void {
    const finished = lastFinished();
    const run = currentRun();
    // 队列已经把下一件摆到确认页上了：这个「知道了」只表示上一件的结果看过了，
    // 不能顺手把还在等她确认的那件也丢掉。
    if (finished && (!run || run.state === "preview" || run.state === "draft")) {
      setLastFinished(null);
      return;
    }
    setLastFinished(null);
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
      // r13 — 这件做完了：轮到下一件。推进只到确认页，动手仍然要她点头；
      // 正在等她确认的下一件一旦摆上来，刚做完这件的结果就先留给她看完
      // （`lastFinished`），不然结果卡片会被下一件的确认页盖住。
      if (stagedQueueId) {
        markQueued(stagedQueueId, state === "done" ? "done" : "failed");
        stagedQueueId = null;
      }
      if (promoteNextQueued()) setLastFinished(next);
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

  // ---- r13 队列（一次说好几件事，一件件来） -------------------------------
  //
  // 账在 `simple/queue.ts`（纯逻辑、可单测），这里只做三件事：存下来、记住
  // "停在确认页的那件是队里的哪一条"（`stagedQueueId`），以及上一件真的做完
  // 之后把下一件摆到确认页。
  //
  // 两条不许破的规矩：
  //   * 摆到确认页 ≠ 开始做。任何一件动手之前都要她点「开始」。
  //   * 不连跑：队列不会因为"还有下一件"就自己往下走；只有上一件做完了、
  //     或者她点了「跳过」/「去做这一件」，才轮到下一件——而且仍然停在确认页。
  //
  // 她关掉程序这队就没了。不持久化是故意的：跨重启恢复等于"上次那几件还得
  // 做"，而她可能早就自己在别处做完了；重排一遍比排错一遍便宜。
  const [queue, setQueue] = createSignal<QueuedJob[]>([]);
  const [lastFinished, setLastFinished] = createSignal<TaskRun | null>(null);
  /** 停在确认页（或者正在做）的那件活，在队里的 id；不属于队列时是 null。 */
  let stagedQueueId: string | null = null;

  function markQueued(id: string, state: QueuedState): void {
    setQueue((list) => withJobState(list, id, state));
  }

  /** 手上这件（停在确认页的那件）退回队里等着，不丢掉。 */
  function releaseStaged(): void {
    const id = stagedQueueId;
    if (!id) return;
    stagedQueueId = null;
    markQueued(id, "waiting");
  }

  /**
   * 把一件活摆到确认页。**只到确认页**：她没有点「开始」之前，什么都不会发生。
   *
   * 先起新的（`startRun` 会把上一件退回队里，比如她点了「再跑一次」），再认领它。
   * 顺序反了就会把自己退回队里。
   */
  function stageQueued(job: QueuedJob): void {
    void startRun(
      { id: job.taskId, title: job.taskTitle, plan: job.plan },
      job.files,
      job.instruction,
    );
    stagedQueueId = job.id;
    markQueued(job.id, "running");
  }

  /** 手上没有别的活时，把排在头一件摆到确认页。 */
  function promoteNextQueued(): QueuedJob | null {
    if (activeRun()) return null;
    const next = nextWaiting(queue());
    if (!next) return null;
    stageQueued(next);
    return next;
  }

  function enqueue(input: QueueInput): QueuedJob | null {
    const job = makeQueuedJob(input, Date.now());
    if (!job) return null;
    // 同一件事（同一张卡、同一句话、同一批文件）已经在排队里，就不再排一遍：
    // 连点两下按钮不该变成做两遍。同一张卡配不同的文件/说法是可以各排一件的。
    const existing = queue().find(
      (item) => (item.state === "waiting" || item.state === "running") && sameJob(item, job),
    );
    if (existing) return existing;
    setQueue((list) => appendJob(list, job));
    return job;
  }

  function removeFromQueue(id: string): void {
    if (!queue().some((item) => item.id === id)) return;
    setQueue((list) => withoutJob(list, id));
    if (stagedQueueId !== id) return;
    stagedQueueId = null;
    const run = currentRun();
    // 真的在做的（已经在动手了）不这样处理：那是「停」，不是「跳过」。
    if (!run || run.state !== "preview") return;
    // 她跳过了停在确认页的这件：把它收起来，把下一件摆上来（仍然停在确认页）。
    setLastFinished(null);
    pendingSnapshot = null;
    setCurrentRun(null);
    resetProgress();
    promoteNextQueued();
  }

  function clearQueue(): void {
    const run = currentRun();
    const staged = stagedQueueId;
    setQueue([]);
    stagedQueueId = null;
    // 停在确认页的那件还什么都没做，可以安静地收起来；
    // 正在动手的那件不动——那要她自己按「停」，不能被一个按钮悄悄打断。
    if (staged && run && run.state === "preview") {
      pendingSnapshot = null;
      setCurrentRun(null);
      resetProgress();
    }
  }

  function startNextQueued(): QueuedJob | null {
    return promoteNextQueued();
  }

  function keepStagedFirst(): void {
    const run = currentRun();
    if (!run || run.state !== "preview") return;
    // 队里已经有同一件事：把它认成"手上这件"，它本来就在最前面。
    const open = queue().filter((item) => item.state === "waiting" || item.state === "running");
    const already = jobFor(open, {
      taskId: run.taskId,
      instruction: run.instruction,
      files: run.files,
    });
    if (already) {
      stagedQueueId = already.id;
      markQueued(already.id, "running");
      return;
    }
    // 她是从卡片直接进来的：这件插到最前面，已经排好的往后排。
    const job = makeQueuedJob(
      {
        taskId: run.taskId,
        taskTitle: run.taskTitle,
        plan: run.plan,
        files: run.files,
        instruction: run.instruction,
      },
      Date.now(),
    );
    if (!job) return;
    setQueue((list) => prependJob(list, job));
    stagedQueueId = job.id;
    markQueued(job.id, "running");
  }

  return {
    daemonStatus,
    session,
    approval,
    question,
    rows,
    steps,
    progress,
    notice,
    connect,
    startSession,
    interrupt,
    respond,
    answerQuestion,
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
    composedInstruction,
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
    queue,
    enqueue,
    removeFromQueue,
    clearQueue,
    startNextQueued,
    keepStagedFirst,
    lastFinished,
  };
}

export type { TaskRun } from "./simple/run.ts";
export type { QueuedJob, QueueInput } from "./simple/queue.ts";
