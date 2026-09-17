// 「出错之后她到底该按哪个按钮」的文案。
//
// 之前出错时只有三个泛泛的出口：重试 / 换个方法 / 复制详情，而「换个方法」其实
// 什么都没做。王姐要的不是三个平级的选项，而是**这一步为什么失败、现在具体按哪
// 一个按钮**。判断规则在 recovery.ts（纯逻辑、可单测），这里只放每一条动作说给
// 她听的那两句话：按钮上写什么（label）、为什么是它（why）。
//
// 为什么单独放一个 copy 模块：copy-guard.test.ts 会扫 copy*.ts 里所有字符串，
// 把「模型 / 路径 / 接口」这类技术词挡在界面外。文案集中在这里，才有人能一眼校
// 对；混进 recovery.ts 的判断代码里就会漏检。
import type { RecoveryCopy } from "./recovery.ts";

/** 每条动作的两句话。why 用大白话说清「为什么先做这件事」。 */
export const RECOVERY: {
  readonly retry: RecoveryCopy;
  readonly retryBridge: RecoveryCopy;
  readonly retryLater: RecoveryCopy;
  readonly pickFiles: RecoveryCopy;
  readonly pickOtherFile: RecoveryCopy;
  readonly closeFile: RecoveryCopy;
  readonly closeOffice: RecoveryCopy;
  readonly saveElsewhere: RecoveryCopy;
  readonly cleanDisk: RecoveryCopy;
  readonly explainInWords: RecoveryCopy;
  readonly answerIt: RecoveryCopy;
  readonly rephrase: RecoveryCopy;
  readonly openFolder: RecoveryCopy;
  readonly copyDetail: RecoveryCopy;
  readonly signIn: RecoveryCopy;
} = {
  /** 通用出口，和原来的「重试」是同一个动作，只是把为什么写出来了。 */
  retry: {
    label: "再试一次",
    why: "刚才那一步再走一遍。多半是碰上了临时的毛病，重来一次就好了。",
  },
  /** 开的是浏览器预览、没连上桌面程序：先去打开桌面上那个。 */
  retryBridge: {
    label: "打开桌面程序后重试",
    why: "现在打开的是浏览器里的预览，不是桌面上的 Cante。先找到并打开电脑上的 Cante 程序，再点这个按钮。",
  },
  /** 没有联网 / 服务方不可用：现在重试也没用，先看网络。 */
  retryLater: {
    label: "过一会儿再试",
    why: "现在连不上帮你处理的服务方，多半是网络断了。先用浏览器看看别的网页能不能打开，过几分钟再点这个按钮。",
  },
  /** 文件被移走 / 删除：她需要重新选一次。 */
  pickFiles: {
    label: "重新选一次文件",
    why: "原来的文件可能被移走、改名或者删掉了。回到选文件那一步，重新选一遍；也可以换成别的文件。",
  },
  /** 文件打不开 / 格式看不懂 / 损坏：换一份再选。 */
  pickOtherFile: {
    label: "换一份文件再试",
    why: "这份文件打不开，或者已经损坏了。换一份在 Excel 里能正常打开的，重新选一次。",
  },
  /** 文件正被 Excel / WPS 打开：先关窗口，再重试。 */
  closeFile: {
    label: "关掉那个窗口再试",
    why: "这个文件正被 Excel 或 WPS 打开着，所以改不动。先把那个窗口关掉，再点这个按钮。",
  },
  /** 原文里能听出是一张表格（Excel / WPS 的表格）：按钮直接点到那个程序。 */
  closeOffice: {
    label: "关掉 Excel 里那个窗口",
    why: "这张表格正被 Excel 或 WPS 打开着，所以改不动它。在任务栏里找到那个表格窗口关掉，再点这个按钮。",
  },
  /** 没有权限：换个她能写的位置。 */
  saveElsewhere: {
    label: "换个位置保存",
    why: "现在这个地方不让改动。把文件复制到桌面或者「文档」，再重新选它一次。",
  },
  /** 磁盘满了：先清地方。 */
  cleanDisk: {
    label: "清理一下磁盘再试",
    why: "这块盘已经满了，写不下新文件。删掉「下载」「桌面」上用不到的，再点这个按钮。",
  },
  /** 图片里的字读不出来：用文字写下来。 */
  explainInWords: {
    label: "用文字写下来",
    why: "图片里的字它认不出来。把内容用文字打一遍，或者换成能选中文字的表格、文档，再选一次。",
  },
  /** 它停下来问了一句：回一句话，而不是重跑。 */
  answerIt: {
    label: "回一句话告诉它",
    why: "它有一处拿不准，停下来等你了。在下面回一句话就行，它会接着做完，不用从头再来。",
  },
  /** 文字类任务出错时的「换个方法」：换个说法。 */
  rephrase: {
    label: "换一句话再说一遍",
    why: "回到刚才那句话，把它说得再具体一点，比如写清要哪一列、结果放哪里。",
  },
  /** 找不到文件夹 / 文件夹被挪走。 */
  openFolder: {
    label: "打开它原来所在的文件夹",
    why: "先看看文件夹还在不在老地方。不在了，就重新选一次。",
  },
  /** 给懂电脑的人看的原始说明。 */
  copyDetail: {
    label: "复制详情",
    why: "把下面那段原始说明复制出来，发给懂电脑的同事，让他帮你看看。",
  },
  /** 账号没配好：她自己改不了，只能找同事。 */
  signIn: {
    label: "复制详情给同事",
    why: "这台电脑的账号还没弄好，你自己改不了。把这段说明发给配置这台电脑的同事，让他帮你弄。",
  },
} as const;
