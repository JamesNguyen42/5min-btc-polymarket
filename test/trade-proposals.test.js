"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTradeProposalStore } = require("../lib/trade-proposals");

const NOW = Date.parse("2026-07-17T22:00:00.000Z");

function buySuggestion(overrides = {}) {
  return {
    action: "BUY",
    ticker: "TEST-EVENT-YES",
    title: "Will the test event happen?",
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    rationale: "The evidence supports a modest YES entry at this limit or better.",
    sources: [
      { label: "Primary report", url: "https://example.com/report" },
      "Operator observation",
    ],
    entryInstruction: "Buy 2 YES contracts only at $0.42 or better.",
    exitInstruction: "Sell at $0.70, stop at $0.20, or exit by the stated deadline.",
    side: "YES",
    contracts: 2,
    limitPriceDollars: 0.42,
    estimatedFeeDollars: 0.03,
    maxLossDollars: 0.87,
    takeProfitPriceDollars: 0.7,
    stopLossPriceDollars: 0.2,
    exitBy: new Date(NOW + 4 * 60_000).toISOString(),
    ...overrides,
  };
}

function sellSuggestion(overrides = {}) {
  return {
    action: "SELL",
    ticker: "TEST-EVENT-NO",
    title: "Reduce the existing NO position",
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    rationale: "The current quote offers a controlled exit from the existing position.",
    sources: [{ label: "Local position review" }],
    entryInstruction: "Sell 1 NO contract at $0.61 or better.",
    exitInstruction: "Cancel the idea if the limit is unavailable; do not chase the quote.",
    side: "NO",
    contracts: 1,
    limitPriceDollars: 0.61,
    estimatedFeeDollars: 0.02,
    maxLossDollars: 0.41,
    ...overrides,
  };
}

function waitSuggestion(overrides = {}) {
  return {
    action: "WAIT",
    ticker: "TEST-EVENT",
    title: "Wait for a clearer test-event quote",
    expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
    rationale: "No entry or exit is justified at the current quote.",
    sources: ["Local review"],
    ...overrides,
  };
}

function createFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trade-suggestions-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = options.now ?? NOW;
  const store = createTradeProposalStore({
    runtimeDir: path.join(directory, "runtime"),
    now: () => clock,
  });
  return {
    directory,
    store,
    setNow(value) {
      clock = value;
    },
  };
}

function readEvents(store) {
  if (!fs.existsSync(store.paths.eventsPath)) return [];
  return fs.readFileSync(store.paths.eventsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function acceptanceEvents(store) {
  return readEvents(store).filter((row) => /accepted/i.test(String(row.kind || "")));
}

function validConfirmation(suggestion) {
  return {
    confirmProposalId: suggestion.id,
    acknowledgeLocalAcceptance: true,
  };
}

test("publishing a BUY suggestion preserves its exact entry and exit plan", (t) => {
  const { store } = createFixture(t);
  const input = buySuggestion();
  const suggestion = store.publish(input);

  assert.equal(suggestion.action, "BUY");
  assert.equal(suggestion.status, "live");
  assert.equal(suggestion.canAccept, true);
  assert.equal(suggestion.source, "codex_cli");
  assert.equal(suggestion.ticker, input.ticker);
  assert.equal(suggestion.title, input.title);
  assert.equal(suggestion.side, "YES");
  assert.equal(suggestion.contracts, 2);
  assert.equal(suggestion.limitPriceDollars, 0.42);
  assert.equal(suggestion.estimatedFeeDollars, 0.03);
  assert.equal(suggestion.maxLossDollars, 0.87);
  assert.equal(suggestion.takeProfitPriceDollars, 0.7);
  assert.equal(suggestion.stopLossPriceDollars, 0.2);
  assert.equal(suggestion.exitBy, input.exitBy);
  assert.equal(suggestion.entryInstruction, input.entryInstruction);
  assert.equal(suggestion.exitInstruction, input.exitInstruction);
  assert.equal(suggestion.rationale, input.rationale);
  assert.equal(suggestion.manualExecutionRequired, true);
  assert.equal(suggestion.orderSubmitted, false);
  assert.match(suggestion.id, /^[0-9a-f-]{36}$/i);
  assert.match(suggestion.digest, /^[0-9a-f]{64}$/i);
  assert.deepEqual(store.current(), suggestion);
});

test("a fresh entry window may expire before its deterministic post-entry exit deadline", (t) => {
  const { store, setNow } = createFixture(t);
  const input = buySuggestion({
    expiresAt: new Date(NOW + 50_000).toISOString(),
    exitBy: new Date(NOW + 4 * 60_000).toISOString(),
  });
  const suggestion = store.publish(input);

  assert.equal(suggestion.status, "live");
  assert.equal(suggestion.exitBy, input.exitBy);
  setNow(NOW + 50_000);
  assert.equal(store.current().status, "expired");
});

test("publishing a SELL suggestion preserves the position-reduction instructions", (t) => {
  const { store } = createFixture(t);
  const input = sellSuggestion();
  const suggestion = store.publish(input);

  assert.equal(suggestion.action, "SELL");
  assert.equal(suggestion.status, "live");
  assert.equal(suggestion.canAccept, true);
  assert.equal(suggestion.side, "NO");
  assert.equal(suggestion.contracts, 1);
  assert.equal(suggestion.limitPriceDollars, 0.61);
  assert.equal(suggestion.entryInstruction, input.entryInstruction);
  assert.equal(suggestion.exitInstruction, input.exitInstruction);
  assert.equal(suggestion.manualExecutionRequired, true);
  assert.equal(suggestion.orderSubmitted, false);
});

test("a scheduled suggestion becomes live exactly at validFrom", (t) => {
  const validFrom = NOW + 60_000;
  const { store, setNow } = createFixture(t);
  const scheduled = store.publish(buySuggestion({
    validFrom: new Date(validFrom).toISOString(),
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
  }));

  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.canAccept, false);
  assert.throws(() => store.accept(scheduled.id, validConfirmation(scheduled)), /scheduled|cannot be accepted|not live/i);

  setNow(validFrom);
  const live = store.current();
  assert.equal(live.status, "live");
  assert.equal(live.canAccept, true);
  assert.equal(live.orderSubmitted, false);
});

test("a suggestion expires at the exact deadline and cannot be accepted", (t) => {
  const { store, setNow } = createFixture(t);
  const suggestion = store.publish(buySuggestion());
  setNow(Date.parse(suggestion.expiresAt));

  const expired = store.current();
  assert.equal(expired.status, "expired");
  assert.equal(expired.canAccept, false);
  assert.equal(expired.orderSubmitted, false);
  assert.throws(() => store.accept(suggestion.id, validConfirmation(suggestion)), /expired|cannot be accepted|not live/i);
  assert.equal(acceptanceEvents(store).length, 0);
});

test("WAIT is informational, cannot be accepted, and rejects actionable fields", (t) => {
  const { store } = createFixture(t);
  const wait = store.publish(waitSuggestion());

  assert.equal(wait.action, "WAIT");
  assert.equal(wait.status, "informational");
  assert.equal(wait.canAccept, false);
  assert.equal(wait.manualExecutionRequired, true);
  assert.equal(wait.orderSubmitted, false);
  assert.throws(() => store.accept(wait.id, validConfirmation(wait)), /informational|WAIT|cannot be accepted|not live/i);
  assert.throws(
    () => store.publish(waitSuggestion({ contracts: 1 })),
    /WAIT|actionable|contracts|order field/i,
  );
});

test("local acceptance is idempotent and writes exactly one acceptance event", (t) => {
  const { store } = createFixture(t);
  const suggestion = store.publish(buySuggestion());
  const accepted = store.accept(suggestion.id, validConfirmation(suggestion));
  const retried = store.accept(suggestion.id, validConfirmation(suggestion));

  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.canAccept, false);
  assert.equal(accepted.acceptedAt, retried.acceptedAt);
  assert.equal(accepted.manualExecutionRequired, true);
  assert.equal(accepted.orderSubmitted, false);
  assert.equal(acceptanceEvents(store).length, 1);
  assert.deepEqual(store.current(), accepted);
});

test("acceptance requires the exact ID and local-only acknowledgment", (t) => {
  const { store } = createFixture(t);
  const suggestion = store.publish(buySuggestion());

  assert.throws(
    () => store.accept("00000000-0000-4000-8000-000000000000", validConfirmation(suggestion)),
    /not found|replaced|ID/i,
  );
  assert.throws(
    () => store.accept(suggestion.id, {
      confirmProposalId: suggestion.id,
      acknowledgeLocalAcceptance: false,
    }),
    /acknowledg|local/i,
  );
  assert.equal(acceptanceEvents(store).length, 0);
  assert.equal(store.current().status, "live");
});

test("stored suggestion or digest tampering is rejected", async (t) => {
  const mutations = [
    ["entry instruction", (suggestion) => { suggestion.entryInstruction = "Buy at any price."; }],
    ["digest", (suggestion) => { suggestion.digest = "0".repeat(64); }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, (subtest) => {
      const { store } = createFixture(subtest);
      const suggestion = store.publish(buySuggestion());
      const stored = JSON.parse(fs.readFileSync(store.paths.currentPath, "utf8"));
      mutate(stored);
      fs.writeFileSync(store.paths.currentPath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");

      assert.throws(() => store.current(), /integrity|digest|tamper/i);
      assert.throws(() => store.accept(suggestion.id, validConfirmation(suggestion)), /integrity|digest|tamper/i);
      assert.equal(acceptanceEvents(store).length, 0);
    });
  }
});

test("clear removes the current suggestion and records no submitted order", (t) => {
  const { store } = createFixture(t);
  store.publish(sellSuggestion());
  store.clear("Operator cleared the stale idea.");

  assert.equal(store.current(), null);
  assert.doesNotMatch(JSON.stringify(readEvents(store)), /"orderSubmitted":true/);
});

test("no suggestion state or audit event ever claims an order was submitted", (t) => {
  const { store } = createFixture(t);
  const first = store.publish(buySuggestion());
  const accepted = store.accept(first.id, validConfirmation(first));
  const wait = store.publish(waitSuggestion());

  assert.equal(first.orderSubmitted, false);
  assert.equal(accepted.orderSubmitted, false);
  assert.equal(wait.orderSubmitted, false);
  assert.doesNotMatch(JSON.stringify({ first, accepted, wait, events: readEvents(store) }), /"orderSubmitted":true/);
});
