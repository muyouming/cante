// Drives `fixtures/fake-cante.ts` over real pipes: spawn the script, write
// `OpMsg` lines to its stdin, read `EventMsg` lines from its stdout. The test
// never re-implements the protocol — it only frames and asserts on what the
// double actually emits.
import { join } from "node:path";

import { expect, test } from "bun:test";

import { eventName } from "../src/protocol.ts";

const FAKE = join(import.meta.dir, "fake-cante.ts");
const BUN = process.execPath;

interface Frame {
  timestamp?: string;
  id?: string;
  event: unknown;
  parent?: string | null;
}

interface Fake {
  proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  send(op: unknown): Promise<string>;
  next(): Promise<Frame>;
  close(): Promise<void>;
}

/** Split a byte stream into lines, resolving `next()` as they arrive. */
function lineQueue(stream: ReadableStream<Uint8Array>) {
  const buffered: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  const push = (line: string) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  };

  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          push(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      }
    } finally {
      if (pending) push(pending);
      closed = true;
      for (const waiter of waiters.splice(0)) waiter(null);
    }
  })();

  return {
    async next(): Promise<string> {
      if (buffered.length) return buffered.shift()!;
      if (closed) throw new Error("fake-cante closed stdout");
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a line")), 5000);
        waiters.push((line) => {
          clearTimeout(timer);
          if (line === null) reject(new Error("fake-cante closed stdout"));
          else resolve(line);
        });
      });
    },
  };
}

let opSeq = 0;

function spawnFake(env: Record<string, string> = {}): Fake {
  const proc = Bun.spawn([BUN, FAKE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const queue = lineQueue(proc.stdout);

  return {
    proc,
    async send(op: unknown): Promise<string> {
      const id = `op_TEST${String(++opSeq).padStart(4, "0")}`;
      proc.stdin.write(JSON.stringify({ op, id }) + "\n");
      await proc.stdin.flush();
      return id;
    },
    async next(): Promise<Frame> {
      const line = await queue.next();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`stdout line is not JSON: ${JSON.stringify(line)}`);
      }
      // The requirement is one JSON *object* per line.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`expected one JSON object per line, got: ${line}`);
      }
      return parsed as Frame;
    },
    async close(): Promise<void> {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      await proc.exited;
    },
  };
}

/** Assert the frame names `name` and return its payload (unit variants -> {}). */
function named(frame: Frame, name: string): any {
  expect(eventName(frame.event)).toBe(name);
  if (frame.event && typeof frame.event === "object") {
    return (frame.event as Record<string, unknown>)[name] ?? {};
  }
  return {};
}

test("StartSession answers with a SessionStart envelope correlated to the op", async () => {
  const fake = spawnFake();
  try {
    const opId = await fake.send({ StartSession: {} });
    const frame = await fake.next();

    expect(frame.parent).toBe(opId);
    expect(typeof frame.timestamp).toBe("string");
    expect(String(frame.id)).toMatch(/^evt_/);

    const session = named(frame, "SessionStart");
    expect(String(session.session_id)).toMatch(/^ses_/);
    expect(session.model.id).toBe("fake-model");
    expect(session.provider.id).toBe("fake");
    expect(session.permission_mode).toBe("Strict");
    expect(Array.isArray(session.skills)).toBe(true);
  } finally {
    await fake.close();
  }
});

test("UserInput streams a turn and parks on an approval pause", async () => {
  const fake = spawnFake();
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");

    await fake.send({ UserInput: "list the files" });
    const seen: string[] = [];
    let pause: any;
    for (let i = 0; i < 20 && !pause; i++) {
      const frame = await fake.next();
      const name = eventName(frame.event);
      seen.push(name);
      if (name === "TurnPause") pause = frame.event;
    }

    expect(seen).toEqual([
      "TurnStart",
      "ThinkingDelta",
      "ThinkingDelta",
      "MessageDelta",
      "MessageDelta",
      "AgentMessage",
      "ToolStart",
      "ToolUpdate",
      "TurnPause",
    ]);
    expect(pause.TurnPause.turn_id).toBe("turn_1");
    expect(pause.TurnPause.reason.Approval.message).toBe("Allow?");
    expect(pause.TurnPause.reason.Approval.tools[0]).toMatchObject({ id: "tool_1", name: "Bash", args: { command: "ls" } });
  } finally {
    await fake.close();
  }
});

test("ApprovalResponse resumes, ends the tool, then completes the turn", async () => {
  const fake = spawnFake();
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");
    await fake.send({ UserInput: "list the files" });
    while (eventName((await fake.next()).event) !== "TurnPause") {
      // drain the scripted turn
    }

    await fake.send({
      ApprovalResponse: { turn_id: "turn_1", responses: [{ tool_use_id: "tool_1", decision: "Accept" }] },
    });

    expect(named(await fake.next(), "TurnResume").turn_id).toBe("turn_1");
    const toolEnd = named(await fake.next(), "ToolEnd");
    expect(toolEnd).toMatchObject({ tool_use_id: "tool_1", tool_name: "Bash", status: "Completed" });
    expect(toolEnd.result_json).toEqual({ content: "ok" });
    const usage = named(await fake.next(), "UsageUpdate");
    expect(usage.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(usage.context).toEqual({ used_tokens: 12, limit_tokens: 100 });
    const end = named(await fake.next(), "TurnEnd");
    expect(end).toMatchObject({ turn_id: "turn_1", status: "Completed", steps: 2 });
  } finally {
    await fake.close();
  }
});

test("FAKE_CANTE_APPROVAL_BATCH parks a whole batch and answers each call on its own decision", async () => {
  const fake = spawnFake({ FAKE_CANTE_APPROVAL_BATCH: "2" });
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");
    await fake.send({ UserInput: "tidy two files" });

    const before: string[] = [];
    let pause: any;
    for (let i = 0; i < 30 && !pause; i++) {
      const frame = await fake.next();
      before.push(eventName(frame.event));
      if (eventName(frame.event) === "TurnPause") pause = frame.event;
    }

    const tools = pause.TurnPause.reason.Approval.tools;
    expect(tools.map((tool: any) => tool.id)).toEqual(["tool_1", "tool_2"]);
    // Both calls are announced and then parked in one pause: the batch the
    // approval card is designed to list.
    expect(before.filter((name) => name === "ToolStart")).toHaveLength(2);
    expect(before.at(-1)).toBe("TurnPause");

    await fake.send({
      ApprovalResponse: {
        turn_id: "turn_1",
        responses: [
          { tool_use_id: "tool_1", decision: "Accept" },
          { tool_use_id: "tool_2", decision: "AcceptAlways" },
        ],
      },
    });

    const after: string[] = [];
    const ends: any[] = [];
    for (;;) {
      const frame = await fake.next();
      const name = eventName(frame.event);
      after.push(name);
      if (name === "ToolEnd") ends.push(named(frame, "ToolEnd"));
      if (name === "TurnEnd") break;
    }
    expect(after).toEqual(["TurnResume", "ToolEnd", "ToolEnd", "UsageUpdate", "TurnEnd"]);
    expect(ends.map((end) => [end.tool_use_id, end.status])).toEqual([
      ["tool_1", "Completed"],
      ["tool_2", "Completed"],
    ]);
  } finally {
    await fake.close();
  }
});

test("a denied call resumes the turn and closes as Denied without ever starting", async () => {
  const fake = spawnFake({ FAKE_CANTE_APPROVAL_BATCH: "2" });
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");
    await fake.send({ UserInput: "tidy two files" });
    while (eventName((await fake.next()).event) !== "TurnPause") {
      // drain up to the pause
    }

    await fake.send({
      ApprovalResponse: {
        turn_id: "turn_1",
        responses: [
          { tool_use_id: "tool_1", decision: "Deny" },
          { tool_use_id: "tool_2", decision: "Accept" },
        ],
      },
    });

    const after: string[] = [];
    const ends: any[] = [];
    for (;;) {
      const frame = await fake.next();
      const name = eventName(frame.event);
      after.push(name);
      if (name === "ToolEnd") ends.push(named(frame, "ToolEnd"));
      if (name === "TurnEnd") break;
    }
    // The effect of a refusal: the call never ran, so no ToolStart follows the
    // resume — only the Denied ToolEnd that colours its row.
    expect(after).not.toContain("ToolStart");
    expect(after).toEqual(["TurnResume", "ToolEnd", "ToolEnd", "UsageUpdate", "TurnEnd"]);
    expect(ends.map((end) => [end.tool_use_id, end.status])).toEqual([
      ["tool_1", "Denied"],
      ["tool_2", "Completed"],
    ]);
    expect(String(ends[0].result_json.content)).toContain("denied");
  } finally {
    await fake.close();
  }
});

test("FAKE_CANTE_TURN_ERROR reports Error then a non-Completed TurnEnd", async () => {
  const fake = spawnFake({ FAKE_CANTE_TURN_ERROR: "1" });
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");
    await fake.send({ UserInput: "run the job" });

    const seen: string[] = [];
    let reported: any;
    let end: any;
    for (let i = 0; i < 20 && !end; i++) {
      const frame = await fake.next();
      const name = eventName(frame.event);
      seen.push(name);
      if (name === "Error") reported = named(frame, "Error");
      if (name === "TurnEnd") end = named(frame, "TurnEnd");
    }

    expect(reported).toBe("provider error: HTTP 429 Too Many Requests");
    expect(seen.at(-1)).toBe("TurnEnd");
    // Externally tagged struct variant with the machine-readable kind, exactly
    // the shape the store's error page reads.
    expect(end).toEqual({
      turn_id: "turn_1",
      status: {
        Error: {
          kind: "rate_limited",
          headline: "rate limited",
          details: ["HTTP 429 Too Many Requests", "the gateway asked us to slow down"],
        },
      },
      steps: 1,
    });
  } finally {
    await fake.close();
  }
});

test("Goal answers with Info for Set, Status and Clear", async () => {
  const fake = spawnFake();
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");

    await fake.send({ Goal: { Set: "tests pass" } });
    expect(named(await fake.next(), "Info")).toBe("goal set: tests pass");

    await fake.send({ Goal: "Status" });
    expect(named(await fake.next(), "Info")).toBe("goal status");

    await fake.send({ Goal: "Clear" });
    expect(named(await fake.next(), "Info")).toBe("goal clear");
  } finally {
    await fake.close();
  }
});

test("Interrupt ends the turn with a structured Interrupted status", async () => {
  const fake = spawnFake();
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");

    await fake.send("Interrupt");
    const end = named(await fake.next(), "TurnEnd");
    // Externally tagged struct variant, not a bare "Interrupted" string.
    expect(end.status).toEqual({ Interrupted: { reason: "user" } });
  } finally {
    await fake.close();
  }
});

test("Shutdown answers Goodbye and the process exits 0", async () => {
  const fake = spawnFake();
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");

    await fake.send("Shutdown");
    expect(eventName((await fake.next()).event)).toBe("Goodbye");

    const code = await Promise.race([fake.proc.exited, Bun.sleep(2000).then(() => "timeout" as const)]);
    expect(code).toBe(0);
  } finally {
    await fake.close();
  }
});

test("malformed stdin lines are ignored without desynchronising the stream", async () => {
  const fake = spawnFake();
  try {
    fake.proc.stdin.write("not json at all\n");
    await fake.proc.stdin.flush();

    const opId = await fake.send({ StartSession: {} });
    const frame = await fake.next();
    named(frame, "SessionStart");
    expect(frame.parent).toBe(opId);
  } finally {
    await fake.close();
  }
});

test("FAKE_CANTE_SEED=1 opens on a populated transcript parked on approval", async () => {
  const fake = spawnFake({ FAKE_CANTE_SEED: "1" });
  try {
    await fake.send({ StartSession: {} });
    const first = await fake.next();
    named(first, "SessionStart");

    const names: string[] = [];
    let pause: any;
    for (let i = 0; i < 40; i++) {
      const frame = await fake.next();
      names.push(eventName(frame.event));
      if (eventName(frame.event) === "TurnPause") {
        pause = frame.event;
        break;
      }
    }

    expect(names).toContain("UserInput");
    expect(names).toContain("AgentMessage");
    expect(names).toContain("ToolEnd");
    expect(names).toContain("UsageUpdate");
    expect(names.at(-1)).toBe("TurnPause");
    expect(pause.TurnPause.reason.Approval.tools[0].name).toBe("Write");
  } finally {
    await fake.close();
  }
});

test("FAKE_CANTE_SLOW_DELTAS splits the delta run across ticks", async () => {
  const fake = spawnFake({ FAKE_CANTE_SLOW_DELTAS: "1" });
  try {
    await fake.send({ StartSession: {} });
    named(await fake.next(), "SessionStart");

    await fake.send({ UserInput: "hi" });
    expect(named(await fake.next(), "MessageDelta")).toBe("hello ");
    expect(named(await fake.next(), "MessageDelta")).toBe("world");
    expect(named(await fake.next(), "AgentMessage")).toBe("hello world");
    expect(named(await fake.next(), "TurnEnd").status).toBe("Completed");
  } finally {
    await fake.close();
  }
});
