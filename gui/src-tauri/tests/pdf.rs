//! PDF 的集成测试：只用库 API 走一遍"造两份 PDF → 合并 → 数页数 → 抽一段另存
//! → 抽文字"，证明这套能力对 crate 外面是可用的——`cante-pdf` 命令行的壳和 Tauri
//! 命令都依赖同一个公开接口。
//!
//! 放在 `tests/` 而不是 `src/pdf.rs` 里，是照着 `tests/sheets.rs` 的做法：库里的
//! 单测盯细节，这里盯一整条链路真的能走通。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::pdf::{self, PageSelection};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp =
            SystemTime::now().duration_since(UNIX_EPOCH).map(|delta| delta.as_nanos()).unwrap_or(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("cante-pdf-it-{label}-{stamp}-{serial}"));
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

/// 造一份每页各写一行文字的 PDF。
fn write_text_pdf(path: &Path, page_texts: &[&str]) {
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
    for text in page_texts {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id =
            document.add_object(Stream::new(dictionary! {}, content.encode().expect("encode")));
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
    document.save(path).expect("save test pdf");
}

#[test]
fn merge_then_count_then_split_through_the_library_api() {
    let dir = TempDir::new("chain");
    let first = dir.join("材料一.pdf");
    let second = dir.join("材料二.pdf");
    let merged = dir.join("合并.pdf");

    write_text_pdf(&first, &["Alpha first", "Alpha second"]);
    write_text_pdf(&second, &["Beta first"]);

    // 合并：顺序和页数都对。
    pdf::merge(&merged, &[&first, &second]).expect("merge");
    assert_eq!(pdf::page_count(&merged).expect("count"), 3);

    let all = pdf::extract_text(&merged, None).expect("read merged");
    for phrase in ["Alpha first", "Alpha second", "Beta first"] {
        assert!(all.contains(phrase), "merged file lost {phrase}: {all}");
    }
    assert!(all.find("Alpha first").unwrap() < all.find("Beta first").unwrap());

    // 拆出后两页，内容能读回来，也只有这两页。
    let tail = dir.join("后两页.pdf");
    let selection = PageSelection::parse("2-3").expect("parse");
    pdf::split(&merged, &selection, &tail).expect("split");
    assert_eq!(pdf::page_count(&tail).expect("count"), 2);

    let tail_text = pdf::extract_text(&tail, None).expect("read tail");
    assert!(tail_text.contains("Alpha second"), "tail lost page two: {tail_text}");
    assert!(tail_text.contains("Beta first"), "tail lost page three: {tail_text}");
    assert!(!tail_text.contains("Alpha first"), "tail kept page one: {tail_text}");

    // 原文件没被动过。
    assert_eq!(pdf::page_count(&first).expect("first"), 2);
    assert_eq!(pdf::page_count(&second).expect("second"), 1);
}
