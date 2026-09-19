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

/**
 * 点一条例子时，框里已经有的字怎么办（F4）。
 *
 * 框是空的、或者正好就是这一句：**直接填进去**。那是她把例子当起点、接着改几个
 * 字用的路，也是「点一下顺手」的那条路。
 *
 * 框里已经有她打的别的字：**一个字都不动**，只把这一句挂成「等她点头」。她很可能
 * 先打了半句「帮我把上个月的表格」，再想参考一下例子怎么写；静默清掉她那半句是
 * 数据丢失（没有撤销、没有确认），所以这里只回答「要不要换」，换不换由她说。
 *
 * 纯函数：界面照这个结果做（fill 就直接 setText，confirm 就先问一句），测试直接
 * 断言这里返回的具体内容。
 */
export type ExampleClick =
  | { kind: "fill"; text: string }
  | { kind: "confirm"; text: string };

export function exampleClick(current: string, sentence: string): ExampleClick {
  const value = sentence.trim();
  const existing = current.trim();
  // 空的、或者和这一句一模一样：没什么可丢的，直接填。
  if (!existing || existing === value) return { kind: "fill", text: value };
  return { kind: "confirm", text: value };
}

/** 首页输入框旁、向导最后一步用的那些话。 */
export const FIRST_RUN = {
  /** 首页：摆在三句例子上面。要说清「点一下会怎样」。 */
  homeTitle: "不知道怎么说？点一句照说，改几个字就行",
  /**
   * r3 — 她做过至少一轮之后，这段话与三句例子默认收起来，只留这个 44px 的口子。
   * 要点出来「点一下就能看见」，否则收起来等于藏掉。
   */
  guideToggleShow: "不知道该怎么说？点这里看三句例子",
  /** 她展开之后还能收回：不让她为了省地方只能一直摊着。 */
  guideToggleHide: "收起这三句例子",
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
  /** F4 — 框里已经有她自己打的字时，点例子先问这一句，不静默清掉。 */
  exampleAsk: "框里已经有你打的字了。要把它换成这句例子吗？",
  /** 她说「换」：这时才动她原来那句话（是她点的，不是我们替她清的）。 */
  exampleUse: "换成这句例子",
  /** 她说「不换」：她打的字留着，我们一个字都不动。 */
  exampleKeep: "保留我打的字",
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
//
// F5（#139）：暂存必须只属于「这一趟打开」。上一次打开时她在向导最后一步点了
// 例子、却没点「开始使用」就退出了 —— 那句话她并没有要，下一次打开绝不能冒到
// 首页的框里。所以存进去的东西带上「哪一趟写的」这个趟号；换一趟打开（模块重新
// 加载就换一个）就不认它，取的时候顺带把它清掉。
//
// 为什么不是「只在向导开始时清一次」：向导不一定还会出现 —— 检查通过那一刻
// 就会记下「向导做完了」，下一次打开直接进首页。只靠向导清，这一条路就漏了。
// ---------------------------------------------------------------------------

/** 暂存用的键；取走即删。 */
export const FIRST_RUN_SENTENCE_KEY = "cante:first-run:sentence";

/** 只用到这三件事，测试里可以塞一个假的进来。 */
export type SentenceStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 这一趟打开的身份：模块加载时取一个，重开应用就换一个。 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 存进去的东西：哪一趟写的 + 那句话。 */
interface StagedSentence {
  run: string;
  sentence: string;
}

function browserStore(): SentenceStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    /* 有些环境把存储关掉了；那就当没暂存，首页的框空着，不报错 */
    return null;
  }
}

/** 旧版本（或别的东西）可能往这里塞过裸字符串；没有趟号的一律不认。 */
function parseStaged(raw: string): StagedSentence | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StagedSentence> | null;
    if (!parsed || typeof parsed.run !== "string" || typeof parsed.sentence !== "string") {
      return null;
    }
    return { run: parsed.run, sentence: parsed.sentence };
  } catch {
    return null;
  }
}

/**
 * 记下她在向导里点的那一句。存不下就算了：不是出错，只是没这句话。
 *
 * `run` 默认就是这一趟；测试里塞一个别的趟号来模拟「上一次打开时写的」。
 */
export function rememberSentence(
  sentence: string,
  target: SentenceStore | null = browserStore(),
  run: string = RUN_ID,
): void {
  if (!target) return;
  const value = sentence.trim();
  if (!value) return;
  try {
    const staged: StagedSentence = { run, sentence: value };
    target.setItem(FIRST_RUN_SENTENCE_KEY, JSON.stringify(staged));
  } catch {
    /* 存储满了或被禁止写入：当作没记下 */
  }
}

/**
 * 向导一开始清一次暂存：上一次打开可能留下了一句她没要的话，这一趟不能再用。
 * 这是兜底的一条（首页取的时候也会按趟号不认它），不是唯一的一条。
 */
export function beginFirstRun(target: SentenceStore | null = browserStore()): void {
  if (!target) return;
  try {
    target.removeItem(FIRST_RUN_SENTENCE_KEY);
  } catch {
    /* 存储不可用：当作没有暂存 */
  }
}

/**
 * 取走向导里点的那一句；没有（或取过了）返回 null，那不是错误。
 *
 * 上一次打开写下的那一句（趟号不是这一趟）也不认：取的时候顺手清掉，返回 null，
 * 首页的框就空着。旧版本留下的裸字符串同样不认。
 */
export function takeSentence(source: SentenceStore | null = browserStore()): string | null {
  if (!source) return null;
  try {
    const raw = source.getItem(FIRST_RUN_SENTENCE_KEY);
    if (raw === null) return null;
    // 取走即清：不管后面认不认它，都不该继续躺在这里。
    source.removeItem(FIRST_RUN_SENTENCE_KEY);
    const staged = parseStaged(raw);
    if (!staged || staged.run !== RUN_ID) return null;
    const value = staged.sentence.trim();
    return value ? value : null;
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
