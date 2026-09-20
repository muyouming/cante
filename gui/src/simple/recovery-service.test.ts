// 服务方自己「忙不过来 / 这个月用完了」，和「断网」是两件不同的事。
//
// 事实现场（2026-09）：派活的网关欠费停机，真实原文是
//   503: {...insufficient credits to make this request...}
// 王姐会遇到同一族：公司网关这个月用量用完、服务方限流、服务方自己抽风几分钟。
//
// 为什么必须和 NETWORK 分开：两条都让她「等」，但等的东西不一样。断网她能自己查
// （先用浏览器看看别的网页能不能打开）；「服务方用不了」不是她能修的，她要做的是
// 等一会儿，一直这样再告诉管网络的同事。两类都给不了「重新选一次文件」——那和
// 服务方用不用得了毫无关系，只会让她以为是自己选错了文件。
//
// 判断错法可复现：把 `recovery.ts` 里的 `SERVICE_BUSY` 分支挪到 `NETWORK` 后面，
// 「今天那条真原文」就会落回 NETWORK（`\b50[234]\b` / `rate limit` / `quota`）；
// 把 `403` 也写进 `SERVICE_BUSY`，「401/403 还是没配好」那一组就红。
import { describe, expect, test } from "bun:test";

import { RECOVERY } from "./copy-recovery.ts";
import { SERVICE_RECOVERY } from "./copy-service.ts";
import { actionsFor, causeOf } from "./recovery.ts";
import type { RecoveryAction, RecoveryError } from "./recovery.ts";

function err(detail: string): RecoveryError {
  return { what: "", how: "", detail };
}

function kinds(actions: readonly RecoveryAction[]): string[] {
  return actions.map((item) => item.kind);
}

function labels(actions: readonly RecoveryAction[]): string {
  return actions.map((item) => item.label).join(" / ");
}

/** 今天那条真原文，原样抄自网关（不美化、不截断）。 */
const QUOTA_RAW =
  '503: {"message":"[commandcode/deepseek/deepseek-v4.1-flash] [400]: You have insufficient credits to make this request. Please purchase more credits to continue  (reset after 15s)"}';

/** 同一族的其它真实说法：网关回过的，以及常见的 HTTP 语义。 */
const SERVICE_FAMILY = [
  QUOTA_RAW,
  "insufficient credits",
  "quota exceeded",
  "insufficient quota",
  "usage limit reached",
  "insufficient balance",
  "rate limit exceeded",
  "429 Too Many Requests",
  "HTTP 429",
  "402 Payment Required",
  "503 Service Unavailable",
  "502 Bad Gateway",
  "service unavailable",
  "the service is overloaded, please try again later",
  "本月用量已用完",
  "余额不足",
];

describe("服务方忙/用完了：落到新的一类，不落到网络、不落到文件", () => {
  test("今天那条真原文 -> 「过一会儿再试」，不是重选文件", () => {
    const actions = actionsFor(err(QUOTA_RAW));
    expect(kinds(actions)).toEqual(["retry", "copy-detail"]);
    // 和断网分开：走的不是 NETWORK 那句「先用浏览器看看别的网页」。
    expect(actions[0]?.label).toBe(SERVICE_RECOVERY.wait.label);
    expect(actions[0]?.why).toBe(SERVICE_RECOVERY.wait.why);
    expect(actions[0]?.why).not.toBe(RECOVERY.retryLater.why);
    expect(kinds(actions)).not.toContain("pick-files");
  });

  test("同族每一串都落到这一类，而不是兜底或断网", () => {
    for (const text of SERVICE_FAMILY) {
      const actions = actionsFor(err(text));
      expect(actions[0]?.why, text).toBe(SERVICE_RECOVERY.wait.why);
      expect(kinds(actions), text).not.toContain("pick-files");
      // 「复制详情」这条后路照旧留着，而且是给管网络的同事那一句。
      expect(actions.at(-1)?.kind, text).toBe("copy-detail");
      expect(actions.at(-1)?.label, text).toBe(SERVICE_RECOVERY.admin.label);
    }
  });

  test("走产品真实链路（store 的 RunError -> cause -> actionsFor）时同样成立", () => {
    const runError: RecoveryError = {
      what: "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: QUOTA_RAW,
      cause: QUOTA_RAW,
    };
    const actions = actionsFor({ ...runError, cause: causeOf(runError) });
    expect(actions[0]?.why).toBe(SERVICE_RECOVERY.wait.why);
    expect(labels(actions)).not.toContain("选文件");
  });

  test("她的两句话里不许出现把锅甩给文件 / 甩给她的说法", () => {
    for (const text of SERVICE_FAMILY) {
      const spoken = JSON.stringify(actionsFor(err(text)));
      // 服务方用不了和她的文件毫无关系：不许提文件、选文件、换一份。
      expect(spoken, text).not.toMatch(/选文件|重新选|换个方法|换一份|文件有问题|文件损坏/);
      // 也不许说成"你没配好账号"（那是 AUTH 的说法）。
      expect(spoken, text).not.toContain(RECOVERY.signIn.label);
    }
  });

  test("当面说清「这不是她的错」——不然她会去折腾自己的电脑", () => {
    const actions = actionsFor(err(QUOTA_RAW));
    expect(actions[0]?.why).toContain("不是你");
    // 文案必须来自 copy 模块，不在判断代码里另写一份。
    expect(actions[0]?.label).toBe(SERVICE_RECOVERY.wait.label);
    expect(actions[0]?.why).toBe(SERVICE_RECOVERY.wait.why);
  });
});

describe("边界：401/403 还是「没配好」，402/429/503 才是服务方的事", () => {
  test("401 / 403 一条不回归：走 AUTH，不是服务方这一类", () => {
    for (const text of ["401 Unauthorized: invalid api key", "403 Forbidden", "unauthenticated"]) {
      const actions = actionsFor(err(text));
      expect(kinds(actions), text).toEqual(["copy-detail"]);
      expect(labels(actions), text).toContain("同事");
      expect(actions[0]?.why, text).not.toBe(SERVICE_RECOVERY.wait.why);
    }
  });

  test("402 / 429 / 503 归服务方，不归 AUTH（`40[13]` 抓不到 402）", () => {
    for (const text of ["402 Payment Required", "429 Too Many Requests", "503 Service Unavailable"]) {
      const actions = actionsFor(err(text));
      expect(actions[0]?.why, text).toBe(SERVICE_RECOVERY.wait.why);
      expect(labels(actions), text).not.toContain(RECOVERY.signIn.label);
    }
  });

  test("普通断网保持原样：仍是「过一会儿再试」那条 NETWORK 的路", () => {
    for (const text of ["fetch failed: ECONNREFUSED 127.0.0.1:8317", "Connection error.", "网络断了", "ETIMEDOUT"]) {
      const actions = actionsFor(err(text));
      expect(actions[0]?.label, text).toBe(RECOVERY.retryLater.label);
      expect(actions[0]?.why, text).toBe(RECOVERY.retryLater.why);
      // 断网时不该冒出「管网络的同事」这句服务方专用的文案。
      expect(labels(actions), text).not.toContain(SERVICE_RECOVERY.admin.label);
    }
  });
});

describe("认不出来的不硬猜", () => {
  test("没头没尾的 HTTP 418 -> 退回通用出口，不判成服务方", () => {
    const actions = actionsFor(err("HTTP 418 I'm a teapot"));
    expect(kinds(actions)).toEqual(["retry", "pick-files", "copy-detail"]);
    expect(actions[0]?.label).toBe(RECOVERY.retry.label);
    expect(actions[0]?.why).not.toBe(SERVICE_RECOVERY.wait.why);
  });

  test("文件名里的 429 不算状态码（和 407 那条同一个判据）", () => {
    for (const text of ["unsupported format for 报表429.xlsx", "cannot read file report-429.xlsx"]) {
      const actions = actionsFor(err(text));
      expect(labels(actions), text).not.toContain(SERVICE_RECOVERY.admin.label);
      expect(actions[0]?.why, text).not.toBe(SERVICE_RECOVERY.wait.why);
    }
  });
});
