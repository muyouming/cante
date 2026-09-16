// Wire types for the Cante `Op`/`Evt` protocol — the subset the GUI renders.
//
// Source of truth: `crates/protocol-shape/src/msg.rs` (see also
// docs-site/docs/reference/protocol-reference.mdx). Rust enums serialize
// externally tagged, so a unit variant arrives as a bare string (`"Goodbye"`)
// and everything else as a single-key object (`{ "ToolStart": { … } }`).

export type Effort = "Min" | "Low" | "Medium" | "High" | "XHigh" | "Max";
export const EFFORTS: readonly Effort[] = ["Min", "Low", "Medium", "High", "XHigh", "Max"];

export type PermissionMode = "Strict" | "Auto" | "Yolo";
export const PERMISSION_MODES: readonly PermissionMode[] = ["Strict", "Auto", "Yolo"];

/** `Accept` (once) · `AcceptForSession` · `AcceptAlways` (persist a rule) · `Deny`. */
export type ReviewDecision = "Accept" | "Deny" | "AcceptForSession" | "AcceptAlways";

export const DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = {
  Accept: "Once",
  AcceptForSession: "Session",
  AcceptAlways: "Always",
  Deny: "Deny",
};

export type ToolEndStatus = "Completed" | "Cancelled" | "Denied" | "Failed";

export interface ToolUse {
  id: string;
  name: string;
  args: unknown;
  malformed_args?: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
}

export interface ContextWindow {
  used_tokens: number;
  limit_tokens: number;
}

export interface ModelSpec {
  id: string;
  display_name?: string | null;
  effort?: Effort | null;
  supported_efforts?: Effort[] | null;
  /**
   * Whether this model can take images (photos, screenshots) as input, as
   * announced on `SessionStart`. Absent means the host did not say — which the
   * simple surface reads as "cannot see images" (the safe direction: better to
   * tell her up front than to let the assistant invent a table).
   */
  support_vision?: boolean | null;
}

export interface ProviderSpec {
  id: string;
  display_name?: string | null;
  base_url?: string | null;
}

export interface SessionInfo {
  session_id: string;
  model: ModelSpec;
  provider: ProviderSpec;
  cwd: string;
  permission_mode: PermissionMode;
  title?: string | null;
  /** Skills the session can invoke as `/name` (announced by `SessionStart`). */
  skills?: SkillMetadata[];
}

export interface SkillMetadata {
  name: string;
  description?: string | null;
  argument_hint?: string | null;
}

export type TurnEndStatus =
  | "Completed"
  | { Interrupted: { reason?: string | null } }
  | { Error: { kind?: string | null; headline: string; details?: string[] } };

export type TurnEndReason = { kind: "ok" } | { kind: "interrupted"; reason: string } | { kind: "error"; headline: string; details: string[] };

export function readTurnEnd(status: TurnEndStatus | undefined): TurnEndReason {
  // The daemon is trusted for shape, but a future/older version or a partial
  // write must not crash the reducer: only accept fields of the right type.
  if (status === undefined || status === null || status === "Completed") return { kind: "ok" };
  if (typeof status !== "object") return { kind: "ok" };
  if ("Interrupted" in status) {
    const reason = (status as { Interrupted?: { reason?: unknown } }).Interrupted?.reason;
    return { kind: "interrupted", reason: typeof reason === "string" && reason ? reason : "interrupted by user" };
  }
  if ("Error" in status) {
    const error = (status as { Error?: { headline?: unknown; details?: unknown } }).Error;
    const headline = typeof error?.headline === "string" && error.headline ? error.headline : "turn failed";
    const raw = error?.details;
    const details = Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === "string")
      : typeof raw === "string"
        ? [raw]
        : [];
    return { kind: "error", headline, details };
  }
  return { kind: "ok" };
}

/** One `EventMsg` envelope as the bridge forwards it. */
export interface EventMsg {
  timestamp?: string;
  id?: string;
  event: unknown;
  parent?: string | null;
}

export interface BridgeStatePayload {
  status: "idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline";
  session: SessionInfo | null;
  pending_approval: PendingApproval | null;
  cante: string | null;
  cwd: string;
}

export interface PendingApproval {
  turn_id: string;
  message: string;
  tools: Array<{ id: string; name: string; args: unknown }>;
}

export interface EventsResponse {
  cursor: number;
  truncated: boolean;
  events: EventMsg[];
  state: BridgeStatePayload;
}

// ---------------------------------------------------------------------------
// Event accessors — everything below is defensive: the daemon may add fields
// or variants, and an unknown event must never take the GUI down.
// ---------------------------------------------------------------------------

export function eventName(event: unknown): string {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const key = Object.keys(event as Record<string, unknown>)[0];
    if (key) return key;
  }
  return "Unknown";
}

export function eventPayload<T = Record<string, unknown>>(event: unknown, name: string): T | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[name];
  return value === undefined ? null : (value as T);
}

export function textOf(event: unknown, name: string): string {
  const value = eventPayload(event, name);
  return typeof value === "string" ? value : "";
}

/** A compact single-line preview of a JSON tool payload. */
export function previewJson(value: unknown, limit = 220): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The human-readable body carried by a tool result, when there is one. */
export function toolResultText(result: unknown, depth = 0): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["content", "text", "stdout", "output", "message", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    const nested = record.result;
    // `result` is recursive in the protocol; bound the walk so a hostile or
    // corrupt payload cannot blow the stack.
    if (nested && typeof nested === "object" && depth < 16) {
      const inner = toolResultText(nested, depth + 1);
      if (inner) return inner;
    }
  }
  return previewJson(result);
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  const body = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  return body.slice(0, length).toUpperCase();
}
