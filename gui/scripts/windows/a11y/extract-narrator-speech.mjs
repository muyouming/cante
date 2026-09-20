// 从 Narrator 的 ETW XML 里把「它真正念出来的话」抽出来。
// 关键事件：OnNarratorContextUpdated（Name=...;ControlType=...;AutomationId=...;ClassName=...;Pid=...;RuntimeId=...）
// 以及那些带 markup/ssml 的片段。XML 里中文件是数字实体的，要还原。
import fs from "node:fs";

const file = process.argv[2];
const xml = fs.readFileSync(file, "utf8");

function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'");
}

// 1) OnNarratorContextUpdated：带 Name/ControlType 的那条，就是"正在念的那个元素"
const ctx = [];
for (const m of xml.matchAll(/<Data[^>]*>([^<]*OnNarratorContextUpdated[^<]*)<\/Data>/g)) {
  const raw = decode(m[1]);
  const name = /Name=([^;]*)/.exec(raw);
  const ct = /ControlType=([^;]*)/.exec(raw);
  const cn = /ClassName=([^;]*)/.exec(raw);
  const pid = /Pid=([^;]*)/.exec(raw);
  ctx.push({ name: name ? name[1] : "", ct: ct ? ct[1] : "", cn: cn ? cn[1] : "", pid: pid ? pid[1] : "" });
}

// 2) markup / ssml 里真正要被念的文本
const spoken = [];
for (const m of xml.matchAll(/<Data[^>]*>([^<]{4,})<\/Data>/g)) {
  const v = decode(m[1]).trim();
  if (!v) continue;
  // 含中文字符，且不是我们自己的探针痕迹
  if (/[\u4e00-\u9fff]/.test(v) && !v.includes("CanteNarratorProbe") && !v.includes("cante-a11y-narr")) {
    spoken.push(v);
  }
}

console.log("=== Narrator 的「正在念哪个元素」（OnNarratorContextUpdated）: " + ctx.length + " 条 ===");
// ControlType 是数字枚举；常见的映射一下
const CT = { "50000": "Button", "50001": "Calendar", "50002": "CheckBox", "50003": "ComboBox", "50004": "Edit", "50005": "Hyperlink", "50006": "Image", "50007": "ListItem", "50008": "List", "50009": "Menu", "50010": "MenuBar", "50011": "MenuItem", "50012": "ProgressBar", "50013": "RadioButton", "50014": "ScrollBar", "50015": "Slider", "50016": "Spinner", "50017": "StatusBar", "50018": "Tab", "50019": "TabItem", "50020": "Text", "50021": "ToolBar", "50022": "ToolTip", "50023": "Tree", "50024": "TreeItem", "50025": "Custom", "50026": "Group", "50027": "Thumb", "50028": "DataGrid", "50029": "DataItem", "50030": "Document", "50031": "SplitButton", "50032": "Window", "50033": "Pane", "50034": "Header", "50035": "HeaderItem", "50036": "Table", "50037": "TitleBar", "50038": "Separator" };
const uniqCtx = [];
const seen = new Set();
for (const c of ctx) {
  const k = c.name + "|" + c.ct;
  if (seen.has(k)) continue;
  seen.add(k);
  uniqCtx.push(c);
}
for (const c of uniqCtx.slice(0, 40)) {
  console.log(`  Name=「${c.name}」  ControlType=${c.ct} (${CT[c.ct] || "?"})  Class=${c.cn}  Pid=${c.pid}`);
}
if (uniqCtx.length > 40) console.log(`  …（共 ${uniqCtx.length} 个不同元素）`);

console.log("");
console.log("=== 含中文的 Data 片段（Narrator 要念的文本）: " + spoken.length + " 条 ===");
const uniqS = [...new Set(spoken)];
for (const s of uniqS.slice(0, 30)) {
  const one = s.replace(/\s+/g, " ");
  console.log("  · " + one.slice(0, 220));
}
if (uniqS.length > 30) console.log(`  …（共 ${uniqS.length} 条不同的）`);
