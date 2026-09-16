// 用产品自己的任务卡生成真机提示词（issue #83）。
//
// 这是整个普查里最关键的一条纪律：发给助手的提示词必须由
// `gui/src/simple/tasks/` 里那张卡自己的 `prompt()` 拼出来，不能在普查脚本里
// 另抄一份。卡片改了提示词，这里立刻跟着改；抄一份的话，普查测的就是另一份
// 提示词，等于白跑。
//
// 表格 / PDF 的能力说明也一样：真机上它由 `simple/capabilities.ts` 在启动时探
// 测后写进信封。普查在外壳里把 CANTE_SHEETS_BIN / CANTE_PDF_BIN 指到真实路径，
// 这里用同一套 `sheetPromptLine` / `pdfPromptLine` 生成同样的说明——探测结果不
// 一样，信封就不一样，助手的行为也会不一样。
//
// 用法：
//   CANTE_SHEETS_BIN=/path/to/cante-sheets CANTE_PDF_BIN=/path/to/cante-pdf \
//     bun gui/scripts/sweep/prompts.ts <plan.json> > <prompts.json>
//
// plan.json 形如：[{ "id": "excel.merge", "files": ["/abs/a.xlsx"], "instruction": "…" }]
import { readFileSync } from "node:fs";

import { sheetPromptLine, pdfPromptLine } from "../../src/simple/capabilities.ts";
import { taskById } from "../../src/simple/tasks/index.ts";
import { setPdfHelper, setSheetHelper } from "../../src/simple/tasks/prompt.ts";

interface PlanEntry {
  id: string;
  label?: string;
  files?: string[];
  folder?: string;
  instruction?: string;
}

const planPath = process.argv[2];
if (!planPath) {
  console.error("用法：bun prompts.ts <plan.json>");
  process.exit(2);
}

const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanEntry[];

// 和真机一致：工具在就写进信封，不在就不写（绝不会假装有）。
const sheetBin = process.env.CANTE_SHEETS_BIN;
const pdfBin = process.env.CANTE_PDF_BIN;
setSheetHelper(sheetBin ? sheetPromptLine({ available: true, path: sheetBin }) : null);
setPdfHelper(pdfBin ? pdfPromptLine({ available: true, path: pdfBin }) : null);

const out = plan.map((entry) => {
  const task = taskById(entry.id);
  if (!task) throw new Error(`目录里没有这张卡：${entry.id}`);
  const files = entry.folder ? [entry.folder] : (entry.files ?? []);
  const prompt = task.prompt(files, entry.instruction ?? "");
  return {
    ...entry,
    title: task.title,
    group: task.group,
    plan: task.plan,
    risks: task.risks ?? [],
    prompt,
  };
});

process.stdout.write(JSON.stringify(out, null, 2));
