import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Preloaded into every test process (`node --test --import ./dist/test-setup.js`). Redirects every
 * file the gateway persists by default into a throwaway directory so running the suite can never
 * truncate or overwrite the developer's live `logs/` data.
 */
const sandbox: string = mkdtempSync(join(tmpdir(), "codex2cc-test-"));

process.env.CODEX2CC_LOG_FILE = join(sandbox, "codex2cc.log");
process.env.CODEX2CC_SETTINGS_FILE = join(sandbox, "settings.json");
process.env.CODEX2CC_USAGE_FILE = join(sandbox, "usage.json");
process.env.CODEX2CC_HOME = sandbox;
// Claude Code and Claude Desktop config paths resolve from the home directory; control panel routes
// rewrite the applied Desktop config, so they must never reach the developer's real one.
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.APPDATA = join(sandbox, "AppData", "Roaming");
process.env.LOCALAPPDATA = join(sandbox, "AppData", "Local");
