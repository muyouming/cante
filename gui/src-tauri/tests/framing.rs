//! JSONL framing: stdout chunks split at arbitrary byte boundaries.
use cante_gui_lib::protocol::LineSplitter;

#[test]
fn reassembles_lines_across_arbitrary_chunks() {
    let mut splitter = LineSplitter::default();
    let mut lines = Vec::new();
    lines.extend(splitter.push(b"{\"a\""));
    lines.extend(splitter.push(b":1}\n{\"b\":"));
    lines.extend(splitter.push(b"2}\n\n   \n"));
    assert_eq!(lines, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
}

#[test]
fn splits_a_multibyte_character_across_chunks() {
    // "café" as UTF-8: the final `é` is two bytes, split between pushes.
    let line = "{\"m\":\"café\"}\n".as_bytes();
    let split = line.iter().position(|&b| b == 0xC3).expect("utf-8 lead byte") + 1;
    let mut splitter = LineSplitter::default();
    let mut out = splitter.push(&line[..split]);
    out.extend(splitter.push(&line[split..]));
    assert_eq!(out, vec!["{\"m\":\"café\"}".to_string()]);
}

#[test]
fn flushes_a_trailing_line_without_newline() {
    let mut splitter = LineSplitter::default();
    assert!(splitter.push(b"tail").is_empty());
    assert_eq!(splitter.finish(), Some("tail".to_string()));
    assert_eq!(splitter.finish(), None);
}

#[test]
fn trims_whitespace_and_drops_blank_lines() {
    let mut splitter = LineSplitter::default();
    let lines = splitter.push(b"  \n {\"x\": 1} \n\t\n");
    assert_eq!(lines, vec!["{\"x\": 1}".to_string()]);
}
