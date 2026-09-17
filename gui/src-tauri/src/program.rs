//! 找要启动的程序：这是「应用自己就能找到随包带的东西」的**唯一一处**实现（#150）。
//!
//! 为什么要有它：决定走 C（执行组件随安装包一起发，见
//! [`gui/docs/DECISION-windows-runtime.md`] §10）之后，用户的电脑上**没有任何设置**
//! 可以指路 —— 下载、双击、下一步、完成，然后就得能用。而在此之前：`daemon.rs` 只读
//! 环境变量（否则 PATH 上的 `cante`），`bridge.rs` 只读另一个环境变量（否则 PATH 上的
//! `pi`），两处各写一遍，就会和「检查电脑」那条探测（`commands.rs`）说不一样的话 ——
//! 探测说「就绪」、真正拉起时却找不到。
//!
//! 所以顺序只写在这里一份，**探测与拉起都调用它**：
//!
//! 1. **环境变量**（原样当命令规格用，即使它指向不存在的程序 —— 「一旦给了就不再往下
//!    找」是既有约定，开发与真机验收指别处这条路一点没变）；
//! 2. **应用自己旁边**（`exe_dir` 下按候选相对路径依次试）；
//! 3. `$HOME/.cante/bin/`；
//! 4. `PATH` 里的每个目录（只试兜底的那个裸名字）。
//!
//! 带空格的目录、非 ASCII 的用户名（中文用户名）在这里都只是普通字符串：本模块
//! 只做 `Path::join` 与存在性判断，没有任何手工拼路径或按分隔符切分的逻辑。传给
//! `Command::new` 的那一端由 `daemon::split_binary` 负责引号，所以规格里的路径同样能带空格。
//!
//! 返回的 [`Located`] 带着「找过哪些位置」：探测把它翻成给用户或技术同事看的中文事实，
//! 拉起只用 [`Located::spec`]。

use std::path::{Path, PathBuf};

/// 随包发的桥（`cante-bridge[.exe]`）的文件名主干：认出来之后探测还要往下看
/// 「动手的组件」在不在（见 `commands::resolve_daemon_bin`）。
pub const BRIDGE_STEM: &str = "cante-bridge";

/// 窗口程序要找的守护进程，按这个顺序试。**先上游的 `cante`、后我们随包发的桥**：
/// 本地 `cargo tauri dev` 时 `target/debug/` 里两个都在，先挑上游那个 = 与改动前一致。
pub const DAEMON_CANDIDATES: &[&[&str]] = &[&["cante"], &[BRIDGE_STEM]];
/// 一个都没找到时，交给 `PATH` 的兜底名字（与改动前 `daemon.rs` 的缺省一致）。
pub const DAEMON_BARE: &str = "cante";

/// 动手的执行组件（`pi`）的候选：应用旁边的 `pi.exe`、或 `pi\` 子目录里的 `pi.exe`。
/// （随包发的那种是「运行时 + 入口脚本」组合，见 [`ASSISTANT_DIR`]，走另一条判断。）
pub const ASSISTANT_CANDIDATES: &[&[&str]] = &[&["pi"], &["pi", "pi"]];
/// 随包发的执行组件目录：`<应用旁边>/pi/`。
pub const ASSISTANT_DIR: &str = "pi";
/// 组合形态的运行时（Windows 上会补成 `bun.exe`）与入口脚本。
///
/// 入口按相对 `<安装目录>\pi\` 的路径找：pi 自己发布出来的就是第一个
/// （`dist/bundle/cli.js`，实测它还要同目录上层的 `dist/` 与 `package.json` 才跑得起来，
/// 所以随包发的是**整份 pi 包**，不是只把 cli.js 抠出来）；后两个是给「扁平拷贝」留的。
pub const ASSISTANT_RUNTIME: &str = "bun";
pub const ASSISTANT_ENTRIES: &[&[&str]] =
    &[&["dist", "bundle", "cli.js"], &["cli.js"], &["dist", "cli.js"]];
/// 一个都没找到时，交给 `PATH` 的兜底名字（与改动前 `bridge.rs` 的缺省一致）。
pub const ASSISTANT_BARE: &str = "pi";

/// `searched` 里代表「系统登记的每个文件夹」（PATH）的那一条。
const PATH_LABEL: &str = "系统里登记的每个文件夹";

/// 一次查找的结果。`spec` 可以直接交给 `Command::new`（可能带引号参数），
/// `path` 是真正找到的那个文件（兜底用裸名字时为 `None`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    spec: String,
    path: Option<String>,
    searched: Vec<String>,
    from_env: bool,
}

impl Located {
    /// 交给 `Command::new` 的规格（`"<程序>" "<参数>" …`）。
    pub fn spec(&self) -> &str {
        &self.spec
    }

    /// 找到的文件路径；`None` 表示没找到（用的是兜底裸名字或环境变量给的规格）。
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// 找过哪些位置（找到了就为空 —— 没什么要向用户解释的）。
    pub fn searched(&self) -> &[String] {
        &self.searched
    }

    /// 规格是环境变量给的吗？给了就用它，**不再回退**。
    pub fn from_env(&self) -> bool {
        self.from_env
    }

    fn at(found: String) -> Self {
        Self {
            spec: found.clone(),
            path: Some(found),
            searched: Vec::new(),
            from_env: false,
        }
    }
}

/// 按冻结的顺序找一个程序（见模块头）。`candidates` 是应用旁边与 `$HOME/.cante/bin/`
/// 里要依次试的相对路径；`bare` 是全都落空时交给 `PATH` 的裸名字。
pub fn locate(
    env_bin: Option<&str>,
    candidates: &[&[&str]],
    bare: &str,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> Located {
    if let Some(raw) = env_bin {
        let raw = raw.trim();
        if !raw.is_empty() {
            let (program, _) = crate::daemon::split_binary(raw);
            return match locate_program(&program, path_var) {
                Some(found) => Located {
                    spec: raw.to_string(),
                    path: Some(found),
                    searched: Vec::new(),
                    from_env: true,
                },
                None => Located {
                    spec: raw.to_string(),
                    path: None,
                    searched: vec![raw.to_string()],
                    from_env: true,
                },
            };
        }
    }

    let mut searched: Vec<String> = Vec::new();
    for dir in nearby_dirs(exe_dir, home) {
        for candidate in candidates {
            if let Some(found) = existing_candidate(&dir, candidate) {
                return Located::at(found);
            }
        }
        searched.push(nearby_label(&dir, candidates[0][0]));
    }

    if let Some(raw) = path_var {
        searched.push(PATH_LABEL.to_string());
        for dir in std::env::split_paths(raw) {
            if let Some(found) = existing_candidate(&dir, &[bare]) {
                return Located::at(found);
            }
        }
    }

    Located { spec: bare.to_string(), path: None, searched, from_env: false }
}

/// 窗口程序要找的守护进程（#103 / #150）。
pub fn locate_daemon(
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> Located {
    locate(env_bin, DAEMON_CANDIDATES, DAEMON_BARE, exe_dir, home, path_var)
}

/// 动手的执行组件（#150）。除了单文件形态，还认随包发的组合：
/// `<目录>/pi/bun[.exe]` + `<目录>/pi/cli.js` —— 运行时按绝对路径起，入口脚本当第一个
/// 参数（这样不依赖用户 PATH 里有没有 `bun`，也不依赖 exe 形态的启动器）。
pub fn locate_assistant(
    env_bin: Option<&str>,
    exe_dir: Option<&Path>,
    home: Option<&Path>,
    path_var: Option<&str>,
) -> Located {
    let single = locate(env_bin, ASSISTANT_CANDIDATES, ASSISTANT_BARE, exe_dir, home, path_var);
    if single.from_env() || single.path().is_some() {
        return single;
    }

    // 单文件形态没找到：看随包发的组合。`searched` 沿用单文件那次的（同一个目录），
    // 追加一行这一组文件的名字，让「复制详情」说得清到底看过什么。
    let mut searched = single.searched;
    for dir in nearby_dirs(exe_dir, home) {
        let bundle = dir.join(ASSISTANT_DIR);
        let label = bundle.to_string_lossy().into_owned();
        if !searched.contains(&label) {
            searched.push(label);
        }
        if let Some(runtime) = existing_candidate(&bundle, &[ASSISTANT_RUNTIME]) {
            for entry in ASSISTANT_ENTRIES {
                let entry = candidate_path(&bundle, entry);
                if let Some(entry) = existing(entry) {
                    return Located {
                        spec: format!("{} {}", quote(&runtime), quote(&entry)),
                        path: Some(runtime),
                        searched: Vec::new(),
                        from_env: false,
                    };
                }
            }
        }
    }

    Located { spec: ASSISTANT_BARE.to_string(), path: None, searched, from_env: false }
}

/// 用真实进程环境找一次守护进程。窗口进程（`daemon.rs`）用它；纯函数入口留给测试。
pub fn daemon_here() -> Located {
    let exe_dir = current_exe_dir();
    let home = home_dir();
    let path_var = std::env::var("PATH").ok();
    locate_daemon(
        std::env::var("CANTE_BIN").ok().as_deref(),
        exe_dir.as_deref(),
        home.as_deref(),
        path_var.as_deref(),
    )
}

/// 用真实进程环境找一次动手的执行组件（桥用它）。
pub fn assistant_here() -> Located {
    let exe_dir = current_exe_dir();
    let home = home_dir();
    let path_var = std::env::var("PATH").ok();
    locate_assistant(
        std::env::var("PI_BIN").ok().as_deref(),
        exe_dir.as_deref(),
        home.as_deref(),
        path_var.as_deref(),
    )
}

/// 这个进程自己所在的目录（应用旁边 / 桥旁边：随包发的东西就放在这里）。
pub fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf))
}

/// Windows 上没有 `HOME`，只有 `USERPROFILE`（王姐那台机器就是后者）。
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// 环境变量给的规格里那个程序在不在。带目录分隔的按它自己看（相对路径按当前目录），
/// 裸名字才去 `PATH` 里找；没有扩展名时补一个 `.exe` 再试（Windows 的写法）。
pub fn locate_program(program: &str, path_var: Option<&str>) -> Option<String> {
    if program.contains('/') || program.contains('\\') {
        return existing(PathBuf::from(program));
    }
    if let Some(found) = existing_candidate(Path::new(""), &[program]) {
        return Some(found);
    }
    if let Some(raw) = path_var {
        for dir in std::env::split_paths(raw) {
            if let Some(found) = existing_candidate(&dir, &[program]) {
                return Some(found);
            }
        }
    }
    None
}

/// 这个路径是不是我们随包发的那个桥？（探测据此决定还要不要看「动手的组件」。）
///
/// 按两种分隔符切（`\` 在 Unix 上不是分隔符，而这个判断在 CI 的 Linux 上也要跑；
/// 真实路径则可能来自用户设置的环境变量，写法不受控），再摘掉 `.exe`。
pub fn is_bundled_bridge(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(lower.as_str());
    stem == BRIDGE_STEM
}

/// 依次要看的两个目录：应用自己旁边、然后 `$HOME/.cante/bin/`。
fn nearby_dirs(exe_dir: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = exe_dir {
        dirs.push(dir.to_path_buf());
    }
    if let Some(home) = home {
        dirs.push(home.join(".cante").join("bin"));
    }
    dirs
}

/// `searched` 里那一行给用户看的字面量：目录 + 第一个候选名字。
fn nearby_label(dir: &Path, name: &str) -> String {
    dir.join(name).to_string_lossy().into_owned()
}

fn quote(value: &str) -> String {
    format!("\"{value}\"")
}

fn existing(path: PathBuf) -> Option<String> {
    if path.is_file() {
        Some(path.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// 候选是一串路径片段（`["pi", "pi"]` = `pi\pi`），由 `Path::join` 拼 —— 分隔符交给
/// 平台，不手工拼字符串，所以带空格、非 ASCII 的目录名都只是普通字符串。
fn candidate_path(dir: &Path, segments: &[&str]) -> PathBuf {
    segments.iter().fold(dir.to_path_buf(), |acc, part| acc.join(part))
}

/// 先按原样找，再给最后一段补 `.exe` 找一次（Windows 上只有后者；这一段在任何
/// 平台上都能单测）。
fn existing_candidate(dir: &Path, segments: &[&str]) -> Option<String> {
    let direct = existing(candidate_path(dir, segments));
    if direct.is_some() {
        return direct;
    }
    let last = segments.last().copied().unwrap_or("");
    if last.is_empty() || last.ends_with(".exe") {
        return None;
    }
    let dotted = format!("{last}.exe");
    let mut with_ext: Vec<&str> = segments.to_vec();
    with_ext.pop();
    with_ext.push(dotted.as_str());
    existing(candidate_path(dir, &with_ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|delta| delta.as_nanos())
                .unwrap_or(0);
            let serial = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("cante-program-{label}-{stamp}-{serial}"));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn place(dir: &Path, name: &str) -> String {
        fs::create_dir_all(dir).expect("create dir");
        let binary = dir.join(name);
        fs::write(&binary, b"stub\n").expect("write stub");
        binary.to_string_lossy().into_owned()
    }

    #[test]
    fn env_wins_even_when_it_points_nowhere() {
        let dir = TempDir::new("env-wins");
        place(&dir.0, DAEMON_BARE);
        let found = locate_daemon(Some("cante"), Some(&dir.0), None, None);
        assert_eq!(found.spec(), "cante", "环境变量给了就是它，不许回退到旁边的文件");
        assert!(found.from_env());
        assert!(found.path().is_none());
        assert_eq!(found.searched(), ["cante".to_string()]);
    }

    #[test]
    fn env_spec_may_carry_arguments() {
        let dir = TempDir::new("env-args");
        let program = place(&dir.0, "wsl.exe");
        let spec = format!("\"{program}\" -e /opt/cante-bin/ante serve");
        let found = locate_daemon(Some(&spec), None, None, None);
        assert_eq!(found.spec(), spec);
        assert_eq!(found.path(), Some(program.as_str()));
    }

    #[test]
    fn next_to_the_app_wins_over_path() {
        let beside = TempDir::new("beside");
        let elsewhere = TempDir::new("elsewhere");
        let expected = place(&beside.0, "cante-bridge.exe");
        let other = place(&elsewhere.0, DAEMON_BARE);
        let path_var = elsewhere.0.to_string_lossy().into_owned();
        let found = locate_daemon(None, Some(&beside.0), None, Some(&path_var));
        assert_eq!(found.path(), Some(expected.as_str()));
        assert_ne!(found.path(), Some(other.as_str()));
    }

    #[test]
    fn upstream_cante_next_to_the_app_still_wins_over_our_bridge() {
        // 本地 `target/debug/` 里两个都在：先挑上游那个，与改动前一致。
        let dir = TempDir::new("order");
        place(&dir.0, "cante-bridge.exe");
        let upstream = place(&dir.0, DAEMON_BARE);
        let found = locate_daemon(None, Some(&dir.0), None, None);
        assert_eq!(found.path(), Some(upstream.as_str()));
    }

    #[test]
    fn home_bin_is_the_third_place() {
        let home = TempDir::new("home");
        let expected = place(&home.0.join(".cante").join("bin"), "cante");
        let found = locate_daemon(None, None, Some(&home.0), None);
        assert_eq!(found.path(), Some(expected.as_str()));
    }

    #[test]
    fn path_is_the_last_place() {
        let dir = TempDir::new("path");
        let expected = place(&dir.0, "cante");
        let path_var = dir.0.to_string_lossy().into_owned();
        let found = locate_daemon(None, None, None, Some(&path_var));
        assert_eq!(found.path(), Some(expected.as_str()));
    }

    #[test]
    fn nothing_found_falls_back_to_the_bare_name_and_lists_where_it_looked() {
        let dir = TempDir::new("none");
        let path_var = dir.0.to_string_lossy().into_owned();
        let found = locate_daemon(None, Some(&dir.0), Some(&dir.0), Some(&path_var));
        assert_eq!(found.spec(), "cante");
        assert!(found.path().is_none());
        assert!(found.searched().iter().any(|item| item.contains(".cante")), "{:?}", found.searched());
        assert!(found.searched().iter().any(|item| item.contains(PATH_LABEL)));
    }

    #[test]
    fn a_directory_with_spaces_is_just_a_string() {
        let dir = TempDir::new("with-spaces");
        let spaced = dir.0.join("Program Files (x86)").join("Cante");
        let expected = place(&spaced, "cante-bridge.exe");
        let found = locate_daemon(None, Some(&spaced), None, None);
        assert_eq!(found.path(), Some(expected.as_str()));
        assert!(found.spec().contains("Program Files (x86)"), "{}", found.spec());
    }

    #[test]
    fn a_non_ascii_user_name_is_just_a_string() {
        // 中文用户名（王姐那种）下的安装目录：路径里带非 ASCII，一样得找得到。
        let dir = TempDir::new("non-ascii");
        let user = "王姐";
        let basket = dir.0.join("Users").join(user).join("AppData").join("Local").join("Cante");
        let expected = place(&basket, "cante-bridge.exe");
        let found = locate_daemon(None, Some(&basket), None, None);
        assert_eq!(found.path(), Some(expected.as_str()));
        assert!(found.spec().contains(user), "{}", found.spec());
        assert!(is_bundled_bridge(found.path().expect("path")));
    }

    #[test]
    fn bundled_assistant_is_the_runtime_plus_the_entry_script() {
        let dir = TempDir::new("bundled-pi");
        let pi = dir.0.join("pi");
        let bun = place(&pi, "bun.exe");
        let entry = place(&pi.join("dist").join("bundle"), "cli.js");
        let found = locate_assistant(None, Some(&dir.0), None, None);
        assert_eq!(found.path(), Some(bun.as_str()));
        assert_eq!(found.spec(), format!("\"{bun}\" \"{entry}\""));
        // 空格与非 ASCII 一样只是字符串：规格里带引号，`split_binary` 认得。
        let (program, args) = crate::daemon::split_binary(found.spec());
        assert_eq!(program, bun);
        assert_eq!(args, vec![entry]);
    }

    #[test]
    fn assistant_also_accepts_a_single_pi_beside_the_app() {
        let dir = TempDir::new("pi-beside");
        let expected = place(&dir.0, "pi.exe");
        let found = locate_assistant(None, Some(&dir.0), None, None);
        assert_eq!(found.path(), Some(expected.as_str()));
        assert_eq!(found.spec(), expected);
    }

    #[test]
    fn assistant_in_a_subdirectory_is_found_too() {
        let dir = TempDir::new("pi-subdir");
        let expected = place(&dir.0.join("pi"), "pi.exe");
        let found = locate_assistant(None, Some(&dir.0), None, None);
        assert_eq!(found.path(), Some(expected.as_str()));
    }

    #[test]
    fn a_half_bundled_assistant_is_not_available() {
        // 只有运行时、没有入口脚本：不算找到，否则拉起时才炸。
        let dir = TempDir::new("half");
        place(&dir.0.join("pi"), "bun.exe");
        let found = locate_assistant(None, Some(&dir.0), None, None);
        assert!(found.path().is_none());
        assert_eq!(found.spec(), "pi");
        assert!(!found.searched().is_empty(), "要看得出它找过哪里");
    }

    #[test]
    fn assistant_env_wins_over_the_bundle() {
        let dir = TempDir::new("env-pi");
        place(&dir.0.join("pi"), "bun.exe");
        place(&dir.0.join("pi"), "cli.js");
        let found = locate_assistant(Some("pi"), Some(&dir.0), None, None);
        assert_eq!(found.spec(), "pi");
        assert!(found.from_env());
        assert!(found.path().is_none(), "PATH 上没有 pi 就如实说没有，不许假装旁边的组合能用");
    }

    #[test]
    fn the_bridge_is_recognized_by_its_file_stem() {
        assert!(is_bundled_bridge("C:\\Cante\\cante-bridge.exe"));
        assert!(is_bundled_bridge("C:\\Program Files (x86)\\Cante\\CANTE-BRIDGE.EXE"));
        assert!(is_bundled_bridge("/Applications/Cante/cante-bridge"));
        assert!(is_bundled_bridge("cante-bridge"));
        assert!(!is_bundled_bridge("C:\\Cante\\cante.exe"));
        assert!(!is_bundled_bridge("/usr/local/bin/ante"));
        assert!(!is_bundled_bridge("C:\\Cante\\cante-bridge-something.exe"));
    }
}
