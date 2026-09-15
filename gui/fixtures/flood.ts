#!/usr/bin/env bun
// Fast, large `cante serve` test double — the soak fixture.
//
// On the first `StartSession` it emits `CANTE_FLOOD_EVENTS` JSONL `EventMsg`
// frames as fast as the pipe allows: a `SessionStart`, a run of interleaved
// event kinds the bridge reduces, one multi-megabyte `MessageDelta` (so stdout
// framing is exercised across many pipe reads), and a final `TurnEnd` so the
// reduced state lands back on `idle`.
//
// Env knobs:
//   CANTE_FLOOD_EVENTS     total frames, including SessionStart and TurnEnd
//   CANTE_FLOOD_BIG_BYTES  byte length of the one oversized MessageDelta string
//   CANTE_FLOOD_BIG_AT     sequence number (1-based) carrying the big payload
//
// It answers `Shutdown` with `Goodbye` then exits 0, and exits 0 when stdin
// closes — the two convergence paths the real daemon has.
export {};

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const TOTAL = Math.max(3, intEnv("CANTE_FLOOD_EVENTS", 24_000));
const BIG_BYTES = intEnv("CANTE_FLOOD_BIG_BYTES", 4 * 1024 * 1024);
const BIG_AT = Math.min(
  Math.max(2, intEnv("CANTE_FLOOD_BIG_AT", Math.floor(TOTAL / 2))),
  TOTAL - 1,
);

const SESSION = {
  model: { id: "flood-model", display_name: "Flood Model" },
  provider: { id: "flood", display_name: "Flood" },
  session_id: "ses_FLOODFLOODFLOODFLOODFLOOD0",
  cwd: process.cwd(),
  permission_mode: "Strict",
  skills: [],
  subagents: [],
};

let seq = 0;
// Built once, lazily: the byte cost of the oversized payload is paid a single
// time and then re-used by every `JSON.stringify`.
let bigPayload = "";

function frame(event: unknown, parent: string | null): string {
  seq += 1;
  return (
    JSON.stringify({
      timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
      id: `evt_flood_${seq}`,
      event,
      parent,
    }) + "\n"
  );
}

// The interleaved middle run. Every kind here is reduced by the bridge (see
// `protocol::reduce_state`); the last middle event is forced to a streaming
// kind so the `TurnEnd` -> `idle` transition is observable.
function middleEvent(index: number): unknown {
  switch (index % 8) {
    case 0:
      return { ThinkingDelta: `think ${index}` };
    case 1:
      return { MessageDelta: `chunk ${index}` };
    case 2:
      return { AgentMessage: `message ${index}` };
    case 3:
      return { ToolStart: { id: `tool_${index}`, name: "Bash", args: { command: "ls" } } };
    case 4:
      return { ToolUpdate: { tool_use_id: `tool_${index}`, seq: index, message: "running" } };
    case 5:
      return {
        ToolEnd: {
          tool_use_id: `tool_${index}`,
          tool_name: "Bash",
          status: "Completed",
          result_json: { content: "ok" },
        },
      };
    case 6:
      return {
        UsageUpdate: {
          usage: { input_tokens: index, output_tokens: 1 },
          context: { used_tokens: index, limit_tokens: 200_000 },
        },
      };
    default:
      return { Info: `step ${index}` };
  }
}

// Respect backpressure so the fixture's own memory is bounded by the pipe, not
// by the whole flood. It is still "as fast as it can": when the reader keeps
// up, `write` returns true and there is no wait at all.
async function writeFrame(text: string): Promise<void> {
  if (!process.stdout.write(text)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", () => resolve()));
  }
}

async function flood(startId: string | null): Promise<void> {
  await writeFrame(frame({ SessionStart: SESSION }, startId));
  const middleCount = TOTAL - 2;
  for (let i = 0; i < middleCount; i += 1) {
    const at = i + 2; // the sequence number this frame will be given
    let event: unknown;
    if (at === BIG_AT) {
      if (!bigPayload) bigPayload = "x".repeat(BIG_BYTES);
      event = { MessageDelta: bigPayload };
    } else if (i === middleCount - 1) {
      event = { MessageDelta: "final delta" };
    } else {
      event = middleEvent(i);
    }
    await writeFrame(frame(event, startId));
  }
  await writeFrame(
    frame({ TurnEnd: { turn_id: "turn_flood", status: "Completed", steps: TOTAL } }, startId),
  );
}

let started = false;

function handle(op: unknown, id: string): void {
  if (op === "Shutdown") {
    void (async () => {
      await writeFrame(frame("Goodbye", id));
      process.exit(0);
    })();
    return;
  }
  if (typeof op === "object" && op !== null && "StartSession" in (op as Record<string, unknown>)) {
    if (!started) {
      started = true;
      void flood(id);
    }
  }
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line) as { op: unknown; id: string };
      handle(message.op, message.id);
    } catch {
      // ignore malformed input, exactly like the real daemon would not see it
    }
  }
}
process.exit(0);
