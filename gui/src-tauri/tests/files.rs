//! File-safety tests: the snapshot/diff/backup/undo core that simple mode's
//! "结果永不覆盖原文件" and "一键撤销" promises rest on.
//!
//! These exercise the plain functions (`files::scan_roots`, `diff_snapshots`,
//! `backup_files`, `undo_files`, the run log), not the `#[tauri::command]`
//! wrappers, so they run headless on every platform — including the Windows CI
//! box — with nothing but `std::fs` and a temp directory.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use cante_gui_lib::files::{
    backup_files, diff_snapshots, is_ignored_dir, read_runs, roots_of, scan_roots, undo_files,
    upsert_run, BeforeState, FileMeta,
};
use serde_json::json;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|delta| delta.as_nanos())
            .unwrap_or(0);
        let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("cante-files-{label}-{stamp}-{serial}"));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, contents).expect("write file");
}

fn paths_of(entries: &[FileMeta]) -> Vec<String> {
    entries.iter().map(|entry| entry.path.clone()).collect()
}

fn meta_of<'a>(entries: &'a [FileMeta], suffix: &str) -> &'a FileMeta {
    entries
        .iter()
        .find(|entry| entry.path.ends_with(suffix))
        .unwrap_or_else(|| panic!("no entry ending in {suffix}: {:?}", paths_of(entries)))
}

#[test]
fn ignored_directories_cover_vcs_build_and_temp_names() {
    for name in [".git", "node_modules", "target", "tmp", "__pycache__", "System Volume Information"] {
        assert!(is_ignored_dir(name), "{name} should be ignored");
    }
    for name in ["Documents", "results", "2024 报表", "keep.txt"] {
        assert!(!is_ignored_dir(name), "{name} should be watched");
    }
}

#[test]
fn roots_widen_a_file_to_its_folder_and_deduplicate() {
    let temp = TempDir::new("roots");
    let folder = temp.path().join("work");
    let file = folder.join("a.txt");
    write(&file, "a");
    write(&folder.join("b.txt"), "b");

    let roots = roots_of(&[file.clone(), folder.clone(), folder.join("b.txt")]);
    assert_eq!(roots, vec![folder.clone()]);

    // A path with no parent (a bare name) contributes nothing.
    assert!(roots_of(&[PathBuf::from("bare.txt")]).is_empty());
}

#[test]
fn scan_is_recursive_sorted_and_skips_ignored_folders() {
    let temp = TempDir::new("scan");
    let folder = temp.path().join("work");
    write(&folder.join("z.txt"), "z");
    write(&folder.join("a.txt"), "a\nb\nc\n");
    write(&folder.join("nested/deep.txt"), "deep");
    write(&folder.join("node_modules/pkg/index.js"), "module.exports = 1;");
    write(&folder.join(".git/HEAD"), "ref: refs/heads/main");

    let (entries, truncated) = scan_roots(std::slice::from_ref(&folder), 1_000);
    assert!(!truncated);
    let names: Vec<String> = entries
        .iter()
        .map(|entry| {
            entry
                .path
                .strip_prefix(&folder.to_string_lossy().into_owned())
                .unwrap_or(&entry.path)
                .trim_start_matches(['/', '\\'])
                .to_string()
        })
        .collect();
    assert_eq!(names, vec!["a.txt", "nested/deep.txt", "z.txt"]);

    // Sorted by absolute path, and line counts only for text files.
    let mut sorted = entries.clone();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    assert_eq!(paths_of(&entries), paths_of(&sorted));
    assert_eq!(meta_of(&entries, "a.txt").lines, Some(3));
    assert_eq!(meta_of(&entries, "z.txt").lines, Some(1));
}

#[test]
fn scan_truncates_at_the_cap_instead_of_hanging() {
    let temp = TempDir::new("cap");
    let folder = temp.path().join("many");
    for index in 0..25 {
        write(&folder.join(format!("{index:03}.txt")), "x");
    }
    let (entries, truncated) = scan_roots(std::slice::from_ref(&folder), 10);
    assert!(truncated);
    assert!(entries.len() <= 11, "cap should hold, got {}", entries.len());
}

#[test]
fn diff_reports_created_modified_and_deleted() {
    let temp = TempDir::new("diff");
    let folder = temp.path().join("work");
    let keep = folder.join("keep.txt");
    let edit = folder.join("edit.txt");
    let gone = folder.join("gone.txt");
    write(&keep, "same");
    write(&edit, "before");
    write(&gone, "bye");

    let (before, _) = scan_roots(std::slice::from_ref(&folder), 1_000);
    write(&folder.join("new.txt"), "hello");
    // Change the length *and* the line count, not just the bytes: a machine
    // whose clock ticks coarsely (CI runners) can stamp two writes with the
    // same mtime, and a same-length edit would then look untouched. The
    // comparison itself checks size, mtime and lines, so this exercises it
    // without depending on timer resolution.
    write(&edit, "after!\nsecond line\n");
    fs::remove_file(&gone).unwrap();
    let (after, _) = scan_roots(std::slice::from_ref(&folder), 1_000);

    let diff = diff_snapshots(&before, &after);
    assert_eq!(diff.created.len(), 1);
    assert!(diff.created[0].ends_with("new.txt"));
    assert_eq!(diff.modified.len(), 1);
    assert!(diff.modified[0].ends_with("edit.txt"));
    assert_eq!(diff.deleted.len(), 1);
    assert!(diff.deleted[0].ends_with("gone.txt"));
}

#[test]
fn backup_then_undo_restores_the_originals_and_hides_the_new_file() {
    let temp = TempDir::new("undo");
    let folder = temp.path().join("work");
    let keep = folder.join("keep.txt");
    let edit = folder.join("edit.txt");
    let gone = folder.join("gone.txt");
    write(&keep, "unchanged");
    write(&edit, "original contents");
    write(&gone, "do not lose me");

    let (before, _) = scan_roots(std::slice::from_ref(&folder), 1_000);
    let run_dir = temp.path().join("private/run-1");
    let backup_dir = run_dir.join("before");
    let (backup, unbacked) = backup_files(&backup_dir, &before);
    assert!(unbacked.is_empty());
    assert_eq!(backup.len(), before.len());
    let state = BeforeState {
        roots: vec![folder.to_string_lossy().into_owned()],
        entries: before.clone(),
        backup,
        unbacked,
    };

    // "Run" the job: change one file, delete another, create a result.
    write(&edit, "changed by the job, much longer than before");
    fs::remove_file(&gone).unwrap();
    let result = folder.join("结果.txt");
    write(&result, "brand new");
    let (after, _) = scan_roots(std::slice::from_ref(&folder), 1_000);
    let diff = diff_snapshots(&before, &after);
    assert_eq!(diff.created.len(), 1);
    assert_eq!(diff.modified.len(), 1); // edit.txt
    assert_eq!(diff.deleted.len(), 1); // gone.txt

    let (restored, failed) = undo_files(&state, &run_dir, &diff.created, &diff.modified, &diff.deleted);
    assert!(failed.is_empty(), "nothing should fail: {failed:?}");

    // The original contents are back, the result is out of the user's folder.
    assert_eq!(fs::read_to_string(&edit).unwrap(), "original contents");
    assert_eq!(fs::read_to_string(&gone).unwrap(), "do not lose me");
    assert_eq!(fs::read_to_string(&keep).unwrap(), "unchanged");
    assert!(!result.exists(), "created file must leave the folder");
    assert!(restored.iter().any(|path| path.ends_with("结果.txt")));
    let removed: Vec<_> = fs::read_dir(run_dir.join("removed"))
        .expect("removed dir")
        .flatten()
        .collect();
    assert_eq!(removed.len(), 1, "the undo keeps the file it took out");
}

#[test]
fn undo_restores_a_deleted_file_without_a_backup_only_as_a_reported_failure() {
    let temp = TempDir::new("undo-fail");
    let folder = temp.path().join("work");
    let file = folder.join("lost.txt");
    write(&file, "gone");
    let (before, _) = scan_roots(std::slice::from_ref(&folder), 1_000);

    // No backup map at all: the file cannot be brought back by us.
    let state = BeforeState {
        roots: vec![folder.to_string_lossy().into_owned()],
        entries: before.clone(),
        backup: BTreeMap::new(),
        unbacked: paths_of(&before),
    };
    let run_dir = temp.path().join("private/run-2");
    fs::remove_file(&file).unwrap();
    let (restored, failed) = undo_files(
        &state,
        &run_dir,
        &[],
        &[],
        &paths_of(&before),
    );
    assert!(restored.is_empty());
    assert_eq!(failed.len(), 1);
    assert!(failed[0].contains("lost.txt"));
    assert!(
        failed[0].contains(&folder.to_string_lossy().into_owned()),
        "the failure must say which folder to look in: {}",
        failed[0]
    );
}

#[test]
fn missing_created_file_is_a_reported_failure_not_a_panic() {
    let temp = TempDir::new("undo-missing");
    let run_dir = temp.path().join("private/run-3");
    let state = BeforeState::default();
    let (restored, failed) = undo_files(
        &state,
        &run_dir,
        &["/definitely/not/here.txt".to_string()],
        &[],
        &[],
    );
    assert!(restored.is_empty());
    assert_eq!(failed.len(), 1);
    assert!(failed[0].contains("已经不在这里了"));
}

#[test]
fn run_log_keeps_newest_first_and_replaces_by_id() {
    let temp = TempDir::new("log");
    let root = temp.path();
    upsert_run(root, json!({ "id": "a", "taskTitle": "第一件" })).unwrap();
    upsert_run(root, json!({ "id": "b", "taskTitle": "第二件" })).unwrap();
    upsert_run(root, json!({ "id": "a", "taskTitle": "改过的一" })).unwrap();

    let runs = read_runs(root);
    assert_eq!(runs.len(), 2);
    // Re-saving a record moves it to the top: it is the most recently touched.
    assert_eq!(runs[0]["id"], "a");
    assert_eq!(runs[1]["id"], "b");
    assert_eq!(runs[0]["taskTitle"], "改过的一");
}

#[test]
fn run_log_is_empty_and_survives_a_corrupt_file() {
    let temp = TempDir::new("log-corrupt");
    let root = temp.path();
    assert!(read_runs(root).is_empty());
    fs::write(root.join("runs.json"), "{ not json").unwrap();
    assert!(read_runs(root).is_empty());
}

#[test]
fn upsert_refuses_a_record_without_an_id() {
    let temp = TempDir::new("log-noid");
    let error = upsert_run(temp.path(), json!({ "taskTitle": "没有编号" })).unwrap_err();
    assert!(error.contains("编号"));
}

#[test]
fn paths_are_reported_with_forward_slashes() {
    // Windows is the majority platform, and its APIs accept both separators, so
    // every path the product shows or stores is spelled with `/`.
    let temp = TempDir::new("slashes");
    let folder = temp.path().join("work");
    write(&folder.join("nested/deep.txt"), "x");
    let (entries, _) = scan_roots(std::slice::from_ref(&folder), 100);
    let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    assert!(
        paths.iter().all(|path| !path.contains('\\')),
        "every path uses `/`: {paths:?}"
    );
    assert!(paths.iter().any(|path| path.ends_with("nested/deep.txt")), "{paths:?}");
}
