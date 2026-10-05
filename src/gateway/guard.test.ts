import assert from "node:assert/strict";
import test from "node:test";
import { checkClient, checkHost, requestPathname, type GuardPolicy } from "./guard.js";

const tokenPolicy: GuardPolicy = { mode: "token", token: "s3cret-token-value-1234" };

test("checkHost accepts loopback names with or without a port", () => {
  for (const host of ["127.0.0.1:3456", "localhost", "LOCALHOST:80", "[::1]:3456"]) {
    assert.deepEqual(checkHost({ host }), { ok: true }, host);
  }
});

test("checkHost rejects rebinding hosts and a missing Host header", () => {
  for (const headers of [{ host: "evil.example:3456" }, { host: "127.0.0.1.evil.example" }, {}]) {
    const result = checkHost(headers);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
  }
});

test("checkClient accepts the token as Bearer or x-api-key", () => {
  assert.deepEqual(checkClient({ authorization: "Bearer s3cret-token-value-1234" }, tokenPolicy), { ok: true });
  assert.deepEqual(checkClient({ authorization: "bearer s3cret-token-value-1234" }, tokenPolicy), { ok: true });
  assert.deepEqual(checkClient({ "x-api-key": "s3cret-token-value-1234" }, tokenPolicy), { ok: true });
});

test("checkClient rejects missing, wrong and malformed credentials with 401", () => {
  const rejected = [
    {},
    { authorization: "Bearer nope" },
    { authorization: "Basic s3cret-token-value-1234" },
    { authorization: "Bearer s3cret-token-value-1234 extra" },
    { "x-api-key": "" },
  ];
  for (const headers of rejected) {
    const result = checkClient(headers, tokenPolicy);
    assert.equal(result.ok, false, JSON.stringify(headers));
    if (!result.ok) assert.equal(result.status, 401);
  }
});

test("open mode allows header-less clients but refuses browser Origin", () => {
  assert.deepEqual(checkClient({}, { mode: "open" }), { ok: true });
  const result = checkClient({ origin: "https://evil.example" }, { mode: "open" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.status, 403);
});

test("requestPathname extracts the path and returns undefined for malformed request targets", () => {
  assert.equal(requestPathname("/v1/messages?beta=true"), "/v1/messages");
  assert.equal(requestPathname(undefined), "/");
  assert.equal(requestPathname("http://["), undefined);
});
