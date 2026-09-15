// App state for the Cante desktop GUI.
//
// Live events arrive on `cante://event`; `events_since` hydrates the transcript
// from the Rust ring on launch and reconciles it periodically so a missed push
// (or a webview reload) cannot desync the view. Every batch is folded into the
// signals below by one reducer — the same shape the reverted bridge used.
import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import {
  allCommands,
  builtinCommand,
  parseSlash,
  type ClientAction,
  type Command,
} from "./commands.ts";
import type { Row, RowTone } from "./rows.ts";
import {
  EFFORTS,
  PERMISSION_MODES,
  eventName,
  eventPayload,
  formatTokens,
  readTurnEnd,
  textOf,
  toolResultText,
  type ContextWindow,
  type Effort,
  type EventMsg,
  type PendingApproval,
  type PermissionMode,
  type ReviewDecision,
  type SessionInfo,
  type TurnEndStatus,
  type Usage,
} from "./protocol.ts";
import {
  BridgeUnavailable,
  errorText,
  invoke,
  isBridgeAvailable,
  onCanteEvent,
  onCanteExit,
  onCanteLog,
  onCanteState,
  type BridgeState,
  type CatalogProvider as WireCatalogProvider,
  type DaemonStatus,
  type LogEntry,
  type ToolDecision,
  type UnlistenFn,
} from "./tauri.ts";

export type Connection = "connecting" | "online" | "offline";

export type { DaemonStatus, LogEntry } from "./tauri.ts";
// Views import their store types from here.
export type { Row, RowKind, RowTone } from "./rows.ts";

export interface CatalogModel {
  id: string;
  display_name: string;
  efforts: Effort[];
}

export interface CatalogProvider {
  id: string;
  display_name: string;
  models: CatalogModel[];
}

export interface SessionOverrides {
  model?: string;
  provider?: string;
  effort?: Effort;
  permission_mode?: PermissionMode;
  cwd?: string;
  resume_session_id?: string;
}

export interface Store {
  /** Tauri bridge reachability (not the daemon's own status). */
  connection: Accessor<Connection>;
  daemonStatus: Accessor<DaemonStatus>;
  session: Accessor<SessionInfo | null>;
  approval: Accessor<PendingApproval | null>;
  rows: Accessor<Row[]>;
  usage: Accessor<Usage | null>;
  context: Accessor<ContextWindow | null>;
  steps: Accessor<number>;
  notice: Accessor<string | null>;
  logs: Accessor<LogEntry[]>;
  catalog: Accessor<CatalogProvider[]>;
  canteVersion: Accessor<string | null>;
  workspace: Accessor<string>;
  /** Built-in commands plus the session's skills. */
  commands: Accessor<Command[]>;
  draft: Accessor<string>;
  history: Accessor<string[]>;
  pickerOpen: Accessor<boolean>;
  paletteOpen: Accessor<boolean>;
  connect(): void;
  startSession(overrides?: SessionOverrides): Promise<void>;
  send(text: string, mode?: "prompt" | "steer" | "shell"): Promise<void>;
  interrupt(): Promise<void>;
  respond(decisions: ReviewDecision[], message?: string): Promise<void>;
  setEffort(effort: Effort): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(provider: string, model: string): Promise<void>;
  setCwd(cwd: string): Promise<void>;
  setDraft(value: string): void;
  /** Send a prompt, or run a `/command` when the text starts with a slash. */
  submit(text?: string): Promise<void>;
  /** Run a command picked from the palette. */
  runCommand(command: Command): Promise<void>;
  historyPrev(): void;
  historyNext(): void;
  openPicker(): void;
  closePicker(): void;
  openPalette(): void;
  closePalette(): void;
  cycleEffort(): Promise<void>;
  cyclePermission(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  requestContextReport(): Promise<void>;
  loadCatalog(): Promise<void>;
  clearTranscript(): void;
}

const MAX_ROWS = 400;
const MAX_ROW_TEXT = 8_000;
const MAX_TOOL_DETAIL = 4_000;
const MAX_LOGS = 200;
const MAX_HISTORY = 50;
const MAX_SEEN = 8_192;
const RECONCILE_MS = 2_000;
const PING_MS = 4_000;

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
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

export function modelLabel(session: SessionInfo | null): string {
  if (!session) return "—";
  return session.model?.display_name || session.model?.id || "—";
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

function normalizeCatalog(wire: WireCatalogProvider[] | undefined): CatalogProvider[] {
  const providers: CatalogProvider[] = [];
  for (const entry of wire ?? []) {
    const record = (entry ?? {}) as WireCatalogProvider;
    const models: CatalogModel[] = [];
    for (const item of record.models ?? []) {
      const id = String(item?.id ?? "");
      if (!id) continue;
      models.push({
        id,
        display_name: String(item.display_name || id),
        efforts: Array.isArray(item.supported_efforts) ? (item.supported_efforts as Effort[]) : [],
      });
    }
    providers.push({
      id: String(record.id ?? ""),
      display_name: String(record.display_name || record.id || ""),
      models,
    });
  }
  return providers;
}

export function createStore(): Store {
  const [connection, setConnection] = createSignal<Connection>("connecting");
  const [daemonStatus, setDaemonStatus] = createSignal<DaemonStatus>("offline");
  const [session, setSession] = createSignal<SessionInfo | null>(null);
  const [approval, setApproval] = createSignal<PendingApproval | null>(null);
  const [rows, setRows] = createSignal<Row[]>([]);
  const [usage, setUsage] = createSignal<Usage | null>(null);
  const [context, setContext] = createSignal<ContextWindow | null>(null);
  const [steps, setSteps] = createSignal(0);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [logs, setLogs] = createSignal<LogEntry[]>([]);
  const [catalog, setCatalog] = createSignal<CatalogProvider[]>([]);
  const [canteVersion, setCanteVersion] = createSignal<string | null>(null);
  const [workspace, setWorkspace] = createSignal("");
  const [draft, setDraftSignal] = createSignal("");
  const [history, setHistory] = createSignal<string[]>([]);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  const commands = createMemo<Command[]>(() => allCommands(session()?.skills ?? []));

  let historyCursor: number | null = null;
  let historyDraft = "";
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
  let autoStarted = false;
  const seen = new Set<string>();
  const seenOrder: string[] = [];

  onCleanup(() => {
    disposed = true;
    for (const off of unlisteners) off();
    if (reconcileTimer !== undefined) clearInterval(reconcileTimer);
    if (pingTimer !== undefined) clearTimeout(pingTimer);
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
    void setup();
  }

  async function setup(): Promise<void> {
    // Subscribe before hydrating so nothing emitted in between is lost; the
    // buffer is flushed in order once the ring replay has landed.
    unlisteners = await Promise.all([
      onCanteEvent(handleEvent),
      onCanteState(handleState),
      onCanteLog(handleLog),
      onCanteExit(handleExit),
    ]);
    if (disposed) {
      for (const off of unlisteners) off();
      return;
    }
    await hydrate();
    if (disposed) return;
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
        setConnection("online");
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
    try {
      const response = await invoke("events_since", { cursor });
      if (disposed) return;
      batch(() => {
        for (const message of response.events) applyEvent(message);
        applyState(response.state);
        cursor = response.cursor;
        setConnection("online");
      });
    } catch (error) {
      if (!disposed) setConnection("offline");
      if (!disposed) setNotice(`events: ${describe(error)}`);
    }
  }

  async function ping(): Promise<void> {
    if (disposed) return;
    try {
      const health = await invoke("health");
      if (disposed) return;
      batch(() => {
        setConnection("online");
        setCanteVersion(health.cante);
        if (health.cwd) setWorkspace(health.cwd);
        if (health.status) setDaemonStatus(health.status);
      });
      // A reachable host with no session yet: open one with host defaults.
      if (!autoStarted && session() === null) {
        autoStarted = true;
        void startSession();
      }
    } catch {
      if (disposed) return;
      setConnection("offline");
      if (!isBridgeAvailable()) {
        setNotice("desktop bridge unavailable — open the Cante desktop app");
      }
    }
    if (!disposed) pingTimer = setTimeout(() => void ping(), PING_MS);
  }

  function handleEvent(message: EventMsg): void {
    if (disposed) return;
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

  function handleLog(entry: LogEntry): void {
    if (disposed || !entry) return;
    setLogs((list) => {
      const next = [...list, entry];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
  }

  function handleExit(payload: { code: number | null }): void {
    if (disposed) return;
    batch(() => {
      setDaemonStatus("offline");
      setApproval(null);
      setNotice(`cante daemon exited (${payload?.code ?? "signal"})`);
    });
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
      text,
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
    if (state.pending_approval !== undefined) setApproval(state.pending_approval ?? null);
    if (state.cante !== undefined) setCanteVersion(state.cante);
    if (state.cwd) setWorkspace(state.cwd);
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
    if (dedupe && !remember(message.id)) return;
    const event = message.event;
    const name = eventName(event);
    const at = eventTime(message);
    transition(name, event);

    switch (name) {
      case "UserInput": {
        const text = textOf(event, "UserInput");
        if (text && text !== lastUserText) {
          setRows(pushRow({ id: `u${++rowSeq}`, kind: "user", label: "you", text, detail: "", tone: "accent", streaming: false, time: at }));
        }
        lastUserText = "";
        return;
      }
      case "MessageDelta":
      case "AgentMessage": {
        const delta = name === "MessageDelta";
        const text = textOf(event, name);
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
        const rowId = `k${++rowSeq}`;
        toolRows.set(id, rowId);
        setRows(pushRow({
          id: rowId,
          kind: "tool",
          label: String(tool?.name ?? "tool"),
          text: JSON.stringify(tool?.args ?? {}, null, 0) ?? "",
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
        setRows(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "info", text, detail: "", tone: "muted", streaming: false, time: at }));
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
        if (Number.isFinite(Number(report.used_tokens)) || Number.isFinite(Number(report.limit_tokens))) {
          setContext({
            used_tokens: Number(report.used_tokens ?? 0),
            limit_tokens: Number(report.limit_tokens ?? 0),
          });
        }
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
      case "UsageUpdate": {
        const payload = eventPayload<{ usage?: Usage; context?: ContextWindow }>(event, "UsageUpdate");
        if (payload?.usage) setUsage(payload.usage);
        if (payload?.context) setContext(payload.context);
        return;
      }
      case "TurnPause": {
        const payload = eventPayload<{ turn_id?: string; reason?: { Approval?: { tools?: PendingApproval["tools"]; message?: string } } }>(event, "TurnPause");
        const gate = payload?.reason?.Approval;
        if (!gate) return;
        setDaemonStatus("awaiting");
        setApproval({
          turn_id: String(payload?.turn_id ?? ""),
          message: String(gate.message ?? ""),
          tools: Array.isArray(gate.tools) ? gate.tools : [],
        });
        return;
      }
      case "Error": {
        const text = textOf(event, "Error");
        setRows(pushRow({ id: `e${++rowSeq}`, kind: "error", label: "error", text: text || "unknown error", detail: "", tone: "error", streaming: false, time: at }));
        setNotice(text || "unknown error");
        return;
      }
      case "TurnEnd": {
        const payload = eventPayload<{ status?: TurnEndStatus; steps?: number }>(event, "TurnEnd");
        const reason = readTurnEnd(payload?.status);
        setSteps(Number(payload?.steps ?? steps()));
        lastUserText = "";
        if (reason.kind === "ok") {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "done", text: `turn complete · ${payload?.steps ?? 0} step(s)`, detail: "", tone: "ok", streaming: false, time: at }));
        } else if (reason.kind === "interrupted") {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "stopped", text: reason.reason, detail: "", tone: "warn", streaming: false, time: at }));
        } else {
          setRows(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "failed", text: reason.headline, detail: reason.details.join(" · "), tone: "error", streaming: false, time: at }));
          setNotice(reason.headline);
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

  async function send(text: string, mode: "prompt" | "steer" | "shell" = "prompt"): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (mode === "prompt") {
      lastUserText = trimmed;
      setRows(pushRow({
        id: `u${++rowSeq}`,
        kind: "user",
        label: "you",
        text: trimmed,
        detail: "",
        tone: "accent",
        streaming: false,
        time: nowLabel(),
      }));
    }
    await attempt(() => invoke("send_input", { text: trimmed, mode }));
  }

  async function interrupt(): Promise<void> {
    await attempt(() => invoke("interrupt"));
  }

  async function respond(decisions: ReviewDecision[], message?: string): Promise<void> {
    const pending = approval();
    if (!pending) return;
    const responses: ToolDecision[] = pending.tools.map((tool, index) => ({
      tool_use_id: tool.id,
      decision: decisions[index] ?? decisions[0] ?? "Deny",
      ...(message ? { message } : {}),
    }));
    const ok = await attempt(() => invoke("approve", { turn_id: pending.turn_id, responses }));
    if (ok) setApproval(null);
  }

  async function setEffort(effort: Effort): Promise<void> {
    const current = session();
    if (!current) return;
    await attempt(() => invoke("update_session", { model: { id: current.model.id, effort } }));
  }

  async function setPermissionMode(mode: PermissionMode): Promise<void> {
    await attempt(() => invoke("update_session", { permission_mode: mode }));
  }

  async function setModel(provider: string, model: string): Promise<void> {
    const current = session();
    await attempt(() => invoke("start_session", {
      provider,
      model,
      effort: current?.model?.effort ?? undefined,
      permission_mode: current?.permission_mode ?? undefined,
    }));
  }

  async function setCwd(cwd: string): Promise<void> {
    const ok = await attempt(() => invoke("set_cwd", { cwd }));
    if (ok) setWorkspace(cwd);
  }

  async function compact(instructions?: string): Promise<void> {
    await attempt(() => invoke("compact", instructions ? { instructions } : {}));
  }

  async function requestContextReport(): Promise<void> {
    await attempt(() => invoke("context_report"));
  }

  // ---- input: draft, history, commands ------------------------------------

  function setDraft(value: string): void {
    historyCursor = null;
    setDraftSignal(value);
  }

  function pushHistory(text: string): void {
    historyCursor = null;
    setHistory((list) => {
      const next = list[list.length - 1] === text ? list : [...list, text];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
  }

  /** ↑ through previously sent prompts; the in-progress draft is restored. */
  function historyPrev(): void {
    const list = history();
    if (list.length === 0) return;
    if (historyCursor === null) {
      historyDraft = draft();
      historyCursor = list.length;
    }
    historyCursor = Math.max(0, historyCursor - 1);
    setDraftSignal(list[historyCursor]!);
  }

  function historyNext(): void {
    const list = history();
    if (historyCursor === null) return;
    if (historyCursor >= list.length - 1) {
      historyCursor = null;
      setDraftSignal(historyDraft);
      return;
    }
    historyCursor += 1;
    setDraftSignal(list[historyCursor]!);
  }

  async function cycleEffort(): Promise<void> {
    const current = session()?.model?.effort ?? "Medium";
    const index = EFFORTS.indexOf(current);
    await setEffort(EFFORTS[(index + 1) % EFFORTS.length]!);
  }

  async function cyclePermission(): Promise<void> {
    const current = session()?.permission_mode ?? "Strict";
    const index = PERMISSION_MODES.indexOf(current);
    await setPermissionMode(PERMISSION_MODES[(index + 1) % PERMISSION_MODES.length]!);
  }

  /** Commands the GUI runs itself; everything else is a daemon `SlashCommand`. */
  async function runClient(action: ClientAction, args = ""): Promise<void> {
    switch (action) {
      case "new-session":
        clearTranscript();
        await startSession();
        return;
      case "clear-view":
        clearTranscript();
        return;
      case "model":
        setPickerOpen(true);
        return;
      case "effort":
        await cycleEffort();
        return;
      case "permissions":
        await cyclePermission();
        return;
      case "compact":
        await compact();
        return;
      case "context":
        await requestContextReport();
        return;
      case "interrupt":
        await interrupt();
        return;
      case "goal":
        await attempt(() => invoke("goal", args ? { command: "Set", condition: args } : { command: "Status" }));
        return;
      case "goal-clear":
        await attempt(() => invoke("goal", { command: "Clear" }));
        return;
      default:
        return;
    }
  }

  /** Dispatch `/<name> <args>` — locally when built in, otherwise to the daemon. */
  async function runCommandByName(name: string, args: string): Promise<void> {
    const builtin = builtinCommand(name);
    if (builtin?.client) {
      // An argument-taking command with nothing typed yet: prefill and let the
      // user finish in the composer rather than guessing.
      if (builtin.prefill !== undefined && !args) {
        setDraftSignal(`/${name} `);
        return;
      }
      await runClient(builtin.client, args);
      return;
    }
    await attempt(() => invoke("slash", { name, args }));
  }

  async function submit(text?: string): Promise<void> {
    const value = (text ?? draft()).trim();
    if (!value) return;
    historyCursor = null;
    setDraftSignal("");
    const slash = parseSlash(value);
    if (slash) {
      await runCommandByName(slash.name, slash.args);
      return;
    }
    pushHistory(value);
    await send(value);
  }

  async function runCommand(command: Command): Promise<void> {
    setPaletteOpen(false);
    if (command.prefill !== undefined) {
      setDraftSignal(`/${command.name} `);
      return;
    }
    if (command.client) {
      await runClient(command.client);
      return;
    }
    await attempt(() => invoke("slash", { name: command.name, args: "" }));
  }

  async function loadCatalog(): Promise<void> {
    try {
      const response = await invoke("catalog");
      setCatalog(normalizeCatalog(response.providers));
      setNotice(null);
    } catch (error) {
      setNotice(`catalog: ${describe(error)}`);
    }
  }

  function openPicker(): void {
    setPickerOpen(true);
  }

  function closePicker(): void {
    setPickerOpen(false);
  }

  function openPalette(): void {
    setPaletteOpen(true);
  }

  function closePalette(): void {
    setPaletteOpen(false);
  }

  function clearTranscript(): void {
    toolRows.clear();
    setRows([]);
    setUsage(null);
    setContext(null);
    setSteps(0);
  }

  return {
    connection,
    daemonStatus,
    session,
    approval,
    rows,
    usage,
    context,
    steps,
    notice,
    logs,
    catalog,
    canteVersion,
    workspace,
    commands,
    draft,
    history,
    pickerOpen,
    paletteOpen,
    connect,
    startSession,
    send,
    interrupt,
    respond,
    setEffort,
    setPermissionMode,
    setModel,
    setCwd,
    setDraft,
    submit,
    runCommand,
    historyPrev,
    historyNext,
    openPicker,
    closePicker,
    openPalette,
    closePalette,
    cycleEffort,
    cyclePermission,
    compact,
    requestContextReport,
    loadCatalog,
    clearTranscript,
  };
}

// Re-exported so views do not need to reach into protocol.ts for copy.
export { EFFORTS, PERMISSION_MODES, formatTokens };
