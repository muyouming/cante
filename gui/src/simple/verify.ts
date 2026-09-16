// 结果核对（信任层）：把「助手说做好了」变成「本机核对过」。
//
// 产品律第二条是「别弄坏我的东西」，而王姐真正怕的是另一件事：助手说做好了，其实
// 什么都没做成。助手的话不能当证据。所以一次运行结束后，拿着它声称产出的文件清单
// 再问一次本机（Rust 的 `file_facts`）：文件在不在、多大、能不能打开。
//
// 三种结果，一种都不能含糊：
//   * ok       都在，而且能打开；
//   * missing  它说有，实际找不到（或者找到了却打不开）——这是最该说出来的；
//   * unknown  核对这一步没做成，就明说没核对，绝不假装。
//
// 这一模块只做纯计算和一句平实中文（文案在 copy-verify.ts），界面怎么摆是
// ResultCard 的事。所有网络/桥接都收在一个可替换的 `fetchFacts` 后面，所以
// `bun test` 不需要 Tauri。

import { invoke } from "../tauri.ts";
import { VERIFY } from "./copy-verify.ts";
import { formatSize } from "./run.ts";

/** 本机对一条路径能给出的事实（Rust `FileFact` 在前端的形状）。 */
export interface FileFact {
  path: string;
  exists: boolean;
  /** 文件字节数；不存在或是文件夹时为 null。 */
  size: number | null;
  /** 最后修改时间（毫秒）；不知道时为 null。 */
  modifiedMs: number | null;
  /** 现在能不能当普通文件打开来读。文件夹一律为 false。 */
  readable: boolean;
}

/** 核对结论：三种情况 + 没有文件可核对。 */
export type VerifyKind = "ok" | "missing" | "unknown" | "none";
export type VerifyReason = "ok" | "absent" | "unreadable" | "failed" | "none";

/** 一个声称产出的文件，以及本机对它的说法。 */
export interface VerifiedFile {
  path: string;
  exists: boolean;
  readable: boolean;
  size: number | null;
}

export interface Verification {
  kind: VerifyKind;
  reason: VerifyReason;
  /** 结果卡片上那句平实中文；`none` 时为空串。 */
  message: string;
  /** 文件都在时，各文件大小之和的显示文本；其余情况为 null。 */
  sizeText: string | null;
  /** 每个声称产出的文件的事实，顺序和传入一致。 */
  files: VerifiedFile[];
  /** 它说有、这次却没找到的文件。 */
  missing: string[];
  /** 「复制详情」用的整段文字。 */
  detail: string;
}

/** Rust 侧 snake_case 的原始形状；一律当作可疑输入来解析。 */
interface WireFact {
  path?: unknown;
  exists?: unknown;
  size?: unknown;
  modified_ms?: unknown;
  readable?: unknown;
}

type OpInvoke = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * 生产用的取事实函数：问 Rust 的 `file_facts`。桥接不在（浏览器预览）时
 * `invoke` 会抛错，由 `verifyResultFiles` 接住并如实说「没能核对」。
 */
export async function fetchFileFacts(paths: string[]): Promise<unknown> {
  const invokeOp = invoke as unknown as OpInvoke;
  return invokeOp("file_facts", { paths });
}

function factFromWire(raw: unknown): FileFact | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as WireFact;
  const path = typeof record.path === "string" ? record.path : "";
  if (!path) return null;
  const size = record.size;
  const modified = record.modified_ms;
  return {
    path,
    exists: record.exists === true,
    size: typeof size === "number" && Number.isFinite(size) ? size : null,
    modifiedMs:
      typeof modified === "number" && Number.isFinite(modified) ? modified : null,
    readable: record.readable === true,
  };
}

/**
 * 把桥接的原始返回变成事实列表。返回 `null` 表示这份返回根本不能用（不是数组），
 * 调用方据此说「没能核对」而不是把坏数据当成「文件都不在」。数组里单条坏数据被丢掉。
 */
export function normalizeFacts(input: unknown): FileFact[] | null {
  if (!Array.isArray(input)) return null;
  const facts: FileFact[] = [];
  for (const raw of input) {
    const fact = factFromWire(raw);
    if (fact) facts.push(fact);
  }
  return facts;
}

/** 去掉空串并去重，同时保留出现顺序。 */
function claimedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string") continue;
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function detailOf(files: readonly VerifiedFile[], unknown: readonly string[]): string {
  const lines: string[] = [VERIFY.detailIntro];
  for (const path of unknown) lines.push(`${VERIFY.detailUnknown}${path}`);
  for (const file of files) {
    if (!file.exists) lines.push(`${VERIFY.detailMissing}${file.path}`);
    else if (!file.readable) lines.push(`${VERIFY.detailUnreadable}${file.path}`);
    else lines.push(`${VERIFY.detailFound}${file.path}（${formatSize(file.size ?? 0)}）`);
  }
  return lines.join("\n");
}

function noneVerification(): Verification {
  return {
    kind: "none",
    reason: "none",
    message: "",
    sizeText: null,
    files: [],
    missing: [],
    detail: "",
  };
}

function failedVerification(paths: readonly string[]): Verification {
  const files = paths.map((path) => ({ path, exists: false, readable: false, size: null }));
  return {
    kind: "unknown",
    reason: "failed",
    message: VERIFY.unknown,
    sizeText: null,
    files,
    missing: [],
    detail: detailOf([], paths),
  };
}

/**
 * 纯判断：拿一组「声称产出的文件」和它们的事实，得出该对用户说什么。
 *
 * `facts === null` 表示核对本身没做成（调用失败），此时说 `unknown`，绝不假装。
 * 某个文件没有任何事实记录也算核对不完整，同样归入 `unknown`：只有本机明确说
 * 「不存在」才是 `missing`。
 */
export function evaluateFacts(
  paths: readonly string[],
  facts: FileFact[] | null,
): Verification {
  const claimed = claimedPaths(paths);
  if (claimed.length === 0) return noneVerification();
  if (facts === null) return failedVerification(claimed);

  const byPath = new Map(facts.map((fact) => [fact.path, fact]));
  if (claimed.some((path) => !byPath.has(path))) return failedVerification(claimed);

  const files: VerifiedFile[] = claimed.map((path) => {
    const fact = byPath.get(path)!;
    return {
      path,
      exists: fact.exists,
      readable: fact.exists && fact.readable,
      size: fact.exists ? fact.size : null,
    };
  });

  const absent = files.filter((file) => !file.exists).map((file) => file.path);
  if (absent.length > 0) {
    return {
      kind: "missing",
      reason: "absent",
      message: VERIFY.missing,
      sizeText: null,
      files,
      missing: absent,
      detail: detailOf(files, []),
    };
  }

  const unreadable = files.filter((file) => !file.readable);
  if (unreadable.length > 0) {
    return {
      kind: "missing",
      reason: "unreadable",
      message: VERIFY.unreadable,
      sizeText: null,
      files,
      missing: [],
      detail: detailOf(files, []),
    };
  }

  const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const sizeText = formatSize(total);
  return {
    kind: "ok",
    reason: "ok",
    message: VERIFY.ok,
    sizeText,
    files,
    missing: [],
    detail: detailOf(files, []),
  };
}

/**
 * 一次运行结束后调用：核对它声称产出的文件。
 *
 * `fetchFacts` 可替换，测试传入假的即可；默认走本机。任何抛错都变成
 * 「没能核对」，因为「说不清」和「假装核对过」是两回事。
 */
export async function verifyResultFiles(
  paths: readonly string[],
  fetchFacts: (paths: string[]) => Promise<unknown> = fetchFileFacts,
): Promise<Verification> {
  const claimed = claimedPaths(paths);
  if (claimed.length === 0) return noneVerification();
  try {
    const raw = await fetchFacts(claimed);
    return evaluateFacts(claimed, normalizeFacts(raw));
  } catch {
    return failedVerification(claimed);
  }
}
