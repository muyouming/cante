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
    backup_files, cleanup_orphan_runs, diff_snapshots, fact_for, facts_of, is_ignored_dir, read_runs,
    roots_of, scan_roots, undo_files, upsert_run, write_runs, BeforeState, FileMeta,
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
    // Compare suffixes, not prefixes: on Windows `read_dir` reports the 8.3
    // short name (`RUNNER~1`) while the temp directory we asked about is spelled
    // with its long name, so stripping the prefix by string would compare two
    // spellings of the same folder. What the product promises is the tail — the
    // relative spelling with `/` separators.
    let names: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
    for expected in ["a.txt", "nested/deep.txt", "z.txt"] {
        assert!(
            names.iter().any(|path| path.ends_with(expected)),
            "missing {expected} in {names:?}"
        );
    }
    assert_eq!(names.len(), 3, "only the three real files: {names:?}");

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
    // The message must point at the folder, but asserting the *whole* temp path
    // would compare spellings again (short vs long name on Windows). The folder
    // name is what the user reads.
    let folder_name = folder.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        failed[0].contains(&folder_name),
        "the failure must say which folder to look in ({folder_name}): {}",
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

// ---------------------------------------------------------------------------
// Backup growth (gui/docs/BACKUP-GROWTH.md): orphan-only cleanup
//
// The run log keeps only the newest 200 records, but the backup directories
// used to stay forever — so every run past the 200th left a directory nobody
// referenced and nothing ever deleted. These tests pin the bound and, more
// importantly, the boundary: a directory any *record* still points at, and the
// run currently being backed up, must never be touched.
// ---------------------------------------------------------------------------

/// Make `runs/<name>/before/` with one file in it, so we can prove the whole
/// directory (and not just an empty shell) survives or goes.
fn make_run_dir(root: &Path, name: &str) -> PathBuf {
    let dir = root.join("runs").join(name).join("before");
    write(&dir.join("000000"), "backup bytes");
    dir
}

#[test]
fn truncation_drops_the_record_but_leaves_its_backup_directory_behind() {
    // A（1）的真跑证据：记录与目录的寿命是**解耦**的，这就是 P1 的根。
    //
    // 用真正落盘的两个原语（read_runs / write_runs）走一遍 upsert_run 内部的
    // 「truncate(MAX_RUNS)」：超出上限的那条记录从 runs.json 里消失了，可它指的那
    // 个 runs/<编号>/ 目录还好好地在磁盘上——没人再引用、也没有任何东西会去删它。
    // 修法就是把这个孤儿目录清掉（见下一条 cleanup 的测试）。
    let cap = 200usize;
    let temp = TempDir::new("truncate-orphan");
    let root = temp.path();

    // 上限内每一条都有记录、都有目录；第 201 条只有目录（代表它存的时候刚好越限）。
    for index in 0..=cap {
        make_run_dir(root, &format!("run-{index:03}"));
    }
    // 和 upsert_run 落盘的顺序一致：最新在前，所以 run-000 在最旧的那一头。
    let mut runs: Vec<serde_json::Value> = (0..=cap)
        .rev()
        .map(|index| json!({ "id": format!("run-{index:03}"), "taskTitle": "做过的事" }))
        .collect();
    // 与 upsert_run 完全一致的那一行：只丢记录（最旧的从尾部掉出去）。
    runs.truncate(cap);
    write_runs(root, &runs).unwrap();

    // 被挤掉的 run-000：记录没了……
    assert!(
        read_runs(root).iter().all(|run| run["id"] != "run-000"),
        "run-000 的记录应该已经掉出上限"
    );
    // ……但它留下的备份目录还在。这就是「只丢记录、不删目录」的积累路径。
    assert!(
        root.join("runs/run-000/before/000000").exists(),
        "这正是 P1：记录被丢了，备份目录却留了下来"
    );
}

#[test]
fn cleanup_removes_only_directories_no_run_record_points_to() {
    let temp = TempDir::new("cleanup-orphan");
    let root = temp.path();
    upsert_run(root, json!({ "id": "kept", "taskTitle": "还有记录" })).unwrap();
    make_run_dir(root, "kept");
    make_run_dir(root, "orphan");

    let removed = cleanup_orphan_runs(root, &[]);
    assert_eq!(removed, vec!["orphan".to_string()]);
    assert!(root.join("runs/kept/before/000000").exists(), "有记录的那次必须原样留着");
    assert!(!root.join("runs/orphan").exists(), "没人引用的目录要被清掉");
}

#[test]
fn cleanup_never_touches_a_directory_a_record_still_points_to() {
    // 最要紧的一条回归：只要记录还在，备份就一个都不能动——否则她点「撤销」时
    // 备份已经被我们删了，那正是产品律 2 不允许发生的事。
    let temp = TempDir::new("cleanup-kept");
    let root = temp.path();
    for id in ["a", "b"] {
        upsert_run(root, json!({ "id": id, "taskTitle": "做过的事" })).unwrap();
        make_run_dir(root, id);
    }

    let removed = cleanup_orphan_runs(root, &[]);
    assert!(removed.is_empty(), "没有孤儿时不该删任何东西：{removed:?}");
    for id in ["a", "b"] {
        assert!(root.join("runs").join(id).join("before/000000").exists(), "{id} 的备份被动了");
    }
}

#[test]
fn cleanup_keeps_the_run_whose_backup_is_still_being_written() {
    // 记录是在备份之后才落盘的（begin_run 建目录 → 跑完 save_run 写记录）。
    // keep 就是那一段窗口里的编号：目录已建、记录还没有，绝不能当成孤儿删掉。
    let temp = TempDir::new("cleanup-inflight");
    let root = temp.path();
    make_run_dir(root, "running");

    let removed = cleanup_orphan_runs(root, &["running".to_string()]);
    assert!(removed.is_empty(), "正在做备份的那次被删了：{removed:?}");
    assert!(root.join("runs/running/before/000000").exists());
}

#[test]
fn cleanup_deletes_only_our_backup_directories_and_never_an_original() {
    // 清理只碰 file-safety/runs/ 底下的目录；她的原始文件在别的目录里，够不着。
    let temp = TempDir::new("cleanup-original");
    let root = temp.path();
    let original = root.join("她的文件/年度报表.xlsx");
    write(&original, "原始内容");
    make_run_dir(root, "orphan");

    let removed = cleanup_orphan_runs(root, &[]);
    assert_eq!(removed, vec!["orphan".to_string()]);
    assert!(original.exists(), "原始文件被删了");
    assert_eq!(fs::read_to_string(&original).unwrap(), "原始内容", "原始文件被改了");
    // 连 runs.json 自己也不能动。
    assert!(!root.join("runs/orphan").exists());
}

#[test]
fn cleanup_is_a_noop_without_a_runs_directory() {
    let temp = TempDir::new("cleanup-none");
    assert!(cleanup_orphan_runs(temp.path(), &[]).is_empty());
    assert!(!temp.path().join("runs").exists(), "不该为了清理凭空建目录");
}

#[test]
fn upsert_run_cleans_the_directory_of_a_record_that_fell_off_the_cap() {
    // 端到端（A 第 1 条的真跑证据）：先做满 200 条记录 + 200 个备份目录，再存第
    // 201 条。最旧那条记录被 MAX_RUNS 挤掉，它对应的目录必须在同一次调用里被扫掉——
    // 这正是 P1 说的「只丢记录、不删目录」。
    //
    // 200 是 files.rs 的 MAX_RUNS（私有常量，这里按它的值写死并说明）。
    let cap = 200usize;
    let temp = TempDir::new("cleanup-on-save");
    let root = temp.path();
    for index in 0..cap {
        let id = format!("run-{index:03}");
        make_run_dir(root, &id);
        upsert_run(root, json!({ "id": id, "taskTitle": "做过的事" })).unwrap();
    }
    // 此刻：200 条记录、200 个目录，都在。
    assert_eq!(read_runs(root).len(), cap);
    assert!(root.join("runs/run-000/before/000000").exists());

    make_run_dir(root, "run-new");
    upsert_run(root, json!({ "id": "run-new", "taskTitle": "刚做完的" })).unwrap();

    // 第 201 条进来：最旧的 run-000 记录被挤掉，它的目录也一起清掉，不再占地方。
    assert_eq!(read_runs(root).len(), cap);
    assert_eq!(read_runs(root)[0]["id"], "run-new");
    assert!(!root.join("runs/run-000").exists(), "掉出上限的旧备份目录要被清掉");
    assert!(root.join("runs/run-001/before/000000").exists(), "没掉出上限的备份不许动");
    assert!(root.join("runs/run-new/before/000000").exists(), "这次自己的备份要留着");
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

// ---------------------------------------------------------------------------
// Result verification (#trust): facts, not errors
//
// The result card says "I checked" only if this layer can answer 在不在 / 多大 /
// 能不能打开 honestly. So the core promise is: nothing here errors and nothing
// here panics — a missing path, a folder, and a file we may not read each come
// back as a *fact*.
// ---------------------------------------------------------------------------

fn fact_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[test]
fn a_real_file_reports_its_size_and_readability() {
    let temp = TempDir::new("facts");
    let file = temp.path().join("结果.txt");
    write(&file, "hello");

    let facts = facts_of(std::slice::from_ref(&file));
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0].path, fact_path(&file));
    assert!(facts[0].exists);
    assert_eq!(facts[0].size, Some(5));
    assert!(facts[0].readable);
    assert!(facts[0].modified_ms.is_some(), "mtime should be known for a fresh file");
}

#[test]
fn a_missing_path_is_a_fact_not_an_error() {
    let temp = TempDir::new("facts-missing");
    let gone = temp.path().join("这一点也没有.txt");
    let fact = fact_for(&gone);
    assert!(!fact.exists);
    assert_eq!(fact.size, None);
    assert_eq!(fact.modified_ms, None);
    assert!(!fact.readable);
    assert_eq!(fact.path, fact_path(&gone));
}

#[test]
fn a_folder_exists_but_is_not_an_openable_result_file() {
    let temp = TempDir::new("facts-dir");
    let folder = temp.path().join("result-folder");
    fs::create_dir_all(&folder).unwrap();

    let fact = fact_for(&folder);
    assert!(fact.exists, "a folder exists");
    assert_eq!(fact.size, None, "a folder has no result-file size");
    assert!(!fact.readable, "a folder is not an openable result file");
}

#[test]
fn an_empty_list_yields_no_facts() {
    assert!(facts_of(&[]).is_empty());
}

#[test]
fn facts_keep_the_order_they_were_asked_in_and_never_drop_a_path() {
    let temp = TempDir::new("facts-order");
    let one = temp.path().join("一.txt");
    let two = temp.path().join("二.txt");
    write(&one, "1");
    let facts = facts_of(&[two.clone(), one.clone()]);
    assert_eq!(facts.len(), 2);
    assert_eq!(facts[0].path, fact_path(&two));
    assert_eq!(facts[1].path, fact_path(&one));
}

#[cfg(unix)]
#[test]
fn an_unreadable_file_is_reported_as_unreadable_not_as_missing() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new("facts-perm");
    let file = temp.path().join("locked.txt");
    write(&file, "secret");
    fs::set_permissions(&file, fs::Permissions::from_mode(0o000)).unwrap();

    // Running as root (some CI containers) ignores the mode entirely. Assert
    // the *honest* answer either way: whatever `File::open` says is the fact.
    let denied = fs::File::open(&file).is_err();
    let fact = fact_for(&file);
    assert!(fact.exists, "the file is still there");
    assert_eq!(fact.readable, !denied, "readable must mirror what open() says");
    assert_eq!(fact.size, Some(6), "size is readable from metadata even when open fails");

    // Restore so the TempDir cleanup can remove it.
    let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
}
