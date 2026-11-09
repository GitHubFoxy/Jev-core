CREATE DATABASE IF NOT EXISTS pag;

-- One row per request through the front. Bodies are stored as received (keys redacted in headers only).
CREATE TABLE IF NOT EXISTS pag.requests
(
    ts          DateTime64(3, 'UTC'),
    id          UUID,
    kind        LowCardinality(String),   -- proxy | decisions
    method      LowCardinality(String),
    path        String,
    status      UInt16,
    duration_ms UInt32,
    ttft_ms     UInt32,                   -- time to first response byte
    client_ip   String,
    user_agent  String,
    session_id  String,                   -- from agent session headers, may be empty
    model       String,                   -- model from the request body
    stream      UInt8,
    upstream    String,                   -- decisions: route that answered
    error       String,
    truncated   UInt8,                    -- 1 if a body hit the size cap
    req_headers String CODEC(ZSTD(3)),
    req_body    String CODEC(ZSTD(3)),
    res_headers String CODEC(ZSTD(3)),
    res_body    String CODEC(ZSTD(3))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (ts, id);
