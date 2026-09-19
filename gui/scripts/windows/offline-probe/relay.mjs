// 造「服务方没了」的三种现场用的假服务方（只在这一台验收机上跑，不进产品）。
//
// 为什么不用真网关：这一轮要验的是**她说出什么话**，所以错误必须是**我们摆出来的**、
// 可重复的。三种模式：
//   * dead   —— 端口没人听（连 TCP 都握不上手）→ 等价于「服务方端口不可达」；
//   * cut    —— 正常开始，答到第 2 个工具调用之后**不再写一个字节、也不发 FIN**
//              （测试 bridge.rs 的 `stall` 现场就是这么造的，可复用）→ 等价于「中途断掉」；
//   * forbid —— 每个请求都回 403（公司网络挡住/网关拒绝）→ 等价于「代理挡住」。
//
// 它**只**实现 pi 真正会发的两条路径：GET /v1/models 与 POST /v1/chat/completions（SSE）。
// 用法： node relay.mjs <dead|cut|forbid> <port> [--marker <文件>]

import http from "node:http";
import fs from "node:fs";

const mode = process.argv[2] || "dead";
const port = Number(process.argv[3] || 18080);
const markerIdx = process.argv.indexOf("--marker");
const marker = markerIdx >= 0 ? process.argv[markerIdx + 1] : "";

function note(line) {
  console.log(`[relay:${mode}] ${line}`);
  if (marker) fs.appendFileSync(marker, `[relay:${mode}] ${line}\n`);
}

const sseHeaders = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache",
  Connection: "close",
};

// OpenAI 兼容的 SSE 分片，形状照 gui/src-tauri/tests/bridge.rs 的 chunk()。
function chunk(model, delta, finish) {
  const payload = {
    id: "chatcmpl-relay",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallChunk(model, index, argsFilled) {
  const delta = {
    tool_calls: [
      {
        index: 0,
        id: `call_relay_${index}`,
        type: "function",
        function: { name: "bash", ...(argsFilled ? { arguments: JSON.stringify({ command: `echo relay-tool-${index}` }) } : { arguments: "" }) },
      },
    ],
  };
  return chunk(model, delta, null);
}

let requests = 0;

const server = http.createServer((req, res) => {
  requests += 1;
  const n = requests;
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    note(`#${n} ${req.method} ${req.url} bytes=${body.length}`);

    if (mode === "forbid") {
      // 公司网络挡住：明确的 403，正文是网关那种英文说明（她要看到的是产品翻出来的中文）。
      const payload = JSON.stringify({
        error: { message: "Forbidden: blocked by corporate proxy", type: "proxy_error", code: 403 },
      });
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(payload);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "relay-model", object: "model" }] }));
      return;
    }

    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return;
    }

    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const model = parsed?.model || "relay-model";
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const lastIsTool = messages.length > 0 && messages[messages.length - 1]?.role === "tool";
    const toolResults = messages.filter((m) => m?.role === "tool").length;

    res.writeHead(200, sseHeaders);

    // cut：答完第 2 个工具调用之后彻底静音 —— 不写正文、不发 [DONE]、不关 socket。
    // 这正是「wifi 断了」在客户端看来的样子（bridge 的 stall 用例就是这么造的：
    // “the cut lands with two completed calls behind it”）。
    if (mode === "cut" && toolResults >= 2) {
      note(`#${n} 静音（第 ${toolResults} 个工具结果之后不再写任何字节）`);
      return;
    }

    const index = toolResults; // 0 → 工具 #1，1 → 工具 #2
    res.write(chunk(model, { role: "assistant", content: "我先看一下" }, null));
    setTimeout(() => {
      if (res.writableEnded) return;
      res.write(chunk(model, { role: "assistant", content: "，然后用工具。" }, null));
      res.write(toolCallChunk(model, index + 1, false));
      res.write(toolCallChunk(model, index + 1, true));
      res.write(chunk(model, {}, "tool_calls"));
      res.write("data: [DONE]\n\n");
      res.end();
      note(`#${n} 回了一个工具调用（工具 #${index + 1}）`);
    }, 30);
  });
});

server.on("error", (error) => {
  if (mode === "dead") {
    // dead 模式本来就不该起监听（端口留给"没人听"），起不来是预期内的。
    note(`监听失败（dead 模式预期）：${error.code}`);
    process.exit(0);
  }
  note(`监听失败：${error.message}`);
  process.exit(1);
});

if (mode === "dead") {
  // 「端口不可达」不是靠起一个中继，而是靠**不起**：直接退出，端口上没人听。
  note(`dead 模式：不起监听，端口 ${port} 保持没人听`);
  process.exit(0);
}

server.listen(port, "127.0.0.1", () => note(`listening on ${port}`));
