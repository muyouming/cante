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
  localOnlyHint,
  onlineHint,
  onlineLabel,
  persistLocalOnly,
  privacyAnswers,
  readLocalOnly,
  runIsOnline,
  webSearchHint,
  type PrivacyState,
} from "./privacy.ts";
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
