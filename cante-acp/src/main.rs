use std::path::PathBuf;

use clap::Parser;
use tracing_subscriber::EnvFilter;

/// Agent Client Protocol agent for Cante: speaks ACP over stdio and drives an
/// installed `cante`. Launch it from an ACP client.
#[derive(Parser)]
#[command(version)]
struct Cli {
    /// The `cante` executable to drive (default: `$CANTE` or its legacy
    /// spelling `$ANTE`, then `cante` on PATH, falling back to `ante`)
    #[arg(long, value_name = "PATH")]
    executable: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // stdout is the wire; logs go to stderr, which ACP clients capture.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let executable = cante_acp::cante_bin::resolve(
        cante_acp::cante_bin::env_executable(),
        cli.executable,
        std::env::var_os("PATH").as_deref(),
    );
    tracing::info!(executable = %executable.display(), "cante-acp starting");
    cante_acp::agent::run(executable).await?;
    Ok(())
}
