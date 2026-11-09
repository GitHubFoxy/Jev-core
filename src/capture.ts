import type { IncomingHttpHeaders } from "node:http";

const SECRET_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie", "set-cookie"]);
const SESSION_HEADERS = ["x-claude-code-session-id", "x-opencode-session", "session_id", "x-session-id", "x-codex-session-id"];

/** Headers as JSON with credentials masked. Bodies are stored as-is. */
export function redactHeaders(h: IncomingHttpHeaders): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  return JSON.stringify(out);
}

/** Agent session id: explicit header first, then Claude Code metadata.user_id, then Codex prompt_cache_key. */
export function sessionId(h: IncomingHttpHeaders, body: unknown): string {
  for (const k of SESSION_HEADERS) {
    const v = h[k];
    if (typeof v === "string" && v) return v;
  }
  if (body && typeof body === "object") {
    const b = body as { metadata?: { user_id?: unknown }; prompt_cache_key?: unknown };
    const uid = b.metadata?.user_id;
    if (typeof uid === "string") {
      const m = /session_id"?\s*[:=]\s*"?([0-9a-f-]{36})/i.exec(uid) ?? /session_([0-9a-f-]{36})/i.exec(uid);
      if (m) return m[1];
    }
    if (typeof b.prompt_cache_key === "string") return b.prompt_cache_key;
  }
  return "";
}
