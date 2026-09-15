// Unit + integration tests for the Cante GUI bridge.
//
//   bun test examples/gui/bridge
//
// The integration case drives a scripted `cante serve` double
// (bridge/fixtures/fake-cante.ts) over real pipes, so framing, the event ring,
// long-poll wakeups, and the HTTP surface are all exercised end to end.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_VERSION,
  CanteDaemon,
  buildBatch,
  coalesceDeltas,
  createBridgeServer,
  createLineSplitter,
  eventName,
  initialBridgeState,
  makeUlid,
  reduceState,
  type EventMsg,
} from "./cante-bridge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CANTE = resolve(HERE, "fixtures/fake-cante.ts");
const scratch = mkdtempSync(join(tmpdir(), "cante-bridge-test-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function msg(event: unknown): EventMsg {
  return { timestamp: "2026-01-01T00:00:00Z", id: "evt_x", event };
}

describe("ids", () => {
  test("mints a 26-character Crockford ULID", () => {
    const ulid = makeUlid();
    expect(ulid).toHaveLength(26);
    expect(ulid).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("sorts by timestamp", () => {
    const early = makeUlid(1_700_000_000_000, new Uint8Array(16));
    const late = makeUlid(1_700_000_100_000, new Uint8Array(16));
    expect(early < late).toBe(true);
  });
});

describe("line splitting", () => {
  test("reassembles lines across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const feed = createLineSplitter((line) => lines.push(line));
    feed('{"a"');
    feed(':1}\n{"b":');
    feed('2}\n\n   \n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe("state reduction", () => {
  test("tracks a full turn through approval", () => {
    let state = initialBridgeState("/tmp");
    state = reduceState(state, { TurnStart: { turn_id: "t1" } });
    expect(state.status).toBe("thinking");
    state = reduceState(state, { MessageDelta: "hi" });
    expect(state.status).toBe("streaming");
    state = reduceState(state, {
      TurnPause: {
        turn_id: "t1",
        reason: { Approval: { tools: [{ id: "tool_1", name: "Bash", args: {} }], message: "Allow?" } },
      },
    });
    expect(state.status).toBe("awaiting");
    expect(state.pending_approval?.tools[0]?.name).toBe("Bash");
    state = reduceState(state, { TurnResume: { turn_id: "t1" } });
    expect(state.pending_approval).toBeNull();
    state = reduceState(state, { TurnEnd: { turn_id: "t1", status: "Completed" } });
    expect(state.status).toBe("idle");
  });

  test("surfaces errors and session identity", () => {
    let state = initialBridgeState("/tmp");
    state = reduceState(state, { SessionStart: { session_id: "ses_1", model: { id: "m" } } });
    expect(state.session?.session_id).toBe("ses_1");
    state = reduceState(state, { Error: "boom" });
    expect(state.status).toBe("error");
  });

  test("reads unit variants carried as bare strings", () => {
    expect(eventName("Goodbye")).toBe("Goodbye");
    expect(eventName({ ToolStart: {} })).toBe("ToolStart");
  });
});

describe("batching", () => {
  test("coalesces adjacent deltas and keeps other events", () => {
    const merged = coalesceDeltas([
      msg({ MessageDelta: "a" }),
      msg({ MessageDelta: "b" }),
      msg({ Info: "note" }),
      msg({ MessageDelta: "c" }),
    ]);
    expect(merged).toHaveLength(3);
    expect((merged[0]!.event as { MessageDelta: string }).MessageDelta).toBe("ab");
    expect((merged[2]!.event as { MessageDelta: string }).MessageDelta).toBe("c");
  });

  test("caps a batch by event count and reports truncation", () => {
    const ring = Array.from({ length: 200 }, (_, i) => msg({ Info: `line ${i}` }));
    const batch = buildBatch(ring, 0, ring.length, 0);
    expect(batch.events.length).toBe(64);
    expect(batch.cursor).toBe(64);
    expect(batch.truncated).toBe(true);
  });

  test("always makes progress even for one oversized event", () => {
    const huge = msg({ Info: "x".repeat(200_000) });
    const batch = buildBatch([huge], 0, 1, 0);
    expect(batch.events).toHaveLength(1);
    expect(batch.cursor).toBe(1);
    expect(batch.truncated).toBe(false);
  });

  test("clamps a cursor that fell off the ring", () => {
    const ring = [msg({ Info: "a" }), msg({ Info: "b" })];
    const batch = buildBatch(ring, 10, 12, 3);
    expect(batch.cursor).toBe(12);
    expect(batch.events).toHaveLength(2);
    expect(batch.truncated).toBe(false);
  });
});

describe("daemon over real pipes", () => {
  test("streams events, tracks approval, and answers an approval", async () => {
    const daemon = new CanteDaemon({ bin: FAKE_CANTE, cwd: scratch });
    const waitUntil = async (predicate: () => boolean, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (!predicate() && Date.now() < deadline) await daemon.wait(daemon.headCursor, 200);
      return predicate();
    };
    try {
      daemon.start();
      daemon.send({ StartSession: { model: "fake-model" } });
      await waitUntil(() => daemon.state.session !== null, 5_000);
      expect(daemon.state.session?.session_id).toBe("ses_FAKEFAKEFAKEFAKEFAKEFAKEFA0");

      daemon.send({ UserInput: "hi" });
      await waitUntil(() => daemon.state.status === "awaiting", 5_000);
      const pending = daemon.state.pending_approval;
      expect(pending?.turn_id).toBe("turn_1");

      daemon.send({
        ApprovalResponse: { turn_id: pending!.turn_id, responses: [{ tool_use_id: "tool_1", decision: "Accept" }] },
      });
      await waitUntil(() => daemon.state.status === "idle", 5_000);
      expect(daemon.state.pending_approval).toBeNull();
      expect(daemon.headCursor).toBeGreaterThanOrEqual(13);
    } finally {
      await daemon.shutdown();
    }
  }, 20_000);

  test("serves the HTTP surface the GUI polls", async () => {
    const { server, daemon } = createBridgeServer({ bin: FAKE_CANTE, cwd: scratch, port: 0 });
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const health = (await (await fetch(`${origin}/healthz`)).json()) as { ok: boolean; bridge: string };
      expect(health.ok).toBe(true);
      expect(health.bridge).toBe(BRIDGE_VERSION);

      const started = (await (
        await fetch(`${origin}/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "fake-model" }),
        })
      ).json()) as { ok: boolean };
      expect(started.ok).toBe(true);

      const events = (await (
        await fetch(`${origin}/events?cursor=0&timeout_ms=2000`)
      ).json()) as { events: unknown[]; state: { session: { session_id: string } } };
      expect(events.events.length).toBeGreaterThan(0);
      expect(events.state.session.session_id).toContain("ses_");

      const missing = await fetch(`${origin}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      });
      expect(missing.status).toBe(400);

      const notFound = await fetch(`${origin}/nope`);
      expect(notFound.status).toBe(404);
    } finally {
      await daemon.shutdown();
      server.stop(true);
    }
  }, 20_000);
});
