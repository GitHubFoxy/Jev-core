import assert from "node:assert/strict";
import test from "node:test";
import { redactHeaders, sessionId } from "../src/capture.ts";

test("redactHeaders masks credentials only", () => {
  const out = JSON.parse(redactHeaders({ authorization: "Bearer x", "x-api-key": "k", "user-agent": "claude-cli" }));
  assert.deepEqual(out, { authorization: "[redacted]", "x-api-key": "[redacted]", "user-agent": "claude-cli" });
});

test("sessionId prefers header, then Claude Code user_id, then prompt_cache_key", () => {
  const id = "0b1c2d3e-0000-4000-8000-123456789abc";
  assert.equal(sessionId({ "x-claude-code-session-id": "h1" }, {}), "h1");
  assert.equal(sessionId({}, { metadata: { user_id: `user_abc_account__session_${id}` } }), id);
  assert.equal(sessionId({}, { metadata: { user_id: JSON.stringify({ device_id: "d", session_id: id }) } }), id);
  assert.equal(sessionId({}, { prompt_cache_key: "pck" }), "pck");
  assert.equal(sessionId({}, undefined), "");
});
