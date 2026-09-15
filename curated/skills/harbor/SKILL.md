---
name: harbor
description: >-
  Run Terminal-Bench or any Harbor dataset with Cante as the agent, using the
  Harbor adapter in the cante repo's cante-harbor/ directory. Use when the user
  wants to benchmark Cante on Harbor or reproduce Cante's published eval results.
metadata:
  argument-hint: "<provider> <model> [task ...]"
---

# Run Harbor with Cante

Run [Harbor](https://github.com/laude-institute/harbor) with Cante as the agent. The adapter (`cante_agent.py`) lives in the `cante-harbor/` directory of the [cante repo](https://github.com/AntigmaLabs/cante). Harbor imports it and installs Cante inside each task sandbox from the published install script.

## Prerequisites

- A checkout of [AntigmaLabs/cante](https://github.com/AntigmaLabs/cante), for `cante-harbor/`
- [uv](https://docs.astral.sh/uv/) with Python 3.12
- Docker running: Harbor executes each task in a container
- The provider API key exported in the shell

## Run

Resolve the model and provider from the user's request. From the repo's `cante-harbor/` directory (so `cante_agent:CanteAgent` is importable):

```bash
uv run --python 3.12 --with harbor harbor run \
  --agent cante_agent:CanteAgent \
  --model "<model_name>" \
  --ak provider=anthropic \
  --ak install_args= \
  --ae 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}' \
  --dataset terminal-bench/terminal-bench-2-1 \
  --n-attempts 1
```

Adjust for the request:

- `provider` selects which key Cante reads inside the sandbox. For `openai` or `gemini`, forward `OPENAI_API_KEY` or `GEMINI_API_KEY` with `--ae` instead.
- `install_args` picks the Cante build installed in each sandbox: empty for the latest release, or a version to pin.
- Scope: add `-i <task-id>` (repeatable) to run specific tasks. Smoke-test one task before a full run unless the user asks otherwise.
- Throughput: `--n-concurrent <n>` caps parallel sandboxes. `--n-attempts <n>` sets attempts per task; published leaderboard runs use 5.
- Custom endpoint: add `--ae 'MODEL_BASE_URL=${MODEL_BASE_URL}'` when routing through a proxy.

## Read results

Harbor prints a per-task summary and writes a run directory with per-trial output; each trial captures Cante's raw event log from `/logs/agent/cante.txt`. Task failures do not make `harbor` exit non-zero, so judge the run by the summary, not the exit code.
