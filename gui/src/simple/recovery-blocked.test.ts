// 「被公司网络挡住」和「网络不好」是**两件不同的事**，出路也必须不同。
//
// 真机验收（WINDOWS-ACCEPTANCE-15）把两种网错都跑出来了：
//   * `wire`     —— 真的连不上（防火墙掐断）；
//   * `proxy407` —— 代理要她先证明身份。
// 两种在屏幕上给的是**同一个动作**（「过一会儿再试」）✗。对「网络不好」那是对的；
// 对「公司不让我连」是错的 —— 等到明天也不会通，她真能做的下一步是**问公司网管**。
//
// 这个文件把两类各自的判据钉住，并给**反面对照**：
//   * 被挡住 → 出路只有「复制详情给公司网管」，**不许**出现「过一会儿再试」；
//   * 网络不好 → **保持**「过一会儿再试」，**不许**被改成「问网管」。
//
// 判断错法可复现：把 `recovery.ts` 里 `PROXY_BLOCK` 那一条去掉，第一组就红；
// 把它放宽成不带「被」的中文匹配，最后一条反面对照就红。
import { describe, expect, test } from "bun:test";

import { explainError } from "./copy.ts";
import { RECOVERY } from "./copy-recovery.ts";
import { actionsFor } from "./recovery.ts";
import type { RecoveryAction, RecoveryError } from "./recovery.ts";

function err(detail: string): RecoveryError {
  return { what: "", how: "", detail };
}

/** 出错页上真正会给她的形状：what/how 是兜底中文，可核对的原文只在 cause。 */
function runFailure(cause: string): RecoveryError {
  return {
    what: "这件事没有做完。",
    how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
    detail: cause,
    cause,
  };
}

function labels(actions: readonly RecoveryAction[]): string {
  return actions.map((item) => item.label).join(" / ");
}

describe("被公司挡住：出路是问公司网管，不是「过一会儿再试」", () => {
  // 每一串都是任务点名要覆盖的真实特征：`407` / `proxy authentication` /
  // `corporate proxy` / `blocked by … proxy` / 中文「被公司网络挡住」。
  const blocked = [
    "407 Proxy Authentication Required",
    "Proxy-Authenticate: Basic realm=corp",
    "proxy authentication required",
    "403: Forbidden: blocked by corporate proxy",
    "blocked by the company proxy",
    "The request was denied by an upstream proxy",
    "connect ECONNREFUSED via a proxy",
    "被公司网络挡住了",
    "被公司的网络拦截",
    "被企业代理拒绝",
  ];

  test("每一串都只给「复制详情给公司网管」，而不是等网络自己好", () => {
    for (const text of blocked) {
      const actions = actionsFor(err(text));
      expect(actions.map((item) => item.kind), text).toEqual(["copy-detail"]);
      expect(actions[0]?.label, text).toContain("网管");
      // 等多久也没用，所以这条路里**不许**再出现「过一会儿再试」。
      expect(labels(actions), text).not.toContain("过一会儿");
    }
  });

  test("当面说清「这通常不是你的电脑坏了」（不然她会去折腾自己的电脑）", () => {
    const actions = actionsFor(err("407 Proxy Authentication Required"));
    expect(actions[0]?.why).toContain("不是你的电脑");
    // 文案必须来自 copy 模块，不在判断代码里另写一份。
    expect(actions[0]?.label).toBe(RECOVERY.askAdmin.label);
    expect(actions[0]?.why).toBe(RECOVERY.askAdmin.why);
  });

  test("走产品真实链路（store 的 RunError → explainError → actionsFor）时同样成立", () => {
    // 出错页真正收到的形状：store.runError 给的对象（what/how/detail/cause）。
    // explainError 见到 what 就直接透传，不会再去跑 DICTIONARY；可核对的原因只在
    // cause 里。这正是真机上会让它生效的那条路。
    const runError: RecoveryError = {
      what: "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: "403: Forbidden: blocked by corporate proxy",
      cause: "403: Forbidden: blocked by corporate proxy",
    };
    const human = explainError(runError);
    const actions = actionsFor({ ...human, cause: runError.cause });
    expect(actions.map((item) => item.kind)).toEqual(["copy-detail"]);
    expect(actions[0]?.label).toContain("网管");
  });
});

describe("网络不好：保持「过一会儿再试」，不许被改成「问网管」", () => {
  // 全是「等一下可能就好」的错法，和「公司不让我连」不是一回事。
  const flaky = [
    "fetch failed: ECONNREFUSED 127.0.0.1:8317",
    "Connection error.",
    "ETIMEDOUT",
    "network is unreachable",
    "no internet connection",
    "连接被拒绝",
    "网络断了",
    "连不上帮你处理的服务方，可能网络断了。已经做到第 2 步，原来的文件都还在。网络好了，点「再试一次」。",
  ];

  test("每一串都走原来的「再试一次」类出路，不出现「网管」", () => {
    for (const text of flaky) {
      const actions = actionsFor(err(text));
      expect(actions[0]?.kind, text).toBe("retry");
      expect(labels(actions), text).not.toContain("网管");
      // 「复制详情」这条后路照旧留着，但按钮不是「复制详情给公司网管」。
      expect(actions.at(-1)?.kind, text).toBe("copy-detail");
      expect(actions[0]?.label, text).not.toBe(RECOVERY.askAdmin.label);
    }
  });

  test("反面对照：这一句就是原来的「过一会儿再试」，没被动过", () => {
    for (const text of ["Connection error.", "ECONNREFUSED", "网络断了"]) {
      const actions = actionsFor(err(text));
      expect(actions[0]?.label, text).toBe(RECOVERY.retryLater.label);
      expect(actions[0]?.why, text).toBe(RECOVERY.retryLater.why);
    }
  });
});

describe("顺序与误伤：被挡住那条必须排在泛化的 NETWORK 前面", () => {
  test("同时命中两类时，更具体的「被挡住」赢（否则会被 NETWORK 抢答）", () => {
    // 真实代理原文常常同时带着网络串：`407` 与 `via proxy` 都在。
    // 若把 PROXY_BLOCK 放到 NETWORK 后面，这一条会被判成「过一会儿再试」。
    const both = actionsFor(err("407 Proxy Authentication Required (via a proxy)"));
    expect(both.map((item) => item.kind)).toEqual(["copy-detail"]);
    expect(both[0]?.label).toContain("网管");
  });

  test("英文 blocked（非文件、非代理语境）既不许触发文件占用，也不许误判成被挡住", () => {
    const policy = actionsFor(err("access blocked by the security policy"));
    expect(policy.map((item) => item.kind)).not.toContain("close-file");
    // 认不出来就老实退回通用出口，不编一个「问网管」的动作。
    expect(labels(policy)).not.toContain("网管");
  });

  test("文件名里的 407（报表407.xlsx）不许被当成代理要认证", () => {
    // `407` 单独看是个好特征，但它也可能只是文件名里的一串数字。
    // 判据：数字前后若紧跟着字母 / 点 / 斜杠，就不算状态码。
    for (const text of [
      "unsupported format for 报表407.xlsx",
      "cannot read file report-407.xlsx",
      "ENOENT: no such file C:\\\\工作\\\\报表407.xlsx",
    ]) {
      expect(labels(actionsFor(err(text))), text).not.toContain("网管");
    }
    // 反面对照：真的是状态码（前后是空白 / 行首行尾）仍然要认出来。
    for (const text of ["407 Proxy Authentication Required", "HTTP 407", "status: 407"]) {
      expect(labels(actionsFor(err(text))), text).toContain("网管");
    }
  });

  test("通用网络文案里也有「公司的网络挡住了」——但少了「被」，不许把普通断网判成被挡住", () => {
    // copy.ts 的通用网络句就是这句。它是**给用户看**的话，会被拼进判断文本里；
    // 所以中文判据必须带「被」，否则每一条普通断网都会被它抢过去判成「公司挡住」。
    const human = explainError("ECONNREFUSED");
    expect(human.what).toContain("公司的网络挡住了");
    const actions = actionsFor({ ...human, cause: "ECONNREFUSED" });
    expect(actions[0]?.label).toBe(RECOVERY.retryLater.label);
  });
});

describe("真机两种错法：wire 与 proxy407 给出不同的动作", () => {
  test("wire（真连不上）→ 过一会儿再试；proxy407（要认证）→ 复制详情给公司网管", () => {
    const wire = actionsFor(runFailure("Connection error."));
    const proxy407 = actionsFor(runFailure("407 Proxy Authentication Required"));
    expect(wire[0]?.label).toBe(RECOVERY.retryLater.label);
    expect(proxy407[0]?.label).toBe(RECOVERY.askAdmin.label);
    // 核心判据：两种错法**不再给同一个动作**。
    expect(wire[0]?.label).not.toBe(proxy407[0]?.label);
  });
});
