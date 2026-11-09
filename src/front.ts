/**
 * PAG front: sits in front of CLIProxyAPI, records every POST to ClickHouse,
 * and serves /v1/decisions itself (CLIProxyAPI has no Decisions API).
 * Config: JSON file from $PAG_FRONT_CONFIG (see config.example.json).
 */
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { canTranslate, normalizeDecisions, parseDecision, toProviderDecision } from "./decisions.ts";
import { redactHeaders, sessionId } from "./capture.ts";

type Route = { name: string; protocol: "systemone" | "openai"; url: string; keyFile: string; model: string; omitModel?: boolean; enabled?: boolean };
type Config = {
  listen: { host: string; port: number };
  upstream: string;
  clientKeyFile: string;
  clickhouse: { url: string; user: string; passFile: string };
  decisions: { alias: string; routes: Route[] };
};

const cfg: Config = JSON.parse(readFileSync(process.env.PAG_FRONT_CONFIG ?? "config.json", "utf8"));
const secret = (f: string) => readFileSync(f, "utf8").trim();
const clientKey = Buffer.from(secret(cfg.clientKeyFile));
const chPass = secret(cfg.clickhouse.passFile);
const routes = cfg.decisions.routes.filter(r => r.enabled !== false).map(r => ({ ...r, key: secret(r.keyFile) }));
const upstream = new URL(cfg.upstream);
const BODY_CAP = 32 * 1024 * 1024; // stored per body; forwarding is never truncated
const QUEUE_CAP = 2000;

type Row = Record<string, string | number>;
const queue: Row[] = [];

async function flush(): Promise<void> {
  if (!queue.length) return;
  const batch = queue.splice(0);
  try {
    const q = encodeURIComponent("INSERT INTO pag.requests FORMAT JSONEachRow");
    const r = await fetch(`${cfg.clickhouse.url}/?query=${q}&date_time_input_format=best_effort`, {
      method: "POST",
      headers: { "X-ClickHouse-User": cfg.clickhouse.user, "X-ClickHouse-Key": chPass },
      body: batch.map(x => JSON.stringify(x)).join("\n"),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  } catch (e) {
    console.error("clickhouse insert failed:", (e as Error).message);
    queue.unshift(...batch);
    if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP); // drop oldest
  }
}
setInterval(flush, 2000).unref();

const cap = (b: Buffer): [string, number] => b.length > BODY_CAP ? [b.subarray(0, BODY_CAP).toString("utf8"), 1] : [b.toString("utf8"), 0];
const jsonOrUndefined = (b: Buffer): any => { try { return JSON.parse(b.toString("utf8")); } catch { return undefined; } };

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: http.IncomingMessage): boolean {
  const h = req.headers;
  const given = typeof h["x-api-key"] === "string" ? h["x-api-key"] : String(h.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  return a.length === clientKey.length && timingSafeEqual(a, clientKey);
}

function send(res: http.ServerResponse, status: number, body: unknown): string {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
  return text;
}

let rr = 0;
async function decisions(req: http.IncomingMessage, res: http.ServerResponse, base: Row, reqBody: Buffer) {
  const start = Date.now();
  const done = (status: number, body: unknown, upstreamName = "", error = "") => {
    const text = send(res, status, body);
    queue.push({ ...base, status, duration_ms: Date.now() - start, upstream: upstreamName, error, res_body: text, res_headers: "{}" });
  };
  if (!authorized(req)) return done(401, { error: "invalid key" });
  const body = jsonOrUndefined(reqBody);
  if (!body || typeof body !== "object") return done(400, { error: "invalid JSON" });
  let dec;
  try { dec = parseDecision(body); } catch (e) { return done(422, { error: (e as Error).message }); }
  const alias = String(body.model ?? cfg.decisions.alias);
  const errors: string[] = [];
  const first = rr++;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[(first + i) % routes.length];
    if (!canTranslate(dec, r.protocol)) continue;
    try {
      const out = toProviderDecision(dec, r.model, r.protocol);
      if (r.omitModel) delete out.model;
      const up = await fetch(r.url, {
        method: "POST",
        headers: { authorization: `Bearer ${r.key}`, "content-type": "application/json" },
        body: JSON.stringify(out),
        signal: AbortSignal.timeout(30_000),
      });
      if (!up.ok) throw new Error(`HTTP ${up.status} ${(await up.text()).slice(0, 200)}`);
      return done(200, normalizeDecisions(await up.json(), dec, alias), r.name);
    } catch (e) {
      errors.push(`${r.name}: ${(e as Error).message}`);
    }
  }
  done(502, { error: "all decision routes failed", details: errors }, "", errors.join(" | "));
}

async function proxy(req: http.IncomingMessage, res: http.ServerResponse, base: Row, reqBody: Buffer, log: boolean) {
  const start = Date.now();
  let ttft = 0, finished = false;
  const out: Buffer[] = [];
  let outSize = 0;
  const finish = (status: number, resHeaders: string, error = "") => {
    if (finished) return;
    finished = true;
    if (!log) return;
    const [res_body, t2] = cap(Buffer.concat(out));
    queue.push({ ...base, status, duration_ms: Date.now() - start, ttft_ms: ttft, error, res_headers: resHeaders, res_body, truncated: (base.truncated as number) | t2 | (outSize > BODY_CAP ? 1 : 0) });
  };
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["accept-encoding"]; // keep upstream bodies readable in the log
  headers["content-length"] = String(reqBody.length);
  delete headers["transfer-encoding"];
  const up = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers }, ures => {
    const h = { ...ures.headers };
    delete h.connection; delete h["keep-alive"];
    res.writeHead(ures.statusCode ?? 502, h);
    ures.on("data", (c: Buffer) => {
      if (!ttft) ttft = Date.now() - start;
      if (outSize < BODY_CAP) out.push(c);
      outSize += c.length;
    });
    ures.on("end", () => finish(ures.statusCode ?? 502, redactHeaders(ures.headers)));
    ures.on("error", e => finish(502, "{}", e.message));
    ures.pipe(res);
  });
  up.on("error", e => {
    if (!res.headersSent) send(res, 502, { error: "upstream unreachable: " + e.message }); else res.destroy();
    finish(502, "{}", e.message);
  });
  res.on("close", () => { if (!finished) { up.destroy(); finish(499, "{}", "client closed"); } });
  up.end(reqBody);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/healthz") return void res.end("ok");
  const post = req.method === "POST";
  let reqBody: Buffer;
  try { reqBody = await readBody(req); } catch { return void res.destroy(); }
  const parsed = post ? jsonOrUndefined(reqBody) : undefined;
  const [req_body, truncated] = cap(reqBody);
  const base: Row = {
    ts: new Date().toISOString(), id: randomUUID(), kind: path === "/v1/decisions" ? "decisions" : "proxy",
    method: req.method ?? "", path, status: 0, duration_ms: 0, ttft_ms: 0,
    client_ip: req.socket.remoteAddress ?? "", user_agent: String(req.headers["user-agent"] ?? ""),
    session_id: sessionId(req.headers, parsed), model: String(parsed?.model ?? ""), stream: parsed?.stream === true ? 1 : 0,
    upstream: "", error: "", truncated, req_headers: redactHeaders(req.headers), req_body, res_headers: "{}", res_body: "",
  };
  if (post && path === "/v1/decisions") return decisions(req, res, base, reqBody);
  return proxy(req, res, base, reqBody, post);
});
server.requestTimeout = 0;
server.timeout = 0;
server.listen(cfg.listen.port, cfg.listen.host, () => console.log(`pag-front on ${cfg.listen.host}:${cfg.listen.port} -> ${cfg.upstream}`));

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); flush().finally(() => process.exit(0)); });
