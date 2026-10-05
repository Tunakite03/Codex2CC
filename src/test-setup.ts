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
