import test from "node:test";
import assert from "node:assert/strict";
import {
  aliceResponse,
  extractUserText,
  fitAliceText,
  isLaunchUtterance,
  isSearchIntent,
  resolveProvider,
  safeHistory
} from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse(
    "Привет",
    false,
    [{ role: "user", text: "тест" }],
    { version: "1.0", session: { session_id: "abc", message_id: 0, user_id: "u1" } }
  );
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.tts, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
  assert.equal(result.session, undefined);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("launch utterances are ignored so skill open does not call the LLM", () => {
  assert.equal(isLaunchUtterance("запусти навык умный помощник"), true);
  assert.equal(isLaunchUtterance("Алиса, открой навык тест"), true);
  assert.equal(isLaunchUtterance("какая погода"), false);
  assert.equal(
    extractUserText({
      session: { new: true },
      request: { command: "", original_utterance: "запусти навык тест" }
    }),
    ""
  );
  assert.equal(
    extractUserText({
      session: { new: false },
      request: { command: "привет", original_utterance: "привет" }
    }),
    "привет"
  );
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("resolveProvider defaults to gemini and accepts openai/deepseek", () => {
  const previous = process.env.LLM_PROVIDER;
  try {
    delete process.env.LLM_PROVIDER;
    assert.equal(resolveProvider(), "gemini");
    process.env.LLM_PROVIDER = "OpenAI";
    assert.equal(resolveProvider(), "openai");
    process.env.LLM_PROVIDER = "deepseek";
    assert.equal(resolveProvider(), "deepseek");
    process.env.LLM_PROVIDER = "claude";
    assert.throws(() => resolveProvider(), /INVALID_LLM_PROVIDER/);
  } finally {
    if (previous === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previous;
  }
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-llm-serper");
  assert.equal(payload.provider, "gemini");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});
