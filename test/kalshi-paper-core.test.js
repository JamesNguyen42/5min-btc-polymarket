"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_PAPER_CONFIG,
  candidateFromMarket,
  estimatedTakerFee,
  evaluatePaperOpportunity,
  maxContractsForBudget,
  openPaperPosition,
  selectCandidates,
  settlePaperPosition,
} = require("../lib/kalshi-paper-core");
const { parseGoogleNewsFeed } = require("../lib/kalshi-market-research");

const NOW = Date.parse("2026-07-17T20:00:00Z");

function market(overrides = {}) {
  return {
    ticker: "TEST-MARKET-YES",
    event_ticker: "TEST-EVENT",
    title: "Will the test event happen?",
    status: "active",
    close_time: "2026-07-17T23:00:00Z",
    yes_bid_dollars: "0.4200",
    yes_ask_dollars: "0.4800",
    no_bid_dollars: "0.5200",
    no_ask_dollars: "0.5800",
    volume_24h_fp: "100.00",
    open_interest_fp: "50.00",
    liquidity_dollars: "10.00",
    market_type: "binary",
    price_level_structure: "linear_cent",
    yes_ask_size_fp: "25.00",
    yes_bid_size_fp: "25.00",
    expected_expiration_time: "2026-07-17T23:05:00Z",
    rules_primary: "Resolves YES if the test event happens.",
    ...overrides,
  };
}

test("Kalshi fee model rounds each order up to the next cent", () => {
  assert.equal(estimatedTakerFee(1, 0.5), 0.02);
  assert.equal(estimatedTakerFee(2, 0.5), 0.04);
  assert.equal(estimatedTakerFee(0, 0.5), 0);
});

test("contract sizing includes the modeled taker fee", () => {
  assert.equal(maxContractsForBudget(0.51, 0.5), 0);
  assert.equal(maxContractsForBudget(0.52, 0.5), 1);
  assert.equal(maxContractsForBudget(1.04, 0.5), 2);
});

test("candidate filtering rejects stale, wide, and inactive markets", () => {
  assert.ok(candidateFromMarket(market(), NOW, DEFAULT_PAPER_CONFIG));
  assert.equal(candidateFromMarket(market({ status: "closed" }), NOW, DEFAULT_PAPER_CONFIG), null);
  assert.equal(candidateFromMarket(market({ close_time: "2026-07-17T20:05:00Z" }), NOW, DEFAULT_PAPER_CONFIG), null);
  assert.equal(candidateFromMarket(market({ yes_ask_dollars: "0.80" }), NOW, DEFAULT_PAPER_CONFIG), null);
});

test("candidate selection limits correlated exposure to one market per event", () => {
  const selected = selectCandidates(
    [
      market({ ticker: "TEST-A", event_ticker: "SAME", volume_24h_fp: "100" }),
      market({ ticker: "TEST-B", event_ticker: "SAME", volume_24h_fp: "90" }),
      market({ ticker: "TEST-C", event_ticker: "OTHER", volume_24h_fp: "80" }),
    ],
    NOW,
    DEFAULT_PAPER_CONFIG,
  );
  assert.equal(selected.length, 2);
  assert.equal(new Set(selected.map((row) => row.eventTicker)).size, 2);
});

test("paper opportunity requires confidence and fee-adjusted expected value", () => {
  const candidate = candidateFromMarket(market(), NOW, DEFAULT_PAPER_CONFIG);
  const approved = evaluatePaperOpportunity(candidate, {
    action: "TRADE",
    fairYesProbability: 0.65,
    confidence: 0.8,
    reason: "Two-source evidence.",
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.side, "yes");
  assert.ok(approved.expectedValuePerContract >= 0.04);

  const weak = evaluatePaperOpportunity(candidate, {
    action: "TRADE",
    fairYesProbability: 0.51,
    confidence: 0.95,
  });
  assert.equal(weak.approved, false);
});

test("paper fills debit virtual cash and settlement credits the correct payout", () => {
  const config = { ...DEFAULT_PAPER_CONFIG, maxStakeUsd: 0.8 };
  const candidate = candidateFromMarket(market(), NOW, config);
  const research = {
    action: "TRADE",
    fairYesProbability: 0.7,
    confidence: 0.9,
    reason: "Paper-only test evidence.",
    headlineCount: 3,
  };
  const opportunity = evaluatePaperOpportunity(candidate, research, config);
  const state = {
    startingCash: 8,
    cash: 8,
    reservedCost: 0,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedTrades: [],
    session: {
      status: "running",
      endsAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const opened = openPaperPosition(state, candidate, opportunity, research, config, new Date(NOW));
  assert.equal(opened.opened, true);
  assert.equal(state.positions.length, 1);
  assert.ok(state.cash < 8);

  const settled = settlePaperPosition(
    state,
    candidate.ticker,
    { status: "finalized", settlement_value_dollars: "1.0000" },
    new Date(NOW + 3_600_000),
  );
  assert.equal(settled.settled, true);
  assert.equal(state.positions.length, 0);
  assert.equal(state.closedTrades.length, 1);
  assert.ok(state.realizedPnl > 0);
});

test("open exposure counts against the session loss budget", () => {
  const config = { ...DEFAULT_PAPER_CONFIG, maxStakeUsd: 0.8, maxSessionLossUsd: 0.8, maxOpenPositions: 3 };
  const first = candidateFromMarket(market(), NOW, config);
  const second = candidateFromMarket(market({ ticker: "TEST-SECOND", event_ticker: "TEST-SECOND-EVENT" }), NOW, config);
  const research = { action: "TRADE", fairYesProbability: 0.7, confidence: 0.9, reason: "Test evidence." };
  const firstOpportunity = evaluatePaperOpportunity(first, research, config);
  const secondOpportunity = evaluatePaperOpportunity(second, research, config);
  const state = {
    startingCash: 8,
    cash: 8,
    reservedCost: 0,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedTrades: [],
    session: { status: "running", endsAt: new Date(Date.now() + 60_000).toISOString() },
  };
  assert.equal(openPaperPosition(state, first, firstOpportunity, research, config).opened, true);
  assert.equal(openPaperPosition(state, second, secondOpportunity, research, config).opened, false);
});

test("blank settlement values never resolve a merely closed market", () => {
  const config = { ...DEFAULT_PAPER_CONFIG, maxStakeUsd: 0.8 };
  const candidate = candidateFromMarket(market(), NOW, config);
  const research = { action: "TRADE", fairYesProbability: 0.7, confidence: 0.9, reason: "Test evidence." };
  const opportunity = evaluatePaperOpportunity(candidate, research, config);
  const state = {
    startingCash: 8,
    cash: 8,
    reservedCost: 0,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedTrades: [],
    session: { status: "running", endsAt: new Date(Date.now() + 60_000).toISOString() },
  };
  openPaperPosition(state, candidate, opportunity, research, config);
  const result = settlePaperPosition(state, candidate.ticker, { status: "closed", settlement_value_dollars: "" });
  assert.equal(result.settled, false);
  assert.equal(state.positions.length, 1);
});

test("a position cannot outlive the session settlement cutoff", () => {
  const now = Date.now();
  const config = { ...DEFAULT_PAPER_CONFIG, maxStakeUsd: 0.8, settlementBufferMinutes: 5 };
  const candidate = candidateFromMarket(
    market({
      close_time: new Date(now + 20 * 60_000).toISOString(),
      expected_expiration_time: new Date(now + 30 * 60_000).toISOString(),
    }),
    now,
    config,
  );
  const research = { action: "TRADE", fairYesProbability: 0.7, confidence: 0.9, reason: "Test evidence." };
  const opportunity = evaluatePaperOpportunity(candidate, research, config);
  const state = {
    startingCash: 8,
    cash: 8,
    reservedCost: 0,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedTrades: [],
    session: { status: "running", endsAt: new Date(now + 25 * 60_000).toISOString() },
  };
  const result = openPaperPosition(state, candidate, opportunity, research, config);
  assert.equal(result.opened, false);
  assert.match(result.reason, /settlement cutoff/i);
});

test("paper runner source contains no Kalshi credential or order endpoint", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "kalshi_any_market_paper.mjs"), "utf8");
  assert.doesNotMatch(source, /KALSHI_(?:API_KEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_SIGNATURE)/);
  assert.doesNotMatch(source, /\/orders(?:\b|\/)/);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
});

test("Google News parser keeps source and publication metadata", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[First &amp; useful]]></title><link>https://example.com/1</link><pubDate>Fri, 17 Jul 2026 19:00:00 GMT</pubDate><source>Example One</source></item>
    <item><title>Second useful</title><link>https://example.com/2</link><pubDate>Fri, 17 Jul 2026 18:00:00 GMT</pubDate><source>Example Two</source></item>
  </channel></rss>`;
  const headlines = parseGoogleNewsFeed(xml);
  assert.equal(headlines.length, 2);
  assert.equal(headlines[0].title, "First & useful");
  assert.equal(headlines[1].source, "Example Two");
});
