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
//   FAKE_CANTE_TURN_QUOTA=1    same shape, but the failure is the real one the
//                              gateway gave us on 2026-09 (503, out of credits).
//   FAKE_CANTE_MAKE_FILE=1     during a normal turn, write one small real
//                              result file to disk. The scripted events alone
//                              never touch the filesystem, so the app's
//                              before/after snapshot diff stays empty and the
//                              finished ResultCard (with every button on it)
//                              can never appear in automation. The file lands
//                              in the folder of the first file the turn was
//                              told to work on (the system temp directory when
//                              the turn names no file), and is removed again
//                              before this process exits.
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/** The result files this process made, removed again before it exits. */
const madeFiles: string[] = [];
let madeFileRun = 0;

/** A short, table-looking name; the suffix only appears on the 2nd run on. */
const MADE_FILE_BASE = "结果_上个月开销汇总";

/**
 * The folder a made-up result should land in: the folder of the first file the
 * turn was asked to work on.
 *
 * The app snapshots the *folders* of the chosen files before and after a run
 * (`files.rs::begin_run` / `snapshot_paths`, then `diffSnapshots`), so a result
 * written anywhere else would be invisible to the ResultCard. Free-text runs
 * name no file; they fall back to the system temp directory.
 */
function resultFolder(instruction: string): string {
  const match = /【要处理的文件】[^\n]*\n\s*1\.\s*(.+)/.exec(instruction);
  const first = match?.[1]?.trim();
  return first && first.length > 0 ? dirname(first) : tmpdir();
}

/**
 * FAKE_CANTE_MAKE_FILE=1: put one small, real file on disk during the turn.
 *
 * This is the fixture's only side effect on purpose. Everything else it does is
 * a scripted event; without this the snapshot diff is always empty and the
 * finished ResultCard is unreachable from an automated run. The numbering keeps
 * a second run in the same folder a *created* file (the first run's file is
 * still there while the process lives), which is what the diff needs to see.
 */
function makeResultFile(instruction: string): void {
  if (process.env.FAKE_CANTE_MAKE_FILE !== "1") return;
  const name = madeFileRun === 0 ? `${MADE_FILE_BASE}.csv` : `${MADE_FILE_BASE}-${madeFileRun + 1}.csv`;
  madeFileRun += 1;
  const path = join(resultFolder(instruction), name);
  // A UTF-8 BOM so Excel and WPS open the Chinese header correctly.
  const body =
    "\uFEFF日期,事项,金额\n" +
    "2026-08-03,办公用品,128.50\n" +
    "2026-08-12,差旅费,860.00\n" +
    "2026-08-25,打印纸,45.80\n";
  writeFileSync(path, body, "utf8");
  madeFiles.push(path);
}

/** Remove what this process made. Safe to call more than once. */
function cleanMadeFiles(): void {
  for (const path of madeFiles.splice(0)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // A leftover file is better than a crash while exiting.
    }
  }
}

// `Shutdown` is the graceful path; this also covers an exit from anywhere else.
process.on("exit", cleanMadeFiles);

const SESSION = {
  model: { id: "fake-model", display_name: "Fake Model" },
  provider: { id: "fake", display_name: "Fake", base_url: "http://127.0.0.1" },
  session_id: "ses_FAKEFAKEFAKEFAKEFAKEFAKEFA0",
  cwd: process.cwd(),
  permission_mode: "Strict",
  skills: [],
  subagents: [],
};

/**
 * 今天真实发生过的那条服务方失败（2026-09 欠费停机）。
 *
 * 原样保留，一个字不改：分流（`src/simple/recovery.ts` 的 `SERVICE_BUSY`）靠的
 * 就是 `insufficient credits` 与 `503` 这些可核对的特征；把它「美化」成中文就
 * 不再能证明夹具演的是现场，回归也就挡不住。测试拿它当锚点。
 */
const QUOTA_RAW =
  '503: {"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue  (reset after 15s)"}';

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
        cleanMadeFiles();
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
    const instruction = typeof record.UserInput === "string" ? record.UserInput : "";
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
    // 服务方自己欠费停机：和上面同一个形状，但吐的是今天那条真原文。
    if (process.env.FAKE_CANTE_TURN_QUOTA === "1") {
      emit({ TurnStart: { turn_id } }, id);
      emit({ MessageDelta: "starting the job" }, id);
      emit({ AgentMessage: "starting the job" }, id);
      emit({ Error: QUOTA_RAW }, id);
      emit(
        {
          TurnEnd: {
            turn_id,
            status: {
              Error: {
                kind: "service_unavailable",
                headline: "服务方暂时用不了",
                details: [QUOTA_RAW, "the service is out of credits; try again later"],
              },
            },
            steps: 1,
          },
        },
        id,
      );
      return;
    }
    // The two failure paths above produced no result, so they returned already.
    // A real result file, when asked for, is written before the turn is scripted
    // to completion (see makeResultFile).
    makeResultFile(instruction);
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
