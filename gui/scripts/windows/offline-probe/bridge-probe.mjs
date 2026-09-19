// Isolate the app from the driver: talk to cante-bridge directly (protocol from CONTRACT.md).
// This tells us whether the dead provider produces a bridge Error event at all.
import { spawn } from "node:child_process";
import path from "node:path";

const BRIDGE = process.argv[2];
const PI_CONFIG_DIR = process.argv[3];
const WORK = process.argv[4];
const STALL_SECS = process.argv[5] || "60";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid() {
  let v = (BigInt(Date.now()) << 80n) | BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString("hex"));
  let out = "";
  for (let i = 0; i < 26; i++) { out = ALPHABET[Number(v & 31n)] + out; v >>= 5n; }
  return out;
}
const opId = () => "op_" + ulid();

const env = { ...process.env, PI_CODING_AGENT_DIR: PI_CONFIG_DIR, CANTE_BRIDGE_STALL_SECS: STALL_SECS };
delete env.PI_PROVIDER; delete env.PI_MODEL; delete env.PI_SESSION_ID; delete env.PI_SESSION_FILE;

const child = spawn(BRIDGE, ["serve"], { cwd: WORK, env, stdio: ["pipe", "pipe", "pipe"] });
let events = 0;
child.stdout.on("data", (chunk) => {
  for (const line of chunk.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    events++;
    console.log(`[bridge] ${line.slice(0, 400)}`);
    // Auto-approve: an open approval sheet pauses the stall clock (the window is
    // waiting on the user, not the provider), so without this the cut scenario
    // never reaches the silence we are trying to reproduce.
    try {
      const frame = JSON.parse(line);
      const pause = frame?.event?.TurnPause;
      const tools = pause?.reason?.Approval?.tools;
      if (Array.isArray(tools) && tools.length) {
        const turnId = pause.turn_id;
        console.log(`[probe] auto-approving ${tools.length} tool(s)`);
        send({
          id: opId(),
          op: { ApprovalResponse: { turn_id: turnId, responses: tools.map((t) => ({ tool_use_id: t.id, decision: "Accept" })) } },
        });
      }
    } catch {}
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(`[bridge stderr] ${chunk}`));
child.on("exit", (code) => { console.log(`[bridge] exited code=${code}`); process.exit(0); });

function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }

setTimeout(() => {
  console.log("[probe] sending StartSession");
  send({ id: opId(), op: { StartSession: { permission_mode: "auto", cwd: WORK } } });
}, 500);

setTimeout(() => {
  console.log("[probe] sending UserInput");
  send({ id: opId(), op: { UserInput: "只回复两个字：可以" } });
}, 2500);

setTimeout(() => {
  console.log(`[probe] done, events=${events}`);
  child.kill();
  process.exit(0);
}, Number(process.env.PROBE_MS || 90000));
