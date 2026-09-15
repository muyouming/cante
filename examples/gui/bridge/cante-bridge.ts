#!/usr/bin/env bun
// Cante GUI bridge — HTTP <-> `cante serve` JSONL.
//
// The PocketJS GUI runs on a bounded whole-response `fetch` (no sockets, no
// streaming), so it cannot speak Cante's stdio / Unix-socket / WebSocket
// transports directly. This bridge owns the daemon process and re-exposes the
// same `Op`/`Evt` stream as a cursor-addressed HTTP long-poll:
//
//   cante (stdio JSONL)  <--spawn-->  bridge (HTTP, loopback)  <--fetch-->  GUI
//
// Batches are small (delta-coalesced, count- and byte-capped) so a single
// response always fits PocketJS's 256 KiB ceiling. The bridge is read-only
// with respect to Cante itself: it never fabricates protocol events.
//
//   bun examples/gui/bridge/cante-bridge.ts
//   CANTE_BIN=/path/to/cante CANTE_GUI_PORT=4317 bun .../cante-bridge.ts

export const BRIDGE_VERSION = "0.1.0";

/** Default loopback port; the GUI's `src/bridge.ts` points here. */
export const DEFAULT_PORT = 4317;
export const DEFAULT_HOST = "127.0.0.1";

/** Long-poll and batch bounds, all comfortably inside PocketJS's 256 KiB cap. */
export const MAX_BATCH_EVENTS = 64;
export const MAX_BATCH_BYTES = 96 * 1024;
export const MAX_POLL_MS = 25_000;
export const DEFAULT_POLL_MS = 20_000;
export const RING_CAPACITY = 4096;
/**
 * Quiet window before a parked long-poll is answered with delta-only news.
 * Without it the first token of a burst would be its own round trip; 40 ms is
 * under a frame budget's worth of visible latency and collects a whole run.
 */
export const DELTA_QUIET_MS = 40;

export type DaemonStatus = "idle" | "thinking" | "streaming" | "awaiting" | "error" | "offline";

export interface EventMsg {
  timestamp?: string;
  id?: string;
  event: unknown;
  parent?: string | null;
}

export interface PendingApproval {
  turn_id: string;
  message: string;
  tools: Array<{ id: string; name: string; args: unknown }>;
}

export interface BridgeState {
  status: DaemonStatus;
  session: Record<string, unknown> | null;
  pending_approval: PendingApproval | null;
  cante: string | null;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Ids — Cante ids are `{prefix}_{ULID}`, so the bridge mints real ULIDs.
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_TIME_CHARS = 10;
const ULID_RANDOM_CHARS = 16;

function encodeTime(time: number): string {
  let out = "";
  let value = time;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < ULID_RANDOM_CHARS; i++) out += CROCKFORD[bytes[i]! % 32];
  return out;
}

/** A monotonic, spec-shaped ULID (48-bit ms timestamp + 80 bits of entropy). */
export function makeUlid(now = Date.now(), random?: Uint8Array): string {
  const bytes = random ?? new Uint8Array(ULID_RANDOM_CHARS);
  if (!random) crypto.getRandomValues(bytes);
  return encodeTime(now) + encodeRandom(bytes);
}

export function makeOpId(): string {
  return `op_${makeUlid()}`;
}

// ---------------------------------------------------------------------------
// Framing — the daemon emits one JSON object per line, and chunk boundaries
// land anywhere, so lines are reassembled before parsing.
// ---------------------------------------------------------------------------

export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = "";
  return (chunk: string) => {
    pending += chunk;
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/** The externally-tagged variant name of an `Evt` (unit variants are strings). */
export function eventName(event: unknown): string {
  if (typeof event === "string") return event;
  if (event && typeof event === "object") {
    const key = Object.keys(event as Record<string, unknown>)[0];
    if (key) return key;
  }
  return "Unknown";
}

export function eventPayload(event: unknown, name: string): Record<string, unknown> | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>)[name];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function initialBridgeState(cwd: string): BridgeState {
  return { status: "idle", session: null, pending_approval: null, cante: null, cwd };
}

/** Fold one daemon event into the bridge's advertised state. */
export function reduceState(state: BridgeState, event: unknown): BridgeState {
  const name = eventName(event);
  const payload = eventPayload(event, name);
  switch (name) {
    case "SessionStart":
    case "SessionUpdated":
      return {
        ...state,
        session: (event as Record<string, unknown>)[name] as Record<string, unknown>,
        pending_approval: null,
        status: "idle",
      };
    case "SessionEnd":
      return { ...state, session: null, pending_approval: null, status: "offline" };
    case "TurnStart":
      return { ...state, status: "thinking", pending_approval: null };
    case "Thinking":
    case "ThinkingDelta":
      return state.status === "awaiting" ? state : { ...state, status: "thinking" };
    case "AgentMessage":
    case "MessageDelta":
    case "ToolStart":
    case "ToolUpdate":
    case "ToolEnd":
      return state.status === "awaiting" ? state : { ...state, status: "streaming" };
    case "TurnPause": {
      const reason = payload?.reason as Record<string, unknown> | undefined;
      const approval = reason?.Approval as Record<string, unknown> | undefined;
      if (!approval) return state;
      const tools = Array.isArray(approval.tools) ? approval.tools : [];
      return {
        ...state,
        status: "awaiting",
        pending_approval: {
          turn_id: String(payload?.turn_id ?? ""),
          message: String(approval.message ?? ""),
          tools: tools.map((tool) => {
            const record = (tool ?? {}) as Record<string, unknown>;
            return {
              id: String(record.id ?? ""),
              name: String(record.name ?? ""),
              args: record.args ?? null,
            };
          }),
        },
      };
    }
    case "TurnResume":
      return { ...state, status: "streaming", pending_approval: null };
    case "TurnEnd":
      return { ...state, status: state.status === "error" ? "error" : "idle", pending_approval: null };
    case "Error":
      return { ...state, status: "error" };
    case "Goodbye":
      return { ...state, status: "offline", pending_approval: null };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Batch building — coalesce runs of deltas so a chatty turn still fits one
// response, then cap by count and encoded bytes.
// ---------------------------------------------------------------------------

const DELTA_KINDS = new Set(["MessageDelta", "ThinkingDelta"]);

/** Merge adjacent deltas of the same kind. Identity-stable for other events. */
export function coalesceDeltas(events: EventMsg[]): EventMsg[] {
  const out: EventMsg[] = [];
  for (const message of events) {
    const name = eventName(message.event);
    const previous = out[out.length - 1];
    if (previous && DELTA_KINDS.has(name) && eventName(previous.event) === name) {
      const head = String((previous.event as Record<string, unknown>)[name] ?? "");
      const tail = String((message.event as Record<string, unknown>)[name] ?? "");
      out[out.length - 1] = { ...previous, event: { [name]: head + tail } };
      continue;
    }
    out.push(message);
  }
  return out;
}

export interface Batch {
  events: EventMsg[];
  cursor: number;
  truncated: boolean;
}

/** Slice `[cursor, head)` out of the ring, bounded by count and bytes. */
export function buildBatch(ring: EventMsg[], first: number, head: number, cursor: number): Batch {
  const start = Math.max(cursor, first);
  const end = Math.min(head, start + MAX_BATCH_EVENTS);
  const out: EventMsg[] = [];
  let bytes = 2;
  let consumed = 0;
  for (let index = start; index < end; index++) {
    const message = ring[index - first]!;
    const name = eventName(message.event);
    const previous = out[out.length - 1];
    const merges = previous !== undefined && DELTA_KINDS.has(name) && eventName(previous.event) === name;
    const candidate: EventMsg = merges
      ? {
          ...previous,
          event: {
            [name]:
              String((previous.event as Record<string, unknown>)[name] ?? "") +
              String((message.event as Record<string, unknown>)[name] ?? ""),
          },
        }
      : message;
    const size = merges
      ? JSON.stringify(candidate).length - JSON.stringify(previous).length
      : JSON.stringify(candidate).length + 1;
    // Always make progress: a single oversized event still goes out.
    if (consumed > 0 && bytes + size > MAX_BATCH_BYTES) break;
    if (merges) out[out.length - 1] = candidate;
    else out.push(candidate);
    bytes += size;
    consumed += 1;
  }
  const next = start + consumed;
  return { events: out, cursor: next, truncated: next < head };
}

// ---------------------------------------------------------------------------
// Daemon — owns `cante serve`, the event ring, and long-poll waiters.
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface DaemonOptions {
  bin?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  capacity?: number;
  onLog?: (line: string) => void;
}

export class CanteDaemon {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private ring: EventMsg[] = [];
  private head = 0;
  private waiters: Waiter[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail: string[] = [];
  state: BridgeState;

  constructor(private readonly options: DaemonOptions = {}) {
    this.state = initialBridgeState(options.cwd ?? process.cwd());
  }

  get running(): boolean {
    return this.proc !== null;
  }

  get capacity(): number {
    return this.options.capacity ?? RING_CAPACITY;
  }

  /** First ring index still retained (older events are dropped). */
  private get first(): number {
    return this.head - this.ring.length;
  }

  private log(line: string): void {
    this.options.onLog?.(line);
  }

  start(): void {
    if (this.proc) return;
    const bin = this.options.bin ?? process.env.CANTE_BIN ?? "cante";
    let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: [bin, "serve"],
        cwd: this.options.cwd ?? process.cwd(),
        env: { ...process.env, ...this.options.env },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }) as Bun.Subprocess<"pipe", "pipe", "pipe">;
    } catch (error) {
      this.state = { ...this.state, status: "offline" };
      throw new Error(`could not start \`${bin} serve\`: ${(error as Error).message}`);
    }
    this.proc = proc;
    this.state = { ...this.state, status: "idle" };

    const feed = createLineSplitter((line) => {
      try {
        this.push(JSON.parse(line) as EventMsg);
      } catch {
        this.log(`skipping non-JSON daemon line: ${line.slice(0, 200)}`);
      }
    });
    void (async () => {
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          feed(new TextDecoder().decode(chunk, { stream: true }));
        }
      } catch {
        /* stream closed with the process */
      }
    })();
    void (async () => {
      try {
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          const text = new TextDecoder().decode(chunk).trimEnd();
          if (!text) continue;
          this.stderrTail.push(text);
          if (this.stderrTail.length > 8) this.stderrTail.shift();
          this.log(`cante: ${text}`);
        }
      } catch {
        /* stream closed with the process */
      }
    })();
    void proc.exited.then(() => {
      if (this.proc === proc) this.proc = null;
      this.state = { ...this.state, status: "offline", pending_approval: null };
      this.wake();
    });
  }

  /** Send one operation (a struct variant or a bare unit variant); returns its op id. */
  send(op: Record<string, unknown> | string): string {
    if (!this.proc) this.start();
    const id = makeOpId();
    const frame = JSON.stringify({ op, id }) + "\n";
    const stdin = this.proc!.stdin as Bun.FileSink;
    stdin.write(frame);
    void stdin.flush();
    return id;
  }

  private push(message: EventMsg): void {
    this.ring.push(message);
    this.head += 1;
    const overflow = this.ring.length - this.capacity;
    if (overflow > 0) this.ring.splice(0, overflow);
    this.state = reduceState(this.state, message.event);
    this.scheduleWake(eventName(message.event));
  }

  /**
   * Wake parked polls, giving a delta burst a short quiet window so one
   * response carries the run rather than its first token. Structural events
   * (tool calls, turn ends, errors, session changes) flush immediately — the
   * caller is waiting on those.
   */
  private scheduleWake(name: string): void {
    if (this.waiters.length === 0) return;
    if (!DELTA_KINDS.has(name)) {
      this.flushNow();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.wake();
    }, DELTA_QUIET_MS);
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.wake();
  }

  private wake(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  /** Resolve when the head moves past `cursor`, or after `timeoutMs`. */
  wait(cursor: number, timeoutMs: number): Promise<void> {
    if (this.head > cursor) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          resolve();
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  batch(cursor: number): Batch {
    return buildBatch(this.ring, this.first, this.head, cursor);
  }

  get headCursor(): number {
    return this.head;
  }

  recentStderr(): string[] {
    return [...this.stderrTail];
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    const op = makeOpId();
    try {
      const stdin = this.proc.stdin as Bun.FileSink;
      stdin.write(JSON.stringify({ op: "Shutdown", id: op }) + "\n");
      await stdin.flush();
    } catch {
      /* the daemon may already be gone */
    }
    const proc = this.proc;
    const closed = proc.exited.then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500));
    if (!(await Promise.race([closed, timeout]))) proc.kill();
    this.proc = null;
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

export interface ServerOptions extends DaemonOptions {
  host?: string;
  port?: number;
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function clampPoll(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_MS;
  return Math.min(Math.floor(raw), MAX_POLL_MS);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createBridgeServer(options: ServerOptions = {}) {
  const daemon = new CanteDaemon(options);
  let catalogCache: { at: number; value: unknown } | null = null;
  let versionCache: string | null = null;

  async function runCante(args: string[], timeoutMs = 10_000): Promise<string> {
    const bin = options.bin ?? process.env.CANTE_BIN ?? "cante";
    const proc = Bun.spawn({
      cmd: [bin, ...args],
      cwd: options.cwd ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return stdout;
  }

  const server = Bun.serve({
    hostname: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      const route = `${request.method} ${url.pathname}`;
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

      switch (route) {
        case "GET /healthz": {
          if (versionCache === null) {
            try {
              versionCache = (await runCante(["--version"], 5_000)).trim().split("\n")[0] ?? null;
            } catch {
              versionCache = null;
            }
          }
          return json({
            ok: true,
            bridge: BRIDGE_VERSION,
            cante: versionCache,
            cwd: daemon.state.cwd,
            daemon: daemon.running,
            status: daemon.state.status,
            stderr: daemon.recentStderr(),
          });
        }

        case "GET /catalog": {
          if (catalogCache && Date.now() - catalogCache.at < 60_000) return json(catalogCache.value);
          try {
            const parsed = JSON.parse(await runCante(["catalog"], 15_000));
            catalogCache = { at: Date.now(), value: parsed };
            return json(parsed);
          } catch (error) {
            return json({ error: `catalog unavailable: ${(error as Error).message}` }, 503);
          }
        }

        case "GET /events": {
          const cursor = Math.max(0, Math.floor(Number(url.searchParams.get("cursor") ?? "0")));
          const poll = clampPoll(url.searchParams.get("timeout_ms"));
          await daemon.wait(cursor, poll);
          const batch = daemon.batch(cursor);
          return json({ ...batch, state: daemon.state });
        }

        case "POST /session": {
          const body = await readJson(request);
          if (!daemon.running) daemon.start();
          const request_: Record<string, unknown> = {};
          for (const key of [
            "model",
            "provider",
            "permission_mode",
            "effort",
            "cwd",
            "system_prompt",
            "append_system_prompt",
          ]) {
            if (body[key] !== undefined && body[key] !== null) request_[key] = body[key];
          }
          const resume = typeof body.resume_session_id === "string" ? body.resume_session_id : null;
          const op = resume
            ? { ResumeSession: { session_id: resume, unattended: false } }
            : { StartSession: request_ };
          return json({ ok: true, op: daemon.send(op) });
        }

        case "POST /update": {
          const body = await readJson(request);
          const update: Record<string, unknown> = {};
          if (body.model && typeof body.model === "object") update.model = body.model;
          if (typeof body.permission_mode === "string") update.permission_mode = body.permission_mode;
          if (typeof body.title === "string") update.title = body.title;
          if (Object.keys(update).length === 0) return json({ error: "nothing to update" }, 400);
          return json({ ok: true, op: daemon.send({ UpdateSession: update }) });
        }

        case "POST /input": {
          const body = await readJson(request);
          const text = typeof body.text === "string" ? body.text : "";
          if (!text.trim()) return json({ error: "text is required" }, 400);
          const mode = typeof body.mode === "string" ? body.mode : "prompt";
          const op =
            mode === "steer" ? { Steer: text } : mode === "shell" ? { ShellInput: text } : { UserInput: text };
          return json({ ok: true, op: daemon.send(op) });
        }

        case "POST /approval": {
          const body = await readJson(request);
          const turn_id = typeof body.turn_id === "string" ? body.turn_id : "";
          const responses = Array.isArray(body.responses) ? body.responses : [];
          if (!turn_id || responses.length === 0) return json({ error: "turn_id and responses are required" }, 400);
          return json({ ok: true, op: daemon.send({ ApprovalResponse: { turn_id, responses } }) });
        }

        case "POST /interrupt":
          return json({ ok: true, op: daemon.send("Interrupt") });

        case "POST /slash": {
          const body = await readJson(request);
          return json({
            ok: true,
            op: daemon.send({ SlashCommand: { name: String(body.name ?? ""), args: String(body.args ?? "") } }),
          });
        }

        case "POST /goal": {
          const body = await readJson(request);
          const command = typeof body.command === "string" ? body.command : "Status";
          const op =
            command === "Set"
              ? { Goal: { Set: String(body.condition ?? "") } }
              : command === "Clear"
                ? { Goal: "Clear" }
                : { Goal: "Status" };
          return json({ ok: true, op: daemon.send(op) });
        }

        case "POST /compact": {
          const body = await readJson(request);
          const op =
            typeof body.instructions === "string"
              ? { Compact: { instructions: body.instructions } }
              : { Compact: {} };
          return json({ ok: true, op: daemon.send(op) });
        }

        case "POST /context":
          return json({ ok: true, op: daemon.send("ContextReport") });

        case "POST /shutdown": {
          await daemon.shutdown();
          return json({ ok: true });
        }

        default:
          return json({ error: `no route for ${route}` }, 404);
      }
    },
  });

  return { server, daemon };
}

if (import.meta.main) {
  const port = Number(process.env.CANTE_GUI_PORT ?? DEFAULT_PORT);
  const host = process.env.CANTE_GUI_HOST ?? DEFAULT_HOST;
  const { server, daemon } = createBridgeServer({ host, port });
  console.log(`cante gui bridge v${BRIDGE_VERSION} on http://${host}:${port}`);
  console.log(`  daemon binary: ${process.env.CANTE_BIN ?? "cante"} (started on first /session)`);
  console.log(`  cwd:           ${daemon.state.cwd}`);
  const stop = async () => {
    await daemon.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
