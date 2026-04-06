# Architecture

EA Harness OSS is a browser-driven orchestration layer for Codex CLI and MT5.

- `server/` hosts the Node.js backend, orchestrator, MT5 bridge, parsers, and APIs.
- `dashboard/` contains the browser UI served as static assets.
- `workspace/` stores project state, generated sources, logs, reports, and analysis artifacts.
