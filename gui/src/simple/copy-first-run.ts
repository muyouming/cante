// r24 — 头 60 秒：教她第一句话怎么说。
//
// 向导三步走完就是首页：一屏卡片加一个「直接说一句话」的框。对一个从没用过这类
// 工具的人，门槛不是按钮在哪，而是「我该怎么开口」——能说什么、能说到多细。
//
// 所以这里只做一件事：给她三句照着改就能用的人话，并且说清「点一下就会填进框
// 里」，让「照着改一句」成为她的第一次尝试。三句不是功能清单，是三种难度：
// 一句话就够的、要她把条件说清楚的、她大概想不到也能说的（微信里的接龙）。
//
// 两个界面（向导最后一步、首页输入框旁）必须说同一批话，所以例子和句子都放这里，
// 改一处两边一起变。纯函数（向导点的那句怎么交到首页、点完之后框里放什么、第一次
// 做成之后那句变体）也留在这里，理由和 AGENTS 写的一样：能单测，不碰界面。

/** 一条「照着说就行」的例子。 */
export interface SayExample {
  /** 一眼能看懂的分寸：这件事要说多细。 */
  level: string;
  /** 她可以照说、也可以照着改的那一句。 */
  sentence: string;
  /**
   * 同一件事、多说一个条件之后的样子。第一次做成之后给她看这一句：她刚办成的
   * 那件事，原来还可以说得更细（`finer` 一定是 `sentence` 加上一个条件，不是另
   * 一件事——测试里钉住了这一点）。
   */
  finer: string;
  /**
   * 这件事在卡片目录里的身份。对得上就说明这只是一句话的说法，卡片里本来就有；
   * 对不上（改了卡名）也不会出事：那时走「卡片名 + 一个条件」那条退路。
   */
  taskId: string;
}

/**
 * 三句例子。顺序就是难度顺序：从「一句话就够」到「你可能没想到」。
 *
 * 每句都是她办得成的一件事，不是功能名；每句都能照着改（换文件、换条件）。
 */
export const SAY_EXAMPLES: readonly SayExample[] = [
  {
    level: "一句话就够",
    sentence: "把这个文件夹里的文件按月份分好",
    finer: "把这个文件夹里的文件按月份分好，只留最近半年的",
    taskId: "files.by-date",
  },
  {
    level: "要给它条件",
    sentence: "把这两张表合成一张，重复的行只留一条",
    finer: "把这两张表合成一张，重复的行只留一条，金额那一列按部门加起来",
    taskId: "excel.merge",
  },
  {
    level: "你可能没想到",
    sentence: "帮我把微信里那些接龙整理成一张表",
    finer: "帮我把微信里那些接龙整理成一张表，同一个人报了两次的合成一行",
    taskId: "wechat.rollcall",
  },
];

/**
 * 她提交的这句话，是不是某条例子的原文？
 *
 * 是的话，这件事在卡片目录里本来就有，得走卡片那条流程（微信接龙要的是贴进去的
 * 文字，走「直接说一句话」会卡在选文件那一步）。只要有半点不同（她改了字），就
 * 还是按她自己想的说，不替她认。
 */
export function exampleForSentence(sentence: string): SayExample | null {
  const value = sentence.trim();
  if (!value) return null;
  return SAY_EXAMPLES.find((item) => item.sentence === value) ?? null;
}

/** 首页输入框旁、向导最后一步用的那些话。 */
export const FIRST_RUN = {
  /** 首页：摆在三句例子上面。要说清「点一下会怎样」。 */
  homeTitle: "不知道怎么说？点一句照说，改几个字就行",
  /** 向导最后一步的标题：接下来是三条承诺。 */
  promisesTitle: "开始之前，先记住三件事",
  /**
   * 三件事，一条一句，都是对她说的：两条路都行、动手前先问你、原来的东西不乱动。
   * 第二条是产品的承诺，不是说明——第一次就该知道。
   */
  promises: [
    {
      lead: "两条路都行：",
      body: "想做什么，点一张卡片，或者直接跟我说一句话。哪样顺手就用哪样；说得不细也没关系。",
    },
    {
      lead: "动手前先问你：",
      body: "要做什么、会动到哪些文件，我先念给你听。你点头，我才开始。",
    },
    {
      lead: "原来的东西不乱动：",
      body: "结果一律另存成新文件。原来的文件我不改、不删，做过的事还能撤回来。",
    },
  ],
  /** 向导最后一步：例子那一节的标题。 */
  wizardExamplesTitle: "第一句话可以这么说：",
  /** 点了会发生什么——这句话就是「例子可以点」的全部说明。 */
  wizardExamplesHint: "点一句，进去它就填在框里了，你改几个字就能开始。",
  /** 第一次做成之后，首页上那句话的开头。 */
  firstWinTitle: "这件事做成了。下一次，话可以说得更细：",
  /**
   * 为什么给她这一句（她自己说的一句话那条路）：她刚说出口的那句话还在眼前，
   * 「在刚才那句话后面加上…」指的就是它。
   */
  firstWinHint: "在刚才那句话后面加上你想要的条件，它就照着这个条件做。点一下就能填进下面的框里。",
  /**
   * 为什么给她这一句（点卡片那条路）：卡片做成的事没有「刚才那句话」，所以不能
   * 那样说；说的是同一件事再往下说细一点，而且不承诺做不到的事。
   */
  firstWinHintCard:
    "下一次做这件事，可以多说一个条件，它就照着这个条件做。点一下就能填进下面的框里。",
} as const;

// ---------------------------------------------------------------------------
// 向导点的那一句，怎么交到首页的框里
//
// 向导和首页都由外壳直接挂载，中间没有可以传参数的地方；而「点一句，进去就填好
// 了」是向导那边说的话，不能只是说说。所以中间放一处很小的暂存：向导点了就写下
// 来，首页一打开就取走并清掉（只填一次，不会第二次打开又冒出来）。
// ---------------------------------------------------------------------------

/** 暂存用的键；取走即删。 */
export const FIRST_RUN_SENTENCE_KEY = "cante:first-run:sentence";

/** 只用到这三件事，测试里可以塞一个假的进来。 */
export type SentenceStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStore(): SentenceStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    /* 有些环境把存储关掉了；那就当没暂存，首页的框空着，不报错 */
    return null;
  }
}

/** 记下她在向导里点的那一句。存不下就算了：不是出错，只是没这句话。 */
export function rememberSentence(
  sentence: string,
  target: SentenceStore | null = browserStore(),
): void {
  if (!target) return;
  const value = sentence.trim();
  if (!value) return;
  try {
    target.setItem(FIRST_RUN_SENTENCE_KEY, value);
  } catch {
    /* 存储满了或被禁止写入：当作没记下 */
  }
}

/** 取走向导里点的那一句；没有（或取过了）返回 null，那不是错误。 */
export function takeSentence(source: SentenceStore | null = browserStore()): string | null {
  if (!source) return null;
  try {
    const value = source.getItem(FIRST_RUN_SENTENCE_KEY);
    if (value === null) return null;
    source.removeItem(FIRST_RUN_SENTENCE_KEY);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 第一次做成之后那句变体
// ---------------------------------------------------------------------------

/** 她直接说一句话那条路在记录里留下的身份（和 tasks/index.ts 的常量同值，测试盯着）。 */
export const FREE_TEXT_RUN_ID = "free.text";

/** 这里只看这四样；文案模块不去 import 整个 store。 */
export interface FinishedRun {
  taskId: string;
  taskTitle: string;
  /** 她自己的那句话（用卡片时可能是空的）。 */
  instruction: string;
  state: string;
}

/** 卡名末尾那个补充（括号里的）是给眼睛看的，不是给人说的。 */
export function spokenTitle(title: string): string {
  return title
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 给「同一件事 + 一个条件」用的那个条件；说不出来时它也不硬凑。 */
const EXTRA_CONDITION = "，做完告诉我结果文件叫什么名字";

/** 她自己那句话本身太长时就不再往里加条件（长句再加条件只会更难读）。 */
const SAID_MAX_CHARS = 60;

function saidSentence(instruction: string): string {
  const flat = instruction
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。．.!！?？,，;；、]+$/u, "");
  if (!flat || flat.length > SAID_MAX_CHARS) return "";
  return flat;
}

/**
 * 她刚办成的那件事，下一次可以说得更细的那一句。说不出来就返回 null（首页那一
 * 行就不出现），而不是编一句不相干的：
 *
 *   * 正好对应三句例子里的一件事 → 用它的「加一个条件」版；
 *   * 她自己说的一句话 → 她的原话 + 一个条件（教她「话可以说得更细」）；
 *   * 别的卡片 → 卡名去掉括号补充 + 一个条件。
 */
export function nextTimeSuggestion(run: FinishedRun): string | null {
  const example = SAY_EXAMPLES.find((item) => item.taskId === run.taskId);
  if (example) return example.finer;

  const base =
    run.taskId === FREE_TEXT_RUN_ID
      ? saidSentence(run.instruction)
      : spokenTitle(run.taskTitle);
  if (!base) return null;
  return `${base}${EXTRA_CONDITION}`;
}

/**
 * 第一次做成之后，那句提示怎么说：她自己说的一句话那条路可以说「刚才那句话」，
 * 点卡片做成的没有那句话，得换一种说法。两种都不承诺做不到的事。
 */
export function firstWinHintFor(run: FinishedRun | null): string {
  return run?.taskId === FREE_TEXT_RUN_ID ? FIRST_RUN.firstWinHint : FIRST_RUN.firstWinHintCard;
}

/**
 * 第一次做成的那件事：只有「最新一条做成了、而且到现在为止只做成这一条」才返回
 * 它。也就是说这句话只在她第一次成功之后出现，不会变成每次回来都唠叨一遍的一行。
 *
 * 已知的边界：如果这台电脑以前只成功过一次、之后什么都没做，那么下次打开时它还会
 * 出现一次（我们只看记录，不看「刚才」）。等她又做成一件，这行就永久退场。
 */
export function firstWinRun(runs: readonly FinishedRun[]): FinishedRun | null {
  const newest = runs[0];
  if (!newest || newest.state !== "done") return null;
  const wins = runs.filter((run) => run.state === "done").length;
  return wins === 1 ? newest : null;
}
