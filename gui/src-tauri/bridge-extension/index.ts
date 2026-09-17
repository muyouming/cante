/**
 * cante-bridge 的审批闸门（pi 侧）。
 *
 * `cante-bridge` 用 `pi -e <这个文件>` 显式加载它，它做三件事：
 *
 *   1. 在 `tool_call` 钩子里**先拦下**每一个工具调用（不是只拦 bash ——
 *      `PROBE-pi-rpc.md` §5 第 1 条：闸门的强度 = 扩展的覆盖率）；
 *   2. 通过一次 `extension_ui_request` 把「这一批想做什么」交给桥，
 *      由桥翻成前端认识的 `TurnPause`；
 *   3. 桥回答后，放行或 `{ block: true }`（拒绝时命令真的不执行）。
 *
 * ## 为什么用 `select` 的 options / value 传数据
 *
 * pi 的对话框协议里，`select` 的 `options` 是给用户看的选项、`value` 是选项之一，
 * 两张表都不适合传结构化数据；但 `rpc-mode` 对 `value` **不做校验**
 * （`"value" in r ? r.value : undefined`），所以桥可以把「逐个调用放行/拒绝」
 * 编码成一个字符串回来。这是**我们和桥之间的约定**，不是 pi 的能力
 * （`PROBE-pi-rpc.md` §3 修订 D/E）。约定版本号是 `MARKER`，两边必须一起改。
 *
 * 编码：
 *   请求  options = [MARKER, JSON.stringify({ v: 1, tools: [{id,name,args}] })]
 *   回答  value   = JSON.stringify({ v: 1, allow: [id…], deny: [id…], reason })
 *
 * 任何读不懂的回答一律**当作拒绝**（fail-safe，探针实测 `cancelled`/超时也走这条路）。
 *
 * ## 为什么一次能问一批
 *
 * `tool_call` 是逐调用触发的，而且兄弟调用是**顺序 preflight**（防抖攒不起来）。
 * 但钩子触发时，当前 assistant 消息（含同一条消息里的全部 `toolCall`）已经写进
 * `ctx.sessionManager.getBranch()`（`PROBE-pi-rpc.md` §3 修订 D），所以从会话里读
 * 整批、只问一次。这条是 pi 的**内部行为**，不是稳定契约：读不到就退化成
 * 「每次调用问一次」，绝不放过。
 */

const MARKER = "cante-gate:v1";
/** 工具不能执行时给模型看的理由（没有更具体的用户意见时）。 */
const DEFAULT_REASON = "用户拒绝了这个操作";

interface GateTool {
  id: string;
  name: string;
  args: unknown;
}

/**
 * 从会话里读当前这一批工具调用。
 *
 * 返回的 key 是 assistant 消息的 entry id：同一批里的每个 `tool_call` 都拿到同一个
 * key，不同批一定不同。读不到会话时返回空（调用方退化成单调用）。
 */
function batchFromSession(ctx: unknown): { key: string; tools: GateTool[] } {
  try {
    const branch = (ctx as { sessionManager?: { getBranch?: () => unknown } })?.sessionManager?.getBranch?.();
    if (!Array.isArray(branch)) return { key: "", tools: [] };
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i] as { id?: unknown; type?: unknown; message?: { role?: unknown; content?: unknown } };
      const message = entry?.message;
      if (entry?.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      const tools: GateTool[] = [];
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block?.type !== "toolCall") continue;
        const id = String(block.id ?? "");
        if (!id) continue;
        tools.push({
          id,
          name: String(block.name ?? ""),
          args: block.arguments ?? block.input ?? {},
        });
      }
      if (tools.length > 0) return { key: String(entry.id ?? `entry:${i}`), tools };
    }
  } catch {
    // 读会话失败不是「允许」的理由 —— 调用方会退回逐个问。
  }
  return { key: "", tools: [] };
}

/** 解析桥的回答；读不懂就是「全拒」。 */
function readDecision(answer: unknown, tools: GateTool[]): { allow: Set<string>; reason: string } {
  const allow = new Set<string>();
  let reason = DEFAULT_REASON;
  if (typeof answer === "string" && answer.length > 0) {
    try {
      const parsed = JSON.parse(answer) as { v?: unknown; allow?: unknown; reason?: unknown };
      if (parsed && parsed.v === 1) {
        if (Array.isArray(parsed.allow)) for (const id of parsed.allow) allow.add(String(id));
        if (typeof parsed.reason === "string" && parsed.reason.length > 0) reason = parsed.reason;
      }
    } catch {
      // fall through: 全拒。
    }
  }
  // 只保留这批里真实存在的 id，免得一个编码错误把别的调用捎带放行。
  for (const id of [...allow]) if (!tools.some((tool) => tool.id === id)) allow.delete(id);
  return { allow, reason };
}

async function ask(
  ctx: {
    hasUI?: unknown;
    signal?: unknown;
    ui?: { select?: (title: string, options: string[], opts?: { signal?: unknown }) => Promise<unknown> };
  },
  tools: GateTool[],
): Promise<{ allow: Set<string>; reason: string }> {
  // RPC 模式下 hasUI 为 true；万一不是，绝不默认放行。
  if (ctx?.hasUI !== true || typeof ctx.ui?.select !== "function") {
    return { allow: new Set<string>(), reason: "这里没法问你要不要允许，先不做" };
  }
  let answer: unknown;
  try {
    // 不带 timeout：等待期间由用户按「停止」或窗口关闭来收场，不等一个
    // 到点就自动拒绝的计时器（那会把「她还在想」误判成「她说不」）。
    // signal 让「停止」也能解除这次等待（桥还会再兜一层 cancelled）。
    answer = await ctx.ui.select("需要你确认", [MARKER, JSON.stringify({ v: 1, tools })], {
      signal: ctx.signal,
    });
  } catch {
    answer = undefined;
  }
  return readDecision(answer, tools);
}

export default function canteApprovalGate(pi: {
  on: (event: string, handler: (event: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => void;
}): void {
  let batchKey: string | null = null;
  let decision: { allow: Set<string>; reason: string } | null = null;

  pi.on("tool_call", async (event, ctx) => {
    const current: GateTool = {
      id: String(event.toolCallId ?? ""),
      name: String(event.toolName ?? ""),
      args: event.input ?? {},
    };
    const fromSession = batchFromSession(ctx);
    let tools = fromSession.tools;
    let key = fromSession.key;
    // 会话里没读到这个调用（读不到会话，或这是单调用）：退化成只问它，
    // key 也要换掉，免得复用上一批的答案。
    if (!tools.some((tool) => tool.id === current.id)) {
      tools = [current];
      key = `single:${current.id}`;
    }

    if (!decision || batchKey !== key) {
      batchKey = key;
      decision = await ask(ctx as never, tools);
    }
    if (current.id && decision.allow.has(current.id)) return undefined;
    return { block: true, reason: decision.reason };
  });
}
