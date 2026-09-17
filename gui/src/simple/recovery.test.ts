// 出错之后的出路，逐类复盘。
//
// 这个文件盯的是 r14 的核心承诺：失败时给她的不是三个平级出口，而是「这一步为什
// 么失败、我现在该按哪个按钮」。规则全部基于错误文本里能核对的特征，所以每一类都
// 能写成一条可复现的用例；认不出来的必须老老实实退回通用三个出口。
//
// 也顺手钉住两个容易被改坏的性质：她说「我拿不准」时不能再给「重试」（重跑一遍不
// 会让她那处不确定变确定），以及「复制详情」永远在最后（给懂电脑的人那条后路不能
// 被别掉）。
import { describe, expect, test } from "bun:test";

import { ERRORS, explainError } from "./copy.ts";
import { actionsFor, causeOf } from "./recovery.ts";
import type { RecoveryAction, RecoveryError } from "./recovery.ts";

function err(detail: string, what = "", how = ""): RecoveryError {
  return { what, how, detail };
}

function kinds(actions: readonly RecoveryAction[]): string[] {
  return actions.map((item) => item.kind);
}

describe("actionsFor：常见失败各给一条能走的路", () => {
  test("文件正被 Excel / WPS 打开：先关窗口再重试，不给「重新选文件」", () => {
    const busy = actionsFor(err("EBUSY: resource busy or locked, open 'C:\\报表.xlsx'"));
    expect(busy[0]?.kind).toBe("close-file");
    expect(busy[0]?.label).toContain("关掉");
    expect(kinds(busy)).not.toContain("pick-files");

    // Windows 上真实会看到的中文提示也一样认得出来。
    expect(actionsFor(err("另一个程序正在使用此文件，进程无法访问")).at(0)?.kind).toBe("close-file");
    // 走产品真实链路（explainError → actionsFor）时同样成立。
    expect(actionsFor(explainError("EBUSY: resource busy or locked")).at(0)?.kind).toBe("close-file");
  });

  test("开的是浏览器预览、没连上桌面程序：先去打开桌面程序", () => {
    const bridge = actionsFor(explainError("desktop bridge unavailable"));
    expect(kinds(bridge)).toEqual(["retry", "copy-detail"]);
    expect(bridge[0]?.label).toContain("桌面程序");
  });

  test("文件被移动 / 删除：重新选一次文件", () => {
    const missing = actionsFor(err("Error: ENOENT: no such file or directory, open 'C:\\报表.xlsx'"));
    expect(missing[0]?.kind).toBe("pick-files");
    expect(missing[0]?.label).toContain("选");

    // 走 explainError 时命中的是 notFoundWhat 那句中文，也必须给同一个动作。
    const localised = actionsFor(explainError("ENOENT: no such file or directory"));
    expect(localised[0]?.kind).toBe("pick-files");
  });

  test("没有权限：换个位置保存", () => {
    const denied = actionsFor(err("os error 13: Permission denied (os error 13)"));
    expect(kinds(denied)).toContain("save-elsewhere");
    expect(kinds(denied)).not.toContain("close-file");

    // Windows 上写不进 xlsx，最常见是 Excel 正开着它——两条路都给，先关窗口。
    const office = actionsFor(err("PermissionError: [Errno 13] Permission denied: 'C:\\报表.xlsx'"));
    expect(office[0]?.kind).toBe("close-file");
    expect(kinds(office)).toContain("save-elsewhere");
  });

  test("看不懂图片里的字：用文字写下来", () => {
    const image = actionsFor(err("无法读取图片里的文字"));
    expect(image[0]?.kind).toBe("explain-in-words");
    expect(image[0]?.label).toContain("文字");
  });

  test("没有联网 / 服务方不可用：稍后重试，并给她找技术同事的出口", () => {
    const offline = actionsFor(err("fetch failed: ECONNREFUSED 127.0.0.1:8317"));
    expect(kinds(offline)).toEqual(["retry", "copy-detail"]);
    expect(offline[0]?.label).toContain("再试");

    // 中文表述（copy.ts 的 network)也一样。
    expect(kinds(actionsFor(explainError("fetch failed: ECONNREFUSED")))).toEqual([
      "retry",
      "copy-detail",
    ]);
  });

  test("动手的组件说 Connection error.：同样是没联网，不给「重新选文件」", () => {
    // 真机验过的那一串：断网时 cante-bridge 报的就是这一句（没有 details）。
    // 旧写法只认 connection refused，于是她拿到的是「重新选一次文件」——
    // 网络断了和她的文件没有一点关系。
    const offline = actionsFor(err("Connection error."));
    expect(kinds(offline)).toEqual(["retry", "copy-detail"]);
    expect(offline[0]?.label).toContain("再试");
    expect(kinds(offline)).not.toContain("pick-files");
    // 那条 why 要把「网络」说出来，不然她不知道等一下是为了什么。
    expect(offline[0]?.why).toContain("网络");
  });

  test("她说「我拿不准」：回一句话，而不是重跑", () => {
    const unsure = actionsFor(err("我拿不准该核哪一列，需要你确认"));
    expect(unsure[0]?.kind).toBe("explain-in-words");
    expect(unsure[0]?.label).toContain("回一句话");
    expect(kinds(unsure)).not.toContain("retry");
  });

  test("账号没配好：她自己改不了，直接把详情交给同事", () => {
    const auth = actionsFor(err("401 Unauthorized: invalid api key"));
    expect(kinds(auth)).toEqual(["copy-detail"]);
    expect(auth[0]?.label).toContain("同事");
  });

  test("文件打不开 / 损坏：换一份再选", () => {
    const broken = actionsFor(err("openpyxl cannot read 报表.xlsx"));
    expect(broken[0]?.kind).toBe("pick-files");
    expect(broken[0]?.label).toContain("换一份");
  });

  test("磁盘满了：清理之后再试", () => {
    const full = actionsFor(err("ENOSPC: no space left on device"));
    expect(full[0]?.kind).toBe("retry");
    expect(full[0]?.label).toContain("清理");
  });
});

describe("actionsFor：可核对的原因（cause）也参与判断", () => {
  /** 出错界面上真正会给她的形状：what/how 是平实中文，原文只在 cause 里。 */
  function runFailure(cause: string): RecoveryError {
    return {
      what: "这件事没有做完。",
      how: "原来的文件都还在。可以再试一次，或者换一种说法告诉我要做什么。",
      detail: "没有更多说明。",
      cause,
    };
  }

  test("cause 说文件被占用：关掉 Excel 里那个窗口", () => {
    const busy = actionsFor(runFailure("EBUSY: resource busy or locked, open 'C:\\报表.xlsx'"));
    expect(busy[0]?.kind).toBe("close-file");
    expect(busy[0]?.label).toContain("关掉");
    expect(busy[0]?.label).toContain("Excel");
  });

  test("cause 里带着表格的临时锁文件：也算表格开着它，不给「换一份文件」", () => {
    // 原文里只有个 `~$报表.xlsx` 时，旧判断会因为 .xlsx 后缀把它归成「格式看不懂」。
    const locked = actionsFor(runFailure("无法写入 C:\\工作\\~$报表.xlsx"));
    expect(locked[0]?.kind).toBe("close-file");
    expect(locked[0]?.label).toContain("Excel");
    expect(kinds(locked)).not.toContain("pick-files");
  });

  test("cause 说找不到文件：重新选一次文件", () => {
    const missing = actionsFor(runFailure("ENOENT: no such file or directory"));
    expect(missing[0]?.kind).toBe("pick-files");
    expect(missing[0]?.label).toContain("选");
  });

  test("cause 说连不上服务方：过一会儿再试，不给「重新选文件」", () => {
    // 出错页上真正会给她的形状：what/how 是 store 的兜底两句，原文只在 cause。
    const offline = actionsFor(runFailure("Connection error."));
    expect(kinds(offline)).toEqual(["retry", "copy-detail"]);
    expect(offline[0]?.label).toContain("再试");
    expect(kinds(offline)).not.toContain("pick-files");
  });

  test("#173 停滞：已经在做、做到一半断了，出路是「再试一次」", () => {
    // 这一句是桥自己在服务方长时间没消息时报的（bridge.rs 的 STALL_HEADLINE）。
    // 它比普通的「连不上」更具体：事情已经做了一半，所以要告诉她怎么接着走，
    // 而不是让她重新选文件。文案里的数字必须原样留着。
    const stalled = actionsFor(
      runFailure(
        "连不上帮你处理的服务方，可能网络断了。已经做到第 3 步，原来的文件都还在。网络好了，点「再试一次」。",
      ),
    );
    expect(kinds(stalled)).toEqual(["retry", "copy-detail"]);
    expect(stalled[0]?.label).toBe("再试一次");
    expect(stalled[0]?.why).toContain("网络");
    expect(kinds(stalled)).not.toContain("pick-files");

    // 没带步数时也走同一条路，不退回通用出口。
    expect(actionsFor(runFailure("连不上帮你处理的服务方"))[0]?.label).toBe("再试一次");
  });

  test("cause 说没有权限：另存到能写的位置", () => {
    const denied = actionsFor(runFailure("os error 13: Permission denied"));
    expect(kinds(denied)).toContain("save-elsewhere");
    expect(kinds(denied)).not.toContain("close-file");
  });

  test("cause 认不出来：老老实实退回通用三个出口", () => {
    expect(kinds(actionsFor(runFailure("something very strange happened")))).toEqual([
      "retry",
      "pick-files",
      "copy-detail",
    ]);
  });

  test("老形状（没有 cause）行为一模一样", () => {
    // 不传 cause 时判断只吃 what/how/detail，结果与加这个字段之前完全一致。
    expect(kinds(actionsFor(err("EBUSY: resource busy or locked")))).toEqual([
      "close-file",
      "copy-detail",
    ]);
    expect(kinds(actionsFor(err("ENOENT: no such file")))).toEqual(["pick-files", "copy-detail"]);
    expect(kinds(actionsFor(err("something unknown")))).toEqual([
      "retry",
      "pick-files",
      "copy-detail",
    ]);
  });

  test("cause 认出来时也要留住「复制详情」那条后路", () => {
    for (const cause of ["EBUSY", "ENOENT", "Permission denied", "~$报表.xlsx", "unknown"]) {
      const list = actionsFor(runFailure(cause));
      expect(list.at(-1)?.kind).toBe("copy-detail");
      expect(list.filter((item) => item.kind === "copy-detail")).toHaveLength(1);
    }
  });

  test("causeOf 只认对象上的 cause，字符串和 Error 都没有", () => {
    expect(causeOf({ what: "", how: "", detail: "", cause: "EBUSY" })).toBe("EBUSY");
    expect(causeOf({ what: "", how: "", detail: "EBUSY" })).toBeUndefined();
    expect(causeOf("EBUSY")).toBeUndefined();
    expect(causeOf(new Error("EBUSY"))).toBeUndefined();
    expect(causeOf(null)).toBeUndefined();
    expect(causeOf({ cause: "   " })).toBeUndefined();
  });
});

describe("actionsFor：认不出来就退回通用出口，不编动作", () => {
  test("没见过的错误 → 重试 / 换个方法 / 复制详情", () => {
    const unknown = actionsFor(err("something very strange happened"));
    expect(kinds(unknown)).toEqual(["retry", "pick-files", "copy-detail"]);
  });

  test("空文本也有一套可用的出口", () => {
    const empty = actionsFor(err(""));
    expect(kinds(empty)).toEqual(["retry", "pick-files", "copy-detail"]);
  });

  test("没有需要的文件时，不硬塞「重新选文件」", () => {
    expect(kinds(actionsFor(err(""), { needs: "none" }))).toEqual(["retry", "copy-detail"]);
  });

  test("文字类的事情：通用出口是「换一句话」，不是选文件", () => {
    const text = actionsFor(err(""), { needs: "text" });
    expect(kinds(text)).toEqual(["retry", "explain-in-words", "copy-detail"]);
  });

  test("文件夹类的事情：通用出口是「打开文件夹」", () => {
    const folder = actionsFor(err(""), { needs: "folder" });
    expect(kinds(folder)).toEqual(["retry", "open-folder", "copy-detail"]);
  });
});

describe("actionsFor：每条动作她自己读得懂", () => {
  const samples: RecoveryError[] = [
    err("desktop bridge unavailable"),
    err("EBUSY: resource busy"),
    err("ENOENT: no such file"),
    err("Permission denied"),
    err("无法读取图片里的文字"),
    err("ECONNREFUSED"),
    err("我拿不准"),
    err("401 unauthorized"),
    err("something unknown"),
    err(""),
  ];

  test("按钮上有一句话，下面有一句为什么，且都是中文", () => {
    for (const sample of samples) {
      for (const item of actionsFor(sample)) {
        expect(item.label.trim().length).toBeGreaterThan(0);
        expect(item.why.trim().length).toBeGreaterThan(8);
        expect(/[\u3400-\u9fff]/.test(item.label)).toBe(true);
        expect(/[\u3400-\u9fff]/.test(item.why)).toBe(true);
      }
    }
  });

  test("「复制详情」永远留在最后，给懂电脑的人留一条后路", () => {
    for (const sample of samples) {
      const list = actionsFor(sample);
      expect(list.at(-1)?.kind).toBe("copy-detail");
      expect(list.filter((item) => item.kind === "copy-detail")).toHaveLength(1);
    }
  });

  test("文案用的是 copy 模块里的原话，不在判断代码里另写一份", () => {
    // 通用出口的「重试」必须和 copy.ts 里那句诊断对得上（同一套说法）。
    expect(actionsFor(err("")).at(0)?.why).toContain("再走一遍");
    // 已解释过的文件找不到，不该因为传了 what/how 就丢掉具体动作。
    const explained = actionsFor({ what: ERRORS.notFoundWhat, how: ERRORS.notFoundHow, detail: "" });
    expect(explained[0]?.kind).toBe("pick-files");
  });
});
