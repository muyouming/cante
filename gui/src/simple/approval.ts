// #60 — the approval gate, in the user's language.
//
// cante pauses a turn when it wants to use a tool it is not sure about. A
// non-technical user cannot read `Bash {"command": "rm -rf build"}`; given that
// screen she either approves blindly or gives up. So the pause is translated
// into three things she can judge: what it wants to do, which of her files are
// involved, and what happens if she says no.
//
// Pure module: no Solid, no store, so the translation is unit-tested directly.
// The Chinese copy itself lives in `copy.ts`, with every other user-facing string.
import { fileName } from "./run.ts";

export interface ApprovalTool {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolDescription {
  /** One plain-Chinese sentence: what this call does. */
  action: string;
  /** The user's own files this call touches, by name (never a full path). */
  files: string[];
  /** Technical detail for the colleague, collapsed in the UI. */
  detail: string;
}

/** Tool names are the one place the protocol leaks the outside world. */
const ACTIONS: Record<string, string> = {
  read: "读取文件",
  write: "写一个新文件",
  edit: "修改文件",
  multiedit: "修改文件",
  notebookedit: "修改笔记本文件",
  bash: "运行一条命令",
  shell: "运行一条命令",
  glob: "找文件",
  grep: "在文件里查找内容",
  ls: "查看文件夹里有什么",
  webfetch: "上网打开一个网页",
  websearch: "上网查资料",
  task: "让另一个助手去做一件事",
  agent: "让另一个助手去做一件事",
};

/** Keys whose value is a file the user knows about. */
const FILE_KEYS = ["file_path", "filePath", "path", "notebook_path", "target_file"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function collectFiles(args: unknown): string[] {
  const record = asRecord(args);
  const out: string[] = [];
  for (const key of FILE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) out.push(fileName(value));
  }
  for (const key of ["file_paths", "paths", "files"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) out.push(fileName(item));
    }
  }
  // The same file named twice (an edit whose args carry two path keys) reads as one.
  return [...new Set(out)];
}

function detailOf(tool: ApprovalTool): string {
  let args: string;
  try {
    args = JSON.stringify(tool.args ?? {}) ?? "";
  } catch {
    args = "(无法显示)";
  }
  return args.length > 400 ? `${args.slice(0, 399)}…` : args;
}

/** Translate one requested call into something the user can judge. */
export function describeTool(tool: ApprovalTool): ToolDescription {
  const action = ACTIONS[tool.name.toLowerCase()] ?? "做一步操作";
  return { action, files: collectFiles(tool.args), detail: detailOf(tool) };
}

/** Every waiting call, described, in the order the daemon asked. */
export function describeApproval(tools: readonly ApprovalTool[]): ToolDescription[] {
  return tools.map((tool) => describeTool(tool));
}
