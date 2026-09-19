// 结果文件到底在哪儿 —— 把机器路径翻成她能认的位置。
//
// 结果卡片原来直接印 folderName(path)，于是她看到的是「位置：<她的家目录>\Desktop」
// 这一串她既读不懂、也不能拿去做任何事的字符。产品律要求界面全中文、零术语，而
// 「路径」正是黑名单里的词。这里只回答一个问题：这个文件夹是不是她熟悉的那个。
//
// 认不出来就返回 other，由文案如实说「原来那个文件夹」——绝不猜，也绝不把
// 路径原样丢给用户。判断是纯的（没有 Solid、没有磁盘），所以 bun test 能把
// Windows 与苹果两种分隔符、中英文文件夹名和兜底都钉住。

import { folderName } from "./run.ts";

/** 她熟悉的几个位置；other 表示我们认不出来。 */
export type PlaceKind = "desktop" | "downloads" | "documents" | "pictures" | "wechat" | "other";

/** 文件夹名（小写）-> 位置。中文名原样写，英文名按小写认。 */
const NAMES: Readonly<Record<string, PlaceKind>> = {
  desktop: "desktop",
  桌面: "desktop",
  downloads: "downloads",
  download: "downloads",
  下载: "downloads",
  documents: "documents",
  document: "documents",
  "my documents": "documents",
  文档: "documents",
  我的文档: "documents",
  pictures: "pictures",
  picture: "pictures",
  "my pictures": "pictures",
  图片: "pictures",
  我的图片: "pictures",
  "wechat files": "wechat",
  wechatapp: "wechat",
  wechat: "wechat",
  微信: "wechat",
};

/** 文件夹的最后一段（去掉末尾分隔符），小写、去空白。 */
function lastSegment(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const tail = index >= 0 ? trimmed.slice(index + 1) : trimmed;
  return tail.trim().toLowerCase();
}

/**
 * 这个结果文件在哪个她熟悉的位置。认不出时返回 "other"。
 *
 * 只认文件的**直接**文件夹名：同一台电脑上「桌面」和「桌面/备份」不是一回事，
 * 把后者说成桌面会让她去错地方。
 */
export function placeOf(path: string): PlaceKind {
  const folder = folderName(path).trim();
  if (folder === "") return "other";
  return NAMES[lastSegment(folder)] ?? "other";
}
