// 「不许把网络问题说成文件问题」的可核对断言（#197 P1）。
//
// 为什么要有它：真机验收（WINDOWS-ACCEPTANCE-13.md）在「代理挡住」那一场里看到
// 屏幕把 403 说成了"文件正被别的程序占用"，并让她"关掉那个窗口再试"—— 那一步
// 在她的处境里根本不存在。原因不是文案，是判断：`recovery.ts` 的 BUSY 规则里
// 有一条 `locked by`，而 "**blocked by**"（公司网关/代理挡住的常见说法）里正好
// 含着这五个字母。
//
// 这个脚本直接 import **产品自己的** recovery.ts / copy.ts（不是把正则抄一份 ——
// 抄一份就会和产品漂移），对一组真实会出现的错误原文断言分类结果。
//
// 用法：  bun gui/scripts/windows/offline-probe/classify-assert.ts
// 退出码：0 = 全部符合期望；1 = 有不符合（打印每一条的实际分类）。

import { actionsFor } from "../../../src/simple/recovery.ts";
import { explainError } from "../../../src/simple/copy.ts";

interface Case {
  /** 这个原文应该被当成哪一类（产品的判断，不是我们希望的）。 */
  expect: "network" | "auth" | "file-busy";
  why: string;
  detail: string;
}

// 期望值分两列，故意分开写：
//   `expect`       = 我们认为**正确**的分类（判据来自 issue #197 P1：
//                    「不许把网络问题说成文件问题」）；
//   `expectFileBusyAsIs` = 当前产品**实际**会给出的分类（如实记录，不美化）。
interface Verdict {
  name: string;
  detail: string;
  want: "network" | "auth" | "file-busy";
  fileProblem: boolean;
  actionLabel: string;
  why: string;
}

const CASES: Verdict[] = [
  {
    name: "代理挡住（403 + blocked by，最常见的公司网关说法）",
    detail: '403: {"message":"Forbidden: blocked by corporate proxy","type":"proxy_error","code":403}',
    want: "auth",
    fileProblem: false,
    actionLabel: "",
    why: "网络/网关问题，绝不能落到文件上",
  },
  {
    name: "代理挡住（403 + blocked by policy）",
    detail: "403: blocked by policy",
    want: "auth",
    fileProblem: false,
    actionLabel: "",
    why: "同上",
  },
  {
    name: "端口不可达（Connection error.）",
    detail: "Connection error.",
    want: "network",
    fileProblem: false,
    actionLabel: "",
    why: "服务方端口没人听，是网络问题",
  },
  {
    name: "端口不可达（ECONNREFUSED）",
    detail: "ECONNREFUSED 127.0.0.1:18090",
    want: "network",
    fileProblem: false,
    actionLabel: "",
    why: "同上",
  },
  {
    name: "中途断掉（桥报的停滞原文）",
    detail: "连不上帮你处理的服务方，可能网络断了。已经做到第 2 步，原来的文件都还在。网络好了，点「再试一次」。",
    want: "network",
    fileProblem: false,
    actionLabel: "",
    why: "#173 的停滞，是网络问题",
  },
  {
    name: "真的文件被占用（对照：这条**应该**是文件问题）",
    detail: "openpyxl: PermissionError: file is locked by another process",
    want: "file-busy",
    fileProblem: true,
    actionLabel: "",
    why: "真实的文件占用必须继续被认出来，不能为了修上面那条把这一条弄丢",
  },
];

const FILE_ACTIONS = new Set(["close-file"]);

let failures = 0;
for (const item of CASES) {
  const human = explainError({ what: "这件事没有做完。", how: "", detail: item.detail, cause: item.detail });
  const actions = actionsFor({ what: human.what, how: human.how, detail: human.detail, cause: item.detail });
  const fileProblem = actions.some((a) => FILE_ACTIONS.has(a.kind));
  const label = actions.map((a) => a.label).join(" / ");
  const verdict = fileProblem !== item.fileProblem;
  if (verdict) failures += 1;
  console.log(`${verdict ? "✗" : "✓"} ${item.name}`);
  console.log(`    原文：${item.detail}`);
  console.log(`    屏幕会写：${human.what}`);
  console.log(`    按钮：${label}`);
  console.log(`    判据：${item.fileProblem ? "**应该**是文件问题" : "**不许**是文件问题（" + item.why + "）"} → ${verdict ? "不符合" : "符合"}`);
}

console.log("");
if (failures === 0) {
  console.log("classify-assert: 全部符合判据。");
  process.exit(0);
}
console.log(`classify-assert: ${failures} 条不符合判据（上面打了 ✗）。`);
process.exit(1);
