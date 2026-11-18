# 0001. File-Backed Multi-Key Pool for Local Exa MCP

status: accepted

Local `stdio` deployments use a file-backed `Key Pool` (auto-discovering `~/.config/exa-mcp/keys.txt` or reading `EXA_KEYS_FILE`) with comma-separated environment fallback (`EXA_API_KEYS`, `EXA_API_KEY`), defaulting to `Fill-First` `Selection Strategy` and cross-process health persistence keyed solely by SHA-256 fingerprints (`keys-state.json`). Self-hosted HTTP / `runtime-server` activates the `Key Pool` when `EXA_KEYS_FILE` or `EXA_API_KEYS` (or comma-separated `EXA_API_KEY`) is configured, while incoming per-request HTTP credentials and OAuth tokens in `api/mcp.ts` remain separate and unpooled.

## Context and Trade-offs

Because Exa's free tier grants $10 monthly `Team Credit` (resetting on the 1st of each UTC month) plus a non-expiring $10 onboarding bonus per team, supporting unlimited free keys via environment variables alone forces edits across every local MCP client config and risks OS environment-length limits. A hot-reloaded text file lets operators add or remove keys without restarting clients, while persisting `Key State` by fingerprint shares `Exhausted Key` (`402`), `Cooldown Key` (`429`), `Disabled Key` (`401` / `403 TEAM_BLOCKED`), and `Run Pinning` (`agent_run` / deep research IDs) across concurrent client processes without ever storing raw secrets on disk.

We chose `Fill-First` over `Round-Robin` as the default so light workloads consume one key's allowance before touching others while still failing over immediately on `429` bursts; `EXA_KEY_STRATEGY=round-robin` remains available for uniform concurrency spreading. We also inspect `403` error messages to isolate content moderation and feature-gate rejections from `TEAM_BLOCKED`, preventing single blocked queries from poisoning healthy keys.
