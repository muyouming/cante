# cante-exec

Standalone asynchronous process execution utilities used by Cante.

The crate provides bounded output collection, timeouts, interactive stdin,
background process polling, and Unix process-group cleanup.

## Example

```rust
use std::time::Duration;

use cante_exec::{CommandOptions, run_with_timeout};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = run_with_timeout(
        CommandOptions::new("git", ".").args(["status", "--short"]),
        Duration::from_secs(10),
        1024 * 1024,
    )
    .await?;

    println!("{}", String::from_utf8_lossy(&output.stdout));
    Ok(())
}
```

Cante targets macOS and Linux. Process-group behavior is implemented on Unix;
non-Unix fallbacks do not provide equivalent lifecycle guarantees.
