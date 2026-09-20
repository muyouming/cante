import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

import { buildStampValue } from "./src/simple/copy-build.ts";

// 这一轮是哪一份产物，得让**应用自己**说得出来（#261：两次拿装着的旧版本当验收
// 对象，结论作废）。版本号本来就有（package.json）；构建时间在这里注入。define 是
// 文本替换：打包时 __CANTE_BUILD_STAMP__ 会被换成下面这个字符串字面量。
//
// 为什么标记串的拼法放在 copy-build.ts 里：验收脚本按同一个标记找，标记必须只有
// 一处定义，免得两边各写一份、哪天漂移了没人发现。
const pad = (n: number): string => String(n).padStart(2, "0");
const now = new Date();
const buildTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// Tauri drives this dev server (see src-tauri/tauri.conf.json: devUrl).
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  clearScreen: false,
  define: { __CANTE_BUILD_STAMP__: JSON.stringify(buildStampValue(buildTime, pkg.version)) },
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
