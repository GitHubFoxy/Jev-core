import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision, toOpenAI, toSystemOne, canTranslate, normalizeDecisions } from "../src/decisions.ts";

const systemRequest = () => ({
  model: "decision", state: { ticket: "Payment screen shows error" },
  questions: {
    urgent: { type: "predicate", instructions: "Is urgent?" },
    team: { type: "choice", instructions: "Select team", choices: { payments: "Billing", product: "Bugs" } },
    impact: { type: "score", instructions: "Rate impact", levels: ["Low", "Medium", "High"] }
  }
});
const nativeAnswers = {
  model: "gpt-6-luna",
  answers: [
    { name: "urgent", type: "predicate", probability: 0.82 },
    { name: "team", type: "choice", choice: "payments", confidence: 0.7, probabilities: [
      { value: "payments", probability: 0.7 }, { value: "product", probability: 0.3 }
    ] },
    { name: "impact", type: "score", score: 1.4, confidence: 0.56, probabilities: [
      { value: 0, label: "Low", probability: 0.1 },
      { value: 1, label: "Medium", probability: 0.4 },
      { value: 2, label: "High", probability: 0.5 }
    ] }
  ],
  usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 }
};
test("System One public request translates to native OpenAI question array", () => {
  const parsed = parseDecision(systemRequest());
  const native = toOpenAI(parsed, "gpt-6-luna");
  assert.equal(native.model, "gpt-6-luna");
  assert.equal(native.input, JSON.stringify(systemRequest().state));
  const qs = native.questions as Array<Record<string, unknown>>;
  assert.deepEqual(qs.map(q => q.name), ["urgent", "team", "impact"]);
  assert.deepEqual(qs[1].choices, [
    { value: "payments", description: "Billing" }, { value: "product", description: "Bugs" }
  ]);
  assert.deepEqual(qs[2].levels, [
    { label: "Low" }, { label: "Medium" }, { label: "High" }
  ]);
});
test("OpenAI native input maps to System One for compatible fallback", () => {
  const input = {
    model: "decision", input: "Customer asks for a refund",
    questions: [{ name: "team", type: "choice", instructions: "Which?", choices: [
      { value: "billing", description: "Payments" }, { value: "technical", description: "Software" }
    ] }]
  };
  const request = parseDecision(input);
  const system = toSystemOne(request, "typesafe/jev-1.13");
  assert.equal(system.state, input.input);
  assert.deepEqual({ ...(system.questions as Record<string, any>).team.criteria }, { billing: "Payments", technical: "Software" });
});
test("normalize named OpenAI arrays into System One response retaining true distributions", () => {
  const normalized = normalizeDecisions(nativeAnswers, parseDecision(systemRequest()), "decision");
  assert.equal(normalized.model, "decision");
  const a = normalized.answers as Record<string, any>;
  assert.equal(a.urgent.probability, 0.82);
  assert.equal(a.team.choice, "payments");
  assert.equal(a.team.probabilities.payments, 0.7);
  assert.equal(a.impact.score, 1.4);
  assert.equal(a.impact.probabilities["2"], 0.5);
  assert.deepEqual(normalized.usage, nativeAnswers.usage);
});
test("OpenAI wire-format caller receives ordered, named native-style answers", () => {
  const req = parseDecision({
    model: "decision", input: "text",
    questions: [
      { name: "urgent", type: "predicate", instructions: "Is urgent?" },
      { name: "team", type: "choice", instructions: "Choose", choices: [
        { value: "payments", description: "Billing" }, { value: "product", description: "Bugs" }
      ] },
      { name: "impact", type: "score", instructions: "Rate", levels: [
        { label: "Low" }, { label: "Medium" }, { label: "High" }
      ] }
    ]
  });
  const out = normalizeDecisions(nativeAnswers, req, "decision");
  assert.ok(Array.isArray(out.answers));
  const a = out.answers as Array<any>;
  assert.deepEqual(a.map(x => x.name), ["urgent", "team", "impact"]);
  assert.deepEqual(a[1].probabilities, nativeAnswers.answers[1].probabilities);
  assert.deepEqual(a[2].probabilities, nativeAnswers.answers[2].probabilities);
});
test("refusal and absent probability metadata never become fabricated answers", () => {
  const req = parseDecision({ model: "decision", state: "s", questions: {
    yes: { type: "predicate", instructions: "?" },
    team: { type: "choice", instructions: "?", choices: { a: "A", b: "B" } }
  } });
  const output = normalizeDecisions({ answers: { yes: { type: "refusal" }, team: { choice: "b" } } }, req, "decision");
  assert.deepEqual({ ...output.answers as Record<string, unknown> }, { yes: { type: "refusal" }, team: { type: "choice", choice: "b" } });
});
test("reject duplicate names, prototype keys, unrecognized choice and invalid distributions", () => {
  assert.throws(() => parseDecision({ model: "decision", state: "s", questions: {
    constructor: { type: "predicate", instructions: "?" }
  } }), /Invalid question ID/);
  assert.throws(() => parseDecision({ model: "decision", input: "s", questions: [
    { name: "a", type: "predicate", instructions: "?" },
    { name: "a", type: "predicate", instructions: "?" }
  ] }), /Duplicate question/);
  const req = parseDecision(systemRequest());
  assert.throws(() => normalizeDecisions({ answers: { ...Object.fromEntries(
    nativeAnswers.answers.map(a => [a.name, a])),
    team: { choice: "payments", probabilities: [{ value: "hacker", probability: 1 }] }
  } }, req, "decision"), /distribution/);
});
test("System One accepts JSON-array state but never sends it as native message objects", () => {
  const request = parseDecision({ model: "decision", state: ["ticket A", "ticket B"],
    questions: { urgent: { type: "predicate", instructions: "Urgent?" } } });
  assert.equal(canTranslate(request, "systemone"), true);
  assert.deepEqual(toSystemOne(request, "jev").state, ["ticket A", "ticket B"]);
  assert.equal(toOpenAI(request, "gpt-6-luna").input, '["ticket A","ticket B"]');
  const native = parseDecision({ model: "decision", input: [{ role: "user", content: "hello" }],
    questions: [{ name: "urgent", type: "predicate", instructions: "Urgent?" }] });
  assert.equal(canTranslate(native, "systemone"), false);
  assert.equal(canTranslate(native, "openai"), true);
});
