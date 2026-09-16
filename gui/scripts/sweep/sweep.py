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
import hashlib
import json
import os
import queue
import re
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

sys.path.insert(0, os.path.dirname(FIXTURE_GEN))
import generate  # noqa: E402  （同目录的 fixture 生成器）

DEFAULT_TIMEOUT = 600  # 单卡上限，秒
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


def truncate(text: str, limit: int = 600) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


_PRIVATE_HOME = re.compile(r"/(?:Users|home)/[^/\s，。；、）)】]+")


def redact(text: str) -> str:
    """报告会提交，用户私人路径不能进去。把真实主目录换成 ~ / <用户>。"""
    home = os.path.expanduser("~")
    if home and home not in ("/", ""):
        text = text.replace(home, "~")
    text = _PRIVATE_HOME.sub("/<用户>", text)
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


def verify_sheet(path: str, sheets_bin: str | None) -> dict:
    result = {"path": path, "kind": "sheet", "ok": False, "note": ""}
    # cante-sheets 读不了 csv（它只认 xls/xlsx/ods），csv 直接按文本核对。
    if path.lower().endswith(".csv"):
        return _verify_csv(path, result)
    if sheets_bin:
        try:
            described = subprocess.run(
                [sheets_bin, "sheets", path], capture_output=True, text=True, timeout=60
            )
            read = subprocess.run([sheets_bin, "read", path], capture_output=True, text=True, timeout=60)
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
        with open(path, encoding="utf-8-sig", errors="replace") as handle:
            rows = [line for line in handle.read().splitlines() if line.strip()]
        result["ok"] = len(rows) >= 1
        result["note"] = f"csv 按文本读回 {len(rows)} 行"
    except Exception as error:  # noqa: BLE001
        result["note"] = f"csv 读不了：{error}"
    return result


def verify_pdf(path: str, pdf_bin: str | None) -> dict:
    result = {"path": path, "kind": "pdf", "ok": False, "note": ""}
    if pdf_bin:
        try:
            pages = subprocess.run([pdf_bin, "pages", path], capture_output=True, text=True, timeout=60)
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
        with open(path, encoding="utf-8", errors="replace") as handle:
            text = handle.read()
        result["ok"] = len(text.strip()) > 0
        result["note"] = f"文本里读到 {len(text.strip())} 个字"
    except Exception as error:  # noqa: BLE001
        result["note"] = f"读不了：{error}"
    return result


def verify_file(path: str, sheets_bin: str | None, pdf_bin: str | None) -> dict:
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
        self.bin = resolve_cante_bin()
        self.sheets_bin = os.environ.get("CANTE_SHEETS_BIN") or shutil.which("cante-sheets")
        self.pdf_bin = os.environ.get("CANTE_PDF_BIN") or shutil.which("cante-pdf")

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
        real_desktop = os.path.expanduser("~/Desktop")
        before_real = set(walk_files(real_desktop)) if os.path.isdir(real_desktop) else set()
        started = time.monotonic()
        started_wall = time.time()
        record = self._drive(prompts[key]["prompt"], run_dir, prep["home"], prep["inputs"])
        elapsed = time.monotonic() - started
        # 文书类任务被要求存到「桌面」。macOS 上真实桌面不认 HOME 环境变量，助手有
        # 时会写到真的桌面去；把这一轮确实由它写出的文件收进 run 目录，既留住证据，
        # 也不会在你的桌面上留垃圾。
        escaped = self._capture_escaped(
            real_desktop, before_real, record.get("tool_args_text", ""), started_wall, run_dir
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
        env["HOME"] = home
        # 让裸的 cante-sheets / cante-pdf 也能找到（提示词里给的是绝对路径，这是双保险）。
        for binary in (self.sheets_bin, self.pdf_bin):
            if binary:
                env["PATH"] = os.path.dirname(binary) + os.pathsep + env.get("PATH", "")
        command = [self.bin, "serve"]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=run_dir,
            env=env,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
        events: queue.Queue = queue.Queue()

        def pump(stream, tag):
            for line in stream:
                events.put((tag, line.rstrip("\n")))

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
        }
        event_log = open(os.path.join(run_dir, "sweep-events.jsonl"), "a", encoding="utf-8")

        def send(payload: dict) -> None:
            try:
                process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                process.stdin.flush()
            except (BrokenPipeError, ValueError):
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
            pending_approvals: set[str] = set()

            while time.monotonic() < deadline:
                try:
                    tag, line = events.get(timeout=0.5)
                except queue.Empty:
                    continue
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
            try:
                process.terminate()
                process.wait(timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    os.killpg(os.getpgid(process.pid), signal.SIGKILL)
                except Exception:  # noqa: BLE001
                    pass
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


def resolve_cante_bin() -> str:
    for candidate in (os.environ.get("CANTE_BIN"), os.environ.get("ANTE_BIN")):
        if candidate and os.path.exists(candidate):
            return candidate
    found = shutil.which("ante") or shutil.which("cante")
    if found:
        return found
    fallback = os.path.expanduser("~/.ante/bin/ante")
    if os.path.exists(fallback):
        return fallback
    raise SystemExit("找不到 ante / cante 可执行文件；请设置 CANTE_BIN。")


# ---------------------------------------------------------------------------
# 报告
# ---------------------------------------------------------------------------


def load_prompts(plan: list[dict], work: str) -> dict:
    plan_path = os.path.join(work, "plan.json")
    with open(plan_path, "w", encoding="utf-8") as handle:
        json.dump(plan, handle, ensure_ascii=False, indent=2)
    command = ["bun", os.path.join(HERE, "prompts.ts"), plan_path]
    result = subprocess.run(command, capture_output=True, text=True, cwd=GUI_ROOT, timeout=120)
    if result.returncode != 0:
        raise SystemExit(f"生成提示词失败（bun prompts.ts）：\n{result.stderr.strip()}")
    entries = json.loads(result.stdout)
    return {f"{item['id']}[{item['scenario']}]" if item.get("scenario") else item["id"]: item for item in entries}


VERDICT_LABEL = {
    "passed": "通过",
    "timeout_output": "超时但有产出",
    "stopped": "停下问问题",
    "failed": "失败",
}


def render_report(results: list[dict], options, skipped_reason: str | None) -> str:
    lines: list[str] = []
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines.append("# 真机任务普查报告")
    lines.append("")
    lines.append(f"生成时间：{stamp}")
    lines.append("")
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
                info = verify_file(absolute, os.environ.get("CANTE_SHEETS_BIN"), os.environ.get("CANTE_PDF_BIN"))
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
        with open(notes_path, encoding="utf-8") as handle:
            lines.append(handle.read().rstrip())
        lines.append("")
    return redact("\n".join(lines) + "\n")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="真机任务普查")
    parser.add_argument("cards", nargs="*", help="只跑这些卡（默认全部）")
    parser.add_argument("--skip", default="", help="这次不跑的卡，逗号分隔（沿用上次攒下的结果）")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="单卡上限，秒")
    parser.add_argument("--work", default=os.path.join(HERE, "work"), help="工作目录")
    parser.add_argument("--report", default=os.path.join(HERE, "report.md"), help="报告写到哪")
    parser.add_argument("--no-fixtures", action="store_true", help="不重新生成 fixture")
    parser.add_argument("--list", action="store_true", help="列出所有卡并退出")
    parser.add_argument("--render-only", action="store_true", help="不跑，只拿 work/results.json 重写报告")
    options = parser.parse_args(argv)

    if options.list:
        for card in CARDS:
            label = f"[{card['scenario']}]" if card.get("scenario") else ""
            print(f"{card['id']}{label}")
        return 0

    if options.render_only:
        results_path = os.path.join(options.work, "results.json")
        if not os.path.exists(results_path):
            print(f"没有可用的结果：{results_path}", file=sys.stderr)
            return 2
        with open(results_path, encoding="utf-8") as handle:
            data = json.load(handle)
        accumulated = data if isinstance(data, dict) else {item["key"]: item for item in data}
        results = []
        for card in CARDS:
            key = f"{card['id']}[{card['scenario']}]" if card.get("scenario") else card["id"]
            if key in accumulated:
                results.append(accumulated[key])
        for key, item in accumulated.items():
            if key not in {entry["key"] for entry in results}:
                results.append(item)
        report = render_report(results, options, None)
        with open(options.report, "w", encoding="utf-8") as handle:
            handle.write(report)
        print(f"报告写到：{options.report}")
        return 0

    selected = [card for card in CARDS if not options.cards or card["id"] in options.cards]
    skipped = {name.strip() for name in options.skip.split(",") if name.strip()}
    if skipped:
        selected = [card for card in selected if card["id"] not in skipped]
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
        return 0

    os.makedirs(options.work, exist_ok=True)
    fixtures_root = os.path.join(options.work, "fixtures")
    manifest_path = os.path.join(options.work, "manifest.json")
    if not options.no_fixtures or not os.path.isdir(fixtures_root):
        manifest = generate.generate(fixtures_root)
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
    else:
        print("复用已有的 fixture（--no-fixtures）")
        with open(manifest_path, encoding="utf-8") as handle:
            manifest = json.load(handle)

    runner = Runner(options)
    if not runner.sheets_bin:
        print("提示：找不到 cante-sheets，表格产出只能用内置兜底读取。", file=sys.stderr)
    if not runner.pdf_bin:
        print("提示：找不到 cante-pdf，PDF 产出只能用内置兜底读取。", file=sys.stderr)

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
            with open(results_path, encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, dict):
                accumulated = {key: item for key, item in data.items() if isinstance(item, dict)}
            else:
                accumulated = {item["key"]: item for item in data}
        except (json.JSONDecodeError, KeyError, TypeError):
            accumulated = {}

    def ordered() -> list[dict]:
        order = []
        for card in CARDS:
            key = f"{card['id']}[{card['scenario']}]" if card.get("scenario") else card["id"]
            if key in accumulated:
                order.append(accumulated[key])
        for key, item in accumulated.items():
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
    return 0 if all(item["verdict"] != "failed" for item in results) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
