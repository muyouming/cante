// App state for the Cante GUI.
//
// One polling loop feeds one reducer: the bridge answers with cursor-addressed
// event batches, and every batch is folded into the transcript + session
// signals below. Solid owns reactivity; nothing here touches the DOM-like tree.
import { after } from "@pocketjs/framework/clock";
import { batch, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import { BridgeUnavailable, DEFAULT_BRIDGE_URL, POLL_TIMEOUT_MS, createBridge, type Bridge } from "./bridge.ts";
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

export type Connection = "connecting" | "online" | "offline";
export type DaemonStatus = "idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline";

// Rows live in `rows.ts` so the pure layout pass can be tested without the
// framework; re-exported here because views import their store types here.
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
}

export interface Store {
  bridge: Bridge;
  bridgeUrl: Accessor<string>;
  connection: Accessor<Connection>;
  daemonStatus: Accessor<DaemonStatus>;
  session: Accessor<SessionInfo | null>;
  approval: Accessor<PendingApproval | null>;
  rows: Accessor<Row[]>;
  usage: Accessor<Usage | null>;
  context: Accessor<ContextWindow | null>;
  steps: Accessor<number>;
  notice: Accessor<string | null>;
  catalog: Accessor<CatalogProvider[]>;
  canteVersion: Accessor<string | null>;
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
  compact(): Promise<void>;
  requestContextReport(): Promise<void>;
  loadCatalog(): Promise<void>;
  clearTranscript(): void;
}

const MAX_ROWS = 400;
const MAX_ROW_TEXT = 8_000;
const MAX_TOOL_DETAIL = 4_000;

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function nowLabel(): string {
  const date = new Date();
  // Hosts without an RTC hand back the epoch; don't print 1970 at users.
  if (!Number.isFinite(date.getTime()) || date.getFullYear() < 2000) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    after(seconds, () => resolve());
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof BridgeUnavailable) {
    if (error.code === "unavailable") return "this host has no HTTP module (net.http)";
    return "bridge unreachable — start it in examples/gui";
  }
  return (error as Error).message;
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

function modelOf(session: SessionInfo | null): string {
  if (!session) return "—";
  return session.model?.display_name || session.model?.id || "—";
}

export function providerLabel(session: SessionInfo | null): string {
  if (!session) return "—";
  return session.provider?.display_name || session.provider?.id || "—";
}

export function modelLabel(session: SessionInfo | null): string {
  return modelOf(session);
}

export function createStore(bridge: Bridge = createBridge(DEFAULT_BRIDGE_URL)): Store {
  const [connection, setConnection] = createSignal<Connection>("connecting");
  const [daemonStatus, setDaemonStatus] = createSignal<DaemonStatus>("idle");
  const [session, setSession] = createSignal<SessionInfo | null>(null);
  const [approval, setApproval] = createSignal<PendingApproval | null>(null);
  const [rows, setRows] = createSignal<Row[]>([]);
  const [usage, setUsage] = createSignal<Usage | null>(null);
  const [context, setContext] = createSignal<ContextWindow | null>(null);
  const [steps, setSteps] = createSignal(0);
  const [notice, setNotice] = createSignal<string | null>(null);
  const [catalog, setCatalog] = createSignal<CatalogProvider[]>([]);
  const [canteVersion, setCanteVersion] = createSignal<string | null>(null);
  const [draft, setDraftSignal] = createSignal("");
  const [history, setHistory] = createSignal<string[]>([]);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const commands = createMemo<Command[]>(() => allCommands(session()?.skills ?? []));
  let historyCursor: number | null = null;
  let historyDraft = "";

  let cursor = 0;
  let alive = true;
  let rowSeq = 0;
  const toolRows = new Map<string, string>();
  let lastUserText = "";

  onCleanup(() => {
    alive = false;
  });

  // ---- reducer ------------------------------------------------------------

  function pushRow(row: Row): Row[] {
    const next = [...rows(), row];
    if (next.length > MAX_ROWS) next.splice(0, next.length - MAX_ROWS);
    return next;
  }

  function replaceRow(next: Row[]): void {
    setRows(next);
  }

  function applyEvent(message: EventMsg): void {
    const event = message.event;
    const name = eventName(event);
    const at = nowLabel();

    switch (name) {
      case "UserInput": {
        const text = textOf(event, "UserInput");
        if (text && text !== lastUserText) {
          replaceRow(pushRow({ id: `u${++rowSeq}`, kind: "user", label: "you", text, detail: "", tone: "accent", streaming: false, time: at }));
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
          replaceRow([...list.slice(0, -1), { ...last, text: clampText(last.text + text, MAX_ROW_TEXT) }]);
          return;
        }
        if (!delta && last && last.kind === "agent" && last.streaming) {
          replaceRow([...list.slice(0, -1), { ...last, text: clampText(text, MAX_ROW_TEXT), streaming: false, tone: "neutral" }]);
          return;
        }
        if (!text) return;
        replaceRow(pushRow({ id: `a${++rowSeq}`, kind: "agent", label: "cante", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "neutral", streaming: delta, time: at }));
        return;
      }
      case "Thinking":
      case "ThinkingDelta": {
        const delta = name === "ThinkingDelta";
        const text = textOf(event, name);
        const list = rows();
        const last = list[list.length - 1];
        if (last && last.kind === "thinking" && last.streaming && delta) {
          replaceRow([...list.slice(0, -1), { ...last, text: clampText(last.text + text, MAX_ROW_TEXT) }]);
          return;
        }
        if (!text) return;
        replaceRow(pushRow({ id: `t${++rowSeq}`, kind: "thinking", label: "thinking", text: clampText(text, MAX_ROW_TEXT), detail: "", tone: "muted", streaming: delta, time: at }));
        return;
      }
      case "ToolStart": {
        const tool = eventPayload<{ id?: string; name?: string; args?: unknown }>(event, "ToolStart");
        const id = String(tool?.id ?? `tool_${rowSeq}`);
        const rowId = `k${++rowSeq}`;
        toolRows.set(id, rowId);
        replaceRow(pushRow({
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
        replaceRow(rows().map((row) =>
          row.id === rowId
            ? { ...row, detail: clampText(`${row.detail}\n${String(update?.message ?? "")}`.trim(), MAX_TOOL_DETAIL) }
            : row,
        ));
        return;
      }
      case "ToolEnd": {
        const end = eventPayload<{ tool_use_id?: string; status?: string; result_json?: unknown; tool_name?: string }>(event, "ToolEnd");
        const rowId = toolRows.get(String(end?.tool_use_id ?? ""));
        if (!rowId) return;
        const result = toolResultText(end?.result_json);
        replaceRow(rows().map((row) =>
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
        const text =
          name === "Info" ? textOf(event, "Info") : String(eventPayload<{ header?: string; detail?: string }>(event, name)?.header
            ?? eventPayload<{ detail?: string }>(event, name)?.detail
            ?? "");
        if (!text) return;
        replaceRow(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "info", text, detail: "", tone: "muted", streaming: false, time: at }));
        return;
      }
      case "CompactStart":
        replaceRow(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "compact", text: "compacting conversation history…", detail: "", tone: "muted", streaming: false, time: at }));
        return;
      case "CompactEnd": {
        const summary = eventPayload<{ summary?: string | null }>(event, "CompactEnd")?.summary ?? null;
        replaceRow(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "compact", text: summary ? "history compacted" : "compaction failed; history unchanged", detail: summary ? clampText(summary, 240) : "", tone: "muted", streaming: false, time: at }));
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
        replaceRow(pushRow({ id: `i${++rowSeq}`, kind: "info", label: "context", text: `window ${formatTokens(Number(report.used_tokens ?? 0))} of ${formatTokens(Number(report.limit_tokens ?? 0))}`, detail: parts.join(" · "), tone: "muted", streaming: false, time: at }));
        return;
      }
      case "Error": {
        const text = textOf(event, "Error");
        replaceRow(pushRow({ id: `e${++rowSeq}`, kind: "error", label: "error", text: text || "unknown error", detail: "", tone: "error", streaming: false, time: at }));
        setNotice(text || "unknown error");
        return;
      }
      case "TurnEnd": {
        const payload = eventPayload<{ status?: TurnEndStatus; steps?: number }>(event, "TurnEnd");
        const reason = readTurnEnd(payload?.status);
        setSteps(Number(payload?.steps ?? steps()));
        lastUserText = "";
        if (reason.kind === "ok") {
          replaceRow(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "done", text: `turn complete · ${payload?.steps ?? 0} step(s)`, detail: "", tone: "ok", streaming: false, time: at }));
        } else if (reason.kind === "interrupted") {
          replaceRow(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "stopped", text: reason.reason, detail: "", tone: "warn", streaming: false, time: at }));
        } else {
          replaceRow(pushRow({ id: `r${++rowSeq}`, kind: "turn", label: "failed", text: reason.headline, detail: reason.details.join(" · "), tone: "error", streaming: false, time: at }));
          setNotice(reason.headline);
        }
        return;
      }
      case "SessionEnd":
        setNotice("session ended");
        return;
      case "Goodbye":
        setDaemonStatus("offline");
        return;
      default:
        return;
    }
  }

  function applyBatch(messages: EventMsg[], state: { status?: DaemonStatus; session?: SessionInfo | null; pending_approval?: PendingApproval | null }): void {
    for (const message of messages) {
      if (eventName(message.event) === "UsageUpdate") {
        const payload = eventPayload<{ usage?: Usage; context?: ContextWindow }>(message.event, "UsageUpdate");
        if (payload?.usage) setUsage(payload.usage);
        if (payload?.context) setContext(payload.context);
      }
      applyEvent(message);
    }
    if (state.session !== undefined) setSession(state.session);
    if (state.pending_approval !== undefined) setApproval(state.pending_approval);
    if (state.status) setDaemonStatus(state.status);
  }

  // ---- poll loop ----------------------------------------------------------

  function connect(): void {
    void (async () => {
      // Probe once so a reachable bridge flips the shell out of "connecting"
      // immediately — the first long-poll can otherwise sit idle for its whole
      // window before anything is sent.
      try {
        const health = await bridge.health(4_000);
        if (!alive) return;
        batch(() => {
          setConnection("online");
          setCanteVersion(health.cante);
        });
      } catch {
        /* the loop below keeps probing */
      }
      while (alive) {
        try {
          const response = await bridge.events(cursor, POLL_TIMEOUT_MS);
          batch(() => {
            setConnection("online");
            setNotice(null);
            applyBatch(response.events, response.state);
            cursor = response.cursor;
          });
          if (response.truncated) continue;
        } catch (error) {
          batch(() => {
            setConnection("offline");
            setNotice(errorMessage(error));
          });
          await sleep(1.2);
          if (!alive) return;
          try {
            const health = await bridge.health(4_000);
            batch(() => {
              setConnection("online");
              setCanteVersion(health.cante);
              setNotice(null);
            });
          } catch {
            /* still offline; the loop backs off again */
          }
        }
      }
    })();
  }

  // ---- actions ------------------------------------------------------------

  async function post(path: string, body: unknown): Promise<boolean> {
    try {
      await bridge.post(path, body);
      setNotice(null);
      return true;
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }

  async function startSession(overrides: SessionOverrides = {}): Promise<void> {
    lastUserText = "";
    const ok = await post("/session", { ...overrides });
    if (ok) setNotice("starting session…");
  }

  async function send(text: string, mode: "prompt" | "steer" | "shell" = "prompt"): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (mode === "prompt") {
      lastUserText = trimmed;
      replaceRow(pushRow({
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
    await post("/input", { text: trimmed, mode });
  }

  async function interrupt(): Promise<void> {
    await post("/interrupt", {});
  }

  async function respond(decisions: ReviewDecision[], message?: string): Promise<void> {
    const pending = approval();
    if (!pending) return;
    const responses = pending.tools.map((tool, index) => ({
      tool_use_id: tool.id,
      decision: decisions[index] ?? decisions[0] ?? "Deny",
      ...(message ? { message } : {}),
    }));
    const ok = await post("/approval", { turn_id: pending.turn_id, responses });
    if (ok) setApproval(null);
  }

  async function setEffort(effort: Effort): Promise<void> {
    const current = session();
    if (!current) return;
    await post("/update", { model: { id: current.model.id, effort } });
  }

  async function setPermissionMode(mode: PermissionMode): Promise<void> {
    await post("/update", { permission_mode: mode });
  }

  async function setModel(provider: string, model: string): Promise<void> {
    const current = session();
    if (!current) return;
    await post("/session", {
      provider,
      model,
      effort: current.model?.effort ?? undefined,
      permission_mode: current.permission_mode,
    });
  }

  async function compact(): Promise<void> {
    await post("/compact", {});
  }

  async function requestContextReport(): Promise<void> {
    await post("/context", {});
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
      return next.length > 50 ? next.slice(next.length - 50) : next;
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
        await post("/goal", args ? { command: "Set", condition: args } : { command: "Status" });
        return;
      case "goal-clear":
        await post("/goal", { command: "Clear" });
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
    await post("/slash", { name, args });
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
    await post("/slash", { name: command.name, args: "" });
  }

  async function loadCatalog(): Promise<void> {
    try {
      const raw = await bridge.get<{ providers?: unknown[] }>("/catalog", 15_000);
      const providers: CatalogProvider[] = [];
      for (const entry of raw.providers ?? []) {
        const record = (entry ?? {}) as Record<string, unknown>;
        const models: CatalogModel[] = [];
        for (const item of (record.models as unknown[]) ?? []) {
          const model = (item ?? {}) as Record<string, unknown>;
          const id = String(model.id ?? "");
          if (!id) continue;
          models.push({
            id,
            display_name: String(model.display_name ?? id),
            efforts: Array.isArray(model.supported_efforts) ? (model.supported_efforts as Effort[]) : [],
          });
        }
        providers.push({
          id: String(record.id ?? ""),
          display_name: String(record.display_name ?? record.id ?? ""),
          models,
        });
      }
      setCatalog(providers);
    } catch (error) {
      setNotice(`catalog unavailable: ${errorMessage(error)}`);
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
    bridge,
    bridgeUrl: () => bridge.base,
    connection,
    daemonStatus,
    session,
    approval,
    rows,
    usage,
    context,
    steps,
    notice,
    catalog,
    canteVersion,
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
