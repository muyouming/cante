# 随安装包一起发的执行组件（#150）

Windows 上「真正动手干活的那个组件」不在这个仓库里：它是 pi 的 npm 包 + 一个 bun 运行时。
它**随我们的安装包一起发**（决定见 [`../docs/DECISION-windows-runtime.md`](../docs/DECISION-windows-runtime.md) §10），
所以用户那边是「下载一次、双击、就能用」——**首次运行绝不下载任何东西**。

这个目录只放两样东西，都是**仓库里**的（会被提交）：

| 文件 | 是什么 |
| --- | --- |
| `versions.json` | 钉住 pi 与 bun 的版本、下载地址、sha256、许可与来源。**构建期唯一的真相来源**。 |
| `licenses/` | 那两样的许可原文（从它们的项目里取回，来源与 sha256 记在 `versions.json` 里）。 |

构建期由 [`../scripts/stage-executor.ts`](../scripts/stage-executor.ts)（`stage-executor.sh` 是同一个东西的壳）
取回、**按 sha256 校验**、摆成应用旁边的形状：

```
<安装目录>\pi\
  bun.exe                 运行时
  package.json            pi 自己认版本/找东西要用
  npm-shrinkwrap.json     依赖清单（许可说明从这里生成）
  dist\bundle\cli.js      入口（应用按这个形状找它，见 src-tauri/src/program.rs）
  THIRD-PARTY-NOTICES.md  随包发的许可说明（构建时生成）
```

落点由 `src-tauri/tauri.windows.conf.json` 的 `bundle.resources`（`executor/pi` → `pi`）决定；
**只有 Windows 的包会带它**（macOS 用上游 `cante` 守护进程，不该为一个用不上的组件把 dmg 撑大）。
产物层由 [`../scripts/verify-bundle.sh`](../scripts/verify-bundle.sh) 的第 ④ 条检查兜住：
Windows 上少了 `pi\bun.exe` / `pi\dist\bundle\cli.js` / `pi\package.json` / 许可说明，就红。

## 换版本

1. 改 `versions.json` 里的 `version` / `url` / `sha256` / `bytes`（sha256 要自己下载后算，别抄）；
2. 取回那一版的许可原文，覆盖 `licenses/` 里对应的文件，并更新 `licenseSource` 与 `licenseSha256`；
3. 跑 `bash gui/scripts/stage-executor.sh --force`（在 Windows 上；别的平台加 `CANTE_EXECUTOR_FORCE=1`）；
4. 跑 `cd gui && bun test src`（`packaging.test.ts` 会挡住"少接线"），再跑一次安装包验收。

`gui/executor/.cache/` 与 `gui/src-tauri/executor/` 都是构建产物，已在 `.gitignore` 里。
