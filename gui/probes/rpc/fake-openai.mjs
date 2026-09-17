#!/usr/bin/env node
/**
 * #103 探针：一个假的 OpenAI 兼容端点（SSE 流式）。
 *
 * 目的：不依赖真模型，就能让 pi 的 RPC 模式真的走完一次
 * 「流式文本 -> 工具调用 -> 工具结果 -> 收尾文本」的循环。
 *
 * 只用 node 标准库。脚本化行为由 scenario 决定：
 *   tool  （默认）：第一轮回一段文本 + 一次 bash 工具调用；第二轮（请求里带 role=tool）回收尾文本。
 *   slow          ：只回文本，每块之间等 delayMs，用来测 abort。
 *
 * 直接跑（供 curl 取证）：
 *   node fake-openai.mjs --port 8931 --scenario tool
 *   curl -N -s http://127.0.0.1:8931/v1/chat/completions -H 'content-type: application/json' \
 *     -d '{"model":"probe-model","stream":true,"messages":[{"role":"user","content":"hi"}]}'
 */
import http from "node:http";

const DEFAULT_TOOL_COMMAND = "echo CANTE-RPC-PROBE";

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function chunkBase(model, delta, finishReason = null) {
  return {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: 1700000000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{port?:number, scenario?:string, delayMs?:number, log?:(msg:string)=>void}} opts
 */
export function startFakeOpenAI(opts = {}) {
  const { port = 0, scenario = "tool", delayMs = 250, toolCommand = DEFAULT_TOOL_COMMAND, secondToolCommand = null, log = () => {} } = opts;
  /** 收到的每个请求体（取证用） */
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "probe-model", object: "model" }] }));
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let raw = "";
    for await (const part of req) raw += part;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* 保留空 body，后面照样回，取证时看 raw */
    }
    const model = body.model || "probe-model";
    const hasToolResult = Array.isArray(body.messages) && body.messages.some((m) => m.role === "tool");
    requests.push({ scenario, model, stream: body.stream, hasToolResult, body });
    log(`[fake-openai] POST /v1/chat/completions scenario=${scenario} model=${model} stream=${body.stream} toolResult=${hasToolResult}`);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    if (scenario === "slow") {
      // 慢慢吐文本，好让客户端有机会在中途发 abort。
      const parts = ["这是", "一段", "很慢", "的回", "答，", "用来", "验证", "中止", "行为", "。"];
      for (const p of parts) {
        if (res.writableEnded) return;
        res.write(sse(chunkBase(model, { role: "assistant", content: p })));
        await sleep(delayMs);
      }
      res.write(sse(chunkBase(model, {}, "stop")));
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (scenario === "multi" || scenario === "tool") {
      if (!hasToolResult) {
        // 第一轮：文本增量 + 一次或两次工具调用（同一 assistant 消息里）。
        for (const part of ["我先看一下", "，然后用工具。"]) {
          res.write(sse(chunkBase(model, { role: "assistant", content: part })));
          await sleep(30);
        }
        const calls = [{ id: "call_probe_1", command: toolCommand }];
        if (scenario === "multi" && secondToolCommand) calls.push({ id: "call_probe_2", command: secondToolCommand });
        calls.forEach((c, index) => {
          res.write(
            sse(
              chunkBase(model, {
                tool_calls: [
                  { index, id: c.id, type: "function", function: { name: "bash", arguments: "" } },
                ],
              }),
            ),
          );
        });
        for (const c of calls) {
          const args = JSON.stringify({ command: c.command });
          const index = calls.indexOf(c);
          for (const piece of [args.slice(0, 12), args.slice(12)]) {
            res.write(
              sse(chunkBase(model, { tool_calls: [{ index, function: { arguments: piece } }] })),
            );
            await sleep(20);
          }
        }
        res.write(sse(chunkBase(model, {}, "tool_calls")));
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // 第二轮（已经拿到工具结果）：收尾文本。
      for (const part of ["命令跑完了", "，事情办好了。"]) {
        res.write(sse(chunkBase(model, { role: "assistant", content: part })));
        await sleep(30);
      }
      res.write(
        sse({
          ...chunkBase(model, {}, "stop"),
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// 直接运行时起一个独立进程（探针 runner 用 import，不走这里）。
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, dflt) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? dflt : process.argv[i + 1];
  };
  const port = Number(arg("port", 8931));
  const scenario = arg("scenario", "tool");
  startFakeOpenAI({ port, scenario, log: (m) => console.log(m) }).then((s) => {
    console.log(`[fake-openai] listening on ${s.url} (scenario=${scenario})`);
  });
}
