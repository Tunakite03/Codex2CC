import assert from "node:assert/strict";
import test from "node:test";
import { BridgeError } from "../bridge/bridge.js";
import { getAppConfig, parsePort } from "./app-config.js";

test("app config resolves default, configured, and ephemeral ports consistently", () => {
  assert.deepEqual(getAppConfig({}), { port: 3456, gatewayUrl: "http://127.0.0.1:3456" });
  assert.deepEqual(getAppConfig({ PORT: " 4567 " }), { port: 4567, gatewayUrl: "http://127.0.0.1:4567" });
  assert.deepEqual(getAppConfig({ PORT: "0" }), { port: 0, gatewayUrl: "http://127.0.0.1:0" });
  assert.equal(parsePort("65535", "--port"), 65535);
  assert.equal(getAppConfig({ PORT: "" }).port, 3456);
});

test("invalid configured ports fail without echoing external input", () => {
  for (const raw of ["-1", "65536", "1.5", "1e3", "abc", " "]) {
    assert.throws(() => getAppConfig({ PORT: raw }), (error: Error) =>
      error instanceof BridgeError && error.code === "invalid_port"
      && error.message === "PORT must be an integer between 0 and 65535.");
  }
});
