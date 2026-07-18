"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("node:events");
const { createAiEngine } = require("../lib/ai-engine");

// Intercept https.request so the chat-completions call never leaves the machine
// and its Authorization header can be inspected.
function mockHttps(t) {
  const captured = [];
  const original = https.request;
  https.request = (url, options, cb) => {
    captured.push({ url: String(url), headers: options.headers });
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => {
      setImmediate(() => {
        cb(res);
        setImmediate(() => {
          res.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        action: "SKIP",
                        side: "UP",
                        probability: 0.5,
                        confidence: 0.5,
                        rationale: "test",
                      }),
                    },
                  },
                ],
              }),
            ),
          );
          res.emit("end");
        });
      });
    };
    return req;
  };
  t.after(() => {
    https.request = original;
  });
  return captured;
}

function seededEngine(env) {
  const engine = createAiEngine(env);
  // Preload news so evaluate() skips the RSS fetch and reaches the model call.
  engine.hydrate({
    news: {
      headlines: [{ title: "headline", source: "src", publishedAt: new Date().toISOString() }],
      refreshedAt: new Date().toISOString(),
    },
  });
  return engine;
}

const KALSHI_INPUT = {
  venue: "kalshi",
  mode: "paper",
  marketId: "TEST-MARKET",
  side: "YES",
  price: 0.5,
  signal: { side: "YES" },
  market: {},
};

test("apiKeys reports each dedicated key independently", () => {
  const both = createAiEngine({ LLAMA_API_KEY: "llama-key", NVIDIA_API_KEY: "nvidia-key" });
  assert.equal(both.state.configured, true);
  assert.deepEqual(both.state.apiKeys, { llama: true, nemotron: true });

  const nvidiaOnly = createAiEngine({ NVIDIA_API_KEY: "nvidia-key" });
  assert.equal(nvidiaOnly.state.configured, true);
  assert.deepEqual(nvidiaOnly.state.apiKeys, { llama: false, nemotron: true });

  const llamaOnly = createAiEngine({ LLAMA_API_KEY: "llama-key" });
  assert.equal(llamaOnly.state.configured, true);
  assert.deepEqual(llamaOnly.state.apiKeys, { llama: true, nemotron: false });
});

test("selecting nemotron authenticates with NVIDIA_API_KEY", async (t) => {
  const captured = mockHttps(t);
  const engine = seededEngine({ LLAMA_API_KEY: "llama-secret", NVIDIA_API_KEY: "nvidia-secret" });
  await engine.evaluate({ ...KALSHI_INPUT, model: "nemotron" });
  const completions = captured.filter((row) => row.url.includes("chat/completions"));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].headers.authorization, "Bearer nvidia-secret");
});

test("selecting llama authenticates with LLAMA_API_KEY", async (t) => {
  const captured = mockHttps(t);
  const engine = seededEngine({ LLAMA_API_KEY: "llama-secret", NVIDIA_API_KEY: "nvidia-secret" });
  await engine.evaluate({ ...KALSHI_INPUT, model: "llama" });
  const completions = captured.filter((row) => row.url.includes("chat/completions"));
  assert.equal(completions.length, 1);
  assert.equal(completions[0].headers.authorization, "Bearer llama-secret");
});

test("nemotron falls back to LLAMA_API_KEY when NVIDIA_API_KEY is unset", async (t) => {
  const captured = mockHttps(t);
  const engine = seededEngine({ LLAMA_API_KEY: "llama-secret" });
  await engine.evaluate({ ...KALSHI_INPUT, model: "nemotron" });
  const completions = captured.filter((row) => row.url.includes("chat/completions"));
  assert.equal(completions[0].headers.authorization, "Bearer llama-secret");
});

test("evaluate blocks and explains when neither model key is configured", async () => {
  const engine = createAiEngine({});
  assert.equal(engine.state.configured, false);
  const decision = await engine.evaluate({ ...KALSHI_INPUT, model: "nemotron" });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /LLAMA_API_KEY or NVIDIA_API_KEY/);
});
