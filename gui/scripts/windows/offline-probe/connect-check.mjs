// 连一下某个地址，只报告结果 —— 用来证明「防火墙规则真的按得住这个程序」。
//
// 用法： bun offline-probe/connect-check.mjs <host> <port> [timeoutMs]
// 输出： CONNECTED <ms> / REFUSED <code> <ms> / TIMEOUT <ms>（静默丢弃）
// 退出码：0 = 连上了；1 = 没连上（refused / timeout）。
//
// 为什么要有它：Windows 防火墙**不管回环**（实测：给 127.0.0.1 加出站阻断规则，
// 同机回环照样握手成功）。所以「按远端端口把服务方切掉」这条规则必须指向**真的
// 非回环端点**，而且要能证明它确实按住了**这个程序**、又没误伤别的程序。
// 这个脚本就是那把尺子：规则加之前应 CONNECTED，加之后应 REFUSED/TIMEOUT，
// 删掉之后又应 CONNECTED。三次都记进报告，才算「现场真的摆上了」。
import net from "node:net";

const host = process.argv[2] || "127.0.0.1";
const port = Number(process.argv[3] || 80);
const timeoutMs = Number(process.argv[4] || 8000);
const started = Date.now();

const socket = net.connect(port, host);
socket.setTimeout(timeoutMs);
socket.on("connect", () => {
  console.log(`CONNECTED ${Date.now() - started}`);
  socket.destroy();
  process.exit(0);
});
socket.on("error", (error) => {
  console.log(`REFUSED ${error.code} ${Date.now() - started}`);
  process.exit(1);
});
socket.on("timeout", () => {
  console.log(`TIMEOUT ${Date.now() - started}`);
  socket.destroy();
  process.exit(1);
});
