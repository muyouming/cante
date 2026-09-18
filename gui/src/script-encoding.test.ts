// Windows 脚本的编码闸门。
//
// 为什么要有它：PowerShell 5.1（Windows 11 自带的那个）**默认按 ANSI/GBK 读 .ps1** ✗，
// 只有文件带 **UTF-8 BOM** 时它才认 UTF-8 ✓。我们仓库里的 .ps1 全都是中文注释/中文输出 ✓，
// 少一个 BOM，那个脚本在这台机器上就会**直接解析失败**（报一串乱码，看不出是谁的错 ✗）。
//
// 2026-09-18 实测抓到：`gui/scripts/check-windows.ps1` 漏了 BOM ✗ ——
// 它是"在 Windows 上跑快检"的那个脚本 ✓，第一次真在 Windows 上运行就炸了 ✓。
// 其余 10 个 .ps1 都有 BOM ✓（说明这条规矩一直被执行，只是没人把关 ✓）。
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", ".."); // 仓库根

function ps1Files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) ps1Files(full, out);
    else if (entry.name.endsWith(".ps1")) out.push(full);
  }
  return out;
}

describe("Windows 的 .ps1 必须带 UTF-8 BOM", () => {
  test("含非 ASCII 的脚本一律要有 BOM（否则 PowerShell 5.1 按 GBK 读 → 解析失败）", () => {
    const offenders: string[] = [];
    for (const file of ps1Files(ROOT)) {
      const bytes = readFileSync(file);
      const hasBom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
      // 只看含非 ASCII 的：纯 ASCII 脚本在 GBK 与 UTF-8 下一样 ✓
      const nonAscii = bytes.some((b) => b > 0x7f);
      if (nonAscii && !hasBom) offenders.push(relative(ROOT, file));
    }
    expect(
      offenders,
      "这些 .ps1 含中文却没有 UTF-8 BOM —— 它们在 Windows 自带的 PowerShell 5.1 上会解析失败：\n" +
        offenders.map((f) => `  · ${f}`).join("\n") +
        "\n修法：在文件开头写入 EF BB BF 三个字节（编辑器里选 'UTF-8 with BOM'）。",
    ).toEqual([]);
  });

  test("扫描确实看到了那些脚本（别因为路径写错而空着通过）", () => {
    const files = ps1Files(ROOT);
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith("check-windows.ps1"))).toBe(true);
    // 至少确认我们确实在仓库根往下扫，而不是扫了个空目录
    expect(statSync(join(ROOT, "gui", "scripts")).isDirectory()).toBe(true);
  });
});
