"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildPublishableSuggestion,
  sanitizedChildEnvironment,
  validateBalancePayload,
  validatePublicMarketPayload,
} = require("../lib/codex-advisory-core");

const ROOT = path.resolve(__dirname, "..");
const NOW = Date.parse("2026-07-18T07:00:00.000Z");

function balance(overrides = {}) {
  return {
    availableCash: 8.3192,
    checkedAt: new Date(NOW - 10_000).toISOString(),
    source: "Local read-only account balance",
    ...overrides,
  };
}

function model(overrides = {}) {
  const trustedMarketUrl = "https://external-api.kalshi.com/trade-api/v2/markets/TEST-EVENT-YES";
  return {
    action: "BUY",
    trustedPublicQuote: true,
    trustedPublicMarketUrl: trustedMarketUrl,
    ticker: "TEST-EVENT-YES",
    title: "Will the test event happen?",
    marketUrl: trustedMarketUrl,
    rulesUrl: trustedMarketUrl,
    marketCloseTime: new Date(NOW + 60 * 60_000).toISOString(),
    side: "YES",
    contracts: 5,
    recommendedAmountDollars: 2.2,
    quotedAskDollars: 0.43,
    quoteObservedAt: new Date(NOW - 10_000).toISOString(),
    limitPriceDollars: 0.42,
    estimatedProbability: 0.55,
    confidence: 0.8,
    takeProfitPriceDollars: 0.58,
    stopLossPriceDollars: 0.32,
    validForMinutes: 5,
    exitWithinMinutes: 4,
    entryInstruction: "Buy only at 42 cents or less while the cited evidence remains current.",
    exitInstruction: "Sell at 58 cents, at 32 cents, or at the time deadline, whichever comes first.",
    rationale: "Current primary evidence implies a material short-lived edge.",
    sources: [
      {
        kind: "MARKET",
        label: "Official market page",
        source: "Kalshi",
        publishedAt: new Date(NOW - 30 * 60_000).toISOString(),
        url: trustedMarketUrl,
      },
      {
        kind: "RULES",
        label: "Official market rules",
        source: "Kalshi",
        publishedAt: new Date(NOW - 24 * 60 * 60_000).toISOString(),
        url: trustedMarketUrl,
      },
      {
        kind: "PRIMARY_EVIDENCE",
        label: "Primary current evidence",
        source: "Primary authority",
        publishedAt: new Date(NOW - 20_000).toISOString(),
        url: "https://example.gov/current-evidence",
      },
    ],
    ...overrides,
  };
}

test("balance validation requires a fresh read while funded trading is disabled", () => {
  const payload = {
    configured: true,
    configError: null,
    fundedTradingEnabled: false,
    accountBalance: balance(),
  };
  assert.deepEqual(validateBalancePayload(payload, NOW), balance());
  assert.throws(
    () => validateBalancePayload({ ...payload, fundedTradingEnabled: true }, NOW),
    /funded trading must be disabled/i,
  );
  assert.throws(
    () => validateBalancePayload({ ...payload, accountBalance: balance({ checkedAt: new Date(NOW - 60_001).toISOString() }) }, NOW),
    /stale/i,
  );
});

test("trusted sizing floors ten percent of live cash and independently reduces contracts", () => {
  const result = buildPublishableSuggestion(model(), balance(), NOW);

  assert.equal(result.actionable, true);
  assert.equal(result.failClosedReason, null);
  assert.equal(Math.floor(balance().availableCash * 0.1 * 100) / 100, 0.83);
  assert.equal(result.suggestion.contracts, 1);
  assert.equal(result.suggestion.limitPriceDollars, 0.42);
  assert.equal(result.suggestion.estimatedFeeDollars, 0.02);
  assert.equal(result.suggestion.maxLossDollars, 0.44);
  assert.ok(result.suggestion.maxLossDollars <= 0.83);
  assert.match(result.suggestion.entryInstruction, /at or below \$0\.44/);
  assert.equal(Date.parse(result.suggestion.expiresAt) - NOW, 50_000);
  assert.equal(Date.parse(result.suggestion.exitBy) - NOW, 4 * 60_000);
});

test("trusted instructions ignore contradictory model-written execution prose", () => {
  const result = buildPublishableSuggestion(model({
    entryInstruction: "Buy 999 contracts and chase the price to any level.",
    exitInstruction: "Never sell and keep adding contracts.",
  }), balance(), NOW);

  assert.equal(result.actionable, true);
  assert.doesNotMatch(result.suggestion.entryInstruction, /999|chase the price to any level/i);
  assert.doesNotMatch(result.suggestion.exitInstruction, /never sell|keep adding/i);
  assert.match(result.suggestion.entryInstruction, /exactly 1 contract/i);
  assert.match(result.suggestion.exitInstruction, /never increase the position/i);
});

test("actionable acceptance expires before either trusted snapshot becomes stale", () => {
  const quoteAt = NOW - 20_000;
  const cashAt = NOW - 5_000;
  const result = buildPublishableSuggestion(
    model({ quoteObservedAt: new Date(quoteAt).toISOString() }),
    balance({ checkedAt: new Date(cashAt).toISOString() }),
    NOW,
  );

  assert.equal(result.actionable, true);
  assert.equal(Date.parse(result.suggestion.expiresAt), quoteAt + 60_000);
  assert.ok(Date.parse(result.suggestion.expiresAt) <= cashAt + 60_000);
});

test("a contract that cannot fit the strict cash cap fails closed to WAIT", () => {
  const result = buildPublishableSuggestion(model({
    quotedAskDollars: 0.83,
    limitPriceDollars: 0.82,
    estimatedProbability: 0.9,
    takeProfitPriceDollars: 0.94,
    stopLossPriceDollars: 0.7,
  }), balance(), NOW);

  assert.equal(result.actionable, false);
  assert.equal(result.suggestion.action, "WAIT");
  assert.match(result.failClosedReason, /no whole contract fits/i);
});

test("stale quotes, overlong validity, SELL, and missing rules all fail closed", async (t) => {
  const cases = [
    ["stale quote", model({ quoteObservedAt: new Date(NOW - 60_001).toISOString() }), /stale/],
    ["overlong validity", model({ validForMinutes: 6 }), /validity/],
    ["SELL", model({ action: "SELL" }), /only.*BUY.*WAIT/i],
    ["missing rules", model({ rulesUrl: null }), /rules.*trusted public ticker/i],
  ];
  for (const [name, input, expected] of cases) {
    await t.test(name, () => {
      const result = buildPublishableSuggestion(input, balance(), NOW);
      assert.equal(result.actionable, false);
      assert.equal(result.suggestion.action, "WAIT");
      assert.match(result.failClosedReason, expected);
      assert.ok(Date.parse(result.suggestion.expiresAt) - NOW <= 5 * 60_000);
    });
  }
});

test("balance must still be fresh when the trusted wrapper publishes", () => {
  const result = buildPublishableSuggestion(
    model(),
    balance({ checkedAt: new Date(NOW - 60_001).toISOString() }),
    NOW,
  );
  assert.equal(result.actionable, false);
  assert.equal(result.suggestion.action, "WAIT");
  assert.match(result.failClosedReason, /available cash.*stale/i);
});

test("trusted public market validation overwrites the model quote only for an open exact ticker", () => {
  const quote = validatePublicMarketPayload({
    market: {
      ticker: "TEST-EVENT-YES",
      title: "Verified public title",
      status: "active",
      close_time: new Date(NOW + 60 * 60_000).toISOString(),
      rules_primary: "This market resolves Yes if the official primary source reports the event.",
      yes_ask_dollars: "0.41",
      no_ask_dollars: "0.61",
    },
  }, {
    ticker: "TEST-EVENT-YES",
    side: "YES",
    officialUrl: "https://external-api.kalshi.com/trade-api/v2/markets/TEST-EVENT-YES",
    observedAtMs: NOW,
  });

  assert.equal(quote.trustedPublicQuote, true);
  assert.equal(quote.quotedAskDollars, 0.41);
  assert.equal(quote.quoteObservedAt, new Date(NOW).toISOString());
  assert.throws(
    () => validatePublicMarketPayload({ market: { ticker: "OTHER", status: "active", close_time: new Date(NOW + 60_000), rules_primary: "rules", yes_ask: 42 } }, { ticker: "TEST-EVENT-YES", side: "YES", officialUrl: "https://external-api.kalshi.com/trade-api/v2/markets/TEST-EVENT-YES", observedAtMs: NOW }),
    /ticker did not match/i,
  );
  assert.throws(
    () => validatePublicMarketPayload({ market: { ticker: "TEST-EVENT-YES", status: "closed", close_time: new Date(NOW + 60_000), rules_primary: "rules", yes_ask: 42 } }, { ticker: "TEST-EVENT-YES", side: "YES", officialUrl: "https://external-api.kalshi.com/trade-api/v2/markets/TEST-EVENT-YES", observedAtMs: NOW }),
    /not open/i,
  );
});

test("missing trusted quote and stale or future source evidence fail closed", async (t) => {
  const cases = [
    ["untrusted quote", model({ trustedPublicQuote: false }), /trusted public Kalshi quote/i],
    ["stale primary evidence", model({
      sources: model().sources.map((source) => source.kind === "PRIMARY_EVIDENCE"
        ? { ...source, publishedAt: new Date(NOW - 6 * 60 * 60_000 - 1).toISOString() }
        : source),
    }), /six hours old/i],
    ["future rules timestamp", model({
      sources: model().sources.map((source) => source.kind === "RULES"
        ? { ...source, publishedAt: new Date(NOW + 30_001).toISOString() }
        : source),
    }), /valid non-future timestamp/i],
  ];
  for (const [name, input, expected] of cases) {
    await t.test(name, () => {
      const result = buildPublishableSuggestion(input, balance(), NOW);
      assert.equal(result.actionable, false);
      assert.equal(result.suggestion.action, "WAIT");
      assert.match(result.failClosedReason, expected);
    });
  }
});

test("explicit Codex WAIT remains non-actionable", () => {
  const result = buildPublishableSuggestion({ action: "WAIT", rationale: "No verified edge." }, balance(), NOW);
  assert.equal(result.actionable, false);
  assert.equal(result.suggestion.action, "WAIT");
  assert.match(result.suggestion.rationale, /No verified edge/);
});

test("child environment removes provider, exchange, token, and private-key secrets", () => {
  const safe = sanitizedChildEnvironment({
    Path: "safe-path",
    USERPROFILE: "saved-login-profile",
    APPDATA: "saved-login-appdata",
    LOCALAPPDATA: "saved-login-local-appdata",
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    CODEX_ACCESS_TOKEN: "secret",
    KALSHI_API_KEY_ID: "secret",
    POLYMARKET_PRIVATE_KEY: "secret",
    LLAMA_API_KEY: "secret",
    SOME_PASSWORD: "secret",
    AWS_ACCESS_KEY_ID: "secret",
  });
  assert.deepEqual(safe, {
    Path: "safe-path",
    USERPROFILE: "saved-login-profile",
    APPDATA: "saved-login-appdata",
    LOCALAPPDATA: "saved-login-local-appdata",
  });
});

test("runner is structurally read-only and delegates only to the local publisher", () => {
  const runner = fs.readFileSync(path.join(ROOT, "scripts", "codex_advisory_loop.mjs"), "utf8");
  assert.match(runner, /"--sandbox", "read-only"/);
  assert.match(runner, /"--ephemeral"/);
  assert.match(runner, /"--ignore-user-config"/);
  assert.match(runner, /"--strict-config"/);
  assert.match(runner, /"--output-schema"/);
  for (const feature of [
    "shell_tool",
    "plugins",
    "apps",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "in_app_browser",
    "computer_use",
    "multi_agent",
  ]) {
    assert.match(runner, new RegExp(`"--disable", "${feature}"`));
  }
  assert.match(runner, /"-m", "gpt-5\.6-sol"/);
  assert.match(runner, /model_provider=\\?"openai\\?"/);
  assert.match(runner, /model_reasoning_effort=\\?"high\\?"/);
  assert.match(runner, /web_search=\\?"live\\?"/);
  assert.match(runner, /shell_environment_policy\.inherit=\\?"none\\?"/);
  assert.match(runner, /project_doc_max_bytes=0/);
  assert.doesNotMatch(runner, /--ignore-rules/);
  assert.match(runner, /trade_suggestion_cli\.mjs["']?\), "publish", "--stdin"/);
  assert.match(runner, /fundedTradingMustBeDisabled:\s*true/);
  assert.match(runner, /orderSubmissionCapable:\s*false/);
  assert.match(runner, /retainStderr:\s*true/);
  assert.match(runner, /result\.stdout.*result\.stderr/s);
  assert.match(runner, /FINALIZATION_RESERVE_MS/);
  assert.match(runner, /operationalDeadlineMs/);
  assert.match(runner, /boundedTimeoutMs\(/);
  assert.match(runner, /https:\/\/external-api\.kalshi\.com\/trade-api\/v2\/markets/);
  assert.doesNotMatch(runner, /trade-api\/v2\/(?:portfolio|orders)\b|kalshiRequest\s*\(|fetch\s*\([^)]*\/(?:portfolio|orders)\b/i);
  assert.doesNotMatch(runner, /\.accept\s*\(|placeKalshiLiveOrder|submitKalshiOrder/i);
});
