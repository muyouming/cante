//! Locating the `cante` executable and checking its version.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// The product's own executable name, and the name a `cante acp` launcher
/// dispatches us under.
const BINARY: &str = "cante";
/// The same daemon is still installed under this name in some setups: our
/// Windows/WSL guidance points `CANTE_BIN` at `…/cante-bin/ante` (AGENTS.md
/// §6), so a bare `ante` on `PATH` is the daemon rather than an error. It is
/// only ever a fallback — `cante` wins whenever both are installed.
const LEGACY_BINARY: &str = "ante";

/// Set by `cante <name>` dispatch to the absolute path of the dispatching binary.
pub const CANTE_ENV: &str = "CANTE";
/// The rename's legacy spelling of [`CANTE_ENV`]: an older launcher that runs
/// `ante acp` sets this instead, and it must keep working.
pub const LEGACY_CANTE_ENV: &str = "ANTE";
/// Set to a non-empty value to skip the version check (development builds
/// of `cante` report `0.1.0`).
pub const SKIP_VERSION_CHECK_ENV: &str = "CANTE_ACP_SKIP_VERSION_CHECK";
/// The oldest `cante` this adapter drives: the release whose wire protocol it
/// is built against.
pub const MIN_VERSION: Version = Version { major: 0, minor: 2, patch: 1 };
/// Bound on `cante --version` so a hung executable cannot hang `initialize`.
const VERSION_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// The executable the environment names: [`CANTE_ENV`], then the legacy
/// [`LEGACY_CANTE_ENV`]. Empty values count as unset.
pub fn env_executable() -> Option<OsString> {
    [CANTE_ENV, LEGACY_CANTE_ENV]
        .into_iter()
        .filter_map(std::env::var_os)
        .find(|value| !value.is_empty())
}

/// Resolve the `cante` executable: `CANTE` (or its legacy spelling `ANTE`,
/// both set when a launcher dispatches us), then `--executable`, then the
/// first of `cante` and the legacy `ante` on `PATH`.
pub fn resolve(env: Option<OsString>, flag: Option<PathBuf>, path_var: Option<&OsStr>) -> PathBuf {
    env.filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(flag)
        .or_else(|| locate(path_var))
        .unwrap_or_else(|| PathBuf::from(BINARY))
}

/// The first of [`BINARY`] and [`LEGACY_BINARY`] that can be run from
/// `path_var`'s directories. `PATH` is a parameter rather than read here, so
/// the search is reproducible in tests and does not depend on the machine the
/// suite happens to run on.
fn locate(path_var: Option<&OsStr>) -> Option<PathBuf> {
    let path_var = path_var?;
    [BINARY, LEGACY_BINARY]
        .into_iter()
        .find_map(|name| which::which_in(name, Some(path_var), ".").ok())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    /// Parse `cante --version` output, e.g. `cante 0.2.1`. The legacy `ante`
    /// spelling is accepted too: a daemon installed under that name answers
    /// `--version` with it.
    pub fn parse(output: &str) -> Option<Self> {
        let output = output.trim();
        let rest = output.strip_prefix("cante ").or_else(|| output.strip_prefix("ante "))?;
        let mut parts = rest.split('.').map(str::parse::<u64>);
        let (Some(Ok(major)), Some(Ok(minor)), Some(Ok(patch)), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        Some(Self { major, minor, patch })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Run `<executable> --version` and refuse anything older than [`MIN_VERSION`].
pub async fn check_version(executable: &Path) -> Result<()> {
    if std::env::var_os(SKIP_VERSION_CHECK_ENV).is_some_and(|value| !value.is_empty()) {
        return Ok(());
    }
    let command = format!("{} --version", executable.display());
    let output = tokio::time::timeout(
        VERSION_CHECK_TIMEOUT,
        tokio::process::Command::new(executable).arg("--version").output(),
    )
    .await
    .with_context(|| format!("`{command}` did not finish within {VERSION_CHECK_TIMEOUT:?}"))?
    .with_context(|| format!("could not run `{command}`; install Cante or pass --executable"))?;
    if !output.status.success() {
        bail!("`{command}` failed with {}", output.status);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = Version::parse(&stdout).with_context(|| {
        format!(
            "unrecognized `cante --version` output {stdout:?}; set {SKIP_VERSION_CHECK_ENV}=1 to skip this check"
        )
    })?;
    if version < MIN_VERSION {
        bail!(
            "cante {version} is older than the {MIN_VERSION} this adapter requires; run `cante update`"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_output() {
        assert_eq!(Version::parse("cante 0.2.1\n"), Some(Version { major: 0, minor: 2, patch: 1 }));
    }

    #[test]
    fn accepts_the_legacy_ante_banner() {
        assert_eq!(Version::parse("ante 0.2.5\n"), Some(Version { major: 0, minor: 2, patch: 5 }));
    }

    #[test]
    fn rejects_other_output() {
        for output in ["", "0.2.1", "cante 0.2", "cante 0.2.1-rc.1", "cante 20260919-1200-abc"] {
            assert_eq!(Version::parse(output), None, "{output:?}");
        }
    }

    #[test]
    fn orders_by_component() {
        assert!(Version::parse("cante 0.10.0") > Version::parse("cante 0.9.9"));
        assert!(Version::parse("cante 0.1.0") < Some(MIN_VERSION));
    }

    #[test]
    fn env_wins_then_flag_then_path() {
        let flag = Some(PathBuf::from("/flag/cante"));
        assert_eq!(
            resolve(Some("/env/cante".into()), flag.clone(), None),
            PathBuf::from("/env/cante")
        );
        assert_eq!(resolve(Some("".into()), flag.clone(), None), PathBuf::from("/flag/cante"));
        assert_eq!(resolve(None, flag, None), PathBuf::from("/flag/cante"));
        // Nothing named and nothing to search: the product's own bare name,
        // which the spawned process resolves through `PATH` itself.
        assert_eq!(resolve(None, None, None), PathBuf::from("cante"));
    }

    /// A directory with an executable named `name` in it.
    #[cfg(unix)]
    fn dir_with(name: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = std::env::temp_dir().join(format!("cante-acp-bin-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        dir
    }

    /// Only the legacy `ante` is installed: the adapter still finds the daemon.
    #[cfg(unix)]
    #[test]
    fn path_falls_back_to_the_legacy_ante_name() {
        let dir = dir_with("ante");
        let path = dir.as_os_str();
        assert_eq!(locate(Some(path)), Some(dir.join("ante")));
        assert_eq!(resolve(None, None, Some(path)), dir.join("ante"));
    }

    /// With both installed the product's own name wins.
    #[cfg(unix)]
    #[test]
    fn path_prefers_cante_over_ante() {
        let dir = dir_with("cante");
        assert_eq!(locate(Some(dir.as_os_str())), Some(dir.join("cante")));
    }
}
