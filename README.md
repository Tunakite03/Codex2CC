# Codex2CC

Runs [Claude Code](https://claude.com/claude-code) and [Claude Desktop](https://claude.ai/download) on your ChatGPT (Codex) login. Codex2CC is a local gateway that accepts Anthropic `/v1/messages` requests and forwards them to the ChatGPT Codex Responses API, translating requests, tool calls, streaming SSE events, and reasoning effort in both directions.

It includes an interactive Web Control Panel with real-time request logs and a comprehensive token usage summary table.

## Operating Modes

| Mode | Command | What it does |
|---|---|---|
| **Web Control Panel** | `codex2cc --ui` | Launches the interactive browser dashboard to configure clients, monitor live logs, and track token usage |
| **Claude Code CLI** | `codex2cc [options] [-- <claude args>]` | Starts an ephemeral local gateway and launches `claude` pointed directly at it |
| **Standalone Gateway** | `codex2cc --serve` | Serves the gateway (and `/ui`) continuously on loopback for Claude Code, Claude Desktop, and SDK clients |
| **Automated Client Setup** | `codex2cc --setup` | Atomically configures Claude Code CLI and Claude Desktop to use the gateway |
| **Configuration Reset** | `codex2cc --reset-config` | Restores standard Anthropic defaults cleanly without deleting chat history |

Run `codex2cc --help` for full CLI options.

---

## Requirements

- **Node.js** 22.12 or newer
- An authenticated ChatGPT session created by the Codex CLI (`codex login`), stored in `~/.codex/auth.json`
- The `claude` command on your `PATH` (for Claude Code CLI mode)

---

## Build and Quick Start

```bash
npm ci
npm run build

# 1. Open the interactive Web Control Panel
node dist/main.js --ui

# 2. Or list models available to your ChatGPT account
node dist/main.js --list-models

# 3. Or launch Claude Code directly through the gateway
node dist/main.js --model gpt-6-sol -- --resume

# 4. Or run non-interactively and pipe the output
node dist/main.js -p "Summarize this repository" | tee summary.txt
```

Status messages and diagnostics are emitted to `stderr`, keeping `stdout` clean for piping.

---

## Web Control Panel & Dashboard

Launch with `node dist/main.js --ui` (or visit `http://127.0.0.1:3456/ui` while running `--serve`).

The Control Panel provides:
- **Client Configuration & Status**: Auto-detects configuration states for Claude Code CLI (`~/.claude/settings.json`) and Claude Desktop (`Claude-3p/configLibrary`), offering one-click configuration and factory resets.
- **Claude Tier Model Mapping**: Assigns a ChatGPT account model to each Claude tier (Fable, Opus, Sonnet, and Haiku). Gateway routing updates immediately; mappings persist to `logs/tier-models.json` and apply to future starts. Re-apply client configuration and reload Claude Code sessions to update their saved tier aliases. The dashboard can restore environment-variable or built-in defaults.
- **Token Usage Summary Table (Bảng Tổng Hợp Token Đã Dùng)**:
  - Tracks total tokens used across models and sessions in real time.
  - **Account Quota & Usage Remaining (Hạn Mức Còn Lại)**: Real-time visual progress gauges for the **5-Hour Rolling Window** and **Weekly Allowance**, showing percentage remaining, percentage used, reset countdown timer, and reset timestamps.
  - KPI summary metrics: **Total Tokens (Grand Total)**, **Prompt Tokens (Input)**, **Completion Tokens (Output)**, and **Cached Tokens (Read)**.
  - Per-model breakdown with request count, token categories, and usage share percentage (`%`).
  - Dedicated **Refresh** and **Reset Counter** controls.
- **Live Activity & Debug Logs**:
  - Live streaming log terminal monitoring incoming messages, model routing, token counts, and upstream errors.
  - Filters by severity (`info`, `warn`, `error`) and search keyword.
  - Real-time 2-second auto-refresh toggle, clipboard copy, and file persistence (`logs/gateway.log`).

---

## Standalone Gateway

```bash
node dist/main.js --serve --port 3456
```

The gateway binds exclusively to `127.0.0.1`. Every request must provide a valid authentication token via `Authorization: Bearer <token>` or `x-api-key: <token>`.
- Set `CODEX2CC_TOKEN` (at least 16 characters) to specify a fixed token.
- If omitted, `--ui` and `--serve` reuse the token already saved for this local gateway URL. On first launch, a cryptographically secure random token is generated and printed at startup.
- `--no-auth` disables token verification (not recommended for shared machines).
- Requests containing non-loopback `Host` headers are rejected to prevent DNS rebinding attacks.

### Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/v1/messages` | `POST` | Anthropic Messages API (streaming SSE and JSON batch responses) |
| `/v1/messages/count_tokens` | `POST` | Local token estimation for client pre-calculations |
| `/v1/models` | `GET` | Catalog of Claude model routes mapped to ChatGPT backend models |
| `/ui` or `/` | `GET` | Web Control Panel dashboard |
| `/api/ui/status` | `GET` | Gateway port, auth mode, and client configuration status |
| `/api/ui/usage` | `GET` | Real-time token usage summary and per-model statistics |
| `/api/ui/usage/reset` | `POST` | Resets all accumulated token counters |
| `/api/ui/logs` | `GET` | Query recent gateway activity logs with level and keyword filters |
| `/api/ui/logs/clear` | `POST` | Clears in-memory log buffer and truncates log file |
| `/api/hello` | `HEAD` | Loopback gateway healthcheck |

---

## Configuring Claude Code & Claude Desktop

Codex2CC provides built-in commands to configure clients safely:

```bash
# Configure both Claude Code CLI and Claude Desktop to point to the local gateway:
node dist/main.js --setup

# Configure only Claude Code CLI (~/.claude/settings.json):
node dist/main.js --setup-cli

# Configure only Claude Desktop:
node dist/main.js --setup-desktop

# Configure with a custom remote gateway URL and explicit token:
node dist/main.js --setup --gateway-url https://my-gateway.internal --token "my-secure-token-12345"

# Reset all configurations back to standard Anthropic defaults:
node dist/main.js --reset-config
```

### Next Steps after Setup
1. **Start the gateway**:
   ```bash
   CODEX2CC_TOKEN="<token>" node dist/main.js --serve --port 3456
   ```
2. **Claude Desktop**: Restart the app and select **"Continue with Gateway"** (do not sign in with claude.ai).
3. **Claude Code CLI**: Open a new terminal tab or reload your editor and run `claude` normally.

### Effort Selection
The model picker and effort picker are separate menus. In Claude Desktop's **Code** tab, close the model picker and press **Cmd+Shift+E** (macOS) or **Ctrl+Shift+E** (Windows) to open the effort picker. Claude Code's terminal interface can open the same choice with `/effort`, or set it directly with `/effort xhigh`.

The Haiku route remains mapped to `gpt-6-luna`. Codex2CC applies `max` effort to that route when Claude omits an effort value, and preserves any effort included in the request. Other model routes keep their existing effort behavior. Claude Code's `/effort` command or the left and right arrows in `/model` can set the effort sent by the client ([Claude Code model configuration](https://code.claude.com/docs/en/model-config)).

---

## Environment Variables

| Variable | Used by | Description |
|---|---|---|
| `CODEX2CC_TOKEN` | `--serve`, `--ui`, setup | Gateway authentication token (min. 16 chars; saved local token reused when unset) |
| `CODEX2CC_LOG_FILE` | all | Path to write formatted gateway logs (default: `logs/gateway.log`) |
| `CODEX2CC_MODEL_FABLE` | all | ChatGPT model for Claude Fable tier (default: `gpt-6-astra`) |
| `CODEX2CC_MODEL_OPUS` | all | ChatGPT model for Claude Opus tier (default: `gpt-6.1-sol`) |
| `CODEX2CC_MODEL_SONNET` | all | ChatGPT model for Claude Sonnet tier (default: `gpt-6-sol`) |
| `CODEX2CC_MODEL_HAIKU` | all | ChatGPT model for Claude Haiku tier (default: `gpt-6-luna`) |
| `CODEX2CC_TIERS_FILE` | all | Optional path for the persisted Web UI tier mapping (default: `logs/tier-models.json` under the project directory) |

Tier mapping precedence is saved Web UI mapping, then `CODEX2CC_MODEL_*` environment variables, then built-in defaults. Use **Use defaults** in the dashboard to remove the saved mapping and return to the environment/default values.

---

## Authentication Mechanism

Codex2CC reads credentials directly from `~/.codex/auth.json` and never prompts for usernames or passwords:
- When the access token expires, Codex2CC automatically refreshes it and writes the rotated token atomically back to `~/.codex/auth.json`.
- Because ChatGPT refresh tokens are single-use, the auth file is checked before and after refresh operations to adopt tokens rotated by concurrent processes.
- If the Codex CLI switches to a different ChatGPT account while the gateway is active, the gateway detects the mismatch, halts requests, and instructs you to restart.

---

## Limitations

- Uses ChatGPT's internal Codex backend endpoint (`/backend-api/codex/responses`), which may change without notice. Check OpenAI's terms before production reliance.
- `max_tokens`, `stop_sequences`, and raw `thinking` blocks are not forwarded upstream.
- Content block types unsupported by the Codex Responses API (such as `document`) are stripped with an explicit note, and tools lacking an `input_schema` are omitted; both are recorded in the activity log.
- `count_tokens` calculates a local heuristic (~4 characters per token).
- If a requested model is not available in your ChatGPT account, the gateway falls back to your account's default model with a logged warning.

---

## Development & Testing

```bash
npm run typecheck
npm test
```

Tests run via Node.js native test runner against compiled output in `dist/`. All upstream network requests and auth files are mocked locally; tests never contact external endpoints or touch your real `~/.codex/auth.json`.
