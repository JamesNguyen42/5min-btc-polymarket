"use strict";

const { estimatedTakerFee, maxContractsForBudget } = require("./kalshi-paper-core");

const MAX_BALANCE_AGE_MS = 60_000;
const MAX_QUOTE_AGE_MS = 60_000;
const MAX_ACTIONABLE_VALIDITY_MINUTES = 5;
const MIN_ACTIONABLE_LIFETIME_MS = 10_000;
const MAX_PRIMARY_EVIDENCE_AGE_MS = 6 * 60 * 60_000;
const MIN_CONFIDENCE = 0.75;
const MIN_EDGE = 0.05;

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value, maxLength = 1_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function floorCents(value) {
  return Math.floor((Number(value) + 1e-9) * 100) / 100;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function safeHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isOfficialMarketUrl(value) {
  const parsed = safeHttpsUrl(value);
  if (!parsed) return false;
  return parsed.hostname === "kalshi.com" || parsed.hostname.endsWith(".kalshi.com");
}

function isOfficialRulesUrl(value) {
  const parsed = safeHttpsUrl(value);
  if (!parsed) return false;
  return isOfficialMarketUrl(parsed.href) || parsed.hostname === "kalshi-public-docs.s3.amazonaws.com";
}

function isOfficialPublicMarketApiUrl(value, ticker) {
  const parsed = safeHttpsUrl(value);
  if (!parsed) return false;
  if (!["external-api.kalshi.com", "api.elections.kalshi.com"].includes(parsed.hostname)) return false;
  const expectedPath = `/trade-api/v2/markets/${encodeURIComponent(String(ticker || "").trim().toUpperCase())}`;
  return parsed.pathname === expectedPath && !parsed.search && !parsed.hash;
}

function waitSuggestion(reason, nowMs, validityMinutes = 5, sources = []) {
  const minutes = Math.max(1, Math.min(5, Math.floor(finiteNumber(validityMinutes, 5))));
  return {
    action: "WAIT",
    validFrom: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + minutes * 60_000).toISOString(),
    rationale: cleanText(reason, 1_000) || "No sufficiently safe, current suggestion is available.",
    sources: Array.isArray(sources) ? sources.slice(0, 8) : [],
  };
}

function validateBalancePayload(payload, nowMs = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Local balance response was not a JSON object");
  }
  if (payload.fundedTradingEnabled !== false) {
    throw new Error("Funded trading must be disabled before advisory suggestions can run");
  }
  if (payload.configured !== true || payload.configError) {
    throw new Error(cleanText(payload.configError, 300) || "Read-only balance access is not configured");
  }
  const balance = payload.accountBalance;
  if (!balance || typeof balance !== "object" || balance.error) {
    throw new Error(cleanText(balance?.error, 300) || "Current live available cash could not be read");
  }
  const availableCash = finiteNumber(balance.availableCash, null);
  if (availableCash === null || availableCash < 0) {
    throw new Error("Current live available cash was missing or invalid");
  }
  const checkedAtMs = parseTimestamp(balance.checkedAt);
  if (checkedAtMs === null || checkedAtMs > nowMs + 30_000 || nowMs - checkedAtMs > MAX_BALANCE_AGE_MS) {
    throw new Error("Current live available cash is stale");
  }
  return {
    availableCash: roundMoney(availableCash),
    checkedAt: new Date(checkedAtMs).toISOString(),
    source: cleanText(balance.source, 120) || "Local read-only account balance",
  };
}

function validateSources(modelOutput, nowMs) {
  const rawSources = Array.isArray(modelOutput.sources) ? modelOutput.sources : [];
  const sources = rawSources.slice(0, 8).map((source) => {
    const parsed = safeHttpsUrl(source?.url);
    const label = cleanText(source?.label || source?.title, 300);
    if (!parsed || !label) return null;
    const publishedAtMs = parseTimestamp(source?.publishedAt);
    if (publishedAtMs === null || publishedAtMs > nowMs + 30_000) return null;
    const kind = String(source?.kind || "").trim().toUpperCase();
    if (!["MARKET", "RULES", "PRIMARY_EVIDENCE"].includes(kind)) return null;
    return {
      kind,
      label,
      source: cleanText(source?.source, 120) || null,
      publishedAt: publishedAtMs === null ? null : new Date(publishedAtMs).toISOString(),
      url: parsed.href,
    };
  }).filter(Boolean);
  if (sources.length !== rawSources.slice(0, 8).length || sources.length < 3) {
    throw new Error("Every research source needs a valid non-future timestamp and HTTPS URL");
  }
  const marketUrl = cleanText(modelOutput.marketUrl, 1_000);
  if (!isOfficialMarketUrl(marketUrl)) throw new Error("A current official Kalshi market URL is required");
  const rulesUrl = cleanText(modelOutput.rulesUrl, 1_000);
  if (!isOfficialRulesUrl(rulesUrl)) throw new Error("An official HTTPS Kalshi rules URL is required");
  if (!sources.some((source) => source.kind === "MARKET" && source.url === new URL(marketUrl).href)) {
    throw new Error("The source list must include the official Kalshi market page");
  }
  if (!sources.some((source) => source.kind === "RULES" && source.url === new URL(rulesUrl).href)) {
    throw new Error("The source list must include the exact official Kalshi rules URL");
  }
  if (!sources.some((source) => (
    source.kind === "PRIMARY_EVIDENCE" &&
    !isOfficialRulesUrl(source.url) &&
    nowMs - Date.parse(source.publishedAt) <= MAX_PRIMARY_EVIDENCE_AGE_MS
  ))) {
    throw new Error("The source list must include independent primary evidence no more than six hours old");
  }
  return sources;
}

function actionableSuggestion(modelOutput, balanceSnapshot, nowMs) {
  if (modelOutput.trustedPublicQuote !== true) throw new Error("A trusted public Kalshi quote is required");
  if (!isOfficialPublicMarketApiUrl(modelOutput.trustedPublicMarketUrl, modelOutput.ticker)) {
    throw new Error("Trusted public market URL is missing or does not match the ticker");
  }
  const trustedMarketUrl = new URL(modelOutput.trustedPublicMarketUrl).href;
  if (safeHttpsUrl(modelOutput.marketUrl)?.href !== trustedMarketUrl || safeHttpsUrl(modelOutput.rulesUrl)?.href !== trustedMarketUrl) {
    throw new Error("Market and rules sources were not tied to the trusted public ticker response");
  }
  const balanceCheckedAtMs = parseTimestamp(balanceSnapshot?.checkedAt);
  if (
    finiteNumber(balanceSnapshot?.availableCash, null) === null ||
    balanceCheckedAtMs === null ||
    balanceCheckedAtMs > nowMs + 30_000 ||
    nowMs - balanceCheckedAtMs > MAX_BALANCE_AGE_MS
  ) {
    throw new Error("Current live available cash is missing or stale at publication time");
  }
  const ticker = cleanText(modelOutput.ticker, 160);
  const title = cleanText(modelOutput.title, 300);
  const side = String(modelOutput.side || "").trim().toUpperCase();
  if (!ticker || !title) throw new Error("Ticker and market title are required");
  if (!/^[A-Z0-9._:-]+$/.test(ticker)) throw new Error("Ticker format was not recognized");
  if (!['YES', 'NO'].includes(side)) throw new Error("Side must be YES or NO");

  const quoteObservedAtMs = parseTimestamp(modelOutput.quoteObservedAt);
  if (
    quoteObservedAtMs === null ||
    quoteObservedAtMs > nowMs + 30_000 ||
    nowMs - quoteObservedAtMs > MAX_QUOTE_AGE_MS
  ) {
    throw new Error("The quoted ask is missing or stale");
  }
  const quotedAsk = finiteNumber(modelOutput.quotedAskDollars, null);
  const limitPrice = finiteNumber(modelOutput.limitPriceDollars, null);
  if (quotedAsk === null || quotedAsk <= 0 || quotedAsk >= 1) throw new Error("Quoted ask must be between 0 and 1");
  if (limitPrice === null || limitPrice <= 0 || limitPrice >= 1) throw new Error("Limit price must be between 0 and 1");
  if (limitPrice > quotedAsk + 1e-9) throw new Error("Limit price cannot exceed the observed ask");
  const marketCloseTimeMs = parseTimestamp(modelOutput.marketCloseTime);
  if (marketCloseTimeMs === null || marketCloseTimeMs <= nowMs) throw new Error("Trusted market close time is missing or elapsed");

  const confidence = finiteNumber(modelOutput.confidence, null);
  const estimatedProbability = finiteNumber(modelOutput.estimatedProbability, null);
  if (confidence === null || confidence < MIN_CONFIDENCE || confidence > 1) {
    throw new Error(`Confidence must be at least ${MIN_CONFIDENCE}`);
  }
  if (estimatedProbability === null || estimatedProbability <= 0 || estimatedProbability >= 1) {
    throw new Error("Estimated probability must be between 0 and 1");
  }
  if (estimatedProbability - limitPrice < MIN_EDGE - 1e-9) {
    throw new Error(`Estimated edge must be at least ${MIN_EDGE}`);
  }

  const requestedContracts = Math.floor(finiteNumber(modelOutput.contracts, 0));
  if (requestedContracts < 1) throw new Error("At least one contract must be suggested");
  const requestedAmount = finiteNumber(modelOutput.recommendedAmountDollars, null);
  if (requestedAmount === null || requestedAmount <= 0) throw new Error("A positive recommended dollar amount is required");
  const riskCapDollars = floorCents(balanceSnapshot.availableCash * 0.1);
  if (riskCapDollars <= 0) throw new Error("Ten percent of available cash is below one cent");
  const maxContracts = maxContractsForBudget(riskCapDollars, limitPrice);
  const contracts = Math.min(requestedContracts, maxContracts);
  if (contracts < 1) throw new Error("No whole contract fits the ten-percent available-cash cap including estimated fees");
  const estimatedFeeDollars = estimatedTakerFee(contracts, limitPrice);
  const maxLossDollars = roundMoney(contracts * limitPrice + estimatedFeeDollars);
  if (maxLossDollars > riskCapDollars + 1e-9) throw new Error("Computed maximum loss exceeds the ten-percent cap");

  const takeProfitPrice = finiteNumber(modelOutput.takeProfitPriceDollars, null);
  const stopLossPrice = finiteNumber(modelOutput.stopLossPriceDollars, null);
  if (takeProfitPrice === null || takeProfitPrice <= limitPrice || takeProfitPrice >= 1) {
    throw new Error("Take-profit price must be above the entry limit and below 1");
  }
  if (stopLossPrice === null || stopLossPrice <= 0 || stopLossPrice >= limitPrice) {
    throw new Error("Stop-loss price must be below the entry limit and above 0");
  }
  const validForMinutes = Math.floor(finiteNumber(modelOutput.validForMinutes, 0));
  const exitWithinMinutes = Math.floor(finiteNumber(modelOutput.exitWithinMinutes, 0));
  if (validForMinutes < 2 || validForMinutes > MAX_ACTIONABLE_VALIDITY_MINUTES) {
    throw new Error(`Actionable validity must be between 2 and ${MAX_ACTIONABLE_VALIDITY_MINUTES} minutes`);
  }
  if (exitWithinMinutes < 1 || exitWithinMinutes > MAX_ACTIONABLE_VALIDITY_MINUTES) {
    throw new Error(`Exit timing must be between 1 and ${MAX_ACTIONABLE_VALIDITY_MINUTES} minutes`);
  }

  const sources = validateSources(modelOutput, nowMs);
  const rationale = cleanText(modelOutput.rationale, 1_000);
  if (!rationale) throw new Error("A research rationale is required");
  const freshnessDeadlineMs = Math.min(
    balanceCheckedAtMs + MAX_BALANCE_AGE_MS,
    quoteObservedAtMs + MAX_QUOTE_AGE_MS,
  );
  const expiresAtMs = Math.min(nowMs + validForMinutes * 60_000, freshnessDeadlineMs);
  if (expiresAtMs - nowMs < MIN_ACTIONABLE_LIFETIME_MS) {
    throw new Error("The balance or quote would become stale too soon for a safe acceptance window");
  }
  const exitByMs = nowMs + exitWithinMinutes * 60_000;
  if (exitByMs >= marketCloseTimeMs) throw new Error("The exit deadline must be before the trusted market close time");

  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const exitByIso = new Date(exitByMs).toISOString();
  const contractWord = contracts === 1 ? "contract" : "contracts";
  const entryInstruction = `Before ${expiresAtIso}, manually place only a ${side} limit buy for exactly ${contracts} ${contractWord} of ${ticker} at $${roundMoney(limitPrice).toFixed(2)} or less. Total at risk, including the estimated fee, must stay at or below $${maxLossDollars.toFixed(2)}. Do not chase the price or add contracts.`;
  const exitInstruction = `After a fill, manually offer to sell the same ${contracts} ${contractWord} at $${roundMoney(takeProfitPrice).toFixed(2)} for take profit; attempt to exit at $${roundMoney(stopLossPrice).toFixed(2)} if the stop is reached; and exit any remainder no later than ${exitByIso}. Never increase the position.`;

  return {
    action: "BUY",
    ticker,
    title,
    side,
    contracts,
    limitPriceDollars: roundMoney(limitPrice),
    estimatedFeeDollars,
    maxLossDollars,
    validFrom: new Date(nowMs).toISOString(),
    expiresAt: expiresAtIso,
    entryInstruction,
    exitInstruction,
    takeProfitPriceDollars: roundMoney(takeProfitPrice),
    stopLossPriceDollars: roundMoney(stopLossPrice),
    exitBy: exitByIso,
    rationale: `Research rationale only; trusted local sizing and instructions above control: ${rationale}`,
    sources,
  };
}

function validatePublicMarketPayload(payload, { ticker, side, officialUrl, observedAtMs = Date.now() }) {
  const market = payload?.market && typeof payload.market === "object" ? payload.market : payload;
  if (!market || typeof market !== "object" || Array.isArray(market)) throw new Error("Public market response was invalid");
  const expectedTicker = cleanText(ticker, 160).toUpperCase();
  const actualTicker = cleanText(market.ticker, 160).toUpperCase();
  if (!expectedTicker || actualTicker !== expectedTicker) throw new Error("Public market ticker did not match the suggestion");
  if (!isOfficialPublicMarketApiUrl(officialUrl, actualTicker)) throw new Error("Public market URL was not an exact official ticker endpoint");
  const normalizedSide = String(side || "").trim().toUpperCase();
  if (!["YES", "NO"].includes(normalizedSide)) throw new Error("Public quote side must be YES or NO");
  const status = String(market.status || "").trim().toLowerCase();
  if (!["active", "open"].includes(status)) throw new Error(`Public market is not open (status ${status || "missing"})`);
  const closeTimeMs = parseTimestamp(market.close_time ?? market.closeTime ?? market.expiration_time ?? market.expirationTime);
  if (closeTimeMs === null || closeTimeMs <= observedAtMs) throw new Error("Public market close time is missing or elapsed");
  const rulesPrimary = cleanText(market.rules_primary ?? market.rulesPrimary, 5_000);
  if (!rulesPrimary) throw new Error("Public market response did not include primary resolution rules");
  const sideKey = normalizedSide.toLowerCase();
  let ask = finiteNumber(market[`${sideKey}_ask_dollars`], null);
  if (ask === null) {
    const cents = finiteNumber(market[`${sideKey}_ask`], null);
    ask = cents === null ? null : cents > 1 ? cents / 100 : cents;
  }
  if (ask === null || ask <= 0 || ask >= 1) throw new Error("Public market has no valid ask for the suggested side");
  return {
    trustedPublicQuote: true,
    trustedPublicMarketUrl: new URL(officialUrl).href,
    ticker: actualTicker,
    title: cleanText(market.title || market.subtitle, 300) || null,
    quotedAskDollars: roundMoney(ask),
    quoteObservedAt: new Date(observedAtMs).toISOString(),
    marketCloseTime: new Date(closeTimeMs).toISOString(),
  };
}

function buildPublishableSuggestion(modelOutput, balanceSnapshot, nowMs = Date.now(), waitMinutes = 5) {
  try {
    if (!modelOutput || typeof modelOutput !== "object" || Array.isArray(modelOutput)) {
      throw new Error("Codex did not return a JSON object");
    }
    const action = String(modelOutput.action || "").trim().toUpperCase();
    if (action === "WAIT") {
      return {
        suggestion: waitSuggestion(
          `Codex returned WAIT: ${cleanText(modelOutput.rationale, 850) || "evidence was not strong enough"}`,
          nowMs,
          waitMinutes,
          [],
        ),
        actionable: false,
        failClosedReason: null,
      };
    }
    if (action !== "BUY") throw new Error("Only a funded-risk-capped BUY or WAIT is supported; exits are expressed in the exit plan");
    const suggestion = actionableSuggestion(modelOutput, balanceSnapshot, nowMs);
    return { suggestion, actionable: true, failClosedReason: null };
  } catch (error) {
    const reason = cleanText(error.message || String(error), 700);
    return {
      suggestion: waitSuggestion(`WAIT (safety validation): ${reason}`, nowMs, waitMinutes),
      actionable: false,
      failClosedReason: reason,
    };
  }
}

function sanitizedChildEnvironment(environment = process.env) {
  const allowedNames = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
  ]);
  const safe = {};
  for (const [name, value] of Object.entries(environment || {})) {
    if (!allowedNames.has(name.toUpperCase())) continue;
    safe[name] = value;
  }
  return safe;
}

module.exports = {
  MAX_BALANCE_AGE_MS,
  MAX_QUOTE_AGE_MS,
  buildPublishableSuggestion,
  sanitizedChildEnvironment,
  validateBalancePayload,
  validatePublicMarketPayload,
  waitSuggestion,
};
