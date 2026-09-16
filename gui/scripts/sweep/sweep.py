#!/usr/bin/env python3
"""真机任务普查：把产品里真实的提示词发给真实助手，收集结果，写成报告。

这个脚本本身不拼任何一句提示词。提示词一律由 `prompts.ts` 调产品任务卡自己的
`prompt()` 生成；这里只负责：准备脏输入、驱动 `ante serve`、自动应答审批、把
产出读回来核对、判断每张卡是「通过 / 停下问问题 / 失败」，最后写成 Markdown。

设计上刻意保守：

* 每张卡在独立目录里跑，输入是 fixture 的副本，产出和原件一眼分得清；
* HOME 指向隔离目录，文书类任务写到「桌面」也不会碰用户真正的桌面；
* 「停下来问问题」是一种结果，不是失败；只有把原件改坏、或号称做完了却读不回
  产出，才算失败；
* 没人应答的审批会卡死整轮，所以审批一律自动同意（只用正确字段 tool_use_id）。

由 gui/scripts/task-sweep.sh 调用；单独跑见 --help。
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import queue
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile
from collections import Counter
from datetime import datetime, timezone
from xml.etree import ElementTree

HERE = os.path.dirname(os.path.abspath(__file__))
GUI_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
REPO_ROOT = os.path.abspath(os.path.join(GUI_ROOT, ".."))
FIXTURE_GEN = os.path.join(GUI_ROOT, "fixtures", "sweep", "generate.py")
IS_WINDOWS = os.name == "nt"

# Windows 上子进程的默认编码**不是** UTF-8（中文 Windows 是 GBK/CP936）。这个脚本
# 里到处是中文字面量、中文文件名、中文提示词，所以：
#   1) 所有跑子进程的地方都显式指定 encoding="utf-8", errors="replace"（下面这个
#      常量），不靠系统默认；
#   2) 自己的 stdout/stderr 在 main() 开头 reconfigure 成 UTF-8（见 force_utf8_streams）；
#   3) 读文本文件走 read_text()，按 UTF-8（带 BOM 也认）解码并把 CRLF 归一成 LF。
TEXT_KWARGS = {"text": True, "encoding": "utf-8", "errors": "replace"}

sys.path.insert(0, os.path.dirname(FIXTURE_GEN))
import generate  # noqa: E402  （同目录的 fixture 生成器）


def env_seconds(name: str, fallback: int) -> int:
    """读一个「秒数」环境变量。空字符串 / 不是数字都退回默认值。

    Windows 上很容易出现 `$env:SWEEP_TIMEOUT = ""` 这种（变量存在但是空的）；
    直接 int() 会在 import 阶段就崩，报一句跟真实原因无关的 ValueError。
    """
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        print(f"注意：{name}={raw!r} 不是秒数，按默认值 {fallback} 秒算。", file=sys.stderr)
        return fallback
    return value if value > 0 else fallback

# 单卡上限（秒）。**必须给慢模型留足**：实测同一张卡在慢模型上要 850 秒，
# 设成 600 会把成功误判成失败（真机上就这么误判过一次）。可用 --timeout 覆盖，
# 也可用环境变量 SWEEP_TIMEOUT 一次性改掉。
DEFAULT_TIMEOUT = env_seconds("SWEEP_TIMEOUT", 1800)
# "卡住"判据：这么久**一个事件都没有**才算卡住。为什么不用墙钟判成败：一张正常的卡
# 只要 30–60 秒，但慢模型会到 850 秒；用墙钟会把"慢但在推进"误判成失败。而模型在流式
# 输出（ThinkingDelta 每秒好几条），所以**长时间零事件**才是真的出事（循环、网关断线
# 后不恢复）。默认 300 秒：留够网关"重连 60 秒 × 4 次"的自救时间，因为每次重连尝试都会
# 发一条事件、会重置这个计时。
DEFAULT_STALL_TIMEOUT = env_seconds("SWEEP_STALL_TIMEOUT", 300)
DEFAULT_MODEL = "ocg/deepseek-flash"
DEFAULT_PROVIDER = "openai-compatible"

# ---------------------------------------------------------------------------
# 卡片清单：每张卡用什么输入、让用户说什么
# ---------------------------------------------------------------------------

CARDS: list[dict] = [
    # 表格
    {
        "id": "excel.merge",
        "files": ["sales_jan", "sales_feb", "sales_mar"],
        "instruction": "把这三个月的销售表合成一张，重复的记录只留一条",
    },
    {
        "id": "excel.merge",
        "files": ["sales_jan", "sales_compat"],
        "scenario": "列名一致",
        "instruction": "把这两张销售表合成一张，重复的记录只留一条",
    },
    {
        "id": "excel.group",
        "files": ["detail"],
        "instruction": "把这张明细表按部门和月份汇总金额，并做一张柱状图",
    },
    {
        "id": "excel.tidy",
        "files": ["messy"],
        "instruction": "把这张表整理一下：表头加粗，去掉空行，日期统一成 2024-01-05 这种",
    },
    {
        "id": "excel.diff",
        "files": ["before", "after"],
        "instruction": "对比这两张表，找出新增的、删掉的和改动过的记录",
    },
    {
        "id": "excel.filter",
        "files": ["big"],
        "instruction": "从这张表里把「华东」三月的记录挑出来，另存一张新表",
    },
    {
        "id": "excel.split",
        "files": ["names_phones"],
        "instruction": "把「姓名电话」这一列拆成姓名和电话两列",
    },
    {
        "id": "excel.split",
        "files": ["names_phones"],
        "scenario": "指定分隔符",
        "instruction": "把「姓名电话」这一列拆成姓名和电话两列，姓名和号码之间用空格或逗号隔开",
    },
    # 文件
    {
        "id": "files.rename",
        "files": ["photo_1", "photo_2", "photo_3"],
        "instruction": "把这三张照片复制一份，按「2024年5月_序号」重新命名，序号从 1 开始，日期就用 2024 年 5 月",
    },
    {
        "id": "files.archive",
        "folder": "dir_by_type",
        "instruction": "把这个文件夹里的文件按图片、文档、表格、其它分开整理",
    },
    {
        "id": "files.dupes",
        "folder": "dir_dupes",
        "instruction": "帮我找出这个文件夹里内容一样的文件，列个清单",
    },
    {
        "id": "pdf.merge",
        "files": ["pdf_one", "pdf_two", "pdf_locked"],
        "instruction": "把这几份材料合成一个 PDF，按我选的顺序",
    },
    {
        "id": "pdf.split",
        "files": ["pdf_one"],
        "instruction": "把这份 PDF 每一页拆成一个文件",
    },
    {
        "id": "pdf.toword",
        "files": ["pdf_scanned"],
        "scenario": "扫描版",
        "instruction": "把这份 PDF 转成 Word，我要改里面的字",
    },
    {
        "id": "pdf.toword",
        "files": ["pdf_one"],
        "scenario": "文字版",
        "instruction": "把这份 PDF 转成 Word，我要改里面的字",
    },
    # 按月整理
    {
        "id": "files.by-date",
        "folder": "dir_by_month",
        "instruction": "把下载文件夹里的文件按月份整理好，一个月一个文件夹",
    },
    # 文书
    {
        "id": "doc.notice",
        "scenario": "原话",
        "instruction": "写一份五一放假通知，5月1日到5月5日放假，5月6日上班",
    },
    {
        "id": "doc.notice",
        "scenario": "信息齐全",
        "instruction": "写一份五一放假通知，发给全体员工，5月1日到5月5日放假，5月6日（周一）上班，落款行政部",
    },
    {
        "id": "doc.leave",
        "scenario": "原话",
        "instruction": "写一张请假条，我下周三请一天事假，带我妈去医院复查",
    },
    {
        "id": "doc.leave",
        "scenario": "信息齐全",
        "instruction": "写一张请假条，请假人王芳，向行政部张经理请 2024 年 5 月 8 日一天事假，原因是陪母亲去医院复查",
    },
    {
        "id": "doc.report",
        "scenario": "原话",
        "instruction": "写一份这周的工作汇报，重点讲客服系统上线的进展和下周计划",
    },
    {
        "id": "doc.report",
        "scenario": "信息齐全",
        "instruction": "写一份这周的工作汇报交给部门领导，本周完成客服系统上线，响应时间从 8 分钟降到 3 分钟，遇到的问题是老系统数据迁移还没做完，下周计划完成数据迁移并做一轮培训测试",
    },
    {
        "id": "doc.summary",
        "files": ["report_txt", "report_docx", "report_md"],
        "instruction": "把这些材料总结成一页要点，每条后面标出是从哪里来的",
    },
    # 微信
    {
        "id": "wechat.table",
        "files": ["chat"],
        "instruction": "把这段聊天记录整理成一张表：谁、什么时候、说了什么。",
    },
    {
        "id": "wechat.draft",
        "files": ["chat"],
        "instruction": "帮我想几条回复，我自己复制过去发。",
    },
    {
        "id": "wechat.batch",
        "files": ["chat"],
        "instruction": "有好几条要回，帮我列个清单，再一条条写好草稿。",
    },
]

# 每张卡的产出应该是什么，用来核对（不改变提示词，只决定怎么读回来）。
EXPECTED = {
    "excel.merge": "sheet",
    "excel.group": "sheet",
    "excel.tidy": "sheet",
    "excel.diff": "sheet",
    "excel.filter": "sheet",
    "excel.split": "sheet",
    "wechat.table": "sheet",
    "files.rename": "file",
    "files.archive": "file",
    "files.dupes": "file",
    "files.by-date": "file",
    "pdf.merge": "pdf",
    "pdf.split": "pdf",
    "pdf.toword": "doc",
    "doc.notice": "doc",
    "doc.leave": "doc",
    "doc.report": "doc",
    "doc.summary": "doc",
    "wechat.draft": "doc",
    "wechat.batch": "doc",
}

SHEET_EXT = {".xlsx", ".xls", ".xlsm", ".xlsb", ".ods", ".csv"}
PDF_EXT = {".pdf"}
DOC_EXT = {".docx", ".doc", ".txt", ".md", ".rtf"}


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def ulid() -> str:
    """事件/操作 id 必须是 ULID 形态，否则守护进程只会回一句误导性的语法错误。"""
    stamp = int(time.time() * 1000)
    randomness = int.from_bytes(os.urandom(10), "big")
    value = (stamp << 80) | randomness
    out = []
    for _ in range(26):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def op_id() -> str:
    return "op_" + ulid()


def force_utf8_streams() -> None:
    """把本脚本自己的 stdout/stderr 钉成 UTF-8。

    Windows 控制台默认是 GBK（或 UTF-16 管道），直接 print 中文会抛
    UnicodeEncodeError 或者打出乱码——报告、卡片清单、进度全都会变成问号。
    errors="replace" 是兜底：宁可打出一个「?」，也不要整轮普查崩在最后一步。
    **注意这不改父进程/调用者的代码页**，也不是在改系统设置，只影响本进程。
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # 被重定向到某些对象时没有这个 API
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def read_text(path: str) -> str:
    """读文本产出：UTF-8（带 BOM 也认），并把 \\r\\n / \\r 归一成 \\n。

    Windows 上记事本 / WPS / 各种工具写出来的是 CRLF。要是把 \\r 当内容，行数、
    字数、逐行比对都会偏一个字符——报告里的「读回 N 行」就不准了。
    """
    with open(path, "rb") as handle:
        data = handle.read()
    return data.decode("utf-8-sig", "replace").replace("\r\n", "\n").replace("\r", "\n")


def load_json(path: str):
    """读 JSON：同样按 UTF-8 读，顺手容忍 BOM（有人在 Windows 记事本里改过就带 BOM）。"""
    return json.loads(read_text(path))


def stop_process(process, grace: float = 10.0) -> None:
    """结束子进程（它可能在 RDP 会话里还带着子进程）。

    POSIX：先 SIGTERM，再向进程组补 SIGKILL（守门进程可能自己拉子进程）。
    Windows：先 terminate，再 taskkill /T 连整个进程树一起收——否则残留的
    守护进程会占着端口/文件，下一张卡直接失败，而且没人看得见原因。
    os.killpg / signal.SIGKILL 在 Windows 上根本不存在，不能无保护地调。
    """
    try:
        process.terminate()
        process.wait(timeout=grace)
        return
    except Exception:  # noqa: BLE001
        pass
    if IS_WINDOWS:
        taskkill = shutil.which("taskkill")
        if taskkill:
            try:
                subprocess.run(
                    [taskkill, "/F", "/T", "/PID", str(process.pid)],
                    capture_output=True,
                    timeout=30,
                    **TEXT_KWARGS,
                )
                return
            except Exception:  # noqa: BLE001
                pass
        try:
            process.kill()
        except Exception:  # noqa: BLE001
            pass
        return
    try:
        os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except Exception:  # noqa: BLE001
        pass


def set_env_var(env: dict, name: str, value: str) -> None:
    """给子进程环境变量赋值，Windows 上先按名字找已有的键。

    Windows 的环境变量名不区分大小写，而 os.environ.copy() 给的是**普通 dict**
    （丢掉了大小写不敏感）。中文 Windows 上遇到的多半是 `Path` 而不是 `PATH`；
    直接 `env["PATH"] = …` 会在环境块里多出一个同名不同大小写的键，子进程
    拿到哪个得看系统心情——极端情况下它整个 PATH 都没了（连系统 DLL 都找不到）。
    """
    if IS_WINDOWS:
        for key in list(env):
            if key.upper() == name.upper():
                env[key] = value
                return
    env[name] = value


def prepend_path(env: dict, directory: str) -> None:
    """把一个目录插到 PATH 最前面（保持原来那个键名的大小写）。"""
    key = "PATH"
    if IS_WINDOWS:
        for existing in env:
            if existing.upper() == "PATH":
                key = existing
                break
    set_env_var(env, key, directory + os.pathsep + env.get(key, ""))


def desktop_dirs() -> list[str]:
    r"""可能的「桌面」目录：文书类卡被要求把结果存到桌面，得知道去哪里找。

    macOS/Linux 上就是 `~/Desktop`；Windows 上可能是 `~ Desktop`，也可能是
    **OneDrive 重定向**之后的 `~\OneDrive\Desktop`（中文系统里文件夹叫「桌面」
    的情况也存在）。只认一个目录的话，OneDrive 重定向的机器上助手把结果写到真
    桌面，普查会误判成「没有产出」——这正是 Windows 上最容易假失败的一条。
    只管已存在的目录，不会去创它们。
    """
    home = os.path.expanduser("~")
    if not home or home in ("/", ""):
        return []
    found: list[str] = []
    bases = [home] + sorted(glob.glob(os.path.join(home, "OneDrive*")))
    for base in bases:
        for name in ("Desktop", "桌面"):
            candidate = os.path.join(base, name)
            if os.path.isdir(candidate) and candidate not in found:
                found.append(candidate)
    return found


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def walk_files(root: str) -> list[str]:
    found = []
    for base, _dirs, files in os.walk(root):
        for name in files:
            found.append(os.path.join(base, name))
    return sorted(found)


def relative(root: str, path: str) -> str:
    return os.path.relpath(path, root)


def display_path(rel: str) -> str:
    normalized = rel.replace(os.sep, "/")
    for prefix in ("home/Desktop/", "escaped/"):
        if normalized.startswith(prefix):
            return normalized[len(prefix) :]
    return normalized


def human_time(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f} 秒"
    minutes, rest = divmod(int(seconds), 60)
    return f"{minutes} 分 {rest} 秒"


def die(message: str, code: int = 2) -> "NoReturn":
    """中文报错 + 固定的退出码。

    退出码的约定（task-sweep.ps1 / 人和 CI 都靠这个判断）：
      0 = 跑完，没有卡失败（包括「本次没真跑」那种说明性报告）
      1 = 跑完，但有卡失败
      2 = 环境或参数不对（找不到 bin、bun、工作目录不可写、卡名认不出）
    """
    print(message, file=sys.stderr)
    raise SystemExit(code)


def truncate(text: str, limit: int = 600) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


# 路径脱敏。报告会提交、zip 会发回开发机，用户真实主目录不能进去：
#   /Users/<名>/…            macOS
#   /home/<名>/…             Linux
#   C:\Users\<名>\…          Windows（反斜杠）
#   C:/Users/<名>/…          Windows（正斜杠：git-bash、Node、很多 Python 库都这么打印）
#   C:\Documents and Settings\<名>\…   老 Windows
#   \\?\C:\Users\<名>\…     长路径前缀
# 用户名可能带空格（王杰 / Wang Jie），所以 Windows 那段取到下一个分隔符为止，
# 而不是到第一个空格——宁可多抹掉一点，也不能漏。
_PRIVATE_HOME = re.compile(r"/(?:Users|home)/[^/\s，。；、）)】]+")
_WINDOWS_HOME = re.compile(
    r"((?:\\\\\?\\)?[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/])(?![\\/])[^\\/\r\n]{0,80}",
    re.IGNORECASE,
)

# 环境变量里像密钥的那些（名字）。报告与 zip 都要按**值**擦一遍：
# 只要它出现在文本里，就说明它正跟着报告/日志外流。
_SECRET_NAME = re.compile(r"(API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)", re.IGNORECASE)
# 名字明确是密钥的，长度要求放宽（本地假 key 可能很短）；靠名字模式猜出来的
# 要够长才动，否则一个像 "1234abcd" 的值会把报告里的普通数字擦成 <已隐藏>。
_KNOWN_SECRET_NAMES = (
    "OPENAI_COMPATIBLE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CANTE_API_KEY",
)
_SECRETS: list[tuple[str, str]] = []  # main() 里用 collect_secrets() 填


def collect_secrets() -> list[tuple[str, str]]:
    """找出当前环境里所有像密钥的值（名字, 值），长的在前。"""
    found: list[tuple[str, str]] = []
    for name, value in os.environ.items():
        if not value:
            continue
        if name in _KNOWN_SECRET_NAMES:
            minimum = 4
        elif _SECRET_NAME.search(name):
            minimum = 12
        else:
            continue
        if len(value) >= minimum:
            found.append((name, value))
    found.sort(key=lambda item: len(item[1]), reverse=True)
    return found


def scrub_secrets(text: str) -> tuple[str, int]:
    """把已知密钥值从文本里换掉。返回（洗过的文本, 擦了几处）。"""
    hits = 0
    for _name, value in _SECRETS:
        count = text.count(value)
        if count:
            hits += count
            text = text.replace(value, "<已隐藏的密钥>")
    return text, hits


def redact_paths(text: str) -> str:
    """只换路径（不碰密钥），因为有些地方（比如打包）要分开计数。"""
    home = os.path.expanduser("~")
    if home and home not in ("/", ""):
        text = text.replace(home, "~")
        # Windows 上同一个目录两种写法都会出现（原生反斜杠、Node/bun 的正斜杠）。
        forward = home.replace("\\", "/")
        if forward != home:
            text = text.replace(forward, "~")
    text = _PRIVATE_HOME.sub("/<用户>", text)
    return _WINDOWS_HOME.sub(r"\1<用户>", text)


def redact(text: str) -> str:
    """报告会提交、zip 会发回开发机：用户私人路径与密钥都不能进去。"""
    text, _hits = scrub_secrets(redact_paths(text))
    return text


def looks_like_question(text: str) -> bool:
    """助手结束时到底是在问用户，还是交了结果？

    只看两点：回复里（`【需要你核对】` 那一段之前）有没有问号，或有没有明确的
    「请你告诉我 / 要不要我 / 等你定」这类请求。真机上「问你一句」不一定带问号
    （比如「你回 A 或 B」），所以标记词要够宽。`【需要你核对】` 那一段不算——它是
    在交结果。
    """
    text = (text or "").strip()
    if not text:
        return False
    head = text.split("【需要你核对】")[0]
    if "？" in head or "?" in head:
        return True
    markers = [
        "请告诉我",
        "先告诉我",
        "麻烦告诉我",
        "请提供",
        "请你确认",
        "请确认一下",
        "需要你告诉我",
        "我需要知道",
        "要不要我",
        "是否要我",
        "是否继续",
        "你想怎么",
        "你希望",
        "请问",
        "问你",
        "需要你定",
        "请你定",
        "由你定",
        "你决定",
        "等你",
        "等你回复",
        "告诉我选",
        "你回",
        "请说一声",
        "给我一句",
        "请你补充",
        "需要你补充",
        "请你选",
        "麻烦你",
        "先问你",
        "要问你",
        "先停下来",
        "停下来问",
        "还没写任何结果",
    ]
    return any(marker in head for marker in markers)


# ---------------------------------------------------------------------------
# 产出核对
# ---------------------------------------------------------------------------


def read_xlsx_rows(path: str) -> list[list[str]] | None:
    """不依赖外部工具的最小 xlsx 读取（兜底用）。"""
    try:
        with zipfile.ZipFile(path) as zf:
            shared: list[str] = []
            if "xl/sharedStrings.xml" in zf.namelist():
                root = ElementTree.fromstring(zf.read("xl/sharedStrings.xml"))
                for si in root:
                    shared.append("".join(node.text or "" for node in si.iter() if node.tag.endswith("}t")))
            sheet_names = [n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
            if not sheet_names:
                return None
            root = ElementTree.fromstring(zf.read(sorted(sheet_names)[0]))
            rows: list[list[str]] = []
            for row in root.iter():
                if not row.tag.endswith("}row"):
                    continue
                cells: list[str] = []
                for cell in row:
                    if not cell.tag.endswith("}c"):
                        continue
                    kind = cell.attrib.get("t")
                    text = ""
                    if kind == "inlineStr":
                        text = "".join(node.text or "" for node in cell.iter() if node.tag.endswith("}t"))
                    elif kind == "s":
                        for node in cell:
                            if node.tag.endswith("}v") and node.text:
                                index = int(node.text)
                                text = shared[index] if index < len(shared) else ""
                    else:
                        for node in cell:
                            if node.tag.endswith("}v") and node.text:
                                text = node.text
                    cells.append(text)
                if any(cell != "" for cell in cells):
                    rows.append(cells)
            return rows
    except Exception:
        return None


def verify_sheet(path: str, sheets_bin: list[str] | None) -> dict:
    result = {"path": path, "kind": "sheet", "ok": False, "note": ""}
    # cante-sheets 读不了 csv（它只认 xls/xlsx/ods），csv 直接按文本核对。
    if path.lower().endswith(".csv"):
        return _verify_csv(path, result)
    if sheets_bin:
        try:
            # argv 用列表（可能是 ["C:\\Program Files\\Cante\\cante-sheets.exe"]）：
            # 路径带空格时拼字符串再交给 shell 一定会断。
            described = subprocess.run(
                [*sheets_bin, "sheets", path], capture_output=True, timeout=60, **TEXT_KWARGS
            )
            read = subprocess.run([*sheets_bin, "read", path], capture_output=True, timeout=60, **TEXT_KWARGS)
            if read.returncode == 0:
                rows = [line for line in read.stdout.splitlines() if line.strip()]
                result["ok"] = len(rows) >= 1
                result["note"] = f"cante-sheets 读回 {len(rows)} 行；表：{truncate(described.stdout.strip(), 80)}"
                return result
            result["note"] = f"cante-sheets 读不了：{truncate(read.stderr.strip() or read.stdout.strip(), 200)}"
            return result
        except Exception as error:  # noqa: BLE001
            result["note"] = f"cante-sheets 调用失败：{error}"
            return result
    rows = read_xlsx_rows(path) if path.lower().endswith((".xlsx", ".xlsm")) else None
    result["ok"] = bool(rows)
    result["note"] = "内置兜底读取" + (f"到 {len(rows)} 行" if rows else "失败")
    return result


def _verify_csv(path: str, result: dict) -> dict:
    try:
        # 按行数算：CRLF 归一在 read_text 里做完了，不会把 \r 当内容。
        rows = [line for line in read_text(path).splitlines() if line.strip()]
        result["ok"] = len(rows) >= 1
        result["note"] = f"csv 按文本读回 {len(rows)} 行"
    except Exception as error:  # noqa: BLE001
        result["note"] = f"csv 读不了：{error}"
    return result


def verify_pdf(path: str, pdf_bin: list[str] | None) -> dict:
    result = {"path": path, "kind": "pdf", "ok": False, "note": ""}
    if pdf_bin:
        try:
            pages = subprocess.run([*pdf_bin, "pages", path], capture_output=True, timeout=60, **TEXT_KWARGS)
            if pages.returncode == 0 and pages.stdout.strip().isdigit():
                count = int(pages.stdout.strip())
                result["ok"] = count >= 1
                result["note"] = f"cante-pdf 读回 {count} 页"
                return result
            result["note"] = f"cante-pdf 读不了：{truncate(pages.stderr.strip() or pages.stdout.strip(), 200)}"
            return result
        except Exception as error:  # noqa: BLE001
            result["note"] = f"cante-pdf 调用失败：{error}"
            return result
    try:
        with open(path, "rb") as handle:
            data = handle.read()
        count = data.count(b"/Type /Page") + data.count(b"/Type/Page")
        result["ok"] = data.startswith(b"%PDF") and count >= 1
        result["note"] = f"内置兜底读取，粗略数到 {count} 页"
    except Exception as error:  # noqa: BLE001
        result["note"] = f"读不了：{error}"
    return result


def verify_doc(path: str) -> dict:
    result = {"path": path, "kind": "doc", "ok": False, "note": ""}
    ext = os.path.splitext(path)[1].lower()
    try:
        size = os.path.getsize(path)
    except OSError as error:
        result["note"] = f"读不了：{error}"
        return result
    if size == 0:
        result["note"] = "文件是空的"
        return result
    if ext == ".docx":
        try:
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
                if "word/document.xml" not in names:
                    result["note"] = "像是坏的 docx：没有 word/document.xml"
                    return result
                xml = zf.read("word/document.xml").decode("utf-8", "replace")
            text = "".join(node.text or "" for node in ElementTree.fromstring(xml).iter() if node.tag.endswith("}t"))
            result["ok"] = len(text.strip()) > 0
            result["note"] = f"docx 里读到 {len(text.strip())} 个字"
        except Exception as error:  # noqa: BLE001
            result["note"] = f"docx 读不了：{error}"
        return result
    try:
        text = read_text(path)
        result["ok"] = len(text.strip()) > 0
        result["note"] = f"文本里读到 {len(text.strip())} 个字"
    except Exception as error:  # noqa: BLE001
        result["note"] = f"读不了：{error}"
    return result


def verify_file(path: str, sheets_bin: list[str] | None, pdf_bin: list[str] | None) -> dict:
    ext = os.path.splitext(path)[1].lower()
    if ext in SHEET_EXT:
        return verify_sheet(path, sheets_bin)
    if ext in PDF_EXT:
        return verify_pdf(path, pdf_bin)
    if ext in DOC_EXT:
        return verify_doc(path)
    return {"path": path, "kind": "file", "ok": os.path.getsize(path) > 0, "note": "非文档类文件，只检查非空"}


# ---------------------------------------------------------------------------
# 单卡驱动
# ---------------------------------------------------------------------------


def snapshot(root: str) -> dict[str, str]:
    result = {}
    for path in walk_files(root):
        rel = relative(root, path)
        normalized = rel.replace(os.sep, "/")
        # 隔离 HOME 里会生出很多工具缓存（Python 字节码、LibreOffice、fontconfig
        # 等），它们不是产出；但 home/Desktop 是文书任务真正写结果的地方，要留。
        if normalized.startswith("home/") and not normalized.startswith("home/Desktop/"):
            continue
        if os.path.basename(rel) == "sweep-events.jsonl":
            continue  # 普查自己的事件日志不算产出
        try:
            result[rel] = sha256(path)
        except OSError:
            result[rel] = "?"
    return result


class Runner:
    def __init__(self, options: argparse.Namespace):
        self.options = options
        self.model = os.environ.get("CANTE_SWEEP_MODEL", DEFAULT_MODEL)
        self.provider = os.environ.get("CANTE_SWEEP_PROVIDER", DEFAULT_PROVIDER)
        self.bin = resolve_cante_bin()  # argv（含 serve）
        self.sheets_bin = helper_argv("cante-sheets")
        self.pdf_bin = helper_argv("cante-pdf")

    def prepare(self, card: dict, manifest: dict) -> dict:
        """建好这一卡的独立目录，把输入拷贝进去。

        顺序很关键：先把输入拷进 run 目录，再用拷贝后的路径去生成提示词。
        如果提示词里写的是 fixture 的路径，助手就会把结果写在 fixture 旁边——
        既污染了公共 fixture，也让「原件有没有被动过」查不出来。
        """
        key = f"{card['id']}[{card['scenario']}]" if card.get("scenario") else card["id"]
        run_dir = os.path.join(self.options.work, "runs", key.replace("[", "_").replace("]", ""))
        if os.path.exists(run_dir):
            shutil.rmtree(run_dir)
        os.makedirs(run_dir)

        inputs: list[str] = []
        fixtures_root = os.path.join(self.options.work, "fixtures")
        folder_path = None
        if card.get("folder"):
            source = os.path.join(fixtures_root, manifest[card["folder"]])
            target = os.path.join(run_dir, os.path.basename(source))
            shutil.copytree(source, target)
            inputs.append(target)
            folder_path = target
        files: list[str] = []
        for key_name in card.get("files", []):
            source = os.path.join(fixtures_root, manifest[key_name])
            target = os.path.join(run_dir, os.path.basename(source))
            shutil.copy2(source, target)
            files.append(target)
        inputs.extend(files)

        home = os.path.join(run_dir, "home")
        os.makedirs(os.path.join(home, "Desktop"), exist_ok=True)
        return {
            "card": card,
            "key": key,
            "run_dir": run_dir,
            "home": home,
            "files": files,
            "folder": folder_path,
            "inputs": inputs,
        }

    def run_card(self, prep: dict, prompts: dict) -> dict:
        card = prep["card"]
        key = prep["key"]
        run_dir = prep["run_dir"]
        label = card.get("scenario") or card["id"]

        before = snapshot(run_dir)
        # 「桌面」可能有好几个（OneDrive 重定向、中文文件夹名），每个都看一眼。
        desktops = desktop_dirs()
        before_real = {desktop: set(walk_files(desktop)) for desktop in desktops}
        started = time.monotonic()
        started_wall = time.time()
        record = self._drive(prompts[key]["prompt"], run_dir, prep["home"], prep["inputs"])
        elapsed = time.monotonic() - started
        # 文书类任务被要求存到「桌面」。macOS 与 Windows 上真实桌面都不认 HOME /
        # USERPROFILE 环境变量（系统照样给真桌面），助手有时会写到真桌面去；把这一
        # 轮确实由它写出的文件收进 run 目录，既留住证据，也不会在桌面上留垃圾。
        escaped: list[str] = []
        args_text = record.get("tool_args_text", "")
        for desktop in desktops:
            escaped += self._capture_escaped(
                desktop, before_real[desktop], args_text, started_wall, run_dir
            )
        record.pop("tool_args_text", None)
        record["escaped"] = escaped
        after = snapshot(run_dir)

        created = sorted(path for path in after if path not in before)
        before_hashes = Counter(before.values())
        after_hashes = Counter(after.values())
        lost = before_hashes - after_hashes
        changed_paths = sorted(path for path, digest in before.items() if after.get(path) not in (None, digest))
        moved = sorted(path for path in before if path not in after)

        expected = EXPECTED.get(card["id"], "file")
        verdict, evidence = self._classify(record, created, expected, run_dir, lost, changed_paths, moved, card)
        record.update(
            {
                "key": key,
                "title": prompts[key].get("title", card["id"]),
                "group": prompts[key].get("group", ""),
                "label": label,
                "elapsed": elapsed,
                "created": created,
                "changed": changed_paths,
                "moved": moved,
                "lost": list(lost.elements()),
                "verdict": verdict,
                "evidence": evidence,
                "run_dir": run_dir,
            }
        )
        return record

    # -- 驱动一轮会话 -------------------------------------------------------

    def _capture_escaped(self, desktop: str, before: set[str], args_text: str, run_start: float, run_dir: str) -> list[str]:
        """把这一轮真写到桌面上的产出收进 run 目录。

        只收两种都对得上的文件：修改时间在本轮开始之后，且文件名在本轮的工具
        参数里出现过。不能只按「新出现的文件」收——这台机器上可能同时有别的
        程序/别的普查在往桌面写东西，误收会把别人的文件搬走。
        """
        if not os.path.isdir(desktop):
            return []
        moved: list[str] = []
        for path in walk_files(desktop):
            if path in before:
                continue
            try:
                if os.path.getmtime(path) < run_start - 2:
                    continue
            except OSError:
                continue
            name = os.path.basename(path)
            stem = os.path.splitext(name)[0]
            # 助手有时先写一个不含扩展名的变量（OUT="…/名字"; cp … "$OUT.docx"），
            # 所以文件名和去掉扩展名的名字都认。
            if name not in args_text and stem not in args_text:
                continue
            target_dir = os.path.join(run_dir, "escaped")
            os.makedirs(target_dir, exist_ok=True)
            dest = os.path.join(target_dir, name)
            serial = 1
            while os.path.exists(dest):
                stem, ext = os.path.splitext(name)
                dest = os.path.join(target_dir, f"{stem}_{serial}{ext}")
                serial += 1
            try:
                shutil.move(path, dest)
                moved.append(os.path.relpath(dest, run_dir))
            except OSError:
                pass
        return moved

    def _drive(self, prompt: str, run_dir: str, home: str, inputs: list[str]) -> dict:
        env = os.environ.copy()
        # 隔离 HOME：文书类任务写到「桌面」时不该碰用户真正的桌面。
        # Windows 上 Rust 的 home_dir / Python 的 expanduser 看的是 USERPROFILE，
        # 只设 HOME 根本不起作用（这是最容易被忽略的一条），所以两个都设。
        set_env_var(env, "HOME", home)
        if IS_WINDOWS:
            set_env_var(env, "USERPROFILE", home)
            drive, tail = os.path.splitdrive(home)
            if drive:
                set_env_var(env, "HOMEDRIVE", drive)
                set_env_var(env, "HOMEPATH", tail or "\\")
        # 让裸的 cante-sheets / cante-pdf 也能找到（提示词里给的是绝对路径，这是双保险）。
        for binary in (self.sheets_bin, self.pdf_bin):
            if binary:
                prepend_path(env, os.path.dirname(binary[0]))
        command = list(self.bin)
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=run_dir,
            env=env,
            bufsize=1,
            start_new_session=not IS_WINDOWS,
            # 串行跑几十张卡时，别让每个子进程在 RDP 会话里冒一个控制台窗口出来
            # （也是我们给真实用户修过的那类黑窗）。
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WINDOWS else 0,
            **TEXT_KWARGS,
        )
        events: queue.Queue = queue.Queue()

        def pump(stream, tag):
            for line in stream:
                # 行尾统一剥掉：Windows 上即使解码对了，也可能留下 \r。
                events.put((tag, line.rstrip("\r\n")))

        threading.Thread(target=pump, args=(process.stdout, "out"), daemon=True).start()
        threading.Thread(target=pump, args=(process.stderr, "err"), daemon=True).start()

        record = {
            "status": "no-turn-end",
            "tool_starts": 0,
            "tool_names": [],
            "tool_args_text": "",
            "tool_failed": 0,
            "tool_denied": 0,
            "errors": [],
            "stderr": [],
            "pauses": 0,
            "messages": [],
            "timeout": False,
            "stalled": False,
            "silent_seconds": 0.0,
        }
        event_log = open(os.path.join(run_dir, "sweep-events.jsonl"), "a", encoding="utf-8")

        def send(payload: dict) -> None:
            try:
                process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                process.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                # 守护进程已经死了的常见表现。Windows 上写已关闭的管道抛的往往是
                # OSError（errno 22 / 句柄无效）而不是 BrokenPipeError，两个都得接。
                pass

        try:
            send(
                {
                    "op": {
                        "StartSession": {
                            "permission_mode": "auto",
                            "cwd": run_dir,
                            "model": self.model,
                            "provider": self.provider,
                        }
                    },
                    "id": op_id(),
                }
            )
            # 等会话起来再发指令，否则守护进程可能还没装好。
            deadline = time.monotonic() + min(60, self.options.timeout)
            while time.monotonic() < deadline:
                try:
                    tag, line = events.get(timeout=0.5)
                except queue.Empty:
                    continue
                if tag == "out" and "SessionStart" in line:
                    break

            sent_at = time.monotonic()
            send({"op": {"UserInput": prompt}, "id": op_id()})
            deadline = sent_at + self.options.timeout
            last_sign = sent_at
            pending_approvals: set[str] = set()

            while time.monotonic() < deadline:
                try:
                    tag, line = events.get(timeout=0.5)
                except queue.Empty:
                    # 没有任何动静：只有超过 stall 上限才算卡住（慢但在推进的不算）。
                    if time.monotonic() - last_sign > self.options.stall_timeout:
                        record["stalled"] = True
                        record["silent_seconds"] = time.monotonic() - last_sign
                        break
                    continue
                last_sign = time.monotonic()
                if tag == "err":
                    if line.strip():
                        record["stderr"].append(line)
                    continue
                try:
                    envelope = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_log.write(line + "\n")
                event_log.flush()
                event = envelope.get("event")
                if not isinstance(event, dict):
                    continue
                if "ToolStart" in event:
                    use = event["ToolStart"]
                    record["tool_starts"] += 1
                    record["tool_names"].append(use.get("name", "?"))
                    if len(record["tool_args_text"]) < 200_000:
                        record["tool_args_text"] += json.dumps(use.get("args"), ensure_ascii=False)
                elif "ToolEnd" in event:
                    status = event["ToolEnd"].get("status")
                    if status == "Failed":
                        record["tool_failed"] += 1
                    elif status == "Denied":
                        record["tool_denied"] += 1
                elif "Error" in event:
                    message = str(event["Error"])
                    record["errors"].append(truncate(message, 300))
                    # 操作被守护进程拒了（多半是 id 形态或字段名写错）：不会再
                    # 有轮次，没必要等满超时。
                    if "Invalid OpMsg" in message and not record["messages"]:
                        record["status"] = "op-rejected"
                        break
                elif "AgentMessage" in event:
                    record["messages"].append(str(event["AgentMessage"]))
                elif "TurnPause" in event:
                    pause = event["TurnPause"]
                    reason = pause.get("reason") or {}
                    approval = reason.get("Approval") if isinstance(reason, dict) else None
                    if approval:
                        record["pauses"] += 1
                        responses = []
                        for tool in approval.get("tools", []):
                            use_id = tool.get("id") or tool.get("tool_use_id")
                            if not use_id or use_id in pending_approvals:
                                continue
                            pending_approvals.add(use_id)
                            # 字段名必须是 tool_use_id；写成 id 会反复暂停。
                            responses.append({"tool_use_id": use_id, "decision": "Accept"})
                        if responses:
                            send(
                                {
                                    "op": {
                                        "ApprovalResponse": {
                                            "turn_id": pause.get("turn_id"),
                                            "responses": responses,
                                        }
                                    },
                                    "id": op_id(),
                                }
                            )
                elif "TurnEnd" in event:
                    end = event["TurnEnd"]
                    status = end.get("status")
                    if isinstance(status, dict):
                        record["status"] = status.get("Completed") or next(iter(status), "unknown")
                        if "Error" in status:
                            detail = status["Error"]
                            record["errors"].append(
                                "轮次出错：" + truncate(str(detail.get("headline") or detail), 300)
                            )
                    else:
                        record["status"] = str(status)
                    record["elapsed_turn"] = time.monotonic() - sent_at
                    break
            else:
                record["timeout"] = True
                send({"op": "Interrupt", "id": op_id()})
                time.sleep(1)
        finally:
            event_log.close()
            try:
                process.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            stop_process(process)
        record["last_message"] = record["messages"][-1] if record["messages"] else ""
        record["prompt"] = prompt
        record["inputs"] = inputs
        return record

    # -- 结论 ---------------------------------------------------------------

    def _classify(self, record, created, expected, run_dir, lost, changed, moved, card) -> tuple[str, str]:
        def paths(kind):
            if kind == "sheet":
                return [p for p in created if os.path.splitext(p)[1].lower() in SHEET_EXT]
            if kind == "pdf":
                return [p for p in created if os.path.splitext(p)[1].lower() in PDF_EXT]
            if kind == "doc":
                return [p for p in created if os.path.splitext(p)[1].lower() in DOC_EXT]
            # 「文件」类任务：新产出里有任何一个非空文件就算产出了（改名、分类、
            # 清单都可能是任意格式）。
            return list(created)

        candidates = paths(expected)
        verifications = []
        for rel in candidates:
            absolute = os.path.join(run_dir, rel)
            verifications.append(verify_file(absolute, self.sheets_bin, self.pdf_bin))
        read_ok = [item for item in verifications if item["ok"]]

        # 安全第一：原件被改内容或被删，直接失败。
        if lost:
            return "failed", f"原件有 {len(lost)} 个内容不见了或被改了：{', '.join(lost[:3])}"
        if card.get("folder") is None and (changed or moved):
            detail = (changed + moved)[:3]
            return "failed", f"原件被动过（改内容或改名）：{', '.join(detail)}"

        # "卡住"先判：它和"总时长到顶"是两回事，而且卡住前也可能已经产出了文件。
        if record.get("stalled"):
            if read_ok:
                names = [os.path.basename(item["path"]) for item in read_ok]
                notes = [item["note"] for item in read_ok[:3]]
                return (
                    "stalled_output",
                    f"{human_time(record.get('silent_seconds', 0))} 里一个动静都没有（卡住了），"
                    f"但已产出可读文件：{'、'.join(names)}；{'; '.join(notes)}",
                )
            return (
                "failed",
                f"{human_time(record.get('silent_seconds', 0))} 里一个动静都没有（卡住了），已停下",
            )
        if record["timeout"]:
            if read_ok:
                names = [os.path.basename(item["path"]) for item in read_ok]
                notes = [item["note"] for item in read_ok[:3]]
                return (
                    "timeout_output",
                    f"超过 {human_time(self.options.timeout)} 未宣告结束，但已产出可读文件：{'、'.join(names)}；{'; '.join(notes)}",
                )
            return "failed", f"超过 {human_time(self.options.timeout)} 还没结束，已强制停下"
        if record["status"] not in ("Completed", "completed"):
            if record["errors"]:
                return "failed", f"轮次状态 {record['status']}；错误：{record['errors'][0]}"
            return "failed", f"轮次状态 {record['status']}"

        if read_ok:
            names = [os.path.basename(item["path"]) for item in read_ok]
            notes = [item["note"] for item in read_ok[:3]]
            return "passed", f"产出 {'、'.join(names)}；{'; '.join(notes)}"

        if candidates and not read_ok:
            first = verifications[0] if verifications else None
            return "failed", f"产出了文件但读不回：{os.path.basename(first['path']) if first else '?'}（{first['note'] if first else ''}）"

        # 没有产出：区分「停下来问」和「什么都没做」。
        if looks_like_question(record["last_message"]):
            return "stopped", f"助手停下来问：{truncate(record['last_message'], 260)}"
        if not created:
            return "failed", f"没有产出，最后一句：{truncate(record['last_message'], 260) or '（空）'}"
        return "failed", f"产出了 {len(created)} 个文件，但没有一类符合预期（{expected}）"


def _override_argv(value: str | None) -> list[str] | None:
    """把 CANTE_BIN / ANTE_BIN 解析成 argv。

    既支持单条路径（含空格的路径在 Windows 上很常见，如 C:\\Program Files\\Cante
    \\ante.exe），也支持带参数的形式（开发机上用真机外壳包 fixture：
    CANTE_BIN="bun /repo/gui/fixtures/fake-cante.ts"）。整个值本身就是一个存在的
    路径时优先当成一条路径，不要被空格切成两截。
    """
    if not value or not value.strip():
        return None
    value = value.strip()
    if os.path.exists(value):
        return [value]
    for candidate in (value, value + ".exe"):
        if os.path.exists(candidate):
            return [candidate]
    # posix=False 在 Windows 上保留引号，所以手动去掉成对的引号。
    parts = shlex.split(value, posix=not IS_WINDOWS)
    if not parts:
        return None
    parts = [part[1:-1] if len(part) >= 2 and part[0] == part[-1] == '"' else part for part in parts]
    return parts


def _exe_names(stem: str) -> list[str]:
    """同一件事在 Windows 上是 ante.exe（可能还有 .cmd / .bat 的包装）。"""
    if IS_WINDOWS:
        return [stem + ".exe", stem + ".cmd", stem + ".bat", stem]
    return [stem]


def _candidate_dirs() -> list[str]:
    """按产品里的顺序列找二进制的目录。顺序：安装目录/主程序旁 → 用户目录 → PATH。

    Windows 上安装包（NSIS/MSI）会把 cante-sheets.exe / cante-pdf.exe 放进安装
    目录（通常与主程序同目录），所以"主程序在哪"必须参与推理。
    """
    dirs: list[str] = []
    for env_name in ("CANTE_HOME", "CANTE_INSTALL_DIR", "ANTE_HOME"):
        value = os.environ.get(env_name)
        if value:
            dirs.append(value)
    if getattr(sys, "frozen", False):
        dirs.append(os.path.dirname(os.path.abspath(sys.executable)))
    home = os.path.expanduser("~")
    if home and home not in ("/", ""):
        dirs.append(os.path.join(home, ".cante", "bin"))
        dirs.append(os.path.join(home, ".ante", "bin"))
    if IS_WINDOWS:
        for env_name in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "ProgramW6432"):
            base = os.environ.get(env_name)
            if not base:
                continue
            dirs.append(os.path.join(base, "Programs", "Cante"))
            dirs.append(os.path.join(base, "Cante"))
    # 本 worktree 的构建产物（开发机上就是这个）。
    for profile in ("debug", "release"):
        dirs.append(os.path.join(GUI_ROOT, "src-tauri", "target", profile))
    return dirs


def resolve_helper(stem: str) -> list[str] | None:
    """找 cante-sheets / cante-pdf。找到就返回 argv（列表），找不到返回 None。

    顺序：环境变量（CANTE_SHEETS_BIN / CANTE_PDF_BIN）→ 安装目录（与主程序同目录
    或 %LOCALAPPDATA%\\Programs\\Cante）→ 用户目录 → 本 worktree 构建产物 → PATH。
    返回列表而不是字符串，是因为路径很可能带空格（C:\\Program Files\\…）——
    所有调用点直接把列表传给 subprocess，**绝不**拼成一个字符串交给 shell。
    Windows 上 shutil.which 会自动补 .exe / PATHEXT，所以 PATH 这一支不用特别处理。
    """
    env_name = "CANTE_SHEETS_BIN" if stem == "cante-sheets" else "CANTE_PDF_BIN"
    argv = _override_argv(os.environ.get(env_name))
    if argv:
        return argv
    found = shutil.which(stem)
    if found:
        return [found]
    # 主程序旁边最可能是安装目录——先把主程序的位置算出来一起找。
    extra: list[str] = []
    for token in self_bin_argv_hint():
        if os.path.isabs(token):
            extra.append(os.path.dirname(token))
    for directory in extra + _candidate_dirs():
        for name in _exe_names(stem):
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return [candidate]
    return None


def self_bin_argv_hint() -> list[str]:
    """主程序在哪（不报错版）：用在找 cante-sheets / cante-pdf 的时候。"""
    for env_name in ("CANTE_BIN", "ANTE_BIN"):
        argv = _override_argv(os.environ.get(env_name))
        if argv:
            return argv
    found = shutil.which("ante") or shutil.which("cante")
    if found:
        return [found]
    for directory in _candidate_dirs():
        for stem in ("ante", "cante"):
            for name in _exe_names(stem):
                candidate = os.path.join(directory, name)
                if os.path.isfile(candidate):
                    return [candidate]
    return []


_HELPER_CACHE: dict[str, list[str] | None] = {}


def helper_argv(stem: str) -> list[str] | None:
    """同一个答案不要找两遍（Runner 与写报告都要用）。"""
    if stem not in _HELPER_CACHE:
        _HELPER_CACHE[stem] = resolve_helper(stem)
    return _HELPER_CACHE[stem]


def resolve_cante_bin() -> list[str]:
    """找真守护进程。找不到时的提示必须能直接照做（说清该设哪个环境变量）。"""
    for env_name in ("CANTE_BIN", "ANTE_BIN"):
        argv = _override_argv(os.environ.get(env_name))
        if argv:
            return argv + ["serve"]
    found = shutil.which("ante") or shutil.which("cante")
    if found:
        return [found, "serve"]
    for directory in _candidate_dirs():
        for stem in ("ante", "cante"):
            for name in _exe_names(stem):
                candidate = os.path.join(directory, name)
                if os.path.isfile(candidate):
                    return [candidate, "serve"]
    looked = "\n  ".join(_candidate_dirs())
    if IS_WINDOWS:
        hint = (
            "  在 PowerShell 里这样指（把路径换成你装的位置）：\n"
            '        $env:CANTE_BIN = "$env:USERPROFILE\\.ante\\bin\\ante.exe"\n'
            "  或者它在安装目录里：\n"
            '        $env:CANTE_BIN = "$env:LOCALAPPDATA\\Programs\\Cante\\ante.exe"'
        )
    else:
        hint = '    export CANTE_BIN=/path/to/ante'
    die(
        "找不到 ante / cante 可执行文件。请任选一种：\n"
        "  1) 设环境变量 CANTE_BIN 指向它（也可以叫 ANTE_BIN）；写成 "
        '"命令 参数" 也认：\n' + hint + "\n"
        "  2) 或把它的目录加进 PATH。\n"
        f"  已经找过这些地方：\n  {looked}\n"
        "  （cante-sheets / cante-pdf 可以用 CANTE_SHEETS_BIN / CANTE_PDF_BIN 单独指。）"
    )


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------


def load_prompts(plan: list[dict], work: str) -> dict:
    plan_path = os.path.join(work, "plan.json")
    with open(plan_path, "w", encoding="utf-8") as handle:
        json.dump(plan, handle, ensure_ascii=False, indent=2)
    prompt_script = os.path.join(HERE, "prompts.ts")
    command = ["bun", prompt_script, plan_path]
    try:
        result = subprocess.run(command, capture_output=True, cwd=GUI_ROOT, timeout=120, **TEXT_KWARGS)
    except FileNotFoundError:
        die(
            "找不到 bun。普查要用产品自己的提示词函数（gui/scripts/sweep/prompts.ts），"
            "所以 bun 是必须的：装好 bun（https://bun.sh）再跑，不要另抄一份提示词。"
        )
    if result.returncode != 0:
        # stdout 也要打：bun 的报错有时只进 stdout。
        die(
            f"生成提示词失败（bun prompts.ts，退出码 {result.returncode}）：\n"
            f"{result.stderr.strip() or result.stdout.strip()}"
        )
    try:
        entries = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        die(
            f"bun prompts.ts 的输出不是 JSON（{error}）。前 400 字：\n"
            f"{result.stdout[:400]}\n--- stderr ---\n{result.stderr[:400]}"
        )
    return {f"{item['id']}[{item['scenario']}]" if item.get("scenario") else item["id"]: item for item in entries}


VERDICT_LABEL = {
    "passed": "通过",
    "timeout_output": "超时但有产出",
    "stopped": "停下问问题",
    "failed": "失败",
}


def render_environment(options, extra_lines: list[str] | None = None) -> list[str]:
    """报告开头的「这次是怎么跑的」：路径、旋钮、平台。

    路径写进报告很关键：Windows 服务器上仓库可能只读，实际用的工作目录是
    `--work` 指的那个。报告里写的是相对位置或带 <用户> 的形式（不外泄真实
    家目录），完整绝对路径在控制台上直接打出来。
    """
    work = getattr(options, "work", "")
    report = getattr(options, "report", "")
    zip_path = getattr(options, "zip_path", "") or "（没打包，加 --zip）"
    lines = [
        "## 这次是怎么跑的",
        "",
        f"- 平台：{'Windows' if IS_WINDOWS else os.name}；Python "
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        f"- 工作目录（--work）：{work}",
        f"- 报告（--report）：{report}",
        f"- 结果包（--zip）：{zip_path}",
        f"- 单卡上限（--timeout）：{human_time(getattr(options, 'timeout', DEFAULT_TIMEOUT))}"
        f"；卡住判据（--stall-timeout）：{human_time(getattr(options, 'stall_timeout', DEFAULT_STALL_TIMEOUT))}",
        "- 「卡住」（那么久一个事件都没有）与「超时到顶」（总时长到上限）是两类不同结论，不要混着看。",
        "- 计时用 time.monotonic()（单调时钟），不受系统对时 / 时区 / Windows 计时器精度影响。",
    ]
    for line in extra_lines or []:
        lines.append(line)
    lines.append("")
    return lines


def render_report(results: list[dict], options, skipped_reason: str | None) -> str:
    lines: list[str] = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append("# 真机任务普查报告")
    lines.append("")
    lines.append(f"生成时间：{stamp}")
    lines.append("")
    lines.extend(render_environment(options))
    if skipped_reason:
        lines.append(f"> 本次没有真跑：{skipped_reason}")
        lines.append("")
        lines.append("没有配置模型端点时，普查不会假装通过——这一节就是说明。")
        return redact("\n".join(lines) + "\n")

    passed = sum(1 for item in results if item["verdict"] == "passed")
    stopped = sum(1 for item in results if item["verdict"] == "stopped")
    timed_out = sum(1 for item in results if item["verdict"] == "timeout_output")
    failed = sum(1 for item in results if item["verdict"] == "failed")
    lines.append(
        f"一共跑了 {len(results)} 张卡：通过 {passed}，超时但有产出 {timed_out}，"
        f"停下问问题 {stopped}，失败 {failed}。"
    )
    lines.append("")
    lines.append("模型：" + os.environ.get("CANTE_SWEEP_MODEL", DEFAULT_MODEL))
    lines.append("")
    lines.append("| 卡 | 结论 | 耗时 | 工具调用 | 产出 |")
    lines.append("| --- | --- | --- | --- | --- |")
    for item in results:
        produced = "、".join(os.path.basename(x) for x in item["created"]) or "（无）"
        lines.append(
            f"| {item['key']} | {VERDICT_LABEL.get(item['verdict'], item['verdict'])} | "
            f"{human_time(item['elapsed'])} | {item['tool_starts']} | {produced} |"
        )
    lines.append("")

    lines.append("## 逐张卡的证据")
    lines.append("")
    for item in results:
        lines.append(f"### {item['key']} — {VERDICT_LABEL.get(item['verdict'], item['verdict'])}")
        lines.append("")
        lines.append(f"- 卡片：{item['title']}（{item['group']}）")
        lines.append(f"- 耗时：{human_time(item['elapsed'])}；工具调用 {item['tool_starts']} 次"
                     f"（失败 {item['tool_failed']}，被拒 {item['tool_denied']}，审批暂停 {item['pauses']} 次）")
        lines.append(f"- 结论：{item['evidence']}")
        if item["errors"]:
            lines.append(f"- 错误事件：{'；'.join(item['errors'][:3])}")
        if item["stderr"]:
            lines.append(f"- 助手 stderr（前 3 行）：{truncate(' | '.join(item['stderr'][:3]), 400)}")
        if item["created"]:
            lines.append("- 新产出：")
            for rel in item["created"]:
                absolute = os.path.join(item["run_dir"], rel)
                info = verify_file(absolute, helper_argv("cante-sheets"), helper_argv("cante-pdf"))
                lines.append(f"    - {display_path(rel)} — {info['note']}")
        if item.get("escaped"):
            lines.append(f"    - （写到真桌面上的文件已收进 escaped/：{'、'.join(item['escaped'])}）")
        if item["verdict"] != "passed":
            lines.append(f"- 最后一句：{truncate(item['last_message'], 400) or '（空）'}")
        lines.append("")

    # 人工写的结论（改了什么、为什么、哪些没改）跟在证据后面，一并在报告里，
    # 这样「报告 = 证据 + 结论」是一次跑出来的。
    notes_path = os.path.join(HERE, "notes.md")
    if os.path.exists(notes_path):
        lines.append(read_text(notes_path).rstrip())
        lines.append("")
    return redact("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# 打包：报告 + 工作目录 + 应用日志，一次拿走（issue #83 / ws/r15）
# ---------------------------------------------------------------------------

# 文件名一看就知道不该进包的东西。就算值扫漏了（比如被 base64 了），也不让它
# 进包：这些文件对「哪张卡出了什么事」没有帮助，却是放密钥最多的地方。
ZIP_BLOCKED_NAMES = {
    "settings.json",
    "catalog.json",
    "credentials.json",
    "credentials",
    "auth.json",
    ".env",
    "installation-id",
    "user_input_history.jsonl",
}
ZIP_BLOCKED_SUFFIX = (".env", ".pem", ".key", ".pfx", ".p12", "_rsa")
# 超过这个大小就不整个读进来洗密钥了，直接流式扫（不安全的就整个不打包）。
ZIP_TEXT_MAX = 32 * 1024 * 1024


def _blocked_arcname(name: str) -> bool:
    lower = name.lower()
    return lower in ZIP_BLOCKED_NAMES or lower.endswith(ZIP_BLOCKED_SUFFIX)


def _stream_contains_secret(path: str) -> str | None:
    """流式找密钥值（不把整个文件读进内存）。找到就返回是哪个环境变量。"""
    needles = [(name, value.encode("utf-8")) for name, value in _SECRETS]
    if not needles:
        return None
    longest = max(len(value) for _name, value in needles)
    try:
        with open(path, "rb") as handle:
            tail = b""
            while True:
                chunk = handle.read(1 << 20)
                if not chunk:
                    return None
                window = tail + chunk
                for name, needle in needles:
                    if needle in window:
                        return name
                # 临界处可能被切开，留一段尾巴继续看。
                tail = window[-(longest - 1) :] if longest > 1 else b""
    except OSError:
        return None


def _has_recent_file(directory: str, cutoff: float) -> bool:
    for base, _dirs, files in os.walk(directory):
        for name in files:
            try:
                if os.path.getmtime(os.path.join(base, name)) >= cutoff:
                    return True
            except OSError:
                continue
    return False


def app_log_dirs(days: int) -> list[tuple[str, str]]:
    """找应用日志目录：返回 [(标签, 绝对路径)]。

    真机上的位置：Windows `%USERPROFILE%\\.ante\\logs`、macOS/Linux `~/.ante/logs`。
    普查给每张卡隔离了 HOME，所以卡自己的日志在 `<work>/runs/<卡>/home/.ante/logs`——
    那一份已经在 work 目录里了，这里只管“外面那份”真应用日志。
    """
    home = os.path.expanduser("~")
    found: list[tuple[str, str]] = []
    if home and home not in ("/", ""):
        for label in (".ante/logs", ".cante/logs"):
            directory = os.path.join(home, *label.split("/"))
            if os.path.isdir(directory):
                found.append((label.replace("/", "-"), directory))
    if not days:
        return found
    # 日志可能攒了好几个月；只带最近几天的，否则包太大、RDP 传不回来。
    cutoff = time.time() - days * 86400
    return [(label, directory) for label, directory in found if _has_recent_file(directory, cutoff)]


def build_zip(zip_path: str, options, log_days: int) -> str:
    """把报告 + work 目录 + 应用日志打成一个 zip，返回它的路径。

    两条纪律：
      1) 绝不把密钥写进 zip——逐文件扫环境里的密钥值，命中了的文本换成
         <已隐藏的密钥>、二进制整个不打包（并记在包内的 ZIP-说明.txt 里）；
      2) 路径按 user 真实家目录敏化——包可能整整飞一趟 RDP 回来，
         报告和说明里的路径与 report.md 一致。
    """
    zip_path = os.path.abspath(zip_path)
    parent = os.path.dirname(zip_path)
    os.makedirs(parent, exist_ok=True)
    work = os.path.abspath(getattr(options, "work", ""))
    report = os.path.abspath(getattr(options, "report", ""))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    root = f"cante-sweep-{stamp}"  # 解压出来不会洒一桌子文件
    stats: dict = {"files": 0, "redacted": [], "excluded": [], "logs": [], "bytes": 0}

    def add(zf: zipfile.ZipFile, path: str, arcname: str) -> None:
        if os.path.abspath(path) == zip_path or _blocked_arcname(os.path.basename(path)):
            return
        try:
            if os.path.getsize(path) > ZIP_TEXT_MAX:
                secret = _stream_contains_secret(path)
                if secret:
                    stats["excluded"].append(f"{arcname}（太大且包含 {secret}，不能安全地洗）")
                    return
                zf.write(path, arcname)
                stats["files"] += 1
                return
            with open(path, "rb") as handle:
                raw = handle.read()
        except OSError as error:
            stats["excluded"].append(f"{arcname}（读不了：{error}）")
            return
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            # 二进制：不能洗，命中密钥就整个不要。
            secret = _stream_contains_secret(path)
            if secret:
                stats["excluded"].append(f"{arcname}（二进制且包含 {secret}）")
                return
            zf.writestr(arcname, raw)
            stats["files"] += 1
            return
        # 文本文件：路径与密钥都洗一遍。路径也要洗，因为应用日志/助手产出里会带着
        # 用户真实主目录，而这个 zip 是要往外发的。
        path_cleaned = redact_paths(text)
        scrubbed, hits = scrub_secrets(path_cleaned)
        marks = []
        if path_cleaned != text:
            marks.append("路径")
        if hits:
            marks.append(f"密钥 {hits} 处")
        if marks:
            stats["redacted"].append(f"{arcname}（洗了：{'、'.join(marks)}）")
            zf.writestr(arcname, scrubbed.encode("utf-8"))
        else:
            zf.writestr(arcname, raw)
        stats["files"] += 1

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 报告放最外层，拆开就能看。
        if os.path.isfile(report):
            add(zf, report, f"{root}/report.md")
        if os.path.isdir(work):
            for path in walk_files(work):
                rel = os.path.relpath(path, work).replace(os.sep, "/")
                add(zf, path, f"{root}/work/{rel}")
        for label, directory in app_log_dirs(log_days):
            for path in walk_files(directory):
                rel = os.path.relpath(path, directory).replace(os.sep, "/")
                # 只收最近几天的（和 app_log_dirs 同一个口径）。
                try:
                    if log_days and os.path.getmtime(path) < time.time() - log_days * 86400:
                        continue
                except OSError:
                    continue
                add(zf, path, f"{root}/app-logs/{label}/{rel}")
            stats["logs"].append(f"{label} <- {directory}")
        readme = [
            "这个包里是什么",
            "================",
            "",
            f"工作目录：{redact(work)}",
            f"报告：{redact(report)}",
            f"应用日志（最近 {log_days} 天）：" if log_days else "应用日志（全部）：",
        ]
        if stats["logs"]:
            readme += [f"  - {redact(item)}" for item in stats["logs"]]
        else:
            readme.append("  -（没找到日志目录）")
        readme += [
            "",
            "拿回开发机只要这一个 zip：report.md 是结论，work/ 是每张卡的输入副本、",
            "产出与事件日志（sweep-events.jsonl），app-logs/ 是应用自己的日志。",
            "",
            "隐私与路径（打包脚本自己做的）：",
            "  - 环境变量里的密钥值已从文本文件里擦掉，命中的二进制文件直接不打包；",
            "  - 文本文件里的用户真实家目录也换成了 <用户> / ~；",
            "  - settings.json / catalog.json / *.env / *.pem / *.key 等文件从不进入这个包。",
        ]
        if stats["redacted"]:
            readme.append("  - 洗过的文件（只列前 40 个）：")
            readme += [f"      {item}" for item in stats["redacted"][:40]]
            if len(stats["redacted"]) > 40:
                readme.append(f"      …还有 {len(stats['redacted']) - 40} 个")
        if stats["excluded"]:
            readme.append("  - 没打包的文件：")
            readme += [f"      {redact(item)}" for item in stats["excluded"]]
        zf.writestr(f"{root}/ZIP-说明.txt", redact("\n".join(readme)) + "\n")

    stats["bytes"] = os.path.getsize(zip_path)
    print(f"结果包：{zip_path}（{stats['bytes'] / 1024 / 1024:.1f} MB，{stats['files']} 个文件）")
    if stats["logs"]:
        print("应用日志：" + "；".join(stats["logs"]))
    else:
        print("应用日志：没找到 ~/.ante/logs（用户目录下没有日志目录）", file=sys.stderr)
    if stats["redacted"]:
        print(f"注意：有 {len(stats['redacted'])} 个文本文件洗过（密钥 / 真实家目录），见包内 ZIP-说明.txt。")
    if stats["excluded"]:
        print(f"注意：有 {len(stats['excluded'])} 个文件没进包（含密钥或读不了），见包内 ZIP-说明.txt。")
    return zip_path


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def card_key(card: dict) -> str:
    return f"{card['id']}[{card['scenario']}]" if card.get("scenario") else card["id"]


def match_cards(wanted: list[str], cards: list[dict] = CARDS) -> tuple[list[dict], list[str]]:
    """按用户写的词挑卡。支持三种写法：

    * `excel.diff`        ——完整的卡 id（id 相同、场景不同的会一起中，比如
                             `excel.merge` 会中「默认」和「列名一致」两张）
    * `excel.merge[列名一致]` ——精确到某个场景
    * `pdf` / `excel` / `wechat` / `doc` / `files` ——整类前缀（“只跑一类”）

    返回（选中的卡, 没认出来的词）。没认出来的词要让用户看得见，不能静默变成
    “什么都没跑”。
    """
    chosen: list[dict] = []
    unknown: list[str] = []
    if not [item for item in wanted if item.strip()]:
        return list(cards), unknown  # 没写就是全跑
    for raw in wanted:
        want = raw.strip()
        if not want:
            continue
        hits = [card for card in cards if want in (card["id"], card_key(card))]
        if not hits:
            prefix = want.rstrip(".") + "."
            hits = [card for card in cards if card["id"].startswith(prefix) or card["id"] == want.rstrip(".")]
        if not hits:
            unknown.append(want)
            continue
        for card in hits:
            if card not in chosen:
                chosen.append(card)
    return chosen, unknown


def is_writable_dir(directory: str) -> bool:
    try:
        os.makedirs(directory, exist_ok=True)
        probe = os.path.join(directory, ".sweep-write-probe")
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("ok")
        os.remove(probe)
        return True
    except OSError:
        return False


def require_writable_dir(directory: str, what: str) -> None:
    if is_writable_dir(directory):
        return
    if IS_WINDOWS:
        example = '  python gui\\scripts\\sweep\\sweep.py --work "$env:TEMP\\cante-sweep" ...'
        why = "（Windows 上仓库可能是只读的、或在受控目录里）"
    else:
        example = "  python3 gui/scripts/sweep/sweep.py --work /tmp/cante-sweep ..."
        why = ""
    die(
        f"{what}不可写：{directory}{why}\n"
        f"用 --work 指到别处再跑，例如：\n{example}"
    )


def main(argv: list[str]) -> int:
    force_utf8_streams()
    if sys.version_info < (3, 10):
        print(
            f"注意：本脚本只在 Python 3.10+ 上验过，你现在是 "
            f"{sys.version_info.major}.{sys.version_info.minor}。先跑吧，出错就把版本升上去。",
            file=sys.stderr,
        )
    if IS_WINDOWS:
        # Python 3.7+ 的 UTF-8 模式：子进程（bun、ante）也看到 UTF-8 环境。
        os.environ.setdefault("PYTHONUTF8", "1")
        os.environ.setdefault("PYTHONIOENCODING", "utf-8:replace")
    _SECRETS.extend(collect_secrets())

    parser = argparse.ArgumentParser(description="真机任务普查")
    parser.add_argument("cards", nargs="*", help="只跑这些卡（id / id[场景] / 整类前缀如 pdf）")
    parser.add_argument("--skip", default="", help="这次不跑的卡，逗号分隔（沿用上次攒下的结果）")
    parser.add_argument(
        "--stall-timeout",
        type=int,
        default=DEFAULT_STALL_TIMEOUT,
        help="多少秒没有任何事件算卡住（默认 300；慢模型不用调这个词，调 --timeout）",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        help="单卡上限，秒（默认 1800，慢模型别调小；也可用 SWEEP_TIMEOUT 覆盖）",
    )
    parser.add_argument(
        "--work",
        default=os.path.join(HERE, "work"),
        help="工作目录（仓库只读时指到别处，如 Windows 的 $env:TEMP\\cante-sweep）",
    )
    parser.add_argument("--report", default=os.path.join(HERE, "report.md"), help="报告写到哪")
    parser.add_argument("--no-fixtures", action="store_true", help="不重新生成 fixture")
    parser.add_argument("--list", action="store_true", help="列出所有卡并退出")
    parser.add_argument("--render-only", action="store_true", help="不跑，只拿 work/results.json 重写报告")
    parser.add_argument(
        "--zip",
        action="store_true",
        help="跑完把报告 + 工作目录 + 应用日志打成一个 zip（不把密钥写进去）",
    )
    parser.add_argument(
        "--zip-out",
        default="",
        help="zip 放到哪（默认 gui/scripts/sweep/cante-sweep-<时间>.zip，不可写时落到工作目录）",
    )
    parser.add_argument(
        "--zip-log-days",
        type=int,
        default=7,
        help="应用日志只带最近几天（默认 7，0 = 全带）",
    )
    options = parser.parse_args(argv)
    # 绝对路径：Windows 上用户可能用相对路径 / 环境变量拼出来的路径，后面
    # 子进程、zip、报告都要用同一个绝对位置。
    options.work = os.path.abspath(os.path.expanduser(options.work))
    options.report = os.path.abspath(os.path.expanduser(options.report))

    if options.list:
        for card in CARDS:
            label = f"[{card['scenario']}]" if card.get("scenario") else ""
            print(f"{card['id']}{label}")
        print(
            "（也可以只给整类前缀跑一类：excel / files / pdf / doc / wechat；"
            "带上 --list 以外的参数就是挑卡跑）",
            file=sys.stderr,
        )
        return 0

    # 报告位置先定下来（写不进就落到工作目录），这样报告里写的路径就是真的那个。
    if not is_writable_dir(os.path.dirname(options.report)):
        original = options.report
        options.report = os.path.join(options.work, "report.md")
        print(f"报告原位置不可写（{original}），改写到：{options.report}", file=sys.stderr)
    options.zip_path = ""
    if options.zip:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        if options.zip_out:
            options.zip_path = os.path.abspath(os.path.expanduser(options.zip_out))
            require_writable_dir(os.path.dirname(options.zip_path), "zip 目录")
        elif is_writable_dir(HERE):
            options.zip_path = os.path.join(HERE, f"cante-sweep-{stamp}.zip")
        else:
            options.zip_path = os.path.join(options.work, f"cante-sweep-{stamp}.zip")

    if options.render_only:
        results_path = os.path.join(options.work, "results.json")
        if not os.path.exists(results_path):
            print(f"没有可用的结果：{results_path}", file=sys.stderr)
            return 2
        data = load_json(results_path)
        accumulated = data if isinstance(data, dict) else {item["key"]: item for item in data}
        results = []
        for card in CARDS:
            if card_key(card) in accumulated:
                results.append(accumulated[card_key(card)])
        for _key, item in accumulated.items():
            if item["key"] not in {entry["key"] for entry in results}:
                results.append(item)
        report = render_report(results, options, None)
        with open(options.report, "w", encoding="utf-8") as handle:
            handle.write(report)
        print(f"报告写到：{options.report}")
        if options.zip:
            build_zip(options.zip_path, options, options.zip_log_days)
        return 0

    selected, unknown = match_cards(options.cards)
    if unknown:
        print(
            f"认不出这些卡：{' '.join(unknown)}（用 --list 看有哪些卡，或给整类前缀如 pdf / excel）",
            file=sys.stderr,
        )
        return 2
    skipped = {name.strip() for name in options.skip.split(",") if name.strip()}
    if skipped:
        selected = [card for card in selected if card["id"] not in skipped and card_key(card) not in skipped]
    if not selected:
        print(f"没有匹配的卡：{' '.join(options.cards)}", file=sys.stderr)
        return 2

    base_url = os.environ.get("OPENAI_COMPATIBLE_BASE_URL", "").strip()
    api_key = os.environ.get("OPENAI_COMPATIBLE_API_KEY", "").strip()
    if not base_url or not api_key:
        reason = "没有配置模型端点（OPENAI_COMPATIBLE_BASE_URL / OPENAI_COMPATIBLE_API_KEY 至少缺一个）。设置好之后再跑。"
        report = render_report([], options, reason)
        with open(options.report, "w", encoding="utf-8") as handle:
            handle.write(report)
        print(report)
        if options.zip:
            build_zip(options.zip_path, options, options.zip_log_days)
        return 0

    require_writable_dir(options.work, "工作目录（--work）")
    if IS_WINDOWS and len(options.work) > 120:
        print(
            "提示：工作目录路径偏长，Windows 老的长路径限制（260 字）可能让产物读写失败；"
            f"能用就用短的（现在是 {len(options.work)} 字）：{options.work}",
            file=sys.stderr,
        )
    print(f"工作目录：{options.work}", flush=True)
    fixtures_root = os.path.join(options.work, "fixtures")
    manifest_path = os.path.join(options.work, "manifest.json")
    if not options.no_fixtures or not os.path.isdir(fixtures_root):
        manifest = generate.generate(fixtures_root)
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
    else:
        print("复用已有的 fixture（--no-fixtures）")
        manifest = load_json(manifest_path)

    runner = Runner(options)
    print(f"守护进程：{' '.join(runner.bin)}", flush=True)
    if not runner.sheets_bin:
        print(
            "提示：找不到 cante-sheets，表格产出只能用内置兜底读取。"
            "可以设 CANTE_SHEETS_BIN 指到它的 .exe 上。",
            file=sys.stderr,
        )
    if not runner.pdf_bin:
        print(
            "提示：找不到 cante-pdf，PDF 产出只能用内置兜底读取。"
            "可以设 CANTE_PDF_BIN 指到它的 .exe 上。",
            file=sys.stderr,
        )

    # 先把每张卡的输入拷进各自的目录，再用拷贝后的路径生成提示词——顺序反了，
    # 助手就会把结果写在公共 fixture 旁边。
    prepared = [runner.prepare(card, manifest) for card in selected]
    plan = []
    for prep in prepared:
        card = prep["card"]
        entry = {"id": card["id"], "instruction": card["instruction"]}
        if card.get("scenario"):
            entry["scenario"] = card["scenario"]
        if prep["folder"]:
            entry["folder"] = prep["folder"]
        if prep["files"]:
            entry["files"] = prep["files"]
        plan.append(entry)

    prompts = load_prompts(plan, options.work)

    # 累加：分几次跑（先跑表格，再跑 PDF）也能拼成一份完整报告。
    results_path = os.path.join(options.work, "results.json")
    accumulated: dict[str, dict] = {}
    if os.path.exists(results_path):
        try:
            data = load_json(results_path)
            if isinstance(data, dict):
                accumulated = {key: item for key, item in data.items() if isinstance(item, dict)}
            else:
                accumulated = {item["key"]: item for item in data}
        except (json.JSONDecodeError, KeyError, TypeError):
            accumulated = {}

    def ordered() -> list[dict]:
        order = []
        for card in CARDS:
            if card_key(card) in accumulated:
                order.append(accumulated[card_key(card)])
        for _key, item in accumulated.items():
            if item not in order:
                order.append(item)
        return order

    for prep in prepared:
        key = prep["key"]
        card = prep["card"]
        print(f"==> {key}", flush=True)
        try:
            result = runner.run_card(prep, prompts)
        except Exception as error:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            result = {
                "key": key,
                "title": card["id"],
                "group": "",
                "elapsed": 0,
                "tool_starts": 0,
                "tool_failed": 0,
                "tool_denied": 0,
                "pauses": 0,
                "errors": [str(error)],
                "stderr": [],
                "created": [],
                "changed": [],
                "moved": [],
                "lost": [],
                "verdict": "failed",
                "evidence": f"普查脚本自己出错：{error}",
                "last_message": "",
                "run_dir": "",
            }
        print(f"    {VERDICT_LABEL.get(result['verdict'], result['verdict'])}：{result['evidence'][:120]}", flush=True)
        accumulated[key] = result
        with open(results_path, "w", encoding="utf-8") as handle:
            json.dump(accumulated, handle, ensure_ascii=False, indent=2)

    results = ordered()
    report = render_report(results, options, None)
    with open(options.report, "w", encoding="utf-8") as handle:
        handle.write(report)
    print(f"\n报告写到：{options.report}")
    if options.zip:
        build_zip(options.zip_path, options, options.zip_log_days)
    failed = [item for item in results if item["verdict"] == "failed"]
    if failed:
        print(f"有 {len(failed)} 张卡失败：{'、'.join(item['key'] for item in failed[:5])}", file=sys.stderr)
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
