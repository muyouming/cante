// Typed frontend for the Tauri bridge described in `CONTRACT.md`.
//
// Rust forwards daemon events verbatim, so everything here is deliberately
// thin: `invoke` gains a command/arg/result map, `listen` gains one wrapper per
// `cante://…` channel, and every failure becomes an `Error` with a
// human-readable message (Tauri rejects with a bare string).
//
// The module must also be safe to import in a plain browser (`vite dev` /
// `bun run build:web`): with no `__TAURI_INTERNALS__` the wrappers reject with
// `BridgeUnavailable` instead of throwing a `TypeError` deep inside the API.
import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type {
  Effort,
  EventMsg,
  PendingApproval,
  PermissionMode,
  ReviewDecision,
  SessionInfo,
} from "./protocol.ts";

export type { UnlistenFn } from "@tauri-apps/api/event";

/** The daemon status union the bridge publishes in `cante://state`. */
export type DaemonStatus = "idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline";

export const CANTE_EVENT = "cante://event";
export const CANTE_STATE = "cante://state";
export const CANTE_LOG = "cante://log";
export const CANTE_EXIT = "cante://exit";

export interface Health {
  ok: boolean;
  cante: string | null;
  cwd: string;
  daemon: boolean;
  status: DaemonStatus;
}

/** `cante://state` payload; `events_since` returns the same object as `state`. */
export interface BridgeState {
  status: DaemonStatus;
  session: SessionInfo | null;
  pending_approval: PendingApproval | null;
  cante?: string | null;
  cwd?: string;
}

export interface EventsResponse {
  cursor: number;
  truncated: boolean;
  events: EventMsg[];
  state: BridgeState;
}

export interface LogEntry {
  stream: "stderr" | "stdout" | "app" | string;
  line: string;
}

export interface ExitPayload {
  code: number | null;
}

/** `approve` responses, one per requested call. */
export interface ToolDecision {
  tool_use_id: string;
  decision: ReviewDecision;
  message?: string;
}

export interface CatalogModel {
  id: string;
  display_name?: string | null;
  supported_efforts?: Effort[] | null;
}

export interface CatalogProvider {
  id: string;
  display_name?: string | null;
  models: CatalogModel[];
}

export interface CatalogResponse {
  providers: CatalogProvider[];
}

export interface StartSessionArgs {
  model?: string;
  provider?: string;
  effort?: Effort;
  permission_mode?: PermissionMode;
  cwd?: string;
  resume_session_id?: string;
}

/**
 * `update_session` carries the live model spec (id + effort); `model` is typed
 * as a union so a Rust side that only wants the id still type-checks.
 */
export interface UpdateSessionArgs {
  model?: string | { id: string; effort?: Effort };
  permission_mode?: PermissionMode;
  title?: string;
}

export interface Commands {
  health: { args: undefined; result: Health };
  events_since: { args: { cursor: number }; result: EventsResponse };
  start_session: { args: StartSessionArgs; result: { ok: true } };
  update_session: { args: UpdateSessionArgs; result: { ok: true } };
  send_input: {
    args: { text: string; mode: "prompt" | "steer" | "shell" };
    result: { ok: true };
  };
  approve: { args: { turn_id: string; responses: ToolDecision[] }; result: { ok: true } };
  interrupt: { args: undefined; result: { ok: true } };
  compact: { args: { instructions?: string }; result: { ok: true } };
  context_report: { args: undefined; result: { ok: true } };
  slash: { args: { name: string; args: string }; result: { ok: true } };
  goal: {
    args: { command: "Set" | "Clear" | "Status"; condition?: string };
    result: { ok: true };
  };
  catalog: { args: undefined; result: CatalogResponse };
  set_cwd: { args: { cwd: string }; result: { ok: true } };
  shutdown: { args: undefined; result: { ok: true } };
}

/** The webview is running without the Tauri host (plain browser preview). */
export class BridgeUnavailable extends Error {
  constructor(message = "desktop bridge unavailable — run the Cante desktop app") {
    super(message);
    this.name = "BridgeUnavailable";
  }
}

/** Rust rejected a command; `message` is its human-readable string. */
export class CommandRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandRejected";
  }
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** True when `window.__TAURI_INTERNALS__` is present. */
export function isBridgeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (isTauri()) return true;
  } catch {
    /* fall through to the internals probe */
  }
  return "__TAURI_INTERNALS__" in window;
}

/**
 * Typed `invoke`. Rejects with `BridgeUnavailable` outside Tauri and
 * `CommandRejected` when Rust returns an error string, so callers can render a
 * notice without touching the raw IPC surface.
 */
export async function invoke<K extends keyof Commands>(
  name: K,
  args?: Commands[K]["args"],
): Promise<Commands[K]["result"]> {
  if (!isBridgeAvailable()) throw new BridgeUnavailable();
  try {
    return await tauriInvoke<Commands[K]["result"]>(
      name as string,
      (args ?? {}) as Record<string, unknown>,
    );
  } catch (error) {
    throw new CommandRejected(errorText(error));
  }
}

async function subscribe<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isBridgeAvailable()) return () => {};
  try {
    return await listen<T>(event, (message) => {
      handler(message.payload);
    });
  } catch {
    // A listener that cannot attach must not take the shell down; the health
    // probe and the reconcile poll are the safety net.
    return () => {};
  }
}

export function onCanteEvent(handler: (event: EventMsg) => void): Promise<UnlistenFn> {
  return subscribe<EventMsg>(CANTE_EVENT, handler);
}

export function onCanteState(handler: (state: BridgeState) => void): Promise<UnlistenFn> {
  return subscribe<BridgeState>(CANTE_STATE, handler);
}

export function onCanteLog(handler: (entry: LogEntry) => void): Promise<UnlistenFn> {
  return subscribe<LogEntry>(CANTE_LOG, handler);
}

export function onCanteExit(handler: (payload: ExitPayload) => void): Promise<UnlistenFn> {
  return subscribe<ExitPayload>(CANTE_EXIT, handler);
}
