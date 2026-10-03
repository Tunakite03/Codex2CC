# Codex2CC

Runs [Claude Code](https://claude.com/claude-code) on your ChatGPT (Codex) login. Codex2CC is a local gateway that
accepts Anthropic `/v1/messages` requests and forwards them to the ChatGPT Codex Responses API, translating requests,
tool calls and streaming events in both directions.

It has three modes:

| Mode | Command | What it does |
|---|---|---|
| Claude Code | `codex2cc [options] [-- <claude args>]` | Starts a private gateway and launches `claude` pointed at it |
| Standalone gateway | `codex2cc --serve` | Serves the gateway for other Anthropic-compatible clients |
| MCP server | `codex2cc --mcp` | Exposes Claude Code-on-ChatGPT as MCP tools over stdio |

Run `codex2cc --help` for all options.

## Requirements

- Node.js 22.12 or newer
- A ChatGPT login created by the Codex CLI (`codex login`), stored in `~/.codex/auth.json`
- The `claude` command on your `PATH` (Claude Code mode and MCP mode)

## Build and run

```bash
npm ci
npm run build
node dist/main.js --list-models
node dist/main.js --model gpt-6-sol -- --resume
node dist/main.js -p "Summarize this repository" | tee summary.txt
```

Status messages go to stderr, so the output of `-p` can be piped.

## Standalone gateway

```bash
node dist/main.js --serve --port 3456
```

The gateway listens on `127.0.0.1` only. Every request must carry a token, as `Authorization: Bearer <token>` or
`x-api-key: <token>`. Set `CODEX2CC_TOKEN` (at least 16 characters) to choose it, otherwise a random one is generated
and printed once at startup. `--no-auth` disables the token and is not recommended: any local process could then spend
your ChatGPT quota. Requests whose `Host` is not a loopback name are refused, which blocks DNS rebinding.

Endpoints: `POST /v1/messages` (streaming and non-streaming), `POST /v1/messages/count_tokens` (a local estimate),
`GET /v1/models`, and `HEAD /api/hello`.

## MCP server

```json
{
  "mcpServers": {
    "codex2cc": {
      "command": "node",
      "args": ["/absolute/path/to/Codex2CC/dist/main.js", "--mcp"],
      "env": { "CODEX2CC_ALLOWED_ROOTS": "/Users/me/projects" }
    }
  }
}
```

Tools: `run_claude_code_with_chatgpt`, `start_claude_code_task`, `check_claude_code_task`,
`list_available_chatgpt_models`. Tasks run `claude -p` in a `project_dir` that must be inside
`CODEX2CC_ALLOWED_ROOTS`. The default permission mode is `acceptEdits`; `bypassPermissions` is refused unless the
operator also sets `CODEX2CC_ALLOW_BYPASS=1`.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CODEX2CC_TOKEN` | `--serve` | Gateway token (min. 16 characters); random if unset |
| `CODEX2CC_MODEL_OPUS`, `_SONNET`, `_HAIKU` | all gateways | Account model used for each Claude tier (defaults `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`) |
| `CODEX2CC_ALLOWED_ROOTS` | MCP | Path-delimited absolute directories tasks may run in (default: the server's working directory, none if that is `/`) |
| `CODEX2CC_ALLOW_BYPASS` | MCP | `1` allows `permission_mode: bypassPermissions` |
| `CODEX2CC_TASK_TIMEOUT_MS` | MCP | Per-task time limit in milliseconds (default 1800000, max 2147483647) |
| `CODEX2CC_MAX_CONCURRENT` | MCP | Concurrent tasks (default 3) |
| `CODEX2CC_TASK_TTL_MS`, `CODEX2CC_MAX_STORED_TASKS` | MCP | How long and how many finished tasks are kept (defaults 3600000, 100) |
| `CODEX2CC_MAX_OUTPUT_CHARS` | MCP | Output kept per task, the last N characters (default 1000000) |
| `CODEX2CC_CLAUDE_BIN` | MCP | Claude Code executable (default `claude`) |

## How authentication works

Codex2CC reads the Codex CLI login from `~/.codex/auth.json` and never asks for credentials itself. When the access
token expires it refreshes it and writes the rotated tokens back to the same file. Refresh tokens are single-use, so the
file is re-read before and after a refresh to pick up tokens another process already rotated. If the Codex login switches
to another ChatGPT account while the gateway runs, the gateway stops using it and asks you to restart.

## Limitations

- This uses ChatGPT's private Codex backend, which can change without notice. Using a ChatGPT subscription through a
  third-party gateway may not be permitted by OpenAI's terms; check them before relying on it.
- `max_tokens`, `stop_sequences` and `thinking` are not forwarded upstream.
- Content blocks the Responses API cannot represent (for example `document`) are replaced by a visible note, and tools
  without an `input_schema` (for example server-side web search) are dropped; both are logged as warnings.
- `count_tokens` is a heuristic (about four characters per token), not an exact count.
- A model name the account does not have falls back to the selected default model, with a one-time warning per name.

## Development

```bash
npm run typecheck
npm test
```

Tests run against the compiled output in `dist/` using the Node test runner, with local fake servers for the ChatGPT
upstream and auth endpoints. Nothing in the test suite contacts OpenAI or touches your real `~/.codex` directory.
