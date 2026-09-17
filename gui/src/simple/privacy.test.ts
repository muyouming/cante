// Privacy copy and switch tests.
//
// The privacy promise is only as good as the words on screen, so these tests
// pin the copy: every answer stays in plain Chinese, the local-only switch
// flips both answers at once, and the two red-line notices are present verbatim.
import { beforeEach, describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import {
  DEFAULT_PRIVACY,
  DRAFT_SEND_NOTICE,
  LOCAL_ONLY_KEY,
  WECHAT_SAFETY_NOTICE,
  latestSentRun,
  localOnlyHint,
  onlineHint,
  onlineLabel,
  persistLocalOnly,
  privacyAnswers,
  readLocalOnly,
  runIsOnline,
  sentContentView,
  sentTextParts,
  webSearchHint,
  type PrivacyState,
} from "./privacy.ts";
import { SENT } from "./copy-privacy-audit.ts";
import { createStore } from "../store.ts";

/** Words this audience does not know; none may appear in user-facing copy. */
const FORBIDDEN = [
  "模型",
  "provider",
  "token",
  "prompt",
  "会话",
  "上下文",
  "权限",
  "工具调用",
  "diff",
  "worktree",
  "路径",
  "API",
];

function assertPlain(text: string): void {
  for (const word of FORBIDDEN) {
    expect(text).not.toContain(word);
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

beforeEach(() => {
  try {
    globalThis.localStorage?.removeItem(LOCAL_ONLY_KEY);
  } catch {
    // no storage in this runtime; the pure tests below do not need it
  }
});

describe("the network question", () => {
  test("a run is online only when allowed and not local-only", () => {
    expect(runIsOnline({ online: true, localOnly: false })).toBe(true);
    expect(runIsOnline({ online: true, localOnly: true })).toBe(false);
    expect(runIsOnline({ online: false, localOnly: false })).toBe(false);
    expect(runIsOnline({ online: false, localOnly: true })).toBe(false);
  });

  test("the result-card stamp and hint are Chinese and jargon-free", () => {
    for (const online of [true, false]) {
      assertPlain(onlineLabel(online));
      assertPlain(onlineHint(online));
    }
    expect(onlineLabel(true)).toBe("本次联网");
    expect(onlineLabel(false)).toBe("本次未联网");
    expect(onlineHint(false)).toContain("没有发出去");
  });
});

describe("the three answers", () => {
  test("always answers what is local, what is online, and who receives it", () => {
    const answers = privacyAnswers(DEFAULT_PRIVACY);
    expect(answers.map((item) => item.question)).toEqual([
      "哪些事在这台电脑上完成？",
      "哪些事需要联网？",
      "联网时内容发给谁？",
    ]);
    for (const item of answers) {
      expect(item.answer.trim().length).toBeGreaterThan(0);
      assertPlain(item.question);
      assertPlain(item.answer);
    }
  });

  test("local-only says nothing left the machine, even with a provider set", () => {
    const state: PrivacyState = { online: false, provider: "某服务方", localOnly: true };
    const who = privacyAnswers(state).at(-1)!.answer;
    expect(who).toContain("什么都没发出去");
    expect(who).not.toContain("某服务方");
  });

  test("online names the receiver once one is known", () => {
    const state: PrivacyState = { online: true, provider: "某服务方", localOnly: false };
    expect(privacyAnswers(state).at(-1)!.answer).toContain("某服务方");
  });

  test("online before the first task still says something concrete", () => {
    const state: PrivacyState = { online: true, provider: null, localOnly: false };
    const who = privacyAnswers(state).at(-1)!.answer;
    expect(who).toContain("开始后");
    assertPlain(who);
  });
});

describe("switch hints", () => {
  test("describe both states in plain language", () => {
    for (const value of [true, false]) {
      assertPlain(localOnlyHint(value));
      assertPlain(webSearchHint(value));
    }
    expect(localOnlyHint(true)).toContain("不会离开");
    expect(webSearchHint(true)).toContain("已关闭");
  });
});

describe("red-line notices", () => {
  test("are the exact wording the brief requires", () => {
    expect(WECHAT_SAFETY_NOTICE).toBe("本功能不会发送任何消息、不会登录你的微信。");
    expect(DRAFT_SEND_NOTICE).toBe("发送动作始终由你完成。");
  });
});

describe("remembering the switch", () => {
  test("reads and writes the local-only flag", () => {
    const storage = fakeStorage();
    expect(readLocalOnly(storage)).toBe(false);
    persistLocalOnly(true, storage);
    expect(storage.map.get(LOCAL_ONLY_KEY)).toBe("1");
    expect(readLocalOnly(storage)).toBe(true);
    persistLocalOnly(false, storage);
    expect(readLocalOnly(storage)).toBe(false);
  });

  test("never throws when storage is missing or hostile", () => {
    expect(readLocalOnly(null)).toBe(false);
    persistLocalOnly(true, null);
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLocalOnly(hostile)).toBe(false);
    expect(() => persistLocalOnly(true, hostile)).not.toThrow();
  });
});

describe("store privacy members", () => {
  function mountStore() {
    let store!: ReturnType<typeof createStore>;
    let dispose!: () => void;
    createRoot((root) => {
      dispose = root;
      store = createStore();
    });
    return { store, dispose };
  }

  test("defaults to online with nobody named yet", () => {
    const { store, dispose } = mountStore();
    expect(store.privacy()).toEqual({ online: true, provider: null, localOnly: false });
    dispose();
  });

  test("opening local-only turns the network answer off", async () => {
    const { store, dispose } = mountStore();
    await store.setLocalOnly(true);
    expect(store.privacy().localOnly).toBe(true);
    expect(store.privacy().online).toBe(false);
    expect(store.privacy().provider).toBeNull();
    await store.setLocalOnly(false);
    expect(store.privacy().online).toBe(true);
    dispose();
  });
});

// ---------------------------------------------------------------------------
// r20 — 「这次发出去了什么」
//
// 这一节展示的必须是**真正发出去的那段文字**（store.composedInstruction 的结果），
// 不是这里另拼的一份。所以下面的断言拿 store 的真实结果来对，而不是自己造一段。
// ---------------------------------------------------------------------------

describe("这次发出去了什么", () => {
  const TASK = {
    id: "excel.merge",
    title: "把几张表合成一张",
    plan: ["打开这几张表", "合成一张新表"],
  };

  function mount() {
    let store!: ReturnType<typeof createStore>;
    let dispose!: () => void;
    createRoot((root) => {
      dispose = root;
      store = createStore();
    });
    return { store, dispose };
  }

  test("展示的就是真正发出去的那一段，与 composedInstruction 逐字一致", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, ["/work/a.xlsx", "/work/b.xlsx"], "把这两张表合成一张");
    const run = store.currentRun()!;
    const composed = store.composedInstruction(run);
    const view = sentContentView({ text: composed, online: true });

    expect(view.state).toBe("sent");
    // 不另拼一份：显示的就是 store 真正会发出去的那一份。
    expect(view.text).toBe(composed);
    expect(view.text).toBe(store.composedInstruction(run));
    // 卡片的规矩和她的原话都在，长度也说明它不是一句话。
    expect(view.text).toContain("原来的文件一张都不要改");
    expect(view.text).toContain("把这两张表合成一张");
    expect(view.text.length).toBeGreaterThan(200);
    dispose();
  });

  test("摘要说出多少字、里面有哪几类内容", async () => {
    const { store, dispose } = mount();
    await store.startRun(TASK, ["/work/a.xlsx"], "把这两张表合成一张");
    const composed = store.composedInstruction(store.currentRun()!);
    const view = sentContentView({ text: composed, online: true });

    expect(sentTextParts(composed)).toEqual([
      SENT.partLabel.what,
      SENT.partLabel.where,
      SENT.partLabel.how,
      SENT.partLabel.words,
    ]);
    expect(view.summary).toContain("字");
    for (const label of sentTextParts(composed)) expect(view.summary).toContain(label);
    assertPlain(view.summary);
    dispose();
  });

  test("没联网时如实说：这次什么都没发出去，也不显示原文", () => {
    const view = sentContentView({ text: "一份并不存在的原文", online: false });
    expect(view.state).toBe("offline");
    expect(view.message).toContain("什么都没发出去");
    expect(view.text).toBe("");
    assertPlain(view.message);
  });

  test("还没做过任务时如实说，不假装发过", () => {
    const view = sentContentView(null);
    expect(view.state).toBe("none");
    expect(view.message).toContain("还没有做过任务");
    expect(view.text).toBe("");
    expect(view.summary).toBe("");
    assertPlain(view.message);
  });

  test("这一节所有的说明文案都没有技术词", () => {
    assertPlain(SENT.filesStay);
    assertPlain(SENT.textGoes);
    assertPlain(SENT.textIsLocal);
    assertPlain(SENT.none);
    assertPlain(SENT.offline);
    assertPlain(SENT.entryShow);
    assertPlain(SENT.entryHide);
    assertPlain(SENT.showFull);
    assertPlain(SENT.hideFull);
    assertPlain(SENT.summary(123, [SENT.partLabel.what, SENT.partLabel.where]));
  });

  test("摘要只描述原文里真有的内容：什么都没有时就说多少字", () => {
    // 找不到卡片时 composedInstruction 退回她那一句话，信封的开头一个都没有。
    expect(sentTextParts("把这两张表合成一张")).toEqual([]);
    expect(SENT.summary(9, [])).toContain("9 个字");
    expect(SENT.summary(9, [])).not.toContain("里面有");
  });

  test("最近一次任务：停在确认页的不算，做过或做完的才算", () => {
    const runs = [
      { id: "old", state: "done", createdAt: 10 },
      { id: "new", state: "preview", createdAt: 99 },
    ];
    expect(latestSentRun(runs)?.id).toBe("old");
    expect(latestSentRun([{ id: "draft", state: "draft", createdAt: 5 }])).toBeNull();
    expect(latestSentRun([])).toBeNull();
  });
});
