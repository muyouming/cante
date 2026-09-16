// 能力中心的检索逻辑：按「你想做的事」找任务。
//
// 纯函数，不碰界面、不碰后台，所以可以单独测。首页分组、浮层搜索、诚实边界
// 这三件事都从这里出发。
//
// 为什么同义词表写死在这个文件里，而不是引入一个中文分词库：
//
//   * 我们面对的是十来个任务、几十个说法，不是全网文本。分词库要带一份词表
//     和一套切词规则，体积、启动时间、以及「为什么它把这句话切成这样」都变成
//     新的不确定性。对一个要打包进桌面程序、给非 IT 用户用的工具，这不划算。
//   * 用户说的词是有限的、可枚举的，就写在下面这张表里。改一个词是新加一行，
//     不用重新训练，也不会有版本升级带来的行为漂移。
//   * 这张表也是产品资产：它记录了「王姐会怎么描述这件事」。以后每加一个任务，
//     都顺手想一遍用户会怎么说、要不要补一行。
import { LIBRARY } from "./copy-library.ts";
import { TASKS, type TaskDef, type TaskGroup } from "./tasks/index.ts";

/** 分组的展示顺序（和首页、copy.ts 的 TASK_GROUPS 保持一致）。 */
const GROUP_ORDER: readonly TaskGroup[] = ["表格", "文件", "微信", "文书", "资料"];

/**
 * 需要「看图认字」才能处理的文件类型。协议目前只能把文字交给助手，图片里的
 * 字读不出来，所以带这些后缀的任务要如实说明现在做不到。
 */
export const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "jpe",
  "bmp",
  "webp",
  "gif",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
]);

/**
 * 同义词表：每一行是一组「意思一样」的说法。用户在搜索框里说出其中一个，
 * 就把整组都当成候选词去匹配，这样「合并」能找到「合成一张」，「对账」能找到
 * 「比较差异」。
 *
 * 只写真正会出现在任务文案里的词，不追求覆盖所有中文说法——宁可搜不到，
 * 也不要搜出一堆不相干的东西。
 */
const SYNONYMS: readonly (readonly string[])[] = [
  ["合并", "汇总", "合起来", "合成", "合成一张", "拼成", "拼起来", "并成一张"],
  ["去重", "重复", "重了", "重复行"],
  ["对账", "核对", "比对", "对比", "差异", "查差异", "不同"],
  ["筛选", "挑出", "选出", "找出", "只要"],
  ["拆分", "分开", "拆成", "拆开", "分列", "拆列"],
  ["改名", "重命名", "换个名字"],
  ["归档", "整理", "分类", "按月份", "分组"],
  ["微信", "群", "聊天", "聊天记录", "导出"],
  ["pdf", "扫描件", "扫描"],
  ["图片", "照片", "截图", "相片"],
  ["总结", "摘要", "提炼", "要点", "概括"],
  ["通知", "告示", "请假", "请假条", "周报", "汇报", "纪要", "会议记录"],
  // 调研（2026-09）补进来的说法：这些词是王姐真会打的，不是我们编的。
  ["检查", "查错", "错了", "对不对", "核一下", "合计", "小计", "总计", "算错"],
  ["发票", "报销", "票据", "台账", "单据"],
  ["考勤", "打卡", "排班", "工时"],
  ["花名册", "员工", "人员", "名单", "档案", "入离职"],
  ["到期", "过期", "续签", "提醒", "合同"],
  ["接龙", "报名", "统计人数", "份数", "没交", "没报名"],
  ["盘点", "资产", "库存", "对不上"],
  ["政策", "标准", "规定", "依据", "出处", "来源", "查一下", "资料"],
];

/** 大小写、空格都不该影响搜索：统一成小写、去掉所有空白。 */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "");
}

/**
 * 把搜索词展开成一组候选词：原话本身，加上它触发到的每一个同义词组里的词。
 * 空搜索词返回空数组（调用方据此返回全部）。
 */
function expandedTerms(query: string): string[] {
  const q = normalize(query);
  if (!q) return [];
  const terms = new Set<string>([q]);
  for (const group of SYNONYMS) {
    if (!group.some((word) => q.includes(normalize(word)))) continue;
    for (const word of group) terms.add(normalize(word));
  }
  return [...terms];
}

/** 一段文字里是否出现任意一个候选词。 */
function hits(text: string, terms: readonly string[]): boolean {
  const hay = normalize(text);
  return terms.some((term) => term.length > 0 && hay.includes(term));
}

/**
 * 一个任务对搜索词的得分。标题命中最高，组名和示例次之，计划步骤和结果提示
 * 最低——分数越高排得越前。0 表示不命中。
 */
function scoreTask(task: TaskDef, terms: readonly string[]): number {
  if (hits(task.title, terms)) return 3;
  if (hits(task.group, terms) || hits(task.example, terms)) return 2;
  const rest = [...task.plan, ...task.summaryHints];
  if (rest.some((line) => hits(line, terms))) return 1;
  return 0;
}

/**
 * 按「你想做的事」搜索任务。
 *
 * - 空搜索词（或纯空白）返回全部，保持 `TASKS` 的原始顺序（常用在前）。
 * - 同分时也保持原始顺序：得分相同的卡片不会因为搜索而乱跳。
 * - 传 `tasks` 可以只搜一部分（测试和预览用）。
 */
export function searchTasks(query: string, tasks: TaskDef[] = TASKS): TaskDef[] {
  const terms = expandedTerms(query);
  if (terms.length === 0) return [...tasks];
  return tasks
    .map((task, index) => ({ task, index, score: scoreTask(task, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.task);
}

/**
 * 按 `TaskGroup` 分组，顺序固定为 表格、文件、微信、文书、资料，只返回非空的组。
 * 不传 `tasks` 就用整份目录。
 */
export function groupTasks(tasks: TaskDef[] = TASKS): Array<{ group: TaskGroup; tasks: TaskDef[] }> {
  const out: Array<{ group: TaskGroup; tasks: TaskDef[] }> = [];
  for (const group of GROUP_ORDER) {
    const inGroup = tasks.filter((task) => task.group === group);
    if (inGroup.length > 0) out.push({ group, tasks: inGroup });
  }
  return out;
}

/**
 * 「现在这台电脑能不能做」。
 *
 * 返回 `null` 表示能做。返回一句话表示现在还做不到，界面用中性的提示把它说出来
 * ——这是诚实的边界，不是错误。目前只有一件做不到的事：从图片（照片、截图）里
 * 认字。协议现在只能把文字交给助手，图片内容送不进去，所以带图片后缀、又要选
 * 文件的任务会命中这里。
 *
 * 故意不做别的限制：现有任务只要不是读图片，都返回 `null`。
 */
export function availabilityHint(task: TaskDef, canSeeImages = false): string | null {
  if (task.needs !== "files") return null;
  const accept = task.accept ?? [];
  const needsImages = accept.some((ext) => IMAGE_TYPES.has(ext.toLowerCase()));
  if (!needsImages) return null;
  // 这条边界曾经是"一律做不到"（协议只承载文本、本机没有 OCR）。现在换成
  // **取决于这个模型能不能看图**：能看图就不该再标"做不到"，看不了图才要如实说。
  // 判断依据由调用方注入（`capabilities.ts` 的 visionAvailable），这里只做纯判断。
  return canSeeImages ? null : LIBRARY.unavailableImage;
}
