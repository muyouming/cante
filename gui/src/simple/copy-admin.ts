// #58 — 企业预置配置（技术同事统一设好的那几项）的面向用户中文。
//
// 和别的 copy 模块一样：这里只有平实中文，一条术语都没有。三条纪律：
//
//   * 不卖萌、不吓人，就说清楚「设了什么」；
//   * 不出现「权限」「策略」「管理员模式」这类词——统一配电脑的人一律叫「技术同事」；
//   * 只陈述事实，不承诺它是安全边界：用户在自己电脑上能改这份文件，它解决的是
//     「公司放不放心」这个组织上的阻力，不是技术强制。
//
// 服务方、具体型号这些值是管理员写死的，按原样显示（它们是变量，不是文案）。
export const ADMIN = {
  /** 首页底部那句平实说明，只有存在配置时才出现。 */
  notice: "这台电脑的设置由技术同事统一管理。",
  showDetail: "看看设了什么",
  hideDetail: "收起",
  defaultLabel: "平时用哪个服务",
  defaultUnset: "没有特别指定，按默认的来",
  networkLabel: "能不能联网",
  networkAllowed: "可以联网，内容会发出去处理",
  networkLocalOnly: "只在这台电脑上处理，内容不外发",
  networkUnset: "没有特别限制",
  disabledLabel: "关掉的任务",
  disabledNone: "没有关掉任何任务",
} as const;

/** 「平时用哪个服务」那一段：有服务方和型号就一起显示，都没有就说没指定。 */
export function adminDefaultText(provider: string | null, model: string | null): string {
  const parts = [provider, model].filter((part): part is string => !!part && part.length > 0);
  if (parts.length === 0) return ADMIN.defaultUnset;
  return parts.join(" / ");
}

/** 「能不能联网」那一段。没写就是没有特别限制。 */
export function adminNetworkText(allow: boolean | null): string {
  if (allow === true) return ADMIN.networkAllowed;
  if (allow === false) return ADMIN.networkLocalOnly;
  return ADMIN.networkUnset;
}

/** 「关掉的任务」那一段：把任务的中文名字连起来；一个都没有就说没有。 */
export function adminDisabledText(names: readonly string[]): string {
  if (names.length === 0) return ADMIN.disabledNone;
  return names.join("、");
}
