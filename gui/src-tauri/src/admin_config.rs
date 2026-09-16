//! 企业预置配置（issue #58）。
//!
//! 调研里反复出现同一个结论：挡住办公人群用 AI 的不是能力，而是「公司不放心」
//! ——微软官方《在工作中使用 AI 的安全提示》、火山引擎《防范员工无意泄密》，还有
//! 标题为「80% 员工偷偷绕开公司 AI 工具」的文章，说的都是这件事。现实里它由 IT
//! 部门统一配一次来解决。我们的两个卖点（只在本机处理、不上传）正好是这条阻力的
//! 解药，所以这份配置要做得让管理员敢批、让王姐看得懂。
//!
//! 配置文件位置（冻结）：`~/.cante/admin.json`；测试可以用环境变量
//! `CANTE_ADMIN_CONFIG` 指向另一个文件。字段用 snake_case，和 [`AdminConfig`]
//! 一致。
//!
//! 诚实的边界（重要，别把它当安全机制）：
//!
//!   * 这不是安全边界。用户在自己的电脑上有文件系统权限，能改甚至删掉这份配置，
//!     也能直接启动别的程序。它解决的是「公司放不放心」这个真实的组织阻力，不是
//!     技术强制。任何声称它能「锁住」用户的说法都是错的。
//!   * 因此，文件不存在按「没有配置」处理；文件坏了、是空的、字段类型不对，也一律
//!     按「没有配置」处理，只把原因记到日志里——绝不能让应用起不来。宁可少读一份
//!     配置，也不能让她打不开软件。
//!   * 解析做成纯函数 [`parse_admin_config`]，不读环境、不碰磁盘，方便单测覆盖
//!     正常、缺字段、坏 JSON、空文件、以及含有不认识任务 id 的情况。

use std::path::{Path, PathBuf};

/// 配置文件里实际存在的字段。`present` 是读出来之后才知道的，不在文件里。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default)]
struct AdminConfigFile {
    /// 管理员规定的默认连接（界面显示「这台电脑被设成了…」）。
    default_provider: Option<String>,
    default_model: Option<String>,
    /// 是否允许联网（false = 只在本机处理）。
    allow_network: Option<bool>,
    /// 被禁用的任务 id（这些任务不出现）。
    disabled_tasks: Vec<String>,
}

/// 读给前端的完整配置。字段和文件一致，另加一个 `present` 说明到底有没有这份配置。
///
/// `serde(default)` 让缺字段的文件照样能读；多余字段（比如给管理员看的 `_comment`）
/// 被忽略，不报错——配置格式要能往后长，不能因为多写一行就整份作废。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct AdminConfig {
    pub present: bool,
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub allow_network: Option<bool>,
    pub disabled_tasks: Vec<String>,
}

/// 一份读不出来的配置，连带原因。原因只进日志，不上面向用户的界面。
fn absent(reason: Option<String>) -> (AdminConfig, Option<String>) {
    (AdminConfig::default(), reason)
}

/// 纯函数：输入文件内容，输出配置。**任何输入都不返回错误**。
///
/// - 空文件 / 只有空白 → `present: false`（和文件不存在一样）；
/// - 不是合法 JSON、或 JSON 不是对象 → `present: false`，原因记下来；
/// - 合法对象 → `present: true`；缺字段走默认值；`disabled_tasks` 原样保留，即使里面
///   是不认识的任务 id 也不报错（淘汰的 id 由前端忽略）。
pub fn parse_admin_config(text: &str) -> AdminConfig {
    parse_admin_config_report(text).0
}

/// 和 [`parse_admin_config`] 一样，但把「为什么没读成」也带出来，供日志使用。
pub fn parse_admin_config_report(text: &str) -> (AdminConfig, Option<String>) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return absent(Some("配置文件是空的".to_string()));
    }
    match serde_json::from_str::<AdminConfigFile>(trimmed) {
        Ok(file) => (
            AdminConfig {
                present: true,
                default_provider: file.default_provider,
                default_model: file.default_model,
                allow_network: file.allow_network,
                disabled_tasks: file.disabled_tasks,
            },
            None,
        ),
        Err(error) => absent(Some(format!("配置文件读不了：{error}"))),
    }
}

/// 这份配置该去哪个文件读。
///
/// `CANTE_ADMIN_CONFIG` 优先（测试用），否则 `~/.cante/admin.json`。两个家目录
/// 环境变量都拿不到时返回 `None`——那就当没有配置，不猜、不报错。
pub fn config_path() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("CANTE_ADMIN_CONFIG") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    home_dir().map(|home| home.join(".cante").join("admin.json"))
}

/// 从指定文件读配置。文件不存在是正常情况（`present: false`，没有原因）。
pub fn load_from_path(path: &Path) -> (AdminConfig, Option<String>) {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_admin_config_report(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => absent(None),
        Err(error) => absent(Some(format!("配置文件读不了：{error}"))),
    }
}

/// 给命令用的入口：读到什么算什么，坏文件只记原因，绝不 panic。
pub fn load() -> AdminConfig {
    let Some(path) = config_path() else {
        return AdminConfig::default();
    };
    let (config, problem) = load_from_path(&path);
    if let Some(problem) = problem {
        // 日志（stderr）里说清楚，界面上一句都不提——她看不懂，也不需要看懂。
        eprintln!("cante：{problem}（{}）", path.display());
    }
    config
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

// ---------------------------------------------------------------------------
// 测试：解析是纯函数，坏输入一律按「没有配置」处理
// ---------------------------------------------------------------------------

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
            let path =
                std::env::temp_dir().join(format!("cante-admin-config-{label}-{stamp}-{serial}"));
            fs::create_dir_all(&path).expect("create temp dir");
            TempDir(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 1. 正常：字段齐全，present 为 true，值原样带出来。
    #[test]
    fn a_complete_file_is_read_field_by_field() {
        let text = r#"{
            "default_provider": "openai-compatible",
            "default_model": "ocg/deepseek-flash",
            "allow_network": false,
            "disabled_tasks": ["wechat.batch", "excel.diff"]
        }"#;
        let config = parse_admin_config(text);
        assert!(config.present);
        assert_eq!(config.default_provider.as_deref(), Some("openai-compatible"));
        assert_eq!(config.default_model.as_deref(), Some("ocg/deepseek-flash"));
        assert_eq!(config.allow_network, Some(false));
        assert_eq!(config.disabled_tasks, vec!["wechat.batch", "excel.diff"]);
    }

    /// 2. 缺字段：文件在（present 为 true），没写的走默认值。
    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let config = parse_admin_config("{}");
        assert!(config.present);
        assert_eq!(config.default_provider, None);
        assert_eq!(config.default_model, None);
        assert_eq!(config.allow_network, None);
        assert!(config.disabled_tasks.is_empty());

        // 只写一半也一样：写了的留下，没写的默认。
        let partial = parse_admin_config(r#"{ "allow_network": true }"#);
        assert!(partial.present);
        assert_eq!(partial.allow_network, Some(true));
        assert!(partial.disabled_tasks.is_empty());
    }

    /// 3. 坏 JSON：不能让应用起不来，按没有配置处理，并且记下原因。
    #[test]
    fn broken_json_is_ignored_with_a_reason() {
        let (config, problem) = parse_admin_config_report("{ this is not json");
        assert!(!config.present);
        assert!(config.disabled_tasks.is_empty());
        let reason = problem.expect("broken JSON should carry a reason");
        assert!(reason.contains("读不了"), "reason: {reason}");

        // 合法 JSON 但不是对象（数组 / 数字）同样按没有配置处理。
        assert!(!parse_admin_config("[1, 2, 3]").present);
        assert!(!parse_admin_config("42").present);
    }

    /// 4. 空文件：和文件不存在一样，present 为 false，也有原因。
    #[test]
    fn an_empty_file_counts_as_absent() {
        assert!(!parse_admin_config("").present);
        assert!(!parse_admin_config("   \n\t  ").present);
        assert!(parse_admin_config_report("").1.is_some());
    }

    /// 5. disabled_tasks 里有不存在的任务 id：原样保留，不报错（淘汰的 id 由界面忽略）。
    #[test]
    fn unknown_task_ids_are_kept_without_complaint() {
        let text = r#"{ "disabled_tasks": ["no.such.task", "wechat.batch"] }"#;
        let config = parse_admin_config(text);
        assert!(config.present);
        assert_eq!(config.disabled_tasks, vec!["no.such.task", "wechat.batch"]);
    }

    /// 文件不存在时读配置不报错：返回「没有配置」，原因也是空的。
    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir = TempDir::new("missing");
        let path = dir.0.join(".cante").join("admin.json");
        let (config, problem) = load_from_path(&path);
        assert!(!config.present);
        assert_eq!(problem, None);
    }

    /// 文件存在时按文件内容读；坏了也不炸，只是把原因带出来。
    #[test]
    fn loading_a_real_file_matches_the_pure_parser() {
        let dir = TempDir::new("present");
        let path = dir.0.join("admin.json");
        fs::write(&path, r#"{ "disabled_tasks": ["files.rename"] }"#).expect("write config");
        let (config, problem) = load_from_path(&path);
        assert_eq!(problem, None);
        assert!(config.present);
        assert_eq!(config.disabled_tasks, vec!["files.rename"]);

        fs::write(&path, "{ not json").expect("write broken config");
        let (broken, reason) = load_from_path(&path);
        assert!(!broken.present);
        assert!(reason.is_some());
    }
}
