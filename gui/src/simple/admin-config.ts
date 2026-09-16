// #58 — 企业预置配置的前端一侧：读缓存 + 幂等初始化 + 两个只用来看的小工具。
//
// 现实里，挡住办公人群用 AI 的不是能力，是「公司放不放心」。IT 同事统一配一次
// 就解决了。后端从 `~/.cante/admin.json` 读到的结果，在这里缓存下来，交给首页、
// 能力中心和向导如实显示。
//
// 三条约定，都是为了让「读不到配置」永远不会变成「软件打不开」：
//   * 只探测一次，幂等；重复调用返回同一个 Promise；
//   * 永不抛异常：命令失败、后端不在、字段乱写，一律按「没有配置」处理；
//   * 这不是安全边界——用户能改这份文件。它解决的是组织上的顾虑，不是技术强制。
//
// 为什么用 Signal 而不是普通变量：配置是异步读到的，首页要在它到货后立刻重画
// （被关掉的任务卡要消失）。初始值是「没有配置」，所以读到之前界面先按全量显示。
import { createSignal } from "solid-js";

import { invoke } from "../tauri.ts";
import { TASKS, taskById } from "./tasks/index.ts";

/** 后端 `admin_config` 命令的返回，也是界面读到的形状。 */
export interface AdminConfig {
  /** 这台电脑到底有没有被统一设过。 */
  present: boolean;
  /** 管理员规定的默认连接。 */
  default_provider: string | null;
  default_model: string | null;
  /** 是否允许联网；false 表示只在本机处理。 */
  allow_network: boolean | null;
  /** 被禁用的任务 id，这些任务在界面上不出现。 */
  disabled_tasks: string[];
}

/** 没有配置（或读失败）时的样子。冻结一份，避免被谁改掉。 */
const ABSENT: AdminConfig = {
  present: false,
  default_provider: null,
  default_model: null,
  allow_network: null,
  disabled_tasks: [],
};

const [config, setConfig] = createSignal<AdminConfig>(ABSENT);
let pending: Promise<void> | null = null;

/** 同步读缓存；没读到就是「没有配置」。 */
export function adminConfig(): AdminConfig {
  return config();
}

/** 这台电脑是不是被统一设过（给向导判断要不要弹）。 */
export function adminConfigured(): boolean {
  return config().present;
}

/**
 * 把后端的原始结果收成一份完整配置。字段缺失、类型不对、`present` 不是 true，
 * 一律按「没有配置」；`disabled_tasks` 只留字符串，不认识的 id 也先留着（由界面忽略）。
 */
export function normalizeAdminConfig(raw: Partial<AdminConfig> | null | undefined): AdminConfig {
  if (!raw || raw.present !== true) return ABSENT;
  const disabled = Array.isArray(raw.disabled_tasks)
    ? raw.disabled_tasks.filter((id): id is string => typeof id === "string")
    : [];
  return {
    present: true,
    default_provider: typeof raw.default_provider === "string" ? raw.default_provider : null,
    default_model: typeof raw.default_model === "string" ? raw.default_model : null,
    allow_network: typeof raw.allow_network === "boolean" ? raw.allow_network : null,
    disabled_tasks: disabled,
  };
}

/**
 * 这个任务是不是被关掉了。没有配置时一律返回 false——配置读不到，界面就该按
 * 完整的功能显示，而不是猜。
 *
 * 第二个参数是给测试和明确调用用的；不传就读当前缓存的配置。
 */
export function isTaskDisabled(taskId: string, from: AdminConfig = config()): boolean {
  if (!from.present) return false;
  return from.disabled_tasks.includes(taskId);
}

/** 当前能显示的任务（目录减去被关掉的那些）。 */
export function visibleTasks(from: AdminConfig = config()): typeof TASKS {
  return TASKS.filter((task) => !isTaskDisabled(task.id, from));
}

/**
 * 被关掉的任务的中文名字，按目录里的标题：`["写群发草稿"]`。
 *
 * 不认识的 id（旧版本留下的、写错的）直接跳过——界面上不该出现一串英文 id。
 */
export function disabledTaskNames(from: AdminConfig = config()): string[] {
  const names: string[] = [];
  for (const id of from.disabled_tasks) {
    const task = taskById(id);
    if (task) names.push(task.title);
  }
  return names;
}

/**
 * 启动时读一次配置，幂等，永不抛。
 *
 * 读失败就当没有配置。`tauri.ts` 的 invoke 有逐命令的联合类型；这里给这个模块
 * 补一条它还没声明的命令（和 capabilities.ts 一样）。
 */
export async function initAdminConfig(): Promise<void> {
  if (pending) return pending;
  pending = (async () => {
    try {
      const ask = invoke as unknown as (
        name: string,
      ) => Promise<Partial<AdminConfig> | null | undefined>;
      const raw = await ask("admin_config");
      setConfig(normalizeAdminConfig(raw));
    } catch {
      setConfig(ABSENT);
    }
  })();
  return pending;
}

// 应用一启动就试着读一次：界面拿到结果后自己会重画。失败也不影响任何别的模块。
void initAdminConfig();
