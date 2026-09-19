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
    // 本轮新增的那一种：代理**要你先登录/验证**（407），与 403 是不同的错法。
    // 现场由 relay.mjs 的 proxy407 模式造（真机跑过，见报告 §「代理要验证那一场」）。
    // `want` 目前是 auth：原文里带着 "sign in"，产品走的是账号那条路（复制详情给同事）。
    // 这**不是**判据（判据只看 fileProblem）；它只是如实记下产品的选择，留给产品拍板。
    name: "代理要验证（407 + Proxy-Authenticate，proxy407 那场的原文）",
    detail:
      '407: {"message":"Proxy Authentication Required: please sign in to the corporate proxy","type":"proxy_error","code":407}',
    want: "auth",
    fileProblem: false,
    actionLabel: "复制详情给同事",
    why: "代理要登录还是账号那条路；重点是**不许**落到文件上",
  },
  {
    name: "代理要验证（407 的简短写法）",
    detail: "407 Proxy Authentication Required",
    want: "auth",
    fileProblem: false,
    actionLabel: "复制详情给同事",
    why: "同上",
  },
  {
    // 「真拔网线」那一场（-Scenario wire）在客户端看来的原文：防火墙静默丢包 →
    // 连接超时/重置。它必须走网络那条路，绝不能落到文件上。
    name: "真拔网线（防火墙静默丢包 → 连接超时）",
    detail: "Connection error.",
    want: "network",
    fileProblem: false,
    actionLabel: "",
    why: "系统级出站阻断就是网络问题",
  },
  {
    name: "真拔网线（连接被重置的另一种写法）",
    detail: "ECONNRESET: socket hang up",
    want: "network",
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

/** 判据里另一种「绝不许出现」的东西：把网络问题说成文件问题的**任何**字样。
 *  不只是按钮 kind —— 文案里出现 Excel / WPS / 窗口 / 占用 也算。仅用于 fileProblem=false 的用例。 */
const FILE_WORDS = ["Excel", "WPS", "关掉那个窗口", "占用", "被打开", "重新选"];

let failures = 0;
for (const item of CASES) {
  const human = explainError({ what: "这件事没有做完。", how: "", detail: item.detail, cause: item.detail });
  const actions = actionsFor({ what: human.what, how: human.how, detail: human.detail, cause: item.detail });
  const fileProblem = actions.some((a) => FILE_ACTIONS.has(a.kind));
  const label = actions.map((a) => a.label).join(" / ");
  const why = actions.map((a) => a.why).join(" / ");
  const spoken = `${human.what}\n${human.how}\n${label}\n${why}`;

  // 两个判据都要看：① 按钮种类里有没有文件类动作；② 屏幕文字里有没有把
  // 网络问题说成文件问题的字样（哪怕按钮种类蒙对了，文案说错了也不行）。
  const wrongKind = fileProblem !== item.fileProblem;
  const wrongWords = !item.fileProblem && FILE_WORDS.some((w) => spoken.includes(w));
  // actionLabel 给了就必须逐字对上（把「产品选择」也钉住，不让它静默漂移）。
  const labelMismatch = item.actionLabel !== "" && label !== item.actionLabel;
  const verdict = wrongKind || wrongWords || labelMismatch;
  if (verdict) failures += 1;

  console.log(`${verdict ? "✗" : "✓"} ${item.name}`);
  console.log(`    原文：${item.detail}`);
  console.log(`    屏幕会写：${human.what}`);
  console.log(`    按钮：${label}`);
  const reason = wrongKind
    ? (item.fileProblem ? "**应该**是文件问题，实际不是" : "**不许**是文件问题，实际是")
    : wrongWords
      ? `**不许**出现文件问题的字样，实际出现了（${FILE_WORDS.filter((w) => spoken.includes(w)).join("、")}）`
      : labelMismatch
        ? `按钮应为「${item.actionLabel}」，实际是「${label}」`
        : "符合";
  console.log(`    判据：${item.fileProblem ? "**应该**是文件问题" : "**不许**是文件问题/字样（" + item.why + "）"} → ${reason}`);
}

console.log("");
if (failures === 0) {
  console.log("classify-assert: 全部符合判据。");
  process.exit(0);
}
console.log(`classify-assert: ${failures} 条不符合判据（上面打了 ✗）。`);
process.exit(1);
