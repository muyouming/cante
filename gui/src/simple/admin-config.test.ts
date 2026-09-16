// #58 — 企业预置配置的前端行为。
//
// 只测两件事：
//   1. 读配置失败时按「没有配置」处理，且绝不抛异常——这是「不让软件打不开」的底线；
//   2. isTaskDisabled 在禁用列表为空 / 有值时的判断，以及不认识的 id 不会出事。
//
//   bun test src

import { describe, expect, mock, test } from "bun:test";

// 让读取必失败：模拟"这台电脑没有桌面程序 / 命令报错"。
// 同时数一下真正问了几次后端，用来验证初始化是幂等的。
let invocations = 0;
mock.module("../tauri.ts", () => ({
  invoke: async () => {
    invocations += 1;
    throw new Error("desktop bridge unavailable");
  },
  isBridgeAvailable: () => false,
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  BridgeUnavailable: class BridgeUnavailable extends Error {},
  CommandRejected: class CommandRejected extends Error {},
}));

const {
  adminConfig,
  disabledTaskNames,
  initAdminConfig,
  isTaskDisabled,
  normalizeAdminConfig,
} = await import("./admin-config.ts");
const { taskById } = await import("./tasks/index.ts");

import type { AdminConfig } from "./admin-config.ts";

/** 一份最小可用的配置，测试里只改动关心的字段。 */
function configured(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    present: true,
    default_provider: null,
    default_model: null,
    allow_network: null,
    disabled_tasks: [],
    ...overrides,
  };
}

describe("initAdminConfig", () => {
  test("读不到配置时 present 为 false，且不抛异常", async () => {
    await expect(initAdminConfig()).resolves.toBeUndefined();
    expect(adminConfig().present).toBe(false);
    expect(adminConfig().disabled_tasks).toEqual([]);
  });

  test("重复调用是幂等的：多次读到的结果一致", async () => {
    const first = await initAdminConfig();
    const second = await initAdminConfig();
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(adminConfig()).toEqual({
      present: false,
      default_provider: null,
      default_model: null,
      allow_network: null,
      disabled_tasks: [],
    });
    // 只问了一次后端：再来多少次也不会重新问。
    const before = invocations;
    await initAdminConfig();
    await initAdminConfig();
    expect(invocations).toBe(before);
  });
});

describe("normalizeAdminConfig", () => {
  test("没有配置、present 不是 true，都当成没有配置", () => {
    expect(normalizeAdminConfig(null).present).toBe(false);
    expect(normalizeAdminConfig(undefined).present).toBe(false);
    expect(normalizeAdminConfig({}).present).toBe(false);
    expect(normalizeAdminConfig({ present: false, disabled_tasks: ["excel.merge"] }).present).toBe(
      false,
    );
  });

  test("完整配置原样保留", () => {
    const config = normalizeAdminConfig({
      present: true,
      default_provider: "openai-compatible",
      default_model: "ocg/deepseek-flash",
      allow_network: false,
      disabled_tasks: ["excel.merge"],
    });
    expect(config).toEqual({
      present: true,
      default_provider: "openai-compatible",
      default_model: "ocg/deepseek-flash",
      allow_network: false,
      disabled_tasks: ["excel.merge"],
    });
  });
});

describe("isTaskDisabled", () => {
  test("禁用列表为空时，任何任务都没被关", () => {
    expect(isTaskDisabled("excel.merge", configured())).toBe(false);
    expect(isTaskDisabled("wechat.draft", configured())).toBe(false);
  });

  test("列表里有这个 id 就是关掉的，别的任务不受影响", () => {
    const config = configured({ disabled_tasks: ["excel.merge", "wechat.batch"] });
    expect(isTaskDisabled("excel.merge", config)).toBe(true);
    expect(isTaskDisabled("wechat.batch", config)).toBe(true);
    expect(isTaskDisabled("excel.group", config)).toBe(false);
  });

  test("没有配置时一律不关（读不到就按完整功能显示）", () => {
    const absent: AdminConfig = {
      present: false,
      default_provider: null,
      default_model: null,
      allow_network: null,
      disabled_tasks: ["excel.merge"],
    };
    expect(isTaskDisabled("excel.merge", absent)).toBe(false);
  });

  test("不认识的 id 留在列表里也不报错", () => {
    const config = configured({ disabled_tasks: ["no.such.task"] });
    expect(isTaskDisabled("no.such.task", config)).toBe(true);
    expect(isTaskDisabled("excel.merge", config)).toBe(false);
  });
});

describe("disabledTaskNames", () => {
  test("认识的 id 换成中文名字，不认识的直接跳过", () => {
    const title = taskById("excel.merge")?.title;
    expect(title).toBeTruthy();
    const names = disabledTaskNames(configured({ disabled_tasks: ["excel.merge", "no.such.task"] }));
    expect(names).toEqual([title as string]);
  });

  test("列表为空时没有名字", () => {
    expect(disabledTaskNames(configured())).toEqual([]);
  });
});
