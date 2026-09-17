#!/usr/bin/env python3
"""生成任务普查用的「脏」输入（issue #83 的普查基础设施）。

这些输入故意不干净：重复行、空单元格、列名只差一点点、两行表头、混合日期写法、
隐藏行、合并单元格、带前导 0 的编号、Windows 风格路径、中文文件名、缺列、多表
列顺序不同、密码 PDF、扫描版 PDF、没有时间记录的文件……

为什么用脚本生成而不是提交二进制：.xlsx / .docx / .pdf 都是二进制，提交进仓库既
占地方又看不出内容，改起来也没法 diff。这里只用 Python 标准库，**另外两个依赖是必须的**
（见下），现场生成，大小都是几 KB。

依赖：**缺了就报错退出，不静默降级**。
这一条是普查自己发现的教训（`gui/SWEEP-0.2.1.md`）：以前 pypdf 不在时 `encrypt_pdf()`
只是 `return False`，那份「加密材料.pdf」就**根本没加密**——同一个场景在不同机器上
不是同一个夹具，看起来却像“产品变好了”。夹具不完整就必须大声失败。

用法：
    python3 gui/fixtures/sweep/generate.py [目标目录]
    python3 gui/fixtures/sweep/generate.py --check-deps   # 只查依赖，不生成

默认写到本目录下的 generated/。生成完会打印每个文件的名字，方便核对；
同时写一份 `fixture-status.json`，让普查报告能看出**每份夹具是完整还是缺依赖**。
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import sys
import zipfile
from xml.sax.saxutils import escape

# ---------------------------------------------------------------------------
# 依赖：缺一个就停下（不静默降级）
# ---------------------------------------------------------------------------


class MissingFixtureDependency(RuntimeError):
    """夹具需要的依赖没装。宁可整轮停下，也不要生成一份“看起来一样”的假夹具。"""


# (import 名, 用来干什么, 怎么装)
DEPENDENCIES: list[tuple[str, str, str]] = [
    ("pypdf", "加密 PDF（pdf.merge 的「加密材料」场景）", "python3 -m pip install pypdf"),
    ("PIL", "表格照片（vision.table 的截图输入）", "python3 -m pip install pillow"),
]

# 上一次 generate() 每份夹具的状态：key → "complete" / "missing-dep: <名字>"。
# 写进 fixture-status.json，也挂在这里方便同进程的调用方直接读。
LAST_STATUS: dict[str, str] = {}


def missing_dependencies() -> list[tuple[str, str, str]]:
    missing: list[tuple[str, str, str]] = []
    for module, purpose, install in DEPENDENCIES:
        try:
            __import__(module)
        except ImportError:
            missing.append((module, purpose, install))
    return missing


def dependency_message(missing: list[tuple[str, str, str]]) -> str:
    lines = ["夹具生成缺少依赖，**不生成**（宁可停下，也不要生成一份不一样却看不出来的夹具）："]
    for module, purpose, install in missing:
        lines.append(f"  - 缺 {module}：用来生成{purpose}")
        lines.append(f"      装它：{install}")
    lines.append("装完重跑同一条命令即可。")
    return "\n".join(lines)


def check_dependencies() -> None:
    missing = missing_dependencies()
    if missing:
        raise MissingFixtureDependency(dependency_message(missing))

# ---------------------------------------------------------------------------
# .xlsx 写入器（纯标准库：xlsx 就是一个 zip + 几个 XML）
# ---------------------------------------------------------------------------


class Text(str):
    """普通文本单元格。"""


class Num:
    """数字单元格（整数/小数都走这里，保住原样）。"""

    def __init__(self, value):
        self.value = value


class Date:
    """日期单元格：写成 Excel 序列号 + yyyy-mm-dd 格式，读回来应是 2024-01-05。"""

    def __init__(self, serial):
        self.serial = serial


class Formula:
    """公式单元格，带一个缓存值（Excel 不打开也能被读工具读到值）。"""

    def __init__(self, expr, cached):
        self.expr = expr
        self.cached = cached


class Bold:
    """加粗文本（表头用）。"""

    def __init__(self, value):
        self.value = value


def _col(n: int) -> str:
    """1 → A，27 → AA。"""
    out = ""
    while n:
        n, rem = divmod(n - 1, 26)
        out = chr(65 + rem) + out
    return out


def _cell_xml(ref: str, value, style: int = 0) -> str:
    s = f' s="{style}"' if style else ""
    if value is None:
        return ""
    if isinstance(value, Bold):
        inner = escape(str(value.value))
        return f'<c r="{ref}"{s or " s=\"1\""} t="inlineStr"><is><t xml:space="preserve">{inner}</t></is></c>'
    if isinstance(value, Text):
        inner = escape(str(value))
        return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{inner}</t></is></c>'
    if isinstance(value, Formula):
        return f'<c r="{ref}"{s}><f>{escape(value.expr)}</f><v>{escape(str(value.cached))}</v></c>'
    if isinstance(value, Date):
        return f'<c r="{ref}" s="{style or 2}"><v>{value.serial}</v></c>'
    if isinstance(value, Num):
        return f'<c r="{ref}"{s}><v>{value.value}</v></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{s}><v>{value}</v></c>'
    inner = escape(str(value))
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{inner}</t></is></c>'


_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    "{sheet_overrides}"
    "</Types>"
)

_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    "</Relationships>"
)

_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>'
    '<fonts count="2">'
    '<font><sz val="11"/><name val="Calibri"/></font>'
    '<font><b/><sz val="11"/><name val="Calibri"/></font>'
    "</fonts>"
    '<fills count="2"><fill><patternFill patternType="none"/></fill>'
    '<fill><patternFill patternType="gray125"/></fill></fills>'
    '<borders count="1"><border/></borders>'
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    '<cellXfs count="3">'
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    "</cellXfs>"
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    "</styleSheet>"
)


def write_xlsx(
    path: str,
    sheets: list[tuple[str, list[list]]],
    merges: dict[str, list[str]] | None = None,
    hidden_rows: dict[str, list[int]] | None = None,
) -> None:
    """写一个最小但合法的 .xlsx。

    sheets 是 [(表名, 行列表)]；单元格可以是 str / Text / Num / Date / Formula /
    Bold / None。merges 和 hidden_rows 按表名给。
    """
    merges = merges or {}
    hidden_rows = hidden_rows or {}
    overrides = []
    sheet_parts = {}
    for index, (name, rows) in enumerate(sheets, start=1):
        overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
        parts = []
        for r, row in enumerate(rows, start=1):
            attrs = f' r="{r}"'
            if r in hidden_rows.get(name, []):
                attrs += ' hidden="1"'
            cells = "".join(
                _cell_xml(f"{_col(c)}{r}", value) for c, value in enumerate(row, start=1)
            )
            parts.append(f"<row{attrs}>{cells}</row>")
        tail = ""
        if merges.get(name):
            refs = "".join(f'<mergeCell ref="{ref}"/>' for ref in merges[name])
            tail += f'<mergeCells count="{len(merges[name])}">{refs}</mergeCells>'
        sheet_parts[index] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f"<sheetData>{''.join(parts)}</sheetData>{tail}</worksheet>"
        )

    workbook_sheets = "".join(
        f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
        for i, (name, _) in enumerate(sheets, start=1)
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{workbook_sheets}</sheets></workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        + f'<Relationship Id="rId{len(sheets) + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES.format(sheet_overrides="".join(overrides)))
        zf.writestr("_rels/.rels", _RELS)
        zf.writestr("xl/workbook.xml", workbook)
        zf.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        zf.writestr("xl/styles.xml", _STYLES)
        for index, xml in sheet_parts.items():
            zf.writestr(f"xl/worksheets/sheet{index}.xml", xml)


# ---------------------------------------------------------------------------
# .docx 写入器（同样是 zip + XML）
# ---------------------------------------------------------------------------


def write_docx(path: str, paragraphs: list[str]) -> None:
    body = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'
        for text in paragraphs
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{body}</w:body></w:document>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        "</Relationships>"
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", content_types)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("word/document.xml", document)


# ---------------------------------------------------------------------------
# 最小 PDF 写入器（文字版 / 没有文字层的「扫描版」）
# ---------------------------------------------------------------------------


def _pdf_bytes(pages: list[list[str] | None]) -> bytes:
    """pages：每页是一行行文字；None 表示只有图形、没有文字层。

    对象编号固定：1 目录、2 页面树、3 字体，之后每页两个对象（内容流、页面）。
    编号固定是为了让页面的 /Parent 指向页面树而不是别的对象——写错会被读工具
    当成坏文件。
    """
    objects: dict[int, bytes] = {}
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"

    page_ids: list[int] = []
    next_id = 4
    for page in pages:
        if page:
            lines = []
            y = 720
            for line in page:
                safe = line.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
                lines.append(f"BT /F1 14 Tf 72 {y} Td ({safe}) Tj ET")
                y -= 22
            stream = "\n".join(lines).encode("latin-1", "replace")
        else:
            # 一个填充矩形，没有文字层，模拟扫描页。
            stream = b"0.8 0.8 0.8 rg 72 200 300 400 re f"
        content_id = next_id
        page_id = next_id + 1
        next_id += 2
        objects[content_id] = (
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
        )
        objects[page_id] = (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents "
            + str(content_id).encode()
            + b" 0 R /Resources << /Font << /F1 3 0 R >> >> >>"
        )
        page_ids.append(page_id)
    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[2] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode()
    objects[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    count = max(objects) + 1
    offsets: dict[int, int] = {}
    for index in range(1, count):
        payload = objects.get(index)
        if payload is None:
            payload = b"null"
        offsets[index] = len(out)
        out += f"{index} 0 obj\n".encode() + payload + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {count}\n".encode()
    out += b"0000000000 65535 f \n"
    for index in range(1, count):
        out += f"{offsets[index]:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode()
    return bytes(out)


def write_pdf(path: str, pages: list[list[str] | None]) -> None:
    with open(path, "wb") as handle:
        handle.write(_pdf_bytes(pages))


def encrypt_pdf(path: str, user_password: str = "secret") -> None:
    """加密一份 PDF。

    pypdf 不在时**抛异常**（以前是 `return False` → 文件静静地没加密，
    于是 pdf.merge 那个场景在不同机器上不是同一份夹具）。
    """
    try:
        from pypdf import PdfReader, PdfWriter
    except ImportError as error:  # pragma: no cover - 取决于环境
        raise MissingFixtureDependency(
            "要生成加密 PDF，需要 pypdf（装它：python3 -m pip install pypdf）。"
            "没有它就不能把这份夹具做成加密的——那会让 pdf.merge 这个场景看起来像产品支持了，所以这里直接停下。"
        ) from error
    reader = PdfReader(path)
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(user_password)
    with open(path, "wb") as handle:
        writer.write(handle)


# ---------------------------------------------------------------------------
# 小二进制素材
# ---------------------------------------------------------------------------

# 1x1 红色 PNG（68 字节）和 1x1 蓝色 PNG，内容不同，可当重复文件素材。
PNG_RED = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
PNG_BLUE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def _write_bytes(path: str, data: bytes) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


# ---------------------------------------------------------------------------
# 各张卡的输入
# ---------------------------------------------------------------------------


def _sales_jan(path: str) -> None:
    write_xlsx(
        path,
        [
            (
                "1月",
                [
                    [Bold("日期"), Bold("部门"), Bold("金额"), Bold("编号")],
                    [Text("2024-01-05"), Text("销售部"), Num(1200), Text("001")],
                    [Text("2024-01-06"), Text("销售部"), Num(800.5), Text("002")],
                    [Text("2024-01-07"), Text(" 市场部 "), Num(1500), Text("003")],
                    # 完全重复的一行（与第二行逐格相同）
                    [Text("2024-01-06"), Text("销售部"), Num(800.5), Text("002")],
                    [Text("2024-01-08"), Text("市场部"), None, Text("004")],
                ],
            )
        ],
    )


def _sales_feb(path: str) -> None:
    # 列顺序不同，且「金额」叫「金额（元）」——列名只差一点点。
    write_xlsx(
        path,
        [
            (
                "2月",
                [
                    [Bold("编号"), Bold("日期"), Bold("金额（元）"), Bold("部门")],
                    [Text("002"), Text("2024-02-03"), Num(800.5), Text("销售部")],
                    [Text("005"), Text("2024-02-04"), Num(2200), Text("销售部")],
                    [Text("006"), Text("2024-02-05"), Num(300), Text("客服部")],
                ],
            )
        ],
    )


def _sales_compat(path: str) -> None:
    # 和 1 月表列名完全一致，用来跑「列名对得上」时的合并主路径。
    write_xlsx(
        path,
        [
            (
                "4月",
                [
                    [Bold("日期"), Bold("部门"), Bold("金额"), Bold("编号")],
                    [Text("2024-01-05"), Text("销售部"), Num(1200), Text("001")],  # 与 1 月表重复
                    [Text("2024-04-02"), Text("销售部"), Num(1300), Text("009")],
                    [Text("2024-04-03"), Text("客服部"), Num(400), Text("010")],
                ],
            )
        ],
    )


def _sales_mar(path: str) -> None:
    # Windows 风格内容 + BOM + 列名顺序又不一样 + 末尾空格。
    _write(
        path,
        "\ufeff部门,日期,金额,编号\n"
        "销售部,2024-03-01,900,002\n"
        "销售部 ,2024-03-02,1100,007\n"
        "市场部,2024-03-03,1800,008\n",
    )


def _detail(path: str) -> None:
    # 部门列有合并单元格（A2:A3），还有隐藏行和第 5 行重复。
    write_xlsx(
        path,
        [
            (
                "明细",
                [
                    [Bold("部门"), Bold("月份"), Bold("金额"), Bold("客户")],
                    [Text("销售部"), Text("1月"), Num(1200), Text("甲公司")],
                    [None, Text("2月"), Num(900), Text("乙公司")],
                    [Text("市场部"), Text("1月"), Num(1500), Text("丙公司")],
                    [Text("市场部"), Text("1月"), Num(1500), Text("丙公司")],
                    [Text("客服部"), Text("2月"), Num(300), Text("丁公司")],
                ],
            )
        ],
        merges={"明细": ["A2:A3"]},
        hidden_rows={"明细": [5]},
    )


def _messy(path: str) -> None:
    # 两行表头、空行、空列、混合日期、千分位、前后空格、前导 0、公式。
    write_xlsx(
        path,
        [
            (
                "登记表",
                [
                    [Bold("客户登记表"), None, None, None, None],
                    [Bold("姓名"), Bold("金额（元）"), Bold("日期"), None, Bold("编号")],
                    [Text("张三"), Text("1,200"), Text("2024/1/5"), None, Text("001")],
                    [Text("李四 "), Num(800), Text("2024.01.06"), None, Text("002")],
                    [Text("王五"), Text("￥1,500"), Text("1月7日"), None, Text("003")],
                    [None, None, None, None, None],
                    [Text(" 赵六"), Num(200), Date(45300), None, Text("004")],
                    [Text("合计"), Formula("SUM(B3:B7)", 3700), None, None, None],
                ],
            )
        ],
    )


def _before_after(before: str, after: str) -> None:
    write_xlsx(
        before,
        [
            (
                "工资表",
                [
                    [Bold("编号"), Bold("姓名"), Bold("金额")],
                    [Text("A01"), Text("张三"), Num(5000)],
                    [Text("A02"), Text("李四"), Num(5200)],
                    [Text("A03"), Text("王五"), Num(4800)],
                    [Text("A06"), Text("钱七"), Num(6000)],
                ],
            )
        ],
    )
    write_xlsx(
        after,
        [
            (
                "工资表",
                [
                    [Bold("编号"), Bold("姓名"), Bold("金额")],
                    [Text("A01"), Text("张三"), Num(5000)],
                    [Text("A02 "), Text("李四"), Num(5200)],  # 编号多一个空格
                    [Text("A04"), Text("周八"), Num(5000)],  # 新增
                    [Text("A06"), Text("钱七"), Num(6500)],  # 改动
                ],
            )
        ],
    )


def _big_table(path: str) -> None:
    write_xlsx(
        path,
        [
            (
                "记录",
                [
                    [Bold("区域"), Bold("月份"), Bold("客户"), Bold("金额")],
                    [Text("华东"), Text("3月"), Text("甲公司"), Num(12000)],
                    [Text("华东 "), Text("3月"), Text("乙公司"), Num(10000)],
                    [Text("华东"), Text("4月"), Text("丙公司"), Num(8000)],
                    [Text("华东"), Text("3月"), Text("丁公司"), Num(15000)],  # 被隐藏的一行，应被读出
                    [Text("华南"), Text("3月"), Text("戊公司"), Num(3000)],
                    [Text("华东"), Text("3月"), Text("己公司"), Num(9999.99)],
                ],
            )
        ],
        hidden_rows={"记录": [4]},
    )


def _names_phones(path: str) -> None:
    write_xlsx(
        path,
        [
            (
                "名单",
                [
                    [Bold("姓名电话"), Bold("备注")],
                    [Text("张三 13800138000"), Text("销售部")],
                    [Text("李四,13900139000"), Text("市场部")],
                    [Text("王五（销售部）"), Text("")],
                    [Text("赵六 0755-12345678"), Text("客服部")],
                    [Text("孙七"), Text("没有分隔符")],
                ],
            )
        ],
    )


def _annual_report(path_txt: str, path_docx: str, path_md: str) -> None:
    paragraphs = [
        "2024 年度工作总结",
        "一、总体情况",
        "全年营业收入 1.2 亿元，比上一年增长 15%。其中华东区贡献 4200 万元，占 35%。",
        "二、重点工作",
        "客服系统在 6 月上线，平均响应时间从 8 分钟降到 3 分钟。",
        "三、存在的问题",
        "部分门店的数据上报仍然靠手工表格，容易出错，年底盘点了两次才对上。",
        "四、下一步计划",
        "计划在明年第一季度把门店数据接入统一系统，减少手工环节。",
    ]
    _write(path_txt, "\n".join(paragraphs) + "\n")
    write_docx(path_docx, paragraphs)
    _write(
        path_md,
        "# 补充说明\n\n"
        "本报告的营收数字来自财务系统导出，未经审计。\n\n"
        "客服系统上线时间是 6 月 18 日，与年度报告里写的 6 月一致。\n",
    )


def _chat_log(path: str) -> None:
    _write(
        path,
        "2024-03-01 09:12 张三：王姐，上个月的报销单我放你桌上了\n"
        "2024-03-01 09:15 王姐：好的，我看一下\n"
        "2024-03-01 09:20 张三：麻烦这个月 15 号之前帮我报掉\n"
        "[图片]\n"
        "2024-03-01 10:02 李四：会议室下午三点有人用吗？\n"
        "王姐：下午三点空着，你用吧\n"
        "2024-03-01 10:30 李四：收到，谢谢\n"
        "2024-03-02 08:40 张三：昨天的发票我补给你\n",
    )


def _photo(path: str, data: bytes) -> None:
    _write_bytes(path, data)


def _touch(path: str, stamp: str) -> None:
    import time

    parsed = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
    os.utime(path, (parsed, parsed))


def _small_zip(path: str) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("readme.txt", "这是一个压缩包里的说明。\n")


# ---------------------------------------------------------------------------
# 汇总生成
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 后补的夹具（issue #161：把普查覆盖率从 20/32 补到全部卡片）
#
# 这些卡片原先从来没进过普查计划（核对账、发票、人员变化、看图转表格、资料调研、
# 接龙与点名）。每张卡都配一份能真跑的输入；确实造不出来的在 CARDS 里逐张写理由。
# ---------------------------------------------------------------------------


def _totals(path: str) -> None:
    """check.totals：台账里有小计/合计，其中一个是错的；另带重复行与空行。"""
    write_xlsx(
        path,
        [
            (
                "报销台账",
                [
                    [Bold("项目"), Bold("一月"), Bold("二月"), Bold("三月")],
                    [Text("差旅"), Num(1200), Num(800), Num(1500)],
                    [Text("办公"), Num(300.5), Num(220.5), Num(410)],
                    [Text("招待"), Num(600), Num(0), Num(250)],
                    # 完全重复的一行
                    [Text("办公"), Num(300.5), Num(220.5), Num(410)],
                    # 空行
                    [None, None, None, None],
                    # 这一行的小计是错的：三月实际是 1500+410+250 = 2160
                    [Bold("小计"), Num(2100.5), Num(1020.5), Num(2150)],
                ],
            )
        ],
    )


def _reconcile(a_path: str, b_path: str) -> None:
    """check.reconcile：两张表按单号对账（有只在一边的，也有金额对不上的）。"""
    write_xlsx(
        a_path,
        [
            (
                "订单台账",
                [
                    [Bold("单号"), Bold("客户"), Bold("应收金额")],
                    [Text("SO-1001"), Text("晨光商贸"), Num(1200)],
                    [Text("SO-1002"), Text("北方物流"), Num(860)],
                    [Text("SO-1003"), Text("海联电子"), Num(2450.5)],
                    [Text("SO-1004"), Text("南岸百货"), Num(300)],
                ],
            )
        ],
    )
    write_xlsx(
        b_path,
        [
            (
                "收款记录",
                [
                    [Bold("单号"), Bold("到账日期"), Bold("实收金额")],
                    [Text("SO-1001"), Text("2024-03-06"), Num(1200)],
                    # 金额对不上：应收 860，实收 806
                    [Text("SO-1002"), Text("2024-03-08"), Num(806)],
                    [Text("SO-1003"), Text("2024-03-12"), Num(2450.5)],
                    # 这张只在收款表里，订单表里没有
                    [Text("SO-1099"), Text("2024-03-15"), Num(99)],
                ],
            )
        ],
    )


def _invoice_pdf(path: str, number: str, date: str, seller: str, total: str) -> None:
    """invoice.ledger / invoice.dupes 用的电子发票 PDF。

    字段名用拉丁字母：我们的 PDF 写入器只有 Helvetica + latin-1（标准库造不出中文字体），
    中文会被替换成问号。卡片本身也说了「字段的叫法可能不同」，所以这仍然是有效的输入；
    这个不足写在报告里。
    """
    write_pdf(
        path,
        [
            [
                "ELECTRONIC INVOICE",
                f"Invoice No: {number}",
                f"Issue Date: {date}",
                f"Seller: {seller}",
                f"Total (tax included): {total}",
            ]
        ],
    )


def _invoice_sheet(path: str) -> None:
    """invoice.dupes：一张汇总表，里面有重复的发票号码（只标不删）。"""
    write_xlsx(
        path,
        [
            (
                "发票清单",
                [
                    [Bold("发票号"), Bold("开票日期"), Bold("销方名称"), Bold("价税合计")],
                    [Text("044031900111"), Text("2024-03-05"), Text("晨光商贸"), Num(1130)],
                    [Text("044031900112"), Text("2024-03-06"), Text("北方物流"), Num(860)],
                    # 同一个号码第二次出现，金额一样
                    [Text("044031900111"), Text("2024-03-05"), Text("晨光商贸"), Num(1130)],
                    # 同一个号码第三次出现，金额不一样
                    [Text("044031900113"), Text("2024-03-09"), Text("海联电子"), Num(2450.5)],
                    [Text("044031900113"), Text("2024-03-09"), Text("海联电子"), Num(2540.5)],
                    # 号码看不清的一行
                    [None, Text("2024-03-10"), Text("南岸百货"), Num(300)],
                ],
            )
        ],
    )


def _invoice_book(path: str) -> None:
    """invoice.crosscheck：发票台账（用于和报销明细对账）。"""
    write_xlsx(
        path,
        [
            (
                "发票台账",
                [
                    [Bold("发票号码"), Bold("开票日期"), Bold("销方名称"), Bold("价税合计")],
                    [Text("044031900111"), Text("2024-03-05"), Text("晨光商贸"), Num(1130)],
                    [Text("044031900112"), Text("2024-03-06"), Text("北方物流"), Num(860)],
                    [Text("044031900113"), Text("2024-03-09"), Text("海联电子"), Num(2450.5)],
                ],
            )
        ],
    )


def _reimburse(path: str) -> None:
    """invoice.crosscheck：报销明细（号码对不上、金额对不上的各有）。"""
    write_xlsx(
        path,
        [
            (
                "报销明细",
                [
                    [Bold("发票号码"), Bold("报销人"), Bold("报销金额")],
                    [Text("044031900111"), Text("王芳"), Num(1130)],
                    # 金额对不上：发票 860，报销只报 806
                    [Text("044031900112"), Text("李强"), Num(806)],
                    # 号码写错了：台账里没有这个号
                    [Text("044031900199"), Text("赵敏"), Num(510)],
                    # 重复报一笔（同号同额出现两次）
                    [Text("044031900111"), Text("王芳"), Num(1130)],
                ],
            )
        ],
    )


def _roster(path: str) -> None:
    """admin.byperson：花名册（一人一行，工号带前导 0）。"""
    write_xlsx(
        path,
        [
            (
                "花名册",
                [
                    [Bold("工号"), Bold("姓名"), Bold("部门"), Bold("岗位")],
                    [Text("001"), Text("王芳"), Text("行政部"), Text("行政专员")],
                    [Text("002"), Text("李强"), Text("销售部"), Text("销售经理")],
                    # 姓名前后多了空格 / 全角空格
                    [Text("003"), Text(" 张伟"), Text("技术部"), Text("工程师")],
                    [Text("004"), Text("赵　敏"), Text("财务部"), Text("会计")],
                ],
            )
        ],
    )


def _attend(path: str) -> None:
    """admin.byperson：考勤（一人多行）。"""
    write_xlsx(
        path,
        [
            (
                "考勤",
                [
                    [Bold("工号"), Bold("日期"), Bold("状态")],
                    [Text("001"), Text("2024-03-01"), Text("出勤")],
                    [Text("001"), Text("2024-03-02"), Text("出勤")],
                    [Text("002"), Text("2024-03-01"), Text("休假")],
                    [Text("002"), Text("2024-03-02"), Text("出勤")],
                    [Text("005"), Text("2024-03-01"), Text("出勤")],
                ],
            )
        ],
    )


def _salary(path: str) -> None:
    """admin.byperson：工资表（一人一行，用「员工编号」认人——与花名册列名不同）。"""
    write_xlsx(
        path,
        [
            (
                "工资",
                [
                    [Bold("员工编号"), Bold("姓名"), Bold("应发工资")],
                    [Text("001"), Text("王芳"), Num(8200)],
                    [Text("002"), Text("李强"), Num(12500)],
                    [Text("003"), Text("张伟"), Num(15800)],
                    # 工资表里有、花名册里没有的这个工号
                    [Text("009"), Text("周涛"), Num(9600)],
                ],
            )
        ],
    )


def _staff_prev(path: str) -> None:
    """admin.changes：上个月的员工名单。"""
    write_xlsx(
        path,
        [
            (
                "上月名单",
                [
                    [Bold("工号"), Bold("姓名"), Bold("部门"), Bold("手机号")],
                    [Text("001"), Text("王芳"), Text("行政部"), Text("13800000001")],
                    [Text("002"), Text("李强"), Text("销售部"), Text("13800000002")],
                    [Text("007"), Text("孙悦"), Text("市场部"), Text("13800000007")],
                ],
            )
        ],
    )


def _staff_now(path: str) -> None:
    """admin.changes：这个月的员工名单（有新增、有离职、有信息变更）。"""
    write_xlsx(
        path,
        [
            (
                "本月名单",
                [
                    [Bold("工号"), Bold("姓名"), Bold("部门"), Bold("手机号")],
                    [Text("001"), Text("王芳"), Text("行政部"), Text("13800000001")],
                    # 部门 + 手机号都变了（应算两条）
                    [Text("002"), Text("李强"), Text("大客户部"), Text("13900000002")],
                    # 新来的
                    [Text("008"), Text("吴迪"), Text("技术部"), Text("13800000008")],
                    # 007 孙悦 不在了（离职）
                ],
            )
        ],
    )


def _contracts(path: str) -> None:
    """admin.expiry：合同/证照台账（快到期、已过期、日期看不清都有；日期写法不统一）。"""
    import datetime

    today = datetime.date.today()

    def stamp(days: int, style: int) -> object:
        day = today + datetime.timedelta(days=days)
        if style == 0:
            return Text(day.strftime("%Y/%m/%d"))
        if style == 1:
            return Text(day.strftime("%Y.%m.%d"))
        if style == 2:
            return Text(f"{day.year}年{day.month}月{day.day}日")
        return Text(day.strftime("%Y-%m-%d"))

    write_xlsx(
        path,
        [
            (
                "合同台账",
                [
                    [Bold("名称"), Bold("类型"), Bold("到期日"), Bold("负责人")],
                    [Text("办公楼租赁合同"), Text("合同"), stamp(9, 0), Text("王芳")],
                    [Text("营业执照"), Text("证照"), stamp(28, 1), Text("王芳")],
                    [Text("消防年检"), Text("年检"), stamp(45, 2), Text("李强")],
                    # 已经过期
                    [Text("电梯维保合同"), Text("合同"), stamp(-6, 3), Text("李强")],
                    # 日期看不清的两种
                    [Text("保洁服务合同"), Text("合同"), Text("长期"), Text("赵敏")],
                    [Text("网络专线合同"), Text("合同"), None, Text("赵敏")],
                ],
            )
        ],
    )


def _table_photo(path: str) -> None:
    """vision.table：一张表格的照片（PNG）。

    需要 Pillow。内容用拉丁字母与数字：Pillow 的默认位图字体没有中文字形，
    画中文会变成豆腐块。这里要测的是「看图抄格子」这条路，不是中文字形识别。
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError as error:  # pragma: no cover - 取决于环境
        raise MissingFixtureDependency(
            "要生成表格照片，需要 pillow（装它：python3 -m pip install pillow）。"
        ) from error

    width, height = 640, 260
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    rows = [
        ["No.", "Item", "Qty", "Unit Price", "Amount"],
        ["A01", "Notebook", "12", "5.50", "66.00"],
        ["A02", "Pen Box", "30", "2.00", "60.00"],
        ["A03", "Stapler", "4", "18.00", "72.00"],
    ]
    left, top, row_h = 20, 20, 46
    col_w = [70, 190, 70, 130, 130]
    for r, row in enumerate(rows):
        y = top + r * row_h
        draw.rectangle([left, y, left + sum(col_w), y + row_h], outline="black", width=2)
        x = left
        for c, cell in enumerate(row):
            draw.text((x + 8, y + 14), cell, fill="black")
            if c:
                draw.line([x, y, x, y + row_h], fill="black", width=2)
            x += col_w[c]
    image.save(path)


def _class_roster(path: str) -> None:
    """wechat.missing：班级花名册（用来和群里的接龙比对，找出没报的）。"""
    write_xlsx(
        path,
        [
            (
                "花名册",
                [
                    [Bold("序号"), Bold("姓名"), Bold("学号")],
                    [Num(1), Text("陈嘉怡"), Text("20240101")],
                    [Num(2), Text("刘思远"), Text("20240102")],
                    [Num(3), Text("王梓涵"), Text("20240103")],
                    [Num(4), Text("张梦琪"), Text("20240104")],
                    [Num(5), Text("李昊然"), Text("20240105")],
                    [Num(6), Text("周雨萱"), Text("20240106")],
                ],
            )
        ],
    )


def generate(root: str) -> dict[str, str]:
    """把所有素材生成到 root 下，返回「逻辑名 → 相对路径」的清单。

    依赖缺一个就抛 `MissingFixtureDependency`（**不静默降级**）；
    同时把每份夹具的状态写进 `<root>/fixture-status.json`，让普查报告能看出
    「完整」还是「缺依赖」。
    """
    check_dependencies()
    if os.path.isdir(root):
        shutil.rmtree(root)
    os.makedirs(root, exist_ok=True)
    manifest: dict[str, str] = {}
    status: dict[str, str] = {}

    def rel(name: str) -> str:
        return name

    def register(key: str, name: str) -> str:
        manifest[key] = rel(name)
        status[key] = "complete"
        return os.path.join(root, name)

    # --- 表格 ---
    _sales_jan(register("sales_jan", "销售明细_1月.xlsx"))
    _sales_feb(register("sales_feb", "销售明细_2月.xlsx"))
    _sales_mar(register("sales_mar", "销售明细_3月.csv"))
    _sales_compat(register("sales_compat", "销售明细_4月.xlsx"))
    _detail(register("detail", "部门明细表.xlsx"))
    _messy(register("messy", "混乱登记表.xlsx"))
    _before_after(
        register("before", "改动前.xlsx"),
        register("after", "改动后.xlsx"),
    )
    _big_table(register("big", "区域记录表.xlsx"))
    _names_phones(register("names_phones", "姓名电话.xlsx"))

    # --- #161 后补：核对账 / 发票 / 人员变化（原先 12 张没进普查计划的卡）---
    _totals(register("totals", "报销台账.xlsx"))
    _reconcile(
        register("reconcile_a", "订单台账.xlsx"),
        register("reconcile_b", "收款记录.xlsx"),
    )
    for index, (number, date, seller, total) in enumerate(
        [
            ("044031900111", "2024-03-05", "Chenguang Trading Co., Ltd.", "1130.00"),
            ("044031900112", "2024-03-06", "Beifang Logistics Co., Ltd.", "860.00"),
            # 与第一张号码相同：给 invoice.dupes / invoice.ledger 都能用
            ("044031900111", "2024-03-05", "Chenguang Trading Co., Ltd.", "1130.00"),
        ],
        start=1,
    ):
        _invoice_pdf(register(f"invoice_pdf_{index}", f"电子发票{index}.pdf"), number, date, seller, total)
    _invoice_sheet(register("invoice_sheet", "发票清单.xlsx"))
    _invoice_book(register("invoice_book", "发票台账.xlsx"))
    _reimburse(register("reimburse", "报销明细.xlsx"))
    _roster(register("roster", "花名册.xlsx"))
    _attend(register("attend", "考勤表.xlsx"))
    _salary(register("salary", "工资表.xlsx"))
    _staff_prev(register("staff_prev", "员工名单_上月.xlsx"))
    _staff_now(register("staff_now", "员工名单_本月.xlsx"))
    _contracts(register("contracts", "合同台账.xlsx"))
    _table_photo(register("table_photo", "记账本照片.png"))
    _class_roster(register("class_roster", "花名册_班级.xlsx"))

    # --- 文档 ---
    _annual_report(
        register("report_txt", "年度报告.txt"),
        register("report_docx", "年度报告.docx"),
        register("report_md", "补充说明.md"),
    )

    # --- 聊天记录 ---
    _chat_log(register("chat", "聊天记录.txt"))

    # --- PDF ---
    pdf_one = register("pdf_one", "材料一.pdf")
    write_pdf(
        pdf_one,
        [
            ["Material One - Page 1", "This is the first page."],
            ["Material One - Page 2", "This is the second page."],
            ["Material One - Page 3", "This is the third page."],
        ],
    )
    pdf_two = register("pdf_two", "材料二.pdf")
    write_pdf(pdf_two, [["Material Two - Page 1"], ["Material Two - Page 2"]])
    pdf_scanned = register("pdf_scanned", "扫描件.pdf")
    write_pdf(pdf_scanned, [None, None])
    pdf_locked = register("pdf_locked", "加密材料.pdf")
    write_pdf(pdf_locked, [["Locked - Page 1"], ["Locked - Page 2"]])
    encrypt_pdf(pdf_locked)
    manifest["pdf_locked_encrypted"] = "yes"

    # --- 照片 / 小文件（改名、分类、重复用）---
    photo_dir = os.path.join(root, "照片")
    os.makedirs(photo_dir, exist_ok=True)
    _photo(os.path.join(photo_dir, "IMG_0001.jpg"), PNG_RED)
    _photo(os.path.join(photo_dir, "IMG_0002.jpg"), PNG_BLUE)
    _photo(os.path.join(photo_dir, "IMG_0003.jpg"), PNG_RED)
    manifest["photo_1"] = "照片/IMG_0001.jpg"
    manifest["photo_2"] = "照片/IMG_0002.jpg"
    manifest["photo_3"] = "照片/IMG_0003.jpg"

    # --- 按月整理：文件时间跨多个月，文件名日期和修改时间故意对不上 ---
    by_month = os.path.join(root, "下载文件夹")
    os.makedirs(os.path.join(by_month, "旧资料"), exist_ok=True)
    manifest["dir_by_month"] = "下载文件夹"
    files_2024_01 = {
        "会议纪要2024-01-05.docx": "2024-01-05 09:00:00",
        "报表.xlsx": "2024-01-20 15:30:00",
    }
    for name, stamp in files_2024_01.items():
        path = os.path.join(by_month, name)
        write_docx(path, ["会议纪要", "时间：2024 年 1 月"]) if name.endswith(".docx") else write_xlsx(
            path, [("Sheet1", [[Bold("月份"), Bold("金额")], [Text("1月"), Num(100)]])]
        )
        _touch(path, stamp)
    # 文件名写着 1 月，修改时间却是 3 月 —— 用来检验「优先看修改时间」。
    contra = os.path.join(by_month, "3月对账单_20240105.txt")
    _write(contra, "文件名写 1 月，实际修改时间是 3 月。\n")
    _touch(contra, "2024-03-11 10:00:00")
    # 没有日期记录、文件名也看不出月份
    no_date = os.path.join(by_month, "随手记.txt")
    _write(no_date, "没有日期线索。\n")
    _touch(no_date, "2024-02-02 08:00:00")
    # 旧资料子文件夹里有一个和根目录同名的文件，挪进同一个月时会重名
    nested = os.path.join(by_month, "旧资料", "报表.xlsx")
    write_xlsx(nested, [("Sheet1", [[Bold("旧"), Bold("表")], [Text("x"), Num(1)]])])
    _touch(nested, "2024-01-08 12:00:00")
    _small_zip(os.path.join(by_month, "安装包.zip"))
    _touch(os.path.join(by_month, "安装包.zip"), "2024-04-01 12:00:00")

    # --- 按类型整理 ---
    by_type = os.path.join(root, "待分类")
    os.makedirs(by_type, exist_ok=True)
    manifest["dir_by_type"] = "待分类"
    _photo(os.path.join(by_type, "风景.png"), PNG_BLUE)
    _write(os.path.join(by_type, "说明.txt"), "一段说明文字。\n")
    write_xlsx(os.path.join(by_type, "台账.xlsx"), [("Sheet1", [[Bold("项目"), Bold("数量")], [Text("A"), Num(1)]])])
    write_docx(os.path.join(by_type, "通知.docx"), ["放假通知", "5 月 1 日放假。"])
    _small_zip(os.path.join(by_type, "资料包.zip"))
    _write(os.path.join(by_type, "README"), "没有后缀的文件。\n")

    # --- 重复文件 ---
    dupes = os.path.join(root, "重复文件")
    os.makedirs(os.path.join(dupes, "备份"), exist_ok=True)
    manifest["dir_dupes"] = "重复文件"
    _photo(os.path.join(dupes, "照片副本1.png"), PNG_BLUE)
    _photo(os.path.join(dupes, "照片副本2.png"), PNG_BLUE)
    _photo(os.path.join(dupes, "备份", "照片副本3.png"), PNG_BLUE)
    _write(os.path.join(dupes, "文档.txt"), "内容一样。\n")
    _write(os.path.join(dupes, "备份", "文档副本.txt"), "内容一样。\n")
    _write(os.path.join(dupes, "不同.txt"), "内容不一样。\n")

    LAST_STATUS.clear()
    LAST_STATUS.update(status)
    with open(os.path.join(root, "fixture-status.json"), "w", encoding="utf-8") as handle:
        json.dump(
            {
                "dependencies": [
                    {"module": module, "purpose": purpose, "status": "ok"}
                    for module, purpose, _ in DEPENDENCIES
                ],
                "fixtures": {key: {"path": manifest[key], "status": status.get(key, "complete")}
                             for key in sorted(status)},
            },
            handle,
            ensure_ascii=False,
            indent=2,
        )

    return manifest


def main(argv: list[str]) -> int:
    if "--check-deps" in argv:
        missing = missing_dependencies()
        if missing:
            print(dependency_message(missing), file=sys.stderr)
            return 2
        for module, purpose, _install in DEPENDENCIES:
            print(f"  {module:8s} 已装（用来生成{purpose}）")
        print("依赖齐全。")
        return 0
    target = argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "generated")
    try:
        manifest = generate(target)
    except MissingFixtureDependency as error:
        print(str(error), file=sys.stderr)
        return 2
    print(f"生成到：{target}")
    for key in sorted(manifest):
        print(f"  {key:22s} {manifest[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
