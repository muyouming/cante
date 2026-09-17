// 第三方清单（gui/THIRD-PARTY-LICENSES.md）的两条底线：
//   1. 它是确定的 —— 同一份输入两次生成逐字节相同；
//   2. 它没有过期 —— `--check` 重新生成后与已提交的文件一致。
//
// 这个测试会真的跑 gui/scripts/license-inventory.sh，而那个脚本要 cargo（Rust 依赖）
// 和 bun（npm 元数据）。两者缺一就打印 SKIP 并返回：环境缺东西既不该被当成通过，
// 也不该被当成产品坏了（与 src-tauri/tests/bridge.rs 对 `pi` 的处理同一口径）。

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const guiRoot = resolve(import.meta.dir, "..");
const script = join(guiRoot, "scripts", "license-inventory.sh");
const inventory = join(guiRoot, "THIRD-PARTY-LICENSES.md");

function available(cmd: string): boolean {
  const probe = spawnSync(cmd, ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

const ready = available("bash") && available("cargo") && available("bun");
const skip = () => console.log("SKIP 第三方清单：本机缺 bash / cargo / bun 之一");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [script, ...args], {
    cwd: guiRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("第三方清单（license inventory）", () => {
  test("两次生成逐字节相同，且带生成说明", () => {
    if (!ready) return skip();
    const first = run(["--stdout"]);
    expect(first.status).toBe(0);
    const second = run(["--stdout"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain("# 第三方开源组件与许可证清单");
    expect(first.stdout).toContain("不要手改");
    // 「其他 / 未知」必须单列，不能混进 MIT。
    expect(first.stdout).toContain("## 其他 / 未知");
    expect(first.stdout).toContain("## 需要留意（copyleft / 无许可证 / 自定义）");
  });

  test("已提交的清单是最新的（--check 通过）", () => {
    if (!ready) return skip();
    expect(existsSync(inventory)).toBe(true);
    const check = run(["--check"]);
    expect(check.stdout + check.stderr).toContain("清单是最新的");
    expect(check.status).toBe(0);
  });
});
