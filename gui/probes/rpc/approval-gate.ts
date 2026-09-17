/**
 * #103 探针用的 pi 扩展：把「先问人」这件事在 tool_call 钩子里真的做出来。
 *
 * 这不是产品代码，只是一次实验：验证 pi 核心没有权限系统时，一个扩展能不能
 * 拦下一次工具调用、通过 extension_ui_request 等人回答、再决定放行/拒绝。
 *
 * 用 -e 显式加载：pi --mode rpc -e ./approval-gate.ts
 *
 * 环境变量（都由探针 runner 设置）：
 *   PROBE_EXT_LOG    每次钩子触发/决定写一行的日志文件（追加）
 *   PROBE_UI_METHOD  select（默认）、confirm（是/否）、batch（防抖攒批，注定失败的对照）、
 *                    batch2（从 ctx.sessionManager 读整条 assistant 消息里的兄弟调用，一次问完）
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.PROBE_EXT_LOG;
const METHOD = ["confirm", "batch", "batch2"].includes(process.env.PROBE_UI_METHOD ?? "")
  ? (process.env.PROBE_UI_METHOD as string)
  : "select";

function note(line: string) {
  if (!LOG) return;
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
}

export default function (pi: ExtensionAPI) {
  note(`extension loaded method=${METHOD}`);

  // batch/batch2 模式用：把同一批（同一 assistant 消息）的工具调用攒起来，只问一次。
  let pendingBatch: { id: string; command: string }[] = [];
  let batchDecision: Promise<boolean> | null = null;
  let lastBatchLength = 0;
  // batch2 模式用：assistant 消息 id -> 该批的逐个决定
  let batch2Answers: Map<string, boolean> | null = null;
  let batch2Key: string | null = null;

  /** 从 sessionManager 的最后一条 assistant 消息里取出这一批工具调用（batch2 的关键）。 */
  function pendingToolCallsFromSession(ctx: {
    sessionManager: { getBranch(): unknown[] };
  }): { entryId: string; ids: { id: string; name: string }[] } | null {
    const branch = ctx.sessionManager.getBranch() as { id?: string; type?: string; message?: any }[];
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      const msg = entry?.message;
      if (entry?.type === "message" && msg?.role === "assistant" && Array.isArray(msg.content)) {
        const ids = msg.content
          .filter((c: any) => c?.type === "toolCall")
          .map((c: any) => ({ id: String(c.id), name: String(c.name) }));
        if (ids.length > 0) return { entryId: String(entry.id ?? i), ids };
      }
    }
    return null;
  }

  pi.on("tool_call", async (event, ctx) => {
    note(`tool_call name=${event.toolName} id=${event.toolCallId} input=${JSON.stringify(event.input)}`);
    if (event.toolName !== "bash") {
      note(`tool_call pass-through (not bash)`);
      return undefined;
    }

    if (!ctx.hasUI) {
      // 非交互模式下 fail-safe：直接拦。
      note(`tool_call no-ui -> block`);
      return { block: true, reason: "no UI available to confirm" };
    }

    const command = String((event.input as { command?: string }).command ?? "");

    if (METHOD === "batch2") {
      const batch = pendingToolCallsFromSession(ctx);
      note(`batch2 session-branch batch=${JSON.stringify(batch)}`);
      const key = batch ? batch.entryId : `single:${event.toolCallId}`;
      if (batch2Key !== key || !batch2Answers) {
        batch2Key = key;
        const ids = batch?.ids ?? [{ id: event.toolCallId, name: event.toolName }];
        const choice = await ctx.ui.select(
          `允许执行这 ${ids.length} 个操作吗？（${ids.map((x) => x.name).join("、")}）`,
          ["允许一次", "拒绝"],
          { timeout: 120000 },
        );
        const allowed = choice === "允许一次";
        batch2Answers = new Map(ids.map((x) => [x.id, allowed]));
        note(`batch2 ui.select batch=${ids.length} ids=${ids.map((x) => x.id).join(",")} allowed=${allowed}`);
      }
      const allowed = batch2Answers.get(event.toolCallId) ?? false;
      note(`tool_call id=${event.toolCallId} batch2 allowed=${allowed}`);
      if (!allowed) return { block: true, reason: "用户拒绝执行这条命令" };
      return undefined;
    }

    if (METHOD === "batch") {
      // 关键实验：等 80ms 看同一个 assistant 消息里的兄弟工具调用会不会也进来。
      // 如果 pi 是「顺序 preflight、逐个 await 钩子」，pendingBatch 永远只有一个。
      pendingBatch.push({ id: event.toolCallId, command });
      if (!batchDecision) {
        batchDecision = new Promise<boolean>((resolve) => {
          setTimeout(async () => {
            const batch = pendingBatch.slice();
            pendingBatch = [];
            lastBatchLength = batch.length;
            note(`ui.request batch-size=${batch.length} ids=${batch.map((b) => b.id).join(",")}`);
            const choice = await ctx.ui.select(`允许执行这 ${batch.length} 个操作吗？`, ["允许一次", "拒绝"], {
              timeout: 120000,
            });
            note(`ui.select(batch=${batch.length}) returned ${JSON.stringify(choice)}`);
            batchDecision = null;
            resolve(choice === "允许一次");
          }, 80);
        });
      }
      const allowed = await batchDecision;
      note(`tool_call id=${event.toolCallId} batch-size-was=${lastBatchLength} allowed=${allowed}`);
      if (!allowed) return { block: true, reason: "用户拒绝执行这条命令" };
      return undefined;
    }

    let allowed = false;
    if (METHOD === "confirm") {
      allowed = await ctx.ui.confirm("允许执行这条命令吗？", command);
      note(`ui.confirm returned ${allowed}`);
    } else {
      const choice = await ctx.ui.select("允许执行这条命令吗？", ["允许一次", "拒绝"], { timeout: 120000 });
      allowed = choice === "允许一次";
      note(`ui.select returned ${JSON.stringify(choice)}`);
    }

    if (!allowed) {
      note(`tool_call blocked`);
      return { block: true, reason: "用户拒绝执行这条命令" };
    }
    note(`tool_call allowed`);
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    note(`tool_result name=${event.toolName} isError=${event.isError}`);
    return undefined;
  });
}
