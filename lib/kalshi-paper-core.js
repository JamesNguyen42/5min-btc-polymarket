"use strict";

const KALSHI_TAKER_FEE_RATE = 0.07;

const DEFAULT_PAPER_CONFIG = Object.freeze({
  startingCash: 8,
  maxStakeUsd: 0.8,
  maxSessionLossUsd: 1.6,
  maxOpenPositions: 2,
  maxTrades: 12,
  minMinutesToClose: 10,
  maxHoursToClose: 24,
  settlementBufferMinutes: 30,
  minVolume24h: 25,
  maxSpread: 0.12,
  minAsk: 0.05,
  maxAsk: 0.95,
  minConfidence: 0.72,
  minExpectedValuePerContract: 0.04,
  maxCandidates: 16,
});

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max, fallback = min) {
  const number = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, number));
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function estimatedTakerFee(contracts, price) {
  const count = finiteNumber(contracts, 0);
  const probability = finiteNumber(price, 0);
  if (count <= 0 || probability <= 0 || probability >= 1) return 0;
  return Math.ceil((KALSHI_TAKER_FEE_RATE * count * probability * (1 - probability) * 100) - 1e-9) / 100;
}

function maxContractsForBudget(budget, price) {
  const spendable = finiteNumber(budget, 0);
  const probability = finiteNumber(price, 0);
  if (spendable <= 0 || probability <= 0 || probability >= 1) return 0;
  let low = 0;
  let high = Math.max(0, Math.floor(spendable / probability));
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    const total = midpoint * probability + estimatedTakerFee(midpoint, probability);
    if (total <= spendable + 1e-9) low = midpoint;
    else high = midpoint - 1;
  }
  return low;
}

function normalizedStatus(market) {
  return String(market?.status || "").trim().toLowerCase();
}

function marketQuote(market) {
  const yesBid = finiteNumber(market?.yes_bid_dollars, finiteNumber(market?.yes_bid, null));
  const yesAsk = finiteNumber(market?.yes_ask_dollars, finiteNumber(market?.yes_ask, null));
  const noBid = finiteNumber(market?.no_bid_dollars, finiteNumber(market?.no_bid, null));
  const noAsk = finiteNumber(market?.no_ask_dollars, finiteNumber(market?.no_ask, null));
  return {
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesSpread: yesBid === null || yesAsk === null ? null : roundMoney(yesAsk - yesBid),
    noSpread: noBid === null || noAsk === null ? null : roundMoney(noAsk - noBid),
    lastPrice: finiteNumber(market?.last_price_dollars, finiteNumber(market?.last_price, null)),
    previousPrice: finiteNumber(market?.previous_price_dollars, finiteNumber(market?.previous_price, null)),
    yesAskSize: Math.max(0, finiteNumber(market?.yes_ask_size_fp, 0)),
    noAskSize: Math.max(0, finiteNumber(market?.no_ask_size_fp, finiteNumber(market?.yes_bid_size_fp, 0))),
  };
}

function compactMarket(market) {
  return {
    ticker: String(market?.ticker || ""),
    eventTicker: String(market?.event_ticker || ""),
    title: String(market?.title || "").trim(),
    subtitle: String(market?.subtitle || "").trim(),
    yesSubtitle: String(market?.yes_sub_title || "").trim(),
    noSubtitle: String(market?.no_sub_title || "").trim(),
    rulesPrimary: String(market?.rules_primary || "").trim().slice(0, 2_000),
    rulesSecondary: String(market?.rules_secondary || "").trim().slice(0, 1_000),
    closeTime: market?.close_time || market?.expected_expiration_time || null,
    expectedExpirationTime: market?.expected_expiration_time || market?.close_time || null,
    updatedTime: market?.updated_time || null,
    status: normalizedStatus(market),
    marketType: String(market?.market_type || "").trim().toLowerCase(),
    priceLevelStructure: String(market?.price_level_structure || "").trim().toLowerCase(),
    canCloseEarly: Boolean(market?.can_close_early),
    feeWaiverExpirationTime: market?.fee_waiver_expiration_time || null,
    volume24h: Math.max(0, finiteNumber(market?.volume_24h_fp, finiteNumber(market?.volume_24h, 0))),
    openInterest: Math.max(0, finiteNumber(market?.open_interest_fp, finiteNumber(market?.open_interest, 0))),
    liquidity: Math.max(0, finiteNumber(market?.liquidity_dollars, 0)),
    provisional: Boolean(market?.is_provisional),
    quote: marketQuote(market),
  };
}

function candidateFromMarket(market, now = Date.now(), config = DEFAULT_PAPER_CONFIG) {
  const compact = compactMarket(market);
  if (!compact.ticker || !["active", "open"].includes(compact.status)) return null;
  if (compact.marketType !== "binary" || compact.priceLevelStructure !== "linear_cent") return null;
  const closeTimestamp = Date.parse(compact.closeTime || "");
  if (!Number.isFinite(closeTimestamp)) return null;
  const minutesToClose = (closeTimestamp - now) / 60_000;
  if (minutesToClose < config.minMinutesToClose || minutesToClose > config.maxHoursToClose * 60) return null;

  const { yesBid, yesAsk, noBid, noAsk, yesSpread, noSpread, yesAskSize, noAskSize } = compact.quote;
  if ([yesBid, yesAsk, noBid, noAsk].some((value) => value === null || value < 0 || value > 1)) return null;
  if (yesAsk < config.minAsk || yesAsk > config.maxAsk || noAsk < config.minAsk || noAsk > config.maxAsk) return null;
  if (yesAskSize < 1 || noAskSize < 1) return null;
  if (yesSpread < 0 || noSpread < 0 || yesSpread > config.maxSpread || noSpread > config.maxSpread) return null;
  if (compact.volume24h < config.minVolume24h) return null;

  const spreadPenalty = (yesSpread + noSpread) * 12;
  const activityScore = Math.log1p(compact.volume24h) * 2 + Math.log1p(compact.openInterest);
  const timeScore = Math.max(0, 2 - Math.abs(Math.log(Math.max(1, minutesToClose) / 180)));
  const score = activityScore + timeScore - spreadPenalty;
  const queryParts = [compact.title, compact.subtitle, compact.yesSubtitle]
    .map((value) => value.trim())
    .filter((value, index, all) => value && all.indexOf(value) === index);

  return {
    ...compact,
    minutesToClose: Number(minutesToClose.toFixed(2)),
    score: Number(score.toFixed(6)),
    researchQuery: queryParts.join(" ").slice(0, 300),
  };
}

function selectCandidates(markets, now = Date.now(), config = DEFAULT_PAPER_CONFIG) {
  const candidates = (Array.isArray(markets) ? markets : [])
    .map((market) => candidateFromMarket(market, now, config))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  const selected = [];
  const events = new Set();
  for (const candidate of candidates) {
    const eventKey = candidate.eventTicker || candidate.ticker;
    if (events.has(eventKey)) continue;
    events.add(eventKey);
    selected.push(candidate);
    if (selected.length >= config.maxCandidates) break;
  }
  return selected;
}

function evaluatePaperOpportunity(candidate, research, config = DEFAULT_PAPER_CONFIG) {
  const modelYes = clamp(research?.modelYesProbability ?? research?.fairYesProbability, 0.01, 0.99, 0.5);
  const confidence = clamp(research?.confidence, 0, 1, 0);
  const { yesAsk, noAsk } = candidate.quote;
  const yesFee = estimatedTakerFee(1, yesAsk);
  const noFee = estimatedTakerFee(1, noAsk);
  const yesExpectedValue = modelYes - yesAsk - yesFee;
  const noExpectedValue = (1 - modelYes) - noAsk - noFee;
  const side = yesExpectedValue >= noExpectedValue ? "yes" : "no";
  const price = side === "yes" ? yesAsk : noAsk;
  const expectedValue = side === "yes" ? yesExpectedValue : noExpectedValue;
  const approved = Boolean(
    research?.action === "TRADE" &&
      confidence >= config.minConfidence &&
      expectedValue >= config.minExpectedValuePerContract,
  );
  return {
    approved,
    side,
    price,
    modelYesProbability: Number(modelYes.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    expectedValuePerContract: Number(expectedValue.toFixed(4)),
    yesExpectedValue: Number(yesExpectedValue.toFixed(4)),
    noExpectedValue: Number(noExpectedValue.toFixed(4)),
    reason: approved
      ? `Paper edge cleared confidence and fee-adjusted EV floors on ${side.toUpperCase()}.`
      : String(research?.reason || "Research did not clear the paper-trade gate."),
  };
}

function sessionRealizedPnl(state) {
  return roundMoney(finiteNumber(state?.cash, 0) + finiteNumber(state?.reservedCost, 0) - finiteNumber(state?.startingCash, 0));
}

function riskGate(state, candidate, opportunity, config = DEFAULT_PAPER_CONFIG) {
  if (!opportunity?.approved) return opportunity?.reason || "Opportunity is not approved.";
  if (state.session?.status !== "running") return "Paper session is not running.";
  if (Date.now() >= Date.parse(state.session.endsAt || "")) return "Paper session deadline reached.";
  const expectedResolution = Date.parse(candidate.expectedExpirationTime || candidate.closeTime || "");
  const settlementCutoff = Date.parse(state.session.endsAt || "") - config.settlementBufferMinutes * 60_000;
  if (!Number.isFinite(expectedResolution) || expectedResolution > settlementCutoff) {
    return "Market is not expected to resolve before the paper session settlement cutoff.";
  }
  if ((state.positions || []).length >= config.maxOpenPositions) return "Maximum open paper positions reached.";
  if ((state.closedTrades || []).length + (state.positions || []).length >= config.maxTrades) return "Maximum paper trade count reached.";
  if ((state.positions || []).some((position) => position.ticker === candidate.ticker)) return "Ticker already has an open paper position.";
  if ((state.positions || []).some((position) => position.eventTicker && position.eventTicker === candidate.eventTicker)) {
    return "A correlated position in the same event is already open.";
  }
  if (finiteNumber(state.realizedPnl, 0) <= -config.maxSessionLossUsd) return "Paper session loss cap reached.";
  const remainingLossBudget = Math.max(
    0,
    config.maxSessionLossUsd - Math.max(0, -finiteNumber(state.realizedPnl, 0)) - finiteNumber(state.reservedCost, 0),
  );
  const budget = Math.min(config.maxStakeUsd, finiteNumber(state.cash, 0), remainingLossBudget);
  const availableAtAsk = opportunity.side === "yes" ? candidate.quote.yesAskSize : candidate.quote.noAskSize;
  if (Math.min(maxContractsForBudget(budget, opportunity.price), Math.floor(availableAtAsk)) < 1) {
    return "Not enough top-of-book size or virtual cash for one fee-inclusive contract.";
  }
  return "";
}

function openPaperPosition(state, candidate, opportunity, research, config = DEFAULT_PAPER_CONFIG, now = new Date()) {
  const rejection = riskGate(state, candidate, opportunity, config);
  if (rejection) return { opened: false, reason: rejection };
  const remainingLossBudget = Math.max(
    0,
    config.maxSessionLossUsd - Math.max(0, -finiteNumber(state.realizedPnl, 0)) - finiteNumber(state.reservedCost, 0),
  );
  const budget = Math.min(config.maxStakeUsd, state.cash, remainingLossBudget);
  const availableAtAsk = opportunity.side === "yes" ? candidate.quote.yesAskSize : candidate.quote.noAskSize;
  const contracts = Math.min(maxContractsForBudget(budget, opportunity.price), Math.floor(availableAtAsk));
  if (contracts < 1) return { opened: false, reason: "No fee-inclusive contract fits the virtual stake cap." };
  const fee = estimatedTakerFee(contracts, opportunity.price);
  const cost = roundMoney(contracts * opportunity.price + fee);
  const position = {
    ticker: candidate.ticker,
    eventTicker: candidate.eventTicker,
    title: candidate.title,
    side: opportunity.side,
    contracts,
    entryPrice: opportunity.price,
    entryFee: fee,
    totalCost: cost,
    openedAt: now.toISOString(),
    closeTime: candidate.closeTime,
    modelYesProbability: opportunity.modelYesProbability,
    confidence: opportunity.confidence,
    expectedValuePerContract: opportunity.expectedValuePerContract,
    research: {
      reason: String(research?.reason || "").slice(0, 500),
      headlineCount: Number(research?.headlineCount || 0),
      researchedAt: research?.researchedAt || null,
      model: research?.model || null,
    },
  };
  state.cash = roundMoney(state.cash - cost);
  state.reservedCost = roundMoney(finiteNumber(state.reservedCost, 0) + cost);
  state.feesPaid = roundMoney(finiteNumber(state.feesPaid, 0) + fee);
  state.positions.push(position);
  return { opened: true, position };
}

function settlementValue(market) {
  const result = String(market?.result || market?.settlement_result || "").toLowerCase();
  if (result === "yes") return 1;
  if (result === "no") return 0;
  const value = finiteNumber(market?.settlement_value_dollars, finiteNumber(market?.settlement_value, null));
  return value === null ? null : clamp(value, 0, 1, null);
}

function settlePaperPosition(state, ticker, market, now = new Date()) {
  const index = state.positions.findIndex((position) => position.ticker === ticker);
  if (index === -1) return { settled: false, reason: "Paper position was not found." };
  const yesPayout = settlementValue(market);
  if (yesPayout === null || !["settled", "finalized"].includes(normalizedStatus(market))) {
    return { settled: false, reason: "Market has not published a settlement value." };
  }
  const position = state.positions[index];
  const payoutPerContract = position.side === "yes" ? yesPayout : 1 - yesPayout;
  const payout = roundMoney(position.contracts * payoutPerContract);
  const pnl = roundMoney(payout - position.totalCost);
  const trade = {
    ...position,
    settledAt: now.toISOString(),
    yesSettlementValue: yesPayout,
    payout,
    pnl,
  };
  state.positions.splice(index, 1);
  state.cash = roundMoney(state.cash + payout);
  state.reservedCost = roundMoney(Math.max(0, finiteNumber(state.reservedCost, 0) - position.totalCost));
  state.realizedPnl = roundMoney(finiteNumber(state.realizedPnl, 0) + pnl);
  state.closedTrades.push(trade);
  return { settled: true, trade };
}

module.exports = {
  DEFAULT_PAPER_CONFIG,
  candidateFromMarket,
  compactMarket,
  estimatedTakerFee,
  evaluatePaperOpportunity,
  maxContractsForBudget,
  openPaperPosition,
  riskGate,
  selectCandidates,
  settlePaperPosition,
  settlementValue,
};
