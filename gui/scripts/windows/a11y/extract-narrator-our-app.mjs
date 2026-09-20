// 从 Narrator 的 ETW XML 里，抽出**它念我们应用时逐字说要念的话**。
//
// 关键：`ControlType=50000;...;Pid=<WebView2 渲染进程>` 的元素是**我们 DOM 里的按钮**；
// 紧挨着的那条 `名字, 按钮,` 就是 Narrator 要念出来的句子。
// （我们应用自己的 pid 不会出现 —— WebView2 的 DOM 跑在 msedgewebview2.exe 里。）
import fs from "node:fs";

const file = process.argv[2];
const xml = fs.readFileSync(file, "utf8");
const dec = (s) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// 1) 我们 DOM 里的元素：ClassName 是 tailwind 类名的那些
const domEls = [];
for (const m of xml.matchAll(/<Data[^>]*>([^<]*ControlType=[^<]*)<\/Data>/g)) {
  const v = dec(m[1]);
  const name = /Name=([^;]*)/.exec(v);
  const ct = /ControlType=([^;]*)/.exec(v);
  const cls = /ClassName=([^;]*)/.exec(v);
  const pid = /Pid=([^;]*)/.exec(v);
  if (cls && /min-h-\[|rounded-|flex |w-full/.test(cls[1])) {
    domEls.push({ name: name ? name[1] : "", ct: ct ? ct[1] : "", cls: cls[1], pid: pid ? pid[1] : "" });
  }
}

// 2) 念出来的句子：形如「名字, 类型,」且含中文
const spoken = [];
for (const m of xml.matchAll(/<Data[^>]*>([^<]+)<\/Data>/g)) {
  const v = dec(m[1]).trim();
  if (/[\u4e00-\u9fff]/.test(v) && /,\s*(按钮|链接|文字|编辑框|列表项|列表|标题|图像|图片|选项卡|复选框),?/.test(v)) {
    spoken.push(v.replace(/\s+/g, " ").trim());
  }
}

console.log("=== ① Narrator 念到**我们 DOM 元素**的证据（ClassName 是 tailwind 类）: " + domEls.length + " 条 ===");
const seen = new Set();
for (const e of domEls) {
  const k = e.name;
  if (seen.has(k)) continue;
  seen.add(k);
  console.log(`  Name=「${e.name}」  ControlType=${e.ct}  Pid=${e.pid}（WebView2 渲染进程）`);
  console.log(`    ClassName=${e.cls.slice(0, 90)}…`);
}

console.log("");
console.log("=== ② Narrator 逐字要念的句子: " + spoken.length + " 条 ===");
for (const s of [...new Set(spoken)]) console.log(`  「${s.slice(0, 200)}」`);

// 3) 从 ETW 时间线里，把这些"念的元素"按出现顺序排出来（这是"她听到的顺序"的一手还原）
console.log("");
console.log("=== ③ 按 ETW 时间顺序，把「念哪个元素 → 念成什么」串起来 ===");
const events = [];
for (const m of xml.matchAll(/<Event[^>]*>([\s\S]*?)<\/Event>/g)) {
  const body = m[1];
  const t = /SystemTime="([^"]+)"/.exec(body);
  const d = [...body.matchAll(/<Data[^>]*>([^<]*)<\/Data>/g)].map((x) => dec(x[1]));
  events.push({ t: t ? t[1] : "", d });
}
const timeline = [];
for (const ev of events) {
  for (const v of ev.d) {
    const el = /Name=([^;]*);Ctrl\+Type=([^;]*);[^;]*;ClassName=([^;]*)/.exec(v);
    if (el && /min-h-\[|rounded-|flex |w-full/.test(el[3])) timeline.push({ t: ev.t, name: el[1], ct: el[2] });
    if (/[\u4e00-\u9fff]/.test(v) && /^[^\n]{1,80},\s*(按钮|链接|文字|编辑框|列表项|标题),?$/.test(v.trim())) {
      timeline.push({ t: ev.t, phrase: v.replace(/\s+/g, " ").trim() });
    }
  }
}
timeline.sort((a, b) => String(a.t).localeCompare(String(b.t)));
for (const x of timeline.slice(0, 40)) {
  if (x.phrase) console.log(`  ${x.t || "        "}  🔊 「${x.phrase}」`);
  else console.log(`  ${x.t || "        "}  · 焦点在 Name=「${x.name}」 ControlType=${x.ct}`);
}
