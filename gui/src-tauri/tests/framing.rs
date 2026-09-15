//! JSONL framing: stdout chunks split at arbitrary byte boundaries.
use cante_gui_lib::protocol::{LineSplitter, MAX_LINE_BYTES};

/// Feed a whole buffer one byte at a time, as a pathological pipe would.
fn push_byte_at_a_time(splitter: &mut LineSplitter, bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    for byte in bytes {
        out.extend(splitter.push(std::slice::from_ref(byte)));
    }
    out
}

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
fn byte_at_a_time_feeding_matches_a_single_push() {
    let line = "{\"m\":\"café\"}\n".as_bytes();
    let mut splitter = LineSplitter::default();
    let out = push_byte_at_a_time(&mut splitter, line);
    assert_eq!(out, vec!["{\"m\":\"café\"}".to_string()]);
    assert_eq!(splitter.buffered(), 0, "the buffer is drained after the newline");
    assert_eq!(splitter.finish(), None);
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
fn splits_a_four_byte_utf8_sequence_across_three_chunks() {
    // U+1F600 is F0 9F 98 80: split it between every one of its bytes.
    let line = "{\"e\":\"😀\"}\n".as_bytes();
    let start = line.iter().position(|&b| b == 0xF0).expect("utf-8 lead byte");
    let mut splitter = LineSplitter::default();
    let mut out = splitter.push(&line[..start + 1]);
    out.extend(splitter.push(&line[start + 1..start + 3]));
    out.extend(splitter.push(&line[start + 3..]));
    assert_eq!(out, vec!["{\"e\":\"😀\"}".to_string()]);
}

#[test]
fn crlf_frames_lines_without_a_trailing_carriage_return() {
    let mut splitter = LineSplitter::default();
    let lines = splitter.push(b"{\"a\":1}\r\n{\"b\":2}\r\n");
    assert_eq!(lines, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
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
    let lines = splitter.push(b"  \n {\"x\": 1} \n\t\n\r\n   \n");
    assert_eq!(lines, vec!["{\"x\": 1}".to_string()]);
}

#[test]
fn a_ten_megabyte_line_fed_byte_at_a_time_is_reassembled() {
    // A pathological chunking of a big-but-legal line: feeds 10 MiB one byte
    // at a time. This only finishes in reasonable time if the splitter does
    // not rescan its whole pending buffer on every push.
    const SIZE: usize = 10 * 1024 * 1024;
    let payload = vec![b'x'; SIZE];
    let mut splitter = LineSplitter::default();
    let mut out = push_byte_at_a_time(&mut splitter, &payload);
    assert!(out.is_empty(), "no newline yet");
    assert_eq!(splitter.buffered(), SIZE);
    out.extend(splitter.push(b"\n"));
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].len(), SIZE);
    assert_eq!(splitter.buffered(), 0, "the buffer releases the line once framed");
}

#[test]
fn an_oversized_unterminated_line_is_dropped_and_the_buffer_stays_bounded() {
    let mut splitter = LineSplitter::default();
    let chunk = vec![b'x'; 1024 * 1024];
    let mut produced = Vec::new();
    // Push well past the cap in 1 MiB chunks; the buffer must never exceed it.
    for _ in 0..(MAX_LINE_BYTES / chunk.len() + 4) {
        produced.extend(splitter.push(&chunk));
        assert!(
            splitter.buffered() <= MAX_LINE_BYTES,
            "buffer grew to {} (cap {MAX_LINE_BYTES})",
            splitter.buffered()
        );
    }
    assert!(produced.is_empty(), "the oversized line must be dropped, not emitted");
    // The terminating newline ends the oversized line; the next line frames fine.
    produced.extend(splitter.push(b"\n{\"ok\":true}\n"));
    assert_eq!(produced, vec!["{\"ok\":true}".to_string()]);
    assert_eq!(splitter.buffered(), 0);
}

#[test]
fn finish_does_not_emit_the_dropped_oversized_tail() {
    let mut splitter = LineSplitter::default();
    let chunk = vec![b'y'; 1024 * 1024];
    for _ in 0..(MAX_LINE_BYTES / chunk.len() + 2) {
        splitter.push(&chunk);
    }
    assert_eq!(splitter.buffered(), 0, "the oversized tail was discarded");
    assert_eq!(splitter.finish(), None, "nothing partial is fabricated");
}
