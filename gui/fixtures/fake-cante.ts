#!/usr/bin/env bun
// Test double for `cante serve` — reads `OpMsg` JSON Lines on stdin and
// answers with a scripted `EventMsg` stream. It is never shipped. The ops and
// events use the real externally-tagged wire shapes from
// `crates/protocol-shape/src/msg.rs`, so the Rust bridge can forward them
// verbatim and `../src/protocol.ts` can read them.
//
// Scripted by op:
//   StartSession     -> SessionStart (+ FAKE_CANTE_SEED=1: a seeded transcript)
//   UserInput        -> TurnStart … approval TurnPause (turn_1)
//   ApprovalResponse -> TurnResume, one ToolEnd per parked call, UsageUpdate,
//                       TurnEnd (Completed). Each call's ToolEnd status follows
//                       its own decision: accepted -> Completed, denied -> Denied
//                       with no ToolStart after the resume (the call never ran).
//   Goal             -> Info
//   Interrupt        -> TurnEnd (Interrupted)
//   Shutdown         -> Goodbye, then exit 0
//
// Env knobs:
//   FAKE_CANTE_SLOW_DELTAS=1   split the delta run across a tick, no TurnStart,
//                              to prove the bridge's quiet-window coalescing.
//   FAKE_CANTE_SEED=1          on StartSession, emit a finished exchange plus a
//                              pending approval, so the window opens populated.
//   FAKE_CANTE_APPROVAL_BATCH  how many calls the scripted turn parks on (real
//                              cante pauses a whole batch at once; default 1).
//   FAKE_CANTE_TURN_ERROR=1    make UserInput fail mid-turn: an Error event
//                              followed by a non-Completed TurnEnd.
export {};

let eventSeq = 0;
function emit(event: unknown, parent: string | null = null): void {
  eventSeq += 1;
  const frame = {
    timestamp: new Date(1_700_000_000_000 + eventSeq * 1000).toISOString(),
    id: `evt_FAKEFAKEFAKEFAKEFAKEFAKEFA${String(eventSeq).padStart(2, "0")}`,
    event,
    parent,
  };
  process.stdout.write(JSON.stringify(frame) + "\n");
}

const SESSION = {
  model: { id: "fake-model", display_name: "Fake Model" },
  provider: { id: "fake", display_name: "Fake", base_url: "http://127.0.0.1" },
  session_id: "ses_FAKEFAKEFAKEFAKEFAKEFAKEFA0",
  cwd: process.cwd(),
  permission_mode: "Strict",
  skills: [],
  subagents: [],
};

/** A call the scripted turn parks on. `args` is echoed verbatim. */
interface ParkedTool {
  id: string;
  name: string;
  args: unknown;
}

/** The calls the last UserInput parked on; ApprovalResponse closes exactly these. */
let parkedTools: ParkedTool[] = [];

/**
 * The scripted batch, sized by FAKE_CANTE_APPROVAL_BATCH.
 *
 * Real cante holds a whole batch of calls and asks about them at once, so the
 * approval card has to render more than one row. The knob keeps the default
 * single-call script intact and lets a test ask for the batch; the catalogue is
 * fixed so ids stay stable and an out-of-range value clamps to a real script.
 */
function approvalBatch(): ParkedTool[] {
  const parsed = Number.parseInt(process.env.FAKE_CANTE_APPROVAL_BATCH ?? "1", 10);
  const size = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 4) : 1;
  const script: ParkedTool[] = [
    { id: "tool_1", name: "Bash", args: { command: "ls" } },
    { id: "tool_2", name: "Write", args: { path: "merged-result.xlsx" } },
    { id: "tool_3", name: "Edit", args: { file_path: "report.xlsx" } },
    { id: "tool_4", name: "Read", args: { file_path: "roster.xlsx" } },
  ];
  return script.slice(0, size);
}

// A short, already-finished turn followed by a turn parked on approval. Every
// event below is a shape real cante emits (see `Evt` in protocol-shape).
function seedTranscript(parent: string): void {
  emit({ UserInput: "Summarise the repository layout" }, parent);
  emit({ TurnStart: { turn_id: "turn_seed_1" } }, parent);
  emit({ ThinkingDelta: "scanning the workspace " }, parent);
  emit({ MessageDelta: "The repo is a Rust workspace" }, parent);
  emit({ AgentMessage: "The repo is a Rust workspace with a docs site, examples and this Tauri GUI." }, parent);
  emit({ ToolStart: { id: "tool_seed_1", name: "Bash", args: { command: "ls" } } }, parent);
  emit({ ToolUpdate: { tool_use_id: "tool_seed_1", seq: 1, message: "listing" } }, parent);
  emit(
    {
      ToolEnd: {
        tool_use_id: "tool_seed_1",
        tool_name: "Bash",
        status: "Completed",
        result_json: { content: "crates\ndocs-site\ngui" },
      },
    },
    parent,
  );
  emit(
    { UsageUpdate: { usage: { input_tokens: 120, output_tokens: 18 }, context: { used_tokens: 138, limit_tokens: 200_000 } } },
    parent,
  );
  emit({ TurnEnd: { turn_id: "turn_seed_1", status: "Completed", steps: 2 } }, parent);
  emit({ TurnStart: { turn_id: "turn_seed_2" } }, parent);
  emit({ AgentMessage: "I would like to write the missing README." }, parent);
  emit({ ToolStart: { id: "tool_seed_2", name: "Write", args: { path: "gui/README.md", content: "…" } } }, parent);
  parkedTools = [{ id: "tool_seed_2", name: "Write", args: { path: "gui/README.md" } }];
  emit(
    {
      TurnPause: {
        turn_id: "turn_seed_2",
        reason: {
          Approval: {
            tools: [{ id: "tool_seed_2", name: "Write", args: { path: "gui/README.md" } }],
            message: "Allow Write to gui/README.md?",
          },
        },
      },
    },
    parent,
  );
}

function handle(op: unknown, id: string): void {
  if (typeof op === "string") {
    switch (op) {
      case "Interrupt":
        emit({ TurnEnd: { turn_id: "turn_1", status: { Interrupted: { reason: "user" } }, steps: 1 } }, id);
        return;
      case "Shutdown":
        emit("Goodbye", id);
        process.exit(0);
        return;
      default:
        return;
    }
  }
  const record = op as Record<string, unknown>;
  if ("StartSession" in record) {
    emit({ SessionStart: SESSION }, id);
    if (process.env.FAKE_CANTE_SEED === "1") seedTranscript(id);
    return;
  }
  if ("Goal" in record) {
    const goal = record.Goal as unknown;
    const text =
      typeof goal === "string" ? `goal ${goal.toLowerCase()}` : `goal set: ${String((goal as { Set?: string }).Set ?? "")}`;
    emit({ Info: text }, id);
    return;
  }
  if ("UserInput" in record) {
    const turn_id = "turn_1";
    // Mid-turn failure: real cante reports the cause once as `Error`, then
    // closes the turn with a non-Completed status the error page reads.
    if (process.env.FAKE_CANTE_TURN_ERROR === "1") {
      emit({ TurnStart: { turn_id } }, id);
      emit({ MessageDelta: "starting the job" }, id);
      emit({ AgentMessage: "starting the job" }, id);
      emit({ Error: "provider error: HTTP 429 Too Many Requests" }, id);
      emit(
        {
          TurnEnd: {
            turn_id,
            status: {
              Error: {
                kind: "rate_limited",
                headline: "rate limited",
                details: ["HTTP 429 Too Many Requests", "the gateway asked us to slow down"],
              },
            },
            steps: 1,
          },
        },
        id,
      );
      return;
    }
    // Slow mode splits the delta run across a tick so tests can prove the
    // bridge's quiet window coalesces it instead of returning token by token.
    if (process.env.FAKE_CANTE_SLOW_DELTAS === "1") {
      // No TurnStart: a structural event would flush the parked poll
      // immediately, and the point here is the delta-only quiet window.
      emit({ MessageDelta: "hello " }, id);
      setTimeout(() => {
        emit({ MessageDelta: "world" }, id);
        emit({ AgentMessage: "hello world" }, id);
        emit({ TurnEnd: { turn_id, status: "Completed", steps: 1 } }, id);
      }, 30);
      return;
    }
    emit({ TurnStart: { turn_id } }, id);
    emit({ ThinkingDelta: "thinking " }, id);
    emit({ ThinkingDelta: "hard" }, id);
    emit({ MessageDelta: "hello " }, id);
    emit({ MessageDelta: "world" }, id);
    emit({ AgentMessage: "hello world" }, id);
    parkedTools = approvalBatch();
    parkedTools.forEach((tool, index) => {
      emit({ ToolStart: { id: tool.id, name: tool.name, args: tool.args } }, id);
      emit({ ToolUpdate: { tool_use_id: tool.id, seq: 1, message: index === 0 ? "running" : "preparing" } }, id);
    });
    emit(
      {
        TurnPause: {
          turn_id,
          reason: {
            Approval: {
              tools: parkedTools.map((tool) => ({ id: tool.id, name: tool.name, args: tool.args })),
              message: "Allow?",
            },
          },
        },
      },
      id,
    );
    return;
  }
  if ("ApprovalResponse" in record) {
    // The window answers the whole batch at once; each call is closed by its own
    // decision. A denied call never started, so it gets no ToolStart after the
    // resume — only a Denied ToolEnd, which is how the row is coloured.
    const responses =
      (record.ApprovalResponse as { responses?: Array<{ tool_use_id?: string; decision?: string }> }).responses ?? [];
    const tools = parkedTools.length > 0 ? parkedTools : [{ id: "tool_1", name: "Bash", args: { command: "ls" } }];
    emit({ TurnResume: { turn_id: "turn_1" } }, id);
    for (const tool of tools) {
      const decision = responses.find((response) => response.tool_use_id === tool.id)?.decision ?? "Deny";
      const accepted = decision === "Accept" || decision === "AcceptForSession" || decision === "AcceptAlways";
      emit(
        {
          ToolEnd: {
            tool_use_id: tool.id,
            tool_name: tool.name,
            status: accepted ? "Completed" : "Denied",
            result_json: { content: accepted ? "ok" : "the user denied this call" },
          },
        },
        id,
      );
    }
    emit({ UsageUpdate: { usage: { input_tokens: 10, output_tokens: 2 }, context: { used_tokens: 12, limit_tokens: 100 } } }, id);
    emit({ TurnEnd: { turn_id: "turn_1", status: "Completed", steps: 2 } }, id);
    return;
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
