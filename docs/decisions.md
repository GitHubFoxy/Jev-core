# Decisions API

`POST /v1/decisions` on the front returns structured decisions (predicate, choice, score). The model name is a stable alias (`decision`); routes behind it rotate round-robin, and a failed route falls through to the next. Client auth is the same key as the rest of the gateway (`Authorization: Bearer` or `x-api-key`).

## Routes

Configured in `decisions.routes` of `~/pag/front/config.json` (see `config.example.json`). Verified 2026-11-09:

| Route | Protocol | Status |
|---|---|---|
| `cloudflare-clef-flash` | `systemone`, URL carries the model, `omitModel: true` | works; Workers AI free tier 10 000 Neurons/day |
| `vercel-laya` | `openai` native, `https://ai-gateway.vercel.sh/v1/decisions`, model `convaiinnovations/laya` | works; near-zero cost, draws on the $5 monthly credit |
| `openrouter-jev` | `systemone`, `https://openrouter.ai/api/alpha/decisions` | disabled: `typesafe/jev-1.14` returns 402 without credits; `inception/mercury-decide:free` has no endpoints |

`convaiinnovations/laya-free` ended with the promo (2026-10-31). Vercel free tier is also blocked for `typesafe-ai/jev-*`. Provider pricing research: [jev-model-allowances.md](jev-model-allowances.md) (written 2026-10-17, partly stale).

## Request formats

System One:

```sh
curl http://omarchy.tail089ef.ts.net:8317/v1/decisions \
  -H "Authorization: Bearer $PAG_KEY" -H "Content-Type: application/json" \
  -d '{"model":"decision","state":{"ticket":"Checkout fails with HTTP 500"},
       "questions":{"urgent":{"type":"predicate","instructions":"Is this urgent?"},
                    "team":{"type":"choice","instructions":"Which team?","choices":{"billing":"Payments","engineering":"Application defects"}},
                    "sev":{"type":"score","instructions":"Impact","levels":["Low","Medium","High"]}}}'
```

OpenAI-native: send `input` (text or message array) and `questions` as an array of `{name, type, instructions, choices|levels}`. The response uses the same shape the caller sent: `answers{}` for System One, `answers[]` for native.

Native message-array input cannot go to a System One route without loss, so those routes are skipped. Choices must be strings; up to 64 questions. A question may return `{"type":"refusal"}`. Probabilities differ between providers; calibrate thresholds before automating decisions with them.

Every call (including failures and 401s) is logged in `pag.requests` with `kind = 'decisions'` and the answering route in `upstream`.
