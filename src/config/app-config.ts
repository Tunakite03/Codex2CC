import { existsSync } from "node:fs";
import { join } from "node:path";
import { BridgeError } from "../bridge/bridge.js";
import { resolveDataDir } from "../telemetry/logger.js";

export const DEFAULT_PORT = 3456;
export const DEFAULT_GATEWAY_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export interface AppConfig {
  readonly port: number;
  readonly gatewayUrl: string;
}

/** Load the shared data directory's .env without overriding the launching shell. */
export function loadAppEnvironment(): void {
  const path = join(resolveDataDir(process.env), ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function parsePort(raw: string | undefined, source: "PORT" | "--port"): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) > 65_535) {
    throw new BridgeError(400, "invalid_port", `${source} must be an integer between 0 and 65535.`);
  }
  return Number(value);
}

export function getAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const port = parsePort(env.PORT, "PORT");
  return { port, gatewayUrl: `http://127.0.0.1:${port}` };
}
