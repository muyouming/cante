//! File safety for simple mode: pick, open, snapshot, back up and undo.
//!
//! Simple mode promises a non-technical user two things: *the app never
//! silently overwrites my files*, and *if something goes wrong I can put it
//! back*. Neither promise can depend on the assistant behaving, so this module
//! does not trust it with anything:
//!
//! * **Before** a job runs, the folders it involves are snapshotted (relative
//!   path + size + modification time, plus a line count for text files) and the
//!   files at risk are copied into an app-private backup directory.
//! * **After** the job, the same folders are snapshotted again. The frontend
//!   diffs the two snapshots (see `gui/src/simple/run.ts`) to fill the run
//!   record's `impact` and the list of new files.
//! * **Undo** moves the files the job created into the private backup
//!   directory and copies the backed-up originals back over anything the job
//!   modified or deleted. Files with no usable backup are reported with the
//!   folder the user can look in.
//!
//! Everything that touches the filesystem is a plain function over `Path`s so
//! `cargo test` can exercise it without a Tauri app; the `#[tauri::command]`
//! wrappers at the bottom only resolve the app-private directory and marshal
//! JSON.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt as _;
use tauri_plugin_opener::OpenerExt as _;

/// Bookkeeping lives under `<app config>/file-safety/`.
const STORE_DIR: &str = "file-safety";
/// Newest-first list of runs, so history survives a restart.
const RUNS_FILE: &str = "runs.json";
/// One private directory per run: `before/` holds backups, `removed/` the files
/// an undo took out of the user's folders (kept so the undo itself is undoable).
const RUNS_DIR: &str = "runs";
const BEFORE_FILE: &str = "before.json";

/// Directories that must never be walked: version control, dependency trees,
/// build output and the usual temporary/cache names. A job never legitimately
/// creates a result inside one of these.
const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".tmp",
    "tmp",
    "$RECYCLE.BIN",
    "System Volume Information",
];

/// Extensions whose line count we report (the result card's "1234 行 → 1180 行").
/// Binary office formats are deliberately absent: a line count there is noise.
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "xml", "html", "htm", "yaml",
    "yml", "ini", "toml", "srt", "vtt", "rs", "ts", "tsx", "js", "jsx", "py", "css", "sql",
];

/// Caps. A snapshot that hits one of these sets `truncated` and keeps going;
/// the UI tells the user the list may be incomplete rather than hanging.
const MAX_ENTRIES: usize = 100_000;
const MAX_LINE_SCAN_BYTES: u64 = 4 * 1024 * 1024;
const MAX_BACKUP_FILES: usize = 2_000;
const MAX_BACKUP_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BACKUP_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RUNS: usize = 200;

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

/// One file as it looked when the folder was scanned.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileMeta {
    /// Absolute path, the key the frontend diffs on.
    pub path: String,
    pub size: u64,
    /// Milliseconds since the Unix epoch; `-1` when the platform cannot say.
    pub mtime_ms: i64,
    /// Line count for text files we bothered to read; `None` for binaries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<u64>,
}

/// The three sets a before/after comparison yields.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SnapshotDiff {
    pub created: Vec<String>,
    pub modified: Vec<String>,
    pub deleted: Vec<String>,
}

/// The before-state persisted next to the backups, so undo survives a restart.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct BeforeState {
    pub roots: Vec<String>,
    pub entries: Vec<FileMeta>,
    /// original absolute path -> file name under `before/`
    #[serde(default)]
    pub backup: BTreeMap<String, String>,
    /// Files in scope that were too big / too numerous to copy.
    #[serde(default)]
    pub unbacked: Vec<String>,
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// True for a directory name that must not be walked into.
pub fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIRS.iter().any(|ignored| name.eq_ignore_ascii_case(ignored))
}

/// The directories a run must watch. A selected file widens to its parent
/// folder, because a job may write its result next to the original.
pub fn roots_of(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for path in paths {
        let candidate = if path.is_dir() {
            path.clone()
        } else {
            match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
                _ => continue,
            }
        };
        if candidate.as_os_str().is_empty() {
            continue;
        }
        if !roots.iter().any(|known| known == &candidate) {
            roots.push(candidate);
        }
    }
    roots
}

fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|delta| delta.as_millis() as i64)
        .unwrap_or(-1)
}

fn is_text_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| TEXT_EXTENSIONS.iter().any(|known| known.eq_ignore_ascii_case(ext)))
        .unwrap_or(false)
}

/// Lines in a text file, counting a trailing partial line. `None` when the
/// file is binary, too big to be worth reading, or unreadable.
fn count_lines(path: &Path, size: u64) -> Option<u64> {
    if !is_text_ext(path) || size > MAX_LINE_SCAN_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.is_empty() {
        return Some(0);
    }
    let newlines = bytes.iter().filter(|byte| **byte == b'\n').count() as u64;
    Some(if bytes.last() == Some(&b'\n') { newlines } else { newlines + 1 })
}

/// Metadata for every regular file under `roots`, depth-first, sorted by path.
/// Symlinks are skipped (they can form cycles and are not "the user's files").
pub fn scan_roots(roots: &[PathBuf], cap: usize) -> (Vec<FileMeta>, bool) {
    let mut files: Vec<FileMeta> = Vec::new();
    let mut truncated = false;
    for root in roots {
        let mut stack: Vec<PathBuf> = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let read = match fs::read_dir(&dir) {
                Ok(read) => read,
                Err(_) => continue,
            };
            for entry in read.flatten() {
                if files.len() >= cap {
                    truncated = true;
                    break;
                }
                let path = entry.path();
                let file_type = match entry.file_type() {
                    Ok(kind) => kind,
                    Err(_) => continue,
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    let name = entry.file_name();
                    if let Some(name) = name.to_str() {
                        if !is_ignored_dir(name) {
                            stack.push(path);
                        }
                    }
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                let meta = match entry.metadata() {
                    Ok(meta) => meta,
                    Err(_) => continue,
                };
                files.push(FileMeta {
                    path: display(&path),
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                    lines: count_lines(&path, meta.len()),
                });
            }
            if truncated {
                break;
            }
        }
        if truncated {
            break;
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    (files, truncated)
}

/// Before/after comparison. A file counts as modified when its size, mtime or
/// line count moved; the conservative direction (a mere touch counts) is the
/// one that keeps undo honest.
pub fn diff_snapshots(before: &[FileMeta], after: &[FileMeta]) -> SnapshotDiff {
    let before_map: BTreeMap<&str, &FileMeta> =
        before.iter().map(|entry| (entry.path.as_str(), entry)).collect();
    let after_map: BTreeMap<&str, &FileMeta> =
        after.iter().map(|entry| (entry.path.as_str(), entry)).collect();

    let mut diff = SnapshotDiff::default();
    for (path, meta) in &after_map {
        match before_map.get(path) {
            None => diff.created.push((*path).to_string()),
            Some(old) => {
                if old.size != meta.size || old.mtime_ms != meta.mtime_ms || old.lines != meta.lines {
                    diff.modified.push((*path).to_string());
                }
            }
        }
    }
    for path in before_map.keys() {
        if !after_map.contains_key(path) {
            diff.deleted.push((*path).to_string());
        }
    }
    diff.created.sort();
    diff.modified.sort();
    diff.deleted.sort();
    diff
}

// ---------------------------------------------------------------------------
// Backup + undo
// ---------------------------------------------------------------------------

/// Copy the files in scope into `backup_dir`, honouring the size/count budget.
/// Returns the `original -> backup file name` map and the files it skipped.
pub fn backup_files(
    backup_dir: &Path,
    entries: &[FileMeta],
) -> (BTreeMap<String, String>, Vec<String>) {
    let mut backup: BTreeMap<String, String> = BTreeMap::new();
    let mut unbacked: Vec<String> = Vec::new();
    let mut used_bytes: u64 = 0;
    if fs::create_dir_all(backup_dir).is_err() {
        return (backup, entries.iter().map(|entry| entry.path.clone()).collect());
    }
    let mut index = 0usize;
    for entry in entries {
        if backup.len() >= MAX_BACKUP_FILES
            || entry.size > MAX_BACKUP_FILE_BYTES
            || used_bytes.saturating_add(entry.size) > MAX_BACKUP_BYTES
        {
            unbacked.push(entry.path.clone());
            continue;
        }
        let source = Path::new(&entry.path);
        let name = format!("{index:06}");
        let target = backup_dir.join(&name);
        match fs::copy(source, &target) {
            Ok(_) => {
                used_bytes = used_bytes.saturating_add(entry.size);
                backup.insert(entry.path.clone(), name);
                index += 1;
            }
            Err(_) => unbacked.push(entry.path.clone()),
        }
    }
    (backup, unbacked)
}

fn copy_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

/// Human-readable folder for a path, used in failure messages so the user can
/// go and look without parsing the path.
fn folder_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(display)
        .unwrap_or_else(|| path.to_string())
}

/// Put a finished run back. `created` files are taken out of the user's folder
/// (into `removed/`, so even the undo is reversible); `modified` and `deleted`
/// files are restored from `before/`. Returns `(restored, failed)` where each
/// failure string says where the user can look.
pub fn undo_files(
    state: &BeforeState,
    run_dir: &Path,
    created: &[String],
    modified: &[String],
    deleted: &[String],
) -> (Vec<String>, Vec<String>) {
    let mut restored: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let removed_dir = run_dir.join("removed");

    for (index, path) in created.iter().enumerate() {
        let source = Path::new(path);
        if !source.exists() {
            failed.push(format!("{path}（已经不在这里了，可能已被你或别的程序移走）"));
            continue;
        }
        let target = removed_dir.join(format!("{index:06}"));
        let moved = fs::rename(source, &target)
            .or_else(|_| copy_file(source, &target).and_then(|_| fs::remove_file(source)));
        match moved {
            Ok(_) => restored.push(path.clone()),
            Err(error) => failed.push(format!("{path}（没能移走：{error}；文件还在原处）")),
        }
    }

    let backup_dir = run_dir.join("before");
    for path in deleted.iter().chain(modified.iter()) {
        let Some(name) = state.backup.get(path) else {
            failed.push(format!(
                "{path}（没有可用的备份，无法自动还原；可以到 {} 文件夹里找找）",
                folder_of(path)
            ));
            continue;
        };
        let source = backup_dir.join(name);
        if !source.exists() {
            failed.push(format!(
                "{path}（备份文件丢了；可以到 {} 文件夹里找找）",
                folder_of(path)
            ));
            continue;
        }
        match copy_file(&source, Path::new(path)) {
            Ok(_) => restored.push(path.clone()),
            Err(error) => failed.push(format!("{path}（没能还原：{error}）")),
        }
    }

    // A deleted file whose folder no longer exists is not restored either; the
    // copy above recreates parents, so this only fires for missing backups.
    (restored, failed)
}

// ---------------------------------------------------------------------------
// Run-log persistence
// ---------------------------------------------------------------------------

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn sanitize_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' { ch } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "run".to_string()
    } else {
        cleaned
    }
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("建不了文件夹：{error}"))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file =
            fs::File::create(&tmp).map_err(|error| format!("写不了文件：{error}"))?;
        file.write_all(text.as_bytes())
            .map_err(|error| format!("写不了文件：{error}"))?;
        file.flush().map_err(|error| format!("写不了文件：{error}"))?;
    }
    if fs::rename(&tmp, path).is_err() {
        fs::copy(&tmp, path).map_err(|error| format!("保存不了文件：{error}"))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Newest first. A corrupt or missing file reads as an empty history rather
/// than taking the app down.
pub fn read_runs(root: &Path) -> Vec<Value> {
    match read_json(&root.join(RUNS_FILE)) {
        Some(Value::Array(runs)) => runs,
        _ => Vec::new(),
    }
}

pub fn write_runs(root: &Path, runs: &[Value]) -> Result<(), String> {
    write_json(&root.join(RUNS_FILE), &Value::Array(runs.to_vec()))
}

/// Insert or replace one run, newest first, keeping the list bounded.
pub fn upsert_run(root: &Path, record: Value) -> Result<(), String> {
    let id = record.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        return Err("这条记录没有编号，存不了".to_string());
    }
    let mut runs = read_runs(root);
    runs.retain(|run| run.get("id").and_then(Value::as_str) != Some(id.as_str()));
    runs.insert(0, record);
    runs.truncate(MAX_RUNS);
    write_runs(root, &runs)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

fn store_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("找不到应用的保存位置：{error}"))?
        .join(STORE_DIR);
    fs::create_dir_all(&root).map_err(|error| format!("建不了应用的保存位置：{error}"))?;
    Ok(root)
}

fn file_paths(picked: Option<Vec<tauri_plugin_dialog::FilePath>>) -> Vec<String> {
    picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| display(&path))
        .collect()
}

/// #41/#42 — the system file picker, limited to the extensions the task needs.
#[tauri::command(rename_all = "snake_case")]
pub async fn pick_files(
    app: tauri::AppHandle,
    multiple: Option<bool>,
    extensions: Option<Vec<String>>,
) -> Result<Value, String> {
    let mut builder = app.dialog().file();
    let extensions = extensions.unwrap_or_default();
    let words: Vec<&str> = extensions
        .iter()
        .map(String::as_str)
        .filter(|ext| !ext.is_empty())
        .collect();
    if !words.is_empty() {
        builder = builder.add_filter("要处理的文件", &words);
    }
    let picked = if multiple.unwrap_or(false) {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|path| vec![path])
    };
    Ok(json!({ "paths": file_paths(picked) }))
}

/// The "choose a folder" picker used by the tidy-up jobs.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Value, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let path = file_paths(picked.map(|path| vec![path])).into_iter().next();
    Ok(json!({ "path": path }))
}

/// Open a result with the system's default program.
#[tauri::command(rename_all = "snake_case")]
pub async fn open_path(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    if !Path::new(&path).exists() {
        return Err(format!("这个文件找不到了：{path}"));
    }
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|error| format!("打不开 {path}：{error}"))?;
    Ok(json!({ "ok": true }))
}

/// Show a result inside its folder (Explorer / Finder / file manager).
#[tauri::command(rename_all = "snake_case")]
pub async fn reveal_path(app: tauri::AppHandle, path: String) -> Result<Value, String> {
    let target = Path::new(&path);
    let target = if target.exists() { target.to_path_buf() } else { PathBuf::from(folder_of(&path)) };
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|error| format!("打不开文件夹：{error}"))?;
    Ok(json!({ "ok": true }))
}

/// Snapshot the folders a run is about to touch, and back up the files in them.
/// Called by the frontend at the moment the user presses 开始.
#[tauri::command(rename_all = "snake_case")]
pub async fn begin_run(app: tauri::AppHandle, id: String, paths: Vec<String>) -> Result<Value, String> {
    let root = store_root(&app)?;
    let run_dir = root.join(RUNS_DIR).join(sanitize_id(&id));
    let backup_dir = run_dir.join("before");
    let roots = roots_of(&paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    let (entries, truncated) = scan_roots(&roots, MAX_ENTRIES);
    let (backup, unbacked) = backup_files(&backup_dir, &entries);
    let state = BeforeState {
        roots: roots.iter().map(|path| display(path)).collect(),
        entries,
        backup,
        unbacked,
    };
    write_json(&run_dir.join(BEFORE_FILE), &serde_json::to_value(&state).map_err(|error| error.to_string())?)?;
    Ok(json!({
        "entries": state.entries,
        "roots": state.roots,
        "unbacked": state.unbacked,
        "truncated": truncated,
    }))
}

/// Snapshot the same folders again when the run ends. The frontend diffs the
/// two snapshots; nothing is written here.
#[tauri::command(rename_all = "snake_case")]
pub async fn snapshot_paths(paths: Vec<String>) -> Result<Value, String> {
    let roots = roots_of(&paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    let (entries, truncated) = scan_roots(&roots, MAX_ENTRIES);
    Ok(json!({
        "entries": entries,
        "roots": roots.iter().map(|path| display(path)).collect::<Vec<_>>(),
        "truncated": truncated,
    }))
}

/// Persist a finished (or failed) run so `run_log` survives a restart.
#[tauri::command(rename_all = "snake_case")]
pub async fn save_run(app: tauri::AppHandle, run: Value) -> Result<Value, String> {
    let root = store_root(&app)?;
    upsert_run(&root, run)?;
    Ok(json!({ "ok": true }))
}

/// The whole history, newest first.
#[tauri::command]
pub async fn run_log(app: tauri::AppHandle) -> Result<Value, String> {
    let root = store_root(&app)?;
    Ok(json!({ "runs": read_runs(&root) }))
}

/// #43 — put a run back. Never asks the assistant for anything.
#[tauri::command(rename_all = "snake_case")]
pub async fn undo_run(app: tauri::AppHandle, id: String) -> Result<Value, String> {
    let root = store_root(&app)?;
    let run_dir = root.join(RUNS_DIR).join(sanitize_id(&id));
    let state: BeforeState = read_json(&run_dir.join(BEFORE_FILE))
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();

    let mut runs = read_runs(&root);
    let record = runs
        .iter()
        .find(|run| run.get("id").and_then(Value::as_str) == Some(id.as_str()));
    let undo = record.and_then(|run| run.get("undo"));
    let created = strings(undo.and_then(|value| value.get("created")));
    let modified = strings(undo.and_then(|value| value.get("modified")));
    let deleted = strings(undo.and_then(|value| value.get("deleted")));

    let (restored, failed) = undo_files(&state, &run_dir, &created, &modified, &deleted);

    // Mark the record so history can show "已撤销" instead of offering it again.
    if let Some(record) = runs
        .iter_mut()
        .find(|run| run.get("id").and_then(Value::as_str) == Some(id.as_str()))
    {
        if let Some(object) = record.as_object_mut() {
            object.insert("undone".to_string(), Value::Bool(true));
            object.insert("restored".to_string(), json!(restored));
            object.insert("failed".to_string(), json!(failed));
        }
        let _ = write_runs(&root, &runs);
    }

    Ok(json!({ "ok": true, "restored": restored, "failed": failed }))
}
