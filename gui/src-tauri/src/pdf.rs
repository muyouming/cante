//! PDF 读写（issue #50）。
//!
//! 简单模式里的三件事——"把几个 PDF 合成一个"、"把一个 PDF 拆成几份"、
//! "看看这份 PDF 有多少页、里面写了什么"——此前和 xlsx 一样卡在最后一步：
//! 这台电脑根本没有能读 PDF 的东西。这个模块就是那块缺失的能力，纯逻辑 + 文件
//! IO，不打印、不退出，方便 `cargo test` 直接测，也给 `cante-pdf` 命令行壳和 Tauri
//! 命令共用。
//!
//! 全部用纯 Rust 的 [`lopdf`] 实现：不依赖 pdfium，也不需要系统里的 PDF 库，装完
//! 就能跑。`merge` / `split` 保持页面内容和顺序；`text` 是尽力而为，遇到扫描件
//! （没有文字层）会明确报错，而不是拿一片空白当成功；遇到"有文字层但字体还原不出
//! 字符"的 PDF（issue #94）会经 [`text_layer_risk`] 报出来，让命令行给退出码 3。
//!
//! 所有错误消息都是中文，读得懂，例如：
//! `文件不存在：/tmp/x.pdf`、`这个格式我读不了：x.docx`、
//! `这个文件像是坏了，读不开：/tmp/x.pdf`、
//! `这个 PDF 里没有文字层（大概是扫描或拍照的），需要先做文字识别：/tmp/scan.pdf`。

use std::fmt;
use std::path::Path;

use lopdf::{dictionary, Dictionary, Document, Encoding, Object, ObjectId};

/// 能读的扩展名（小写）。不在这个名单里的格式直接说"读不了"，而不是硬试。
const SUPPORTED_EXTENSIONS: &[&str] = &["pdf"];

/// 处理 PDF 时可能出的问题。前三类和表格那边一一对应：不存在 / 这个格式读不了 /
/// 文件像是坏了。后两类是 PDF 才有的情况：页码越界、扫描件没有文字层。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PdfError {
    /// 文件根本不在。
    NotFound(String),
    /// 这个扩展名我们不认识 / 读不了。
    Unsupported(String),
    /// 文件在，但打不开（坏了、加密了……）。
    Broken(String),
    /// 页码写法不对，或者超出这份 PDF 的真实页数。
    PageRange(String),
    /// 读出来的文字是空的——多半是扫描件或照片，得先做文字识别。
    NoText(String),
}

impl fmt::Display for PdfError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PdfError::NotFound(path) => write!(f, "文件不存在：{path}"),
            PdfError::Unsupported(path) => write!(f, "这个格式我读不了：{path}"),
            PdfError::Broken(what) => write!(f, "这个文件像是坏了，读不开：{what}"),
            PdfError::PageRange(reason) => write!(f, "{reason}"),
            PdfError::NoText(path) => {
                write!(f, "这个 PDF 里没有文字层（大概是扫描或拍照的），需要先做文字识别：{path}")
            }
        }
    }
}

impl std::error::Error for PdfError {}

// ---------------------------------------------------------------------------
// 页码
// ---------------------------------------------------------------------------

/// 一段页码范围，1 起算，两端都算在内。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

/// 从 `--pages 1-5` 这样一行写法里解析出来的选择。空表示"全部页"。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PageSelection {
    ranges: Vec<PageRange>,
}

impl PageSelection {
    /// 全部页。
    pub fn all() -> Self {
        PageSelection { ranges: Vec::new() }
    }

    /// 解析 `1-5` / `3` / `1,3-5` 这类写法。语法错误 → [`PdfError::PageRange`]。
    pub fn parse(spec: &str) -> Result<Self, PdfError> {
        let spec = spec.trim();
        if spec.is_empty() {
            return Err(PdfError::PageRange("页码不能是空的（应该像 1-5 这样）".to_string()));
        }

        let mut ranges = Vec::new();
        for part in spec.split(',') {
            let part = part.trim();
            if part.is_empty() {
                return Err(PdfError::PageRange(format!("页码写法不对：{spec}")));
            }
            let (start, end) = match part.split_once('-') {
                Some((start, end)) => (start.trim(), end.trim()),
                None => (part, part),
            };
            let start: u32 =
                start.parse().map_err(|_| PdfError::PageRange(format!("页码写法不对：{part}")))?;
            let end: u32 =
                end.parse().map_err(|_| PdfError::PageRange(format!("页码写法不对：{part}")))?;
            if start == 0 || end == 0 {
                return Err(PdfError::PageRange(format!("页码从 1 开始，{part} 不是有效页码")));
            }
            if end < start {
                return Err(PdfError::PageRange(format!("页码范围写反了：{part}")));
            }
            ranges.push(PageRange { start, end });
        }

        Ok(PageSelection { ranges })
    }

    /// 是不是"没指定，就是全部页"。
    pub fn is_all(&self) -> bool {
        self.ranges.is_empty()
    }

    /// 按这份 PDF 的真实页数展开成 1 起的页码列表，越界就报中文错误。
    /// 空选择表示全部页。
    pub fn pages(&self, total: usize) -> Result<Vec<u32>, PdfError> {
        if self.ranges.is_empty() {
            return Ok((1..=total as u32).collect());
        }

        let total = total as u32;
        let mut pages = Vec::new();
        for range in &self.ranges {
            if range.end > total {
                return Err(PdfError::PageRange(format!(
                    "页码超出范围：这个 PDF 一共 {total} 页，你要的是 {}-{}",
                    range.start, range.end
                )));
            }
            for page in range.start..=range.end {
                if !pages.contains(&page) {
                    pages.push(page);
                }
            }
        }
        Ok(pages)
    }
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/// 这份 PDF 有多少页。
pub fn page_count(path: &Path) -> Result<usize, PdfError> {
    Ok(load(path)?.get_pages().len())
}

/// 抽出来的文字可不可信。`None` 表示可信；`Some(中文原因)` 表示不可信，命令行会把
/// 它转成 stderr 警告 + 退出码 3（见 `cante-pdf`）。
///
/// 真实的 PDF 里有一类"有文字、但抽不出来"的文件，抽出来是**乱码**而不是空：
/// 扫描件是没有文字层（`extract_text` 会返回 [`PdfError::NoText`]），而这里说的是
/// 另一回事——文字层在，但字体没能把"码位"还原成"字符"。常见两种：
///
/// 1. CID 字体（`Type0`）没带 `ToUnicode` 对照表。打印/导出流水线出的中文 PDF
///    大量是这样。真机验证：同一条 cupsfilter 流水线，拉丁文抽取完好，中文只能抽
///    出 `2026`、`D`、`g%` 这类噪声。
/// 2. Chrome / Skia 导出的 PDF 用 `Type3` 字体（字形是画出来的程序），字符对照表
///    挂在 `/Encoding` 的 `/Differences` 上，字形名却是 `/g0`、`/g830` 这种合成名，
///    对不上任何真实字符。issue #94 就是这个：**退出码 0，stdout 全是乱码**。
///
/// 乱码比"抽不出来"更危险：助手会拿一页乱码去总结，而用户会相信它（正是 issue
/// #81 想防的事）。所以这里两层判断，任一层命中都判为不可信：
///
/// * **字体层**（确定性的）：看这份 PDF 用到的字体有没有"能还原字符"的对照关系，
///   判断标准直接复用 lopdf 真正抽文字时用的同一个函数，避免"两套标准"。
/// * **文字层**（兜底）：抽出来的内容里像正常文字的字符占比低于阈值。
///
/// 阈值标定与两层各自能挡住什么、挡不住什么，见 [`READABLE_RATIO_FLOOR`]。
pub fn text_layer_risk(path: &Path, text: &str) -> Option<String> {
    let document = Document::load(path).ok()?;
    if let Some(kind) = unmapped_font_kind_used_by(&document) {
        return Some(format!(
            "这个 PDF 用的{kind}没能把文字还原出来，抽出来的内容很可能是乱码（打印或导出的 PDF 常见）"
        ));
    }
    text_quality_risk(text)
}

/// 这份 PDF 用到的字体里，第一个"还原不出字符"的种类；都没有就返回 `None`。
fn unmapped_font_kind_used_by(document: &Document) -> Option<&'static str> {
    for page_id in document.get_pages().into_values() {
        // 只看页面上真正用到的字体。没被引用的字体对象不影响抽出来的文字，
        // 拿它告警就是误报。
        let Ok(fonts) = document.get_page_fonts(page_id) else {
            continue;
        };
        for font in fonts.values() {
            if let Some(kind) = unmapped_font_kind(document, font) {
                return Some(kind);
            }
        }
    }
    None
}

/// 单个字体能不能把码位还原成字符；不能就返回它是什么（写进中文告警里）。
///
/// 判断所用的编码，和 `Document::extract_text` 内部用的是同一个
/// [`Dictionary::get_font_encoding`]，所以标准不会跑偏：lopdf 怎么解，我们就怎么判。
fn unmapped_font_kind(document: &Document, font: &Dictionary) -> Option<&'static str> {
    let subtype = font
        .get(b"Subtype".as_slice())
        .ok()
        .and_then(|value| value.as_name().ok())
        .unwrap_or(b"");
    let is_cid = subtype == b"Type0";
    let is_type3 = subtype == b"Type3";
    let kind = if is_cid {
        "中文字体"
    } else if subtype == b"Type3" {
        "特殊字体"
    } else {
        "字体"
    };

    match font.get_font_encoding(document) {
        // 有能用的文字对照表：字符还原得出来。
        Ok(Encoding::UnicodeMapEncoding(_)) => None,
        // CID 字体的码位是字形编号，套单字节表（包括 Differences）只会得到乱码。
        Ok(Encoding::OneByteEncoding(_)) if is_cid => Some(kind),
        Ok(Encoding::Differences(_)) if is_cid => Some(kind),
        // Type3 的乱码（issue #94）：字体自己带了 /ToUnicode 对照表，但对照表挂在
        // /Encoding /Differences 上、字形名又是 /g0、/g830 这种合成名，lopdf 先看不
        // 懂的 /Encoding、解析失败就退回了默认单字节表——明明手边就有能用的
        // /ToUnicode，却被忽略了。Chrome / Skia 导出的中文 PDF 就是这一种。
        //
        // 为什么必须同时要求"有 /ToUnicode"：真机扫到不少 TeX 出的 Type3 字体
        // （LLVM/Polly 的论文），Differences 同样解析不了，但它们没有 ToUnicode，
        // 退回的单字节表跟原意几乎一样，抽出来的字读得懂。只看"Type3 + Differences
        // 解析失败"会把它们误报，正是 brief 里说的"误报让用户不信任工具"。
        Ok(Encoding::OneByteEncoding(_))
            if is_type3
                && declares_differences(document, font)
                && has_character_map(document, font) =>
        {
            Some(kind)
        }
        // 其余情况都往"可信"那边靠（宁可漏报也不误报）：真机扫过 91 份文档，
        // Type1 字体带 /fi、/fl 这种连字名的 Differences 很常见，lopdf 同样会
        // 解析失败、退回单字节表，但退回去的表跟原编码几乎一样，抽出来的字照样
        // 读得懂（LLVM/Polly 的论文、医院给的说明 PDF 都是这样）。把它们报出来
        // 才是真的误报，会把用户和助手都吓住。
        //
        // 已知的偏严（如实记下，不为了"看起来干净"再放水）：只要这份 PDF 里
        // **任何**一个 Type3 字体命中上面这条，就整份告警。真机上有一份 20 页的
        // 聊天打印稿（fa69767d…….pdf）只在末尾用 Type3 画了两个字符，其余文字
        // 都读得懂，也会被告警。宁可多提醒一次，也不放过整页中文乱码那类。
        _ => None,
    }
}

/// 字体是不是写了 `/Encoding` 里的 `/Differences` 对照表。
fn declares_differences(document: &Document, font: &Dictionary) -> bool {
    matches!(
        font.get_deref(b"Encoding", document),
        Ok(Object::Dictionary(encoding)) if encoding.has(b"Differences")
    )
}

/// 字体是不是自带了一张独立的文字对照表（`/ToUnicode`）。
fn has_character_map(document: &Document, font: &Dictionary) -> bool {
    font.get_deref(b"ToUnicode", document).is_ok()
}

/// 可读字符占比的底线。低于它，整段文字就当不可信。
///
/// 标定用的是真机 `cante-pdf text` 的原始输出（见 issue #94 的复现样本）：
///
/// | 样本                                   | 可读占比 |
/// | -------------------------------------- | -------- |
/// | Chrome 正常中文（带 ToUnicode）        | 0.89     |
/// | Chrome 正常中英数字混排                | 0.93     |
/// | cupsfilter 正常拉丁文                  | 1.00     |
/// | cupsfilter 中文乱码（无对照表）        | 1.00     |
/// | Chrome Type3 中文乱码                  | 0.93     |
///
/// 结论写清楚：**这一层分不开"正常"和"乱码"**——乱码也是由可读的单字节字符拼出来
/// 的，占比甚至比正常样本还高。所以拦不住 issue #94 的乱码，真正拦住它的是上面的
/// 字体层；把这一点写在这里，是为了不让后来的人以为调一下阈值就能省掉字体层。
///
/// 它真正能兜住的是另一种常见的坏 PDF：文字对照表里塞了 U+FFFD 占位符，或者混进
/// 控制字符、私用区码位（很多残缺的中文对照表长这样就）。那时占比会明显掉下来。
///
/// 阈值取 0.5，**宁可漏报也不误报**：正常文档里几乎不可能有一半字符不属于任何正常
/// 文字；反过来只要还有一半正常字符，助手手里就还有东西可用，不值得打断用户。
const READABLE_RATIO_FLOOR: f64 = 0.5;

/// 文字层兜底：抽出来的内容里"像正常文字"的字符占比太低就判为不可信。
fn text_quality_risk(text: &str) -> Option<String> {
    // 空行、空格是正文的一部分，不该拉低占比，所以先剔掉。
    let content: Vec<char> = text.chars().filter(|character| !character.is_whitespace()).collect();
    if content.is_empty() {
        // 整个抽出来是空的，由 `extract_text` 的 NoText 分支负责，不在这里重复报。
        return None;
    }
    let readable = content.iter().filter(|character| is_readable_character(**character)).count();
    let ratio = readable as f64 / content.len() as f64;
    (ratio < READABLE_RATIO_FLOOR).then(|| {
        "这份 PDF 抽出来的文字大半是认不出的符号，跟原文对不上（多半是字体没带出文字信息）。请不要照着它下结论"
            .to_string()
    })
}

/// 一个字符像不像"正常文档里会出现的东西"。
///
/// 收录范围刻意保守：中文（常用区、扩展区、兼容区）、中日韩标点、全角字符、拉丁
/// 字母与常用符号、数字、常见标点、货币符号、箭头、数学符号。**不认识的一律算不
/// 可读**——包括私用区、控制字符、代理区、U+FFFD、emoji、生僻文字。范围越窄，越
/// 不容易把正常文档误判成乱码。
fn is_readable_character(character: char) -> bool {
    if character.is_ascii_alphanumeric() || character.is_ascii_punctuation() {
        return true;
    }
    matches!(
        character,
        '\u{00A0}'..='\u{024F}'      // 拉丁字母补充、常用符号（°、×、÷、§…）
        | '\u{2010}'..='\u{206F}'    // 通用标点（引号、破折号、省略号…）
        | '\u{20A0}'..='\u{20BF}'    // 货币符号（€、₩…）
        | '\u{2190}'..='\u{21FF}'    // 箭头
        | '\u{2200}'..='\u{22FF}'    // 数学符号（≤、≠…）
        | '\u{2E80}'..='\u{2FDF}'    // 中日韩部首（康熙部首等，字体里常见）
        | '\u{3000}'..='\u{303F}'    // 中文标点
        | '\u{3400}'..='\u{4DBF}'    // 中文（扩展 A）
        | '\u{4E00}'..='\u{9FFF}'    // 中文（常用）
        | '\u{F900}'..='\u{FAFF}'    // 中文（兼容）
        | '\u{FE10}'..='\u{FE4F}'    // 直排标点、兼容符号
        | '\u{FF00}'..='\u{FFEF}'    // 全角字母、数字、标点
        | '\u{20000}'..='\u{2FA1F}'  // 中文（扩展 B 及以后）
    )
}

pub fn extract_text(path: &Path, selection: Option<&PageSelection>) -> Result<String, PdfError> {
    let document = load(path)?;
    let total = document.get_pages().len();
    let numbers = match selection {
        Some(selection) => selection.pages(total)?,
        None => (1..=total as u32).collect(),
    };
    if numbers.is_empty() {
        return Err(PdfError::NoText(path.display().to_string()));
    }

    let text = document
        .extract_text(&numbers)
        .map_err(|_| broken_with(path, "读里面文字的时候出了点问题"))?;

    if text.trim().is_empty() {
        return Err(PdfError::NoText(path.display().to_string()));
    }
    Ok(text)
}

/// 打开一份 PDF，并把"文件不存在 / 格式不认识 / 打不开"分开说清楚。
fn load(path: &Path) -> Result<Document, PdfError> {
    if !path.exists() {
        return Err(PdfError::NotFound(path.display().to_string()));
    }
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        let lowered = extension.to_ascii_lowercase();
        if !SUPPORTED_EXTENSIONS.contains(&lowered.as_str()) {
            return Err(PdfError::Unsupported(path.display().to_string()));
        }
    }
    Document::load(path).map_err(|_| PdfError::Broken(path.display().to_string()))
}

/// 库兜出来的错误说明是英文，不能端给她，所以只留中文的半句。
fn broken_with(path: &Path, why: &str) -> PdfError {
    PdfError::Broken(format!("{}（{why}）", path.display()))
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/// 把几份 PDF 按给定顺序合成一份，写到 `output`。页面内容和顺序都保住。
pub fn merge(output: &Path, inputs: &[&Path]) -> Result<(), PdfError> {
    if inputs.is_empty() {
        return Err(PdfError::Broken("没有可以合并的 PDF".to_string()));
    }

    // 新文档只放一个空的 Pages 占位，等页都收齐了再填 Kids。
    let mut document = Document::with_version("1.5");
    let pages_id: ObjectId = document.new_object_id();
    let mut max_id = document.max_id + 1;
    let mut kids: Vec<Object> = Vec::new();

    for input in inputs {
        let mut source = load(input)?;
        // 每份文件的对象整体往后挪，编号不会撞车。
        source.renumber_objects_with(max_id);
        max_id = source.max_id + 1;

        let page_ids: Vec<ObjectId> = source.get_pages().into_values().collect();
        if page_ids.is_empty() {
            return Err(PdfError::Broken(format!("{}（这个 PDF 里一页也没有）", input.display())));
        }

        // 页面先换掉 Parent，指向新的 Pages 节点；再搬其余对象（不覆盖已搬的页）。
        for page_id in &page_ids {
            if let Ok(page) = source.get_object(*page_id).and_then(Object::as_dict) {
                let mut page = page.clone();
                page.set("Parent", pages_id);
                document.objects.insert(*page_id, Object::Dictionary(page));
            }
        }
        for (id, object) in source.objects {
            document.objects.entry(id).or_insert(object);
        }
        kids.extend(page_ids.into_iter().map(Object::Reference));
    }

    document.max_id = max_id;
    let count = kids.len() as u32;
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );
    let catalog_id = document.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    document.trailer.set("Root", catalog_id);

    document
        .save(output)
        .map_err(|_| broken_with(output, "写不进去，可能磁盘满了，或者这里不让写"))?;
    Ok(())
}

/// 从一份 PDF 里抽出一段页，另存到 `output`；其余页不要。空选择表示全部页。
pub fn split(input: &Path, selection: &PageSelection, output: &Path) -> Result<(), PdfError> {
    let mut document = load(input)?;
    let total = document.get_pages().len();
    let keep = selection.pages(total)?;
    if keep.is_empty() {
        return Err(PdfError::PageRange("没有要保留的页".to_string()));
    }

    let remove: Vec<u32> = (1..=total as u32).filter(|page| !keep.contains(page)).collect();
    if !remove.is_empty() {
        document.delete_pages(&remove);
    }

    document
        .save(output)
        .map_err(|_| broken_with(output, "写不进去，可能磁盘满了，或者这里不让写"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use lopdf::content::{Content, Operation};
    use lopdf::Stream;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// 每个测试一个独一无二的临时目录，退出时自动删。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0);
            let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("cante-pdf-{label}-{stamp}-{serial}"));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }

        fn join(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 造一份每页各写一行文字的 PDF（自带文字层，能抽出来）。
    fn write_text_pdf(path: &Path, page_texts: &[&str]) {
        let document = build_pdf(
            page_texts
                .iter()
                .map(|text| Content {
                    operations: vec![
                        Operation::new("BT", vec![]),
                        Operation::new("Tf", vec!["F1".into(), 24.into()]),
                        Operation::new("Td", vec![72.into(), 700.into()]),
                        Operation::new("Tj", vec![Object::string_literal(*text)]),
                        Operation::new("ET", vec![]),
                    ],
                })
                .collect(),
        );
        save(document, path);
    }

    /// 造一份没有任何文字层的 PDF（模拟扫描件）：每页只画一个框。
    fn write_scanned_pdf(path: &Path, pages: usize) {
        let document = build_pdf(
            (0..pages)
                .map(|_| Content {
                    operations: vec![
                        Operation::new("re", vec![72.into(), 72.into(), 400.into(), 600.into()]),
                        Operation::new("f", vec![]),
                    ],
                })
                .collect(),
        );
        save(document, path);
    }

    /// 用 lopdf 自己拼一份 PDF，页内容由调用方给。
    fn build_pdf(contents: Vec<Content>) -> Document {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! {
                "F1" => font_id,
            },
        });

        let mut kids: Vec<Object> = Vec::new();
        for content in contents {
            let encoded = content.encode().expect("encode page content");
            let content_id = document.add_object(Stream::new(dictionary! {}, encoded));
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            });
            kids.push(page_id.into());
        }

        let count = kids.len() as u32;
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    fn save(mut document: Document, path: &Path) {
        document.save(path).expect("save test pdf");
    }

    #[test]
    fn pages_reports_the_count() {
        let dir = TempDir::new("pages");
        let path = dir.join("三页.pdf");
        write_text_pdf(&path, &["one", "two", "three"]);
        assert_eq!(page_count(&path).expect("count"), 3);
    }

    /// 一段能被 lopdf 解析的 ToUnicode 对照表：码 1 → 中，码 2 → 文。
    const TO_UNICODE_CMAP: &[u8] = b"/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <4E2D>
<0002> <6587>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end
";

    /// 拼一个单页 PDF；字体现场造（它可能要先生成 CMap / 字形流等对象）。
    fn one_page_pdf(content: &[u8], build_font: impl FnOnce(&mut Document) -> Dictionary) -> Document {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font = build_font(&mut document);
        let font_id = document.add_object(font);
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content_id = document.add_object(Stream::new(dictionary! {}, content.to_vec()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => resources_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document
    }

    /// 造一份 CID（Type0）字体、显示 "中文" 两字的 PDF。`with_map` 决定带不带
    /// 能用的 ToUnicode 对照表；真机里中文 PDF 的两种典型形态各占一半。
    fn build_pdf_with_cid_font(with_map: bool) -> Document {
        one_page_pdf(b"BT /F1 24 Tf 72 700 Td <00010002> Tj ET", |document| {
            let mut font = dictionary! {
                "Type" => "Font",
                "Subtype" => "Type0",
                "BaseFont" => "STSong-Light",
            };
            if with_map {
                let cmap_id = document.add_object(Stream::new(dictionary! {}, TO_UNICODE_CMAP.to_vec()));
                font.set("Encoding", "Identity-H");
                font.set("ToUnicode", cmap_id);
            } else {
                // 真机最常见的形态：有 Identity-H，没有 ToUnicode。
                font.set("Encoding", "Identity-H");
            }
            font
        })
    }

    /// 造一份 Chrome / Skia 形态的 Type3 字体 PDF（issue #94 的真机样本）。
    /// 字形是画出来的程序，对照表挂在 /Encoding /Differences 上，但字形名是合成的
    /// /g0，对不上任何真实字符 —— 抽出来是乱码，而以前判不出来。
    /// `with_to_unicode` 决定字体带不带独立的 `/ToUnicode`：Chrome 会带（这是真正
    /// 的病根：lopdf 手边有能用的对照表却忽略它）；TeX 出的 Type3 不带。
    fn build_pdf_with_type3_font(glyph_name: &[u8], with_to_unicode: bool) -> Document {
        let glyph_name = glyph_name.to_vec();
        one_page_pdf(b"BT /F1 24 Tf 72 700 Td (AB) Tj ET", |document| {
            let char_proc_id =
                document.add_object(Stream::new(dictionary! {}, b"10 0 0 0 10 10 d1".to_vec()));
            // 字形名要当字典的键用，`dictionary!` 宏的键只能直接写字面量，
            // 所以这里手动拼一个 CharProcs。
            let mut char_procs = dictionary! {};
            char_procs.set(glyph_name.clone(), char_proc_id);
            let mut font = dictionary! {
                "Type" => "Font",
                "Subtype" => "Type3",
                "FontBBox" => vec![0.into(), 0.into(), 1000.into(), 1000.into()],
                "FontMatrix" => vec![
                    0.001.into(), 0.into(), 0.into(), 0.001.into(), 0.into(), 0.into(),
                ],
                "CharProcs" => char_procs,
                "Encoding" => dictionary! {
                    "Type" => "Encoding",
                    "Differences" => vec![0.into(), Object::Name(glyph_name)],
                },
                "FirstChar" => 0,
                "LastChar" => 0,
                "Widths" => vec![1000.into()],
            };
            if with_to_unicode {
                let cmap_id =
                    document.add_object(Stream::new(dictionary! {}, TO_UNICODE_CMAP.to_vec()));
                font.set("ToUnicode", cmap_id);
            }
            font
        })
    }

    #[test]
    fn a_cid_font_without_a_text_map_is_reported_as_unreliable() {
        let dir = TempDir::new("risk");
        let risky = dir.join("中文打印件.pdf");
        save(build_pdf_with_cid_font(false), &risky);
        // 文字本身是正常的中文，所以只能由字体那一层报出来。
        let reason = text_layer_risk(&risky, "中文").expect("must warn");
        assert!(reason.contains("乱码") || reason.contains("对照表"), "reason: {reason}");

        let fine = dir.join("带映射.pdf");
        save(build_pdf_with_cid_font(true), &fine);
        assert_eq!(text_layer_risk(&fine, "中文"), None);

        // 简单字体的 PDF（拉丁文那种）不告警：真机上抽取是好的。
        let simple = dir.join("latin.pdf");
        write_text_pdf(&simple, &["Employee list July 2026"]);
        assert_eq!(text_layer_risk(&simple, "Employee list July 2026"), None);
    }

    /// issue #94 的正题：Chrome / Skia 的 Type3 字体（字形名是合成的 /g0）以前完全
    /// 判不出来，`cante-pdf text` 因此吐出乱码还给退出码 0。现在必须告警。
    #[test]
    fn a_type3_font_with_synthetic_glyph_names_is_reported_as_unreliable() {
        let dir = TempDir::new("type3");
        let risky = dir.join("chrome导出.pdf");
        save(build_pdf_with_type3_font(b"g0", true), &risky);
        let reason = text_layer_risk(&risky, "AB").expect("must warn");
        assert!(reason.contains("乱码") || reason.contains("对照表"), "reason: {reason}");
    }

    /// 反面一：Type3 字体如果老老实实用标准字形名（/A、/B），lopdf 能对上号，就不能
    /// 告警。这一条防的是"一见 Type3 就报警"那种误报。
    #[test]
    fn a_type3_font_with_real_glyph_names_is_not_reported() {
        let dir = TempDir::new("type3-ok");
        let path = dir.join("正常Type3.pdf");
        save(build_pdf_with_type3_font(b"A", true), &path);
        assert_eq!(text_layer_risk(&path, "AB"), None);
    }

    /// 反面二（真机上踩到的）：TeX 出的 Type3 字体同样带解析不了的 Differences，
    /// 但没有 /ToUnicode，退回的单字节表跟原意几乎一样，抽出来读得懂。这种不能告警
    /// ——LLVM/Polly 的论文、医院给的说明 PDF 都是这样，误报会吓到用户。
    #[test]
    fn a_type3_font_without_a_character_map_is_not_reported() {
        let dir = TempDir::new("type3-tex");
        let path = dir.join("tex出的Type3.pdf");
        save(build_pdf_with_type3_font(b"a33", false), &path);
        assert_eq!(text_layer_risk(&path, "AB"), None);
    }

    /// 防误报的关键一条：正常能抽的 PDF（中文 CID + 拉丁文各一）都不能告警。
    #[test]
    fn normal_pdfs_are_not_reported() {
        let dir = TempDir::new("no-false-positive");

        let chinese = dir.join("正常中文.pdf");
        save(build_pdf_with_cid_font(true), &chinese);
        let chinese_text = extract_text(&chinese, None).expect("extract chinese");
        assert!(chinese_text.contains("中文"), "should read the two words: {chinese_text:?}");
        assert_eq!(text_layer_risk(&chinese, &chinese_text), None);

        let latin = dir.join("正常拉丁.pdf");
        write_text_pdf(&latin, &["Employee list July 2026", "Total 1234.56"]);
        let latin_text = extract_text(&latin, None).expect("extract latin");
        assert!(latin_text.contains("Employee list July 2026"), "latin text: {latin_text:?}");
        assert_eq!(text_layer_risk(&latin, &latin_text), None);
    }

    /// 兜底那一层：字体没问题，但抽出来的内容大半是认不出的码位（U+FFFD、控制字符、
    /// 私用区），也要拦住。
    #[test]
    fn text_below_the_readable_floor_is_reported() {
        let dir = TempDir::new("quality");
        let path = dir.join("字体正常.pdf");
        write_text_pdf(&path, &["Normal document"]);

        // 4 个正常字 + 6 个坏码位 = 0.40 < 0.50 → 告警。
        let below = format!("正常文字{}", "\u{FFFD}".repeat(6));
        let reason = text_layer_risk(&path, &below).expect("0.40 is below the floor");
        assert!(reason.contains("认不出") || reason.contains("对不上"), "reason: {reason}");
    }

    /// 阈值边界：刚好 0.50 不告警（判据是"低于"），刚刚好掉到 0.50 以下才告警。
    /// 控制字符和私用区也要算"认不出"。
    #[test]
    fn text_at_the_readable_floor_is_not_reported() {
        let dir = TempDir::new("quality-boundary");
        let path = dir.join("字体正常.pdf");
        write_text_pdf(&path, &["Normal document"]);

        // 4 个正常字 + 4 个坏码位 = 0.50 → 不告警。
        let at_floor = format!("正常文字{}", "\u{FFFD}".repeat(4));
        assert_eq!(text_layer_risk(&path, &at_floor), None);

        // 私用区码位也算认不出：4 正常 + 5 私用 = 0.44 → 告警。
        let private_use = format!("正常文字{}", "\u{E000}".repeat(5));
        assert!(text_layer_risk(&path, &private_use).is_some());
    }

    #[test]
    fn text_extracts_the_written_words() {
        let dir = TempDir::new("text");
        let path = dir.join("文字.pdf");
        write_text_pdf(&path, &["Alice report", "Bob summary"]);

        let all = extract_text(&path, None).expect("extract all");
        assert!(all.contains("Alice report"), "missing first page: {all}");
        assert!(all.contains("Bob summary"), "missing second page: {all}");

        let selection = PageSelection::parse("2").expect("parse");
        let second = extract_text(&path, Some(&selection)).expect("extract page 2");
        assert!(second.contains("Bob summary"), "missing Bob: {second}");
        assert!(!second.contains("Alice report"), "leaked page 1: {second}");
    }

    #[test]
    fn a_scanned_pdf_says_there_is_no_text_layer() {
        let dir = TempDir::new("scan");
        let path = dir.join("扫描件.pdf");
        write_scanned_pdf(&path, 2);

        // 有页数，这不是坏文件。
        assert_eq!(page_count(&path).expect("count"), 2);

        match extract_text(&path, None) {
            Err(PdfError::NoText(reported)) => assert_eq!(reported, path.display().to_string()),
            other => panic!("expected NoText, got {other:?}"),
        }
        let message = extract_text(&path, None).unwrap_err().to_string();
        assert!(message.contains("没有文字层"), "message should say so: {message}");
        assert!(!message.contains("读不开"), "not a broken file: {message}");
    }

    #[test]
    fn merge_keeps_the_given_order() {
        let dir = TempDir::new("merge");
        let first = dir.join("第一份.pdf");
        let second = dir.join("第二份.pdf");
        let output = dir.join("合并.pdf");
        write_text_pdf(&first, &["First document"]);
        write_text_pdf(&second, &["Second document"]);

        merge(&output, &[&first, &second]).expect("merge");
        assert_eq!(page_count(&output).expect("count"), 2);

        let text = extract_text(&output, None).expect("extract");
        let first_at = text.find("First document").expect("first page text");
        let second_at = text.find("Second document").expect("second page text");
        assert!(first_at < second_at, "order was not preserved: {text}");

        // 反过来合，顺序也跟着反过来。
        let reversed = dir.join("反过来.pdf");
        merge(&reversed, &[&second, &first]).expect("merge reversed");
        let text = extract_text(&reversed, None).expect("extract reversed");
        assert!(text.find("Second document").unwrap() < text.find("First document").unwrap());
    }

    #[test]
    fn merge_keeps_all_pages_of_each_file() {
        let dir = TempDir::new("merge-many");
        let first = dir.join("甲.pdf");
        let second = dir.join("乙.pdf");
        let output = dir.join("合.pdf");
        write_text_pdf(&first, &["a1", "a2"]);
        write_text_pdf(&second, &["b1", "b2", "b3"]);

        merge(&output, &[&first, &second]).expect("merge");
        assert_eq!(page_count(&output).expect("count"), 5);
    }

    #[test]
    fn split_keeps_the_requested_range() {
        let dir = TempDir::new("split");
        let input = dir.join("原文件.pdf");
        let output = dir.join("后半.pdf");
        write_text_pdf(&input, &["page one", "page two", "page three"]);

        let selection = PageSelection::parse("2-3").expect("parse");
        split(&input, &selection, &output).expect("split");

        assert_eq!(page_count(&output).expect("count"), 2);
        let text = extract_text(&output, None).expect("extract");
        assert!(text.contains("page two"), "missing page two: {text}");
        assert!(text.contains("page three"), "missing page three: {text}");
        assert!(!text.contains("page one"), "kept page one: {text}");
    }

    #[test]
    fn split_a_single_page() {
        let dir = TempDir::new("split-one");
        let input = dir.join("原文件.pdf");
        let output = dir.join("第二页.pdf");
        write_text_pdf(&input, &["alpha", "beta"]);

        let selection = PageSelection::parse("2").expect("parse");
        split(&input, &selection, &output).expect("split");
        assert_eq!(page_count(&output).expect("count"), 1);
        assert!(extract_text(&output, None).expect("extract").contains("beta"));
    }

    #[test]
    fn out_of_range_pages_are_refused_in_chinese() {
        let dir = TempDir::new("range");
        let path = dir.join("两页.pdf");
        let output = dir.join("要的.pdf");
        write_text_pdf(&path, &["one", "two"]);

        let selection = PageSelection::parse("1-5").expect("parse");
        match split(&path, &selection, &output) {
            Err(PdfError::PageRange(message)) => {
                assert!(message.contains("超出范围"), "message: {message}");
                assert!(message.contains("2 页"), "message should name the real count: {message}");
            }
            other => panic!("expected PageRange, got {other:?}"),
        }
        assert!(extract_text(&path, Some(&selection)).is_err());

        // 语法本身就不对的写法也要报出来。
        assert!(PageSelection::parse("").is_err());
        assert!(PageSelection::parse("5-1").is_err());
        assert!(PageSelection::parse("0").is_err());
        assert!(PageSelection::parse("abc").is_err());
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = TempDir::new("missing");
        let path = dir.join("没有这个文件.pdf");
        match page_count(&path) {
            Err(PdfError::NotFound(reported)) => {
                assert_eq!(reported, path.display().to_string());
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(page_count(&path).unwrap_err().to_string().contains("文件不存在"));
    }

    #[test]
    fn a_non_pdf_is_unsupported() {
        let dir = TempDir::new("unsupported");
        let path = dir.join("说明.docx");
        fs::write(&path, b"this is not a pdf at all").expect("write");
        match page_count(&path) {
            Err(PdfError::Unsupported(reported)) => {
                assert_eq!(reported, path.display().to_string());
            }
            other => panic!("expected Unsupported, got {other:?}"),
        }
        assert!(page_count(&path).unwrap_err().to_string().contains("读不了"));
    }

    #[test]
    fn a_broken_pdf_is_reported_as_broken() {
        let dir = TempDir::new("broken");
        let path = dir.join("坏文件.pdf");
        fs::write(&path, b"this is definitely not a PDF body").expect("write");
        assert!(matches!(page_count(&path), Err(PdfError::Broken(_))));
        assert!(page_count(&path).unwrap_err().to_string().contains("坏了"));
    }

    #[test]
    fn a_failed_save_never_leaks_english() {
        // 和 cante-sheets 的 GBK 那条同一类：库/系统兜出来的英文不得端给她。
        // 这里让保存落在“一个文件下面”的路径上，逼出 save 失败。
        let dir = TempDir::new("save-fail");
        let input = dir.join("原件.pdf");
        write_text_pdf(&input, &["hello"]);
        let blocker = dir.join("挡住.pdf");
        fs::write(&blocker, b"not a directory").expect("write blocker");
        let output = blocker.join("子目录").join("结果.pdf");

        let error = merge(&output, &[&input, &input]).expect_err("写不进去必须报错");
        let message = error.to_string();
        let leaked: String = message
            .replace(&output.display().to_string(), "")
            .chars()
            .filter(|character| character.is_ascii_alphabetic())
            .collect();
        assert!(leaked.is_empty(), "错误消息里漏了英文：{message}");
        assert!(message.contains("写不进去"), "要是中文说明：{message}");
    }

    #[test]
    fn page_selection_parses_lists_and_single_pages() {
        let selection = PageSelection::parse("1,3-4").expect("parse");
        assert_eq!(selection.pages(5).expect("pages"), vec![1, 3, 4]);

        let single = PageSelection::parse("3").expect("parse");
        assert_eq!(single.pages(5).expect("pages"), vec![3]);

        let all = PageSelection::all();
        assert!(all.is_all());
        assert_eq!(all.pages(3).expect("pages"), vec![1, 2, 3]);
    }
}
