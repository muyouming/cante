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
//! （没有文字层）会明确报错，而不是拿一片空白当成功。
//!
//! 所有错误消息都是中文，读得懂，例如：
//! `文件不存在：/tmp/x.pdf`、`这个格式我读不了：x.docx`、
//! `这个文件像是坏了，读不开：/tmp/x.pdf`、
//! `这个 PDF 里没有文字层（大概是扫描或拍照的），需要先做文字识别：/tmp/scan.pdf`。

use std::fmt;
use std::path::Path;

use lopdf::{dictionary, Document, Object, ObjectId};

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

/// 抽出文字。默认整份；给了页码就只抽那几页。
///
/// 抽出来是空的（扫描件、照片），会返回 [`PdfError::NoText`]，不会拿空白当成功。
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

    let text = document.extract_text(&numbers).map_err(|error| {
        PdfError::Broken(format!("{}（读文字的时候出错：{}）", path.display(), error))
    })?;

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

    document.save(output).map_err(|error| {
        PdfError::Broken(format!("{}（写不进去：{}）", output.display(), error))
    })?;
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

    document.save(output).map_err(|error| {
        PdfError::Broken(format!("{}（写不进去：{}）", output.display(), error))
    })?;
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
