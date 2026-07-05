const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

loadLocalEnv(path.join(ROOT, ".env"));

const TRADING_STATE_VERSION = 1;
const TRADING_STATE_FILE = path.isAbsolute(process.env.TRADING_STATE_FILE || "")
  ? process.env.TRADING_STATE_FILE
  : path.resolve(ROOT, process.env.TRADING_STATE_FILE || path.join("runtime", "trading_state.json"));
const START_PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const KALSHI_API_PREFIX = "/trade-api/v2";
const KALSHI_BTC15M_SERIES = process.env.KALSHI_BTC15M_SERIES || "KXBTC15M";
const PAPER_POLL_MS = Math.max(3000, Number(process.env.PAPER_POLL_MS || 10000));
const LIVE_COMPARE_POLL_MS = Math.max(3000, Number(process.env.LIVE_COMPARE_POLL_MS || PAPER_POLL_MS));
const LIVE_COMPARE_PROFILE = process.env.LIVE_COMPARE_PROFILE === "aggressive" ? "aggressive" : "conservative";
const COMPARE_STRATEGIES = ["v1", "v2", "v3"];
const DEFAULT_COMPARE_STRATEGIES = parseCompareStrategyList(process.env.LIVE_COMPARE_STRATEGIES || "v1,v3", ["v1", "v3"]);
const DEFAULT_PRIMARY_STRATEGY = parseCompareStrategyList(process.env.TRADING_PRIMARY_STRATEGY || "v1", ["v1"])[0];
const DEFAULT_POLYMARKET_STRATEGIES = parseCompareStrategyList(process.env.POLYMARKET_COMPARE_STRATEGIES || "v1", ["v1"]);
const DEFAULT_POLYMARKET_PRIMARY_STRATEGY = parseCompareStrategyList(
  process.env.POLYMARKET_PRIMARY_STRATEGY || "v1",
  ["v1"],
)[0];
const LIVE_COMPARE_STARTING_CASH = Math.max(1, envNumber("LIVE_COMPARE_STARTING_CASH", 10));
const PAPER_STARTING_CASH = Math.max(1, envNumber("PAPER_STARTING_CASH", LIVE_COMPARE_STARTING_CASH));
const POLYMARKET_STARTING_CASH = Math.max(1, envNumber("POLYMARKET_STARTING_CASH", LIVE_COMPARE_STARTING_CASH));
const KALSHI_MARKET_CACHE_MS = Math.max(3000, Number(process.env.KALSHI_MARKET_CACHE_MS || 12000));
const KALSHI_SETTLEMENT_CACHE_MS = Math.max(3000, Number(process.env.KALSHI_SETTLEMENT_CACHE_MS || 30000));
const POLYMARKET_MARKET_CACHE_MS = Math.max(1000, Number(process.env.POLYMARKET_MARKET_CACHE_MS || 3000));
const POLYMARKET_SETTLEMENT_CACHE_MS = Math.max(3000, Number(process.env.POLYMARKET_SETTLEMENT_CACHE_MS || 30000));
const PAPER_ENTRY_SECONDS_LEFT = Math.max(10, Number(process.env.PAPER_ENTRY_SECONDS_LEFT || 120));
const PAPER_MIN_SECONDS_LEFT = Math.max(5, Number(process.env.PAPER_MIN_SECONDS_LEFT || 30));
const PAPER_TRIGGER_PRICE = Math.min(0.99, Math.max(0.01, Number(process.env.PAPER_TRIGGER_PRICE || 0.7)));
const POLYMARKET_POLL_MS = Math.max(3000, Number(process.env.POLYMARKET_POLL_MS || PAPER_POLL_MS));
const POLYMARKET_ENTRY_SECONDS_LEFT = Math.max(10, Number(process.env.POLYMARKET_ENTRY_SECONDS_LEFT || 120));
const POLYMARKET_MIN_SECONDS_LEFT = Math.max(5, Number(process.env.POLYMARKET_MIN_SECONDS_LEFT || 20));
const POLYMARKET_TRIGGER_PRICE = Math.min(0.99, Math.max(0.01, Number(process.env.POLYMARKET_TRIGGER_PRICE || PAPER_TRIGGER_PRICE)));
const POLYMARKET_BTC5M_SLUG_PREFIX = process.env.POLYMARKET_BTC5M_SLUG_PREFIX || "btc-updown-5m";
const POLYMARKET_GAMMA_BASE_URL = (process.env.POLYMARKET_GAMMA_BASE_URL || "https://gamma-api.polymarket.com").replace(/\/$/, "");
const POLYMARKET_CLOB_BASE_URL = (process.env.POLYMARKET_CLOB_BASE_URL || "https://clob.polymarket.com").replace(/\/$/, "");
const KALSHI_LIVE_MAX_PRICE_SLIPPAGE = Math.max(0, envNumber("KALSHI_LIVE_MAX_PRICE_SLIPPAGE", 0.03));
const KALSHI_LIVE_MAX_TAKE_PRICE = asNumber(process.env.KALSHI_LIVE_MAX_TAKE_PRICE, 0.99, 0.01, 1);
const KALSHI_TAKER_FEE_RATE = Math.max(0, envNumber("KALSHI_TAKER_FEE_RATE", 0.07));
const KALSHI_LIVE_CASH_BUFFER_USD = Math.max(0, envNumber("KALSHI_LIVE_CASH_BUFFER_USD", 0.25));
const KALSHI_ORDERBOOK_DEPTH = Math.round(asNumber(process.env.KALSHI_ORDERBOOK_DEPTH, 100, 1, 100));
const KALSHI_LIVE_TIME_IN_FORCE =
  process.env.KALSHI_LIVE_TIME_IN_FORCE === "fill_or_kill" && process.env.KALSHI_LIVE_ALLOW_FILL_OR_KILL === "1"
    ? "fill_or_kill"
    : "immediate_or_cancel";
const POLYMARKET_LIVE_MAX_PRICE_SLIPPAGE = Math.max(0, envNumber("POLYMARKET_LIVE_MAX_PRICE_SLIPPAGE", 0.03));
const ACCOUNT_BALANCE_CACHE_MS = Math.max(5000, Number(process.env.ACCOUNT_BALANCE_CACHE_MS || 30000));
const FRONTEND_ORIGINS = String(process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const currentBtc15mMarketCache = {
  expiresAt: 0,
  promise: null,
  value: null,
};
const kalshiMarketByTickerCache = new Map();
const polymarketBtc5mMarketCache = {
  expiresAt: 0,
  promise: null,
  value: null,
};
const polymarketMarketBySlugCache = new Map();
const polymarketBookByTokenCache = new Map();
const kalshiAccountBalanceCache = {
  expiresAt: 0,
  promise: null,
  value: null,
};
const polymarketAccountBalanceCache = {
  expiresAt: 0,
  promise: null,
  value: null,
};
const tradingState = {
  mode: "paper",
  workerStatus: "inactive",
  killSwitch: true,
  updatedAt: new Date().toISOString(),
  accountBalance: createAccountBalance("Kalshi portfolio balance"),
  balances: {
    startingCash: 0,
    currentEquity: 0,
    realizedPnl: 0,
    returnPct: 0,
  },
  strategy: {
    seriesTicker: KALSHI_BTC15M_SERIES,
    primaryStrategy: DEFAULT_PRIMARY_STRATEGY,
    triggerPrice: PAPER_TRIGGER_PRICE,
    entrySecondsLeft: PAPER_ENTRY_SECONDS_LEFT,
    minSecondsLeft: PAPER_MIN_SECONDS_LEFT,
    pollSeconds: PAPER_POLL_MS / 1000,
  },
  limits: createDefaultLimits(),
  lastTrade: null,
  recentTrades: [],
  activePosition: null,
  liveMarket: null,
  liveCompare: createLiveCompareState(),
  polymarket: createPolymarketState(),
  startedAt: null,
  stoppedAt: null,
  lastPollAt: null,
  lastError: null,
  note: "Kalshi live worker is inactive. Select a model, keep fail-safes set, and turn off the kill switch only when ready.",
};
const paperWorker = {
  timer: null,
  polling: false,
};
const liveCompareWorker = {
  timer: null,
  polling: false,
};
const polymarketWorker = {
  timer: null,
  polling: false,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function createCompareAccount(strategy) {
  return {
    strategy,
    startingCash: 0,
    currentEquity: 0,
    realizedPnl: 0,
    returnPct: 0,
    entriesToday: 0,
    activePosition: null,
    lastSignal: null,
    lastTrade: null,
    recentTrades: [],
  };
}

function createAccountBalance(source) {
  return {
    availableCash: null,
    rawBalance: null,
    allowance: null,
    rawAllowance: null,
    source,
    checkedAt: null,
    error: null,
    signerAddress: null,
    funderAddress: null,
    signatureType: null,
    apiCredsSource: null,
    refreshed: null,
    refreshError: null,
    signatureTypeBalances: [],
    collateralAddress: null,
    onChainFunderBalance: null,
    onChainFunderRawBalance: null,
    onChainSignerBalance: null,
    onChainSignerRawBalance: null,
    onChainError: null,
  };
}

function createDefaultLimits() {
  return {
    maxDailyLossUsd: 25,
    maxDailyLossPct: 10,
    maxTotalLossUsd: 50,
    maxTotalLossPct: 20,
    maxStakeUsd: 5,
    maxTradesPerDay: 12,
  };
}

function parseCompareStrategyList(value, fallback = ["v1", "v3"], allowEmpty = false) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const selected = [];
  for (const item of raw) {
    const strategy = String(item || "").trim().toLowerCase();
    if (COMPARE_STRATEGIES.includes(strategy) && !selected.includes(strategy)) selected.push(strategy);
  }
  if (selected.length) return selected;
  const fallbackSelected = [];
  for (const item of Array.isArray(fallback) ? fallback : []) {
    const strategy = String(item || "").trim().toLowerCase();
    if (COMPARE_STRATEGIES.includes(strategy) && !fallbackSelected.includes(strategy)) fallbackSelected.push(strategy);
  }
  return fallbackSelected.length ? fallbackSelected : allowEmpty ? [] : ["v1"];
}

function normalizeCompareStrategies(value) {
  const explicitList = Array.isArray(value);
  return parseCompareStrategyList(value, explicitList ? [] : DEFAULT_COMPARE_STRATEGIES, explicitList);
}

function normalizePrimaryStrategy(value) {
  return parseCompareStrategyList([value], [DEFAULT_PRIMARY_STRATEGY])[0] || "v1";
}

function ensurePrimaryStrategyEnabled(strategies, primaryStrategy) {
  const primary = normalizePrimaryStrategy(primaryStrategy);
  const selected = normalizeCompareStrategies(strategies);
  return selected.includes(primary) ? selected : [primary, ...selected];
}

function compareStrategyLabel(strategies = DEFAULT_COMPARE_STRATEGIES) {
  return normalizeCompareStrategies(strategies)
    .map((strategy) => strategy.toUpperCase())
    .join("/");
}

function enabledCompareStrategies(compare = tradingState.liveCompare) {
  return ensurePrimaryStrategyEnabled(compare?.enabledStrategies, compare?.primaryStrategy || tradingState.strategy?.primaryStrategy);
}

function normalizePolymarketStrategies(value) {
  const explicitList = Array.isArray(value);
  return parseCompareStrategyList(value, explicitList ? [] : DEFAULT_POLYMARKET_STRATEGIES, explicitList);
}

function enabledPolymarketStrategies(state = tradingState.polymarket) {
  const primary = normalizePrimaryStrategy(state?.primaryStrategy || DEFAULT_POLYMARKET_PRIMARY_STRATEGY);
  const selected = normalizePolymarketStrategies(state?.enabledStrategies);
  return selected.includes(primary) ? selected : [primary, ...selected];
}

function createLiveCompareState() {
  return {
    workerStatus: "inactive",
    profile: LIVE_COMPARE_PROFILE,
    mode: "paper_live_data",
    primaryStrategy: DEFAULT_PRIMARY_STRATEGY,
    enabledStrategies: ensurePrimaryStrategyEnabled(DEFAULT_COMPARE_STRATEGIES, DEFAULT_PRIMARY_STRATEGY),
    seriesTicker: KALSHI_BTC15M_SERIES,
    pollSeconds: LIVE_COMPARE_POLL_MS / 1000,
    startedAt: null,
    stoppedAt: null,
    lastPollAt: null,
    lastError: null,
    lastReport: null,
    liveMarket: null,
    note: `${compareStrategyLabel(DEFAULT_COMPARE_STRATEGIES)} live compare worker is inactive. It uses live data and virtual paper fills only.`,
    strategies: {
      v1: createCompareAccount("v1"),
      v2: createCompareAccount("v2"),
      v3: createCompareAccount("v3"),
    },
    recentTrades: [],
  };
}

function createPolymarketState() {
  const primaryStrategy = DEFAULT_POLYMARKET_PRIMARY_STRATEGY;
  const enabledStrategies = enabledPolymarketStrategies({
    primaryStrategy,
    enabledStrategies: DEFAULT_POLYMARKET_STRATEGIES,
  });
  return {
    workerStatus: "inactive",
    profile: LIVE_COMPARE_PROFILE,
    mode: "paper",
    liveArmed: false,
    killSwitch: true,
    primaryStrategy,
    enabledStrategies,
    limits: createDefaultLimits(),
    marketSlugPrefix: POLYMARKET_BTC5M_SLUG_PREFIX,
    pollSeconds: POLYMARKET_POLL_MS / 1000,
    startedAt: null,
    stoppedAt: null,
    lastPollAt: null,
    lastError: null,
    lastReport: null,
    liveMarket: null,
    accountBalance: createAccountBalance("Polymarket collateral balance"),
    note: `${compareStrategyLabel(enabledStrategies)} Polymarket 5m worker is inactive. Paper mode uses live Polymarket data.`,
    strategies: {
      v1: createCompareAccount("v1"),
      v2: createCompareAccount("v2"),
      v3: createCompareAccount("v3"),
    },
    recentTrades: [],
  };
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanTradeList(value, maxItems) {
  return Array.isArray(value) ? value.filter(isPlainObject).slice(0, maxItems) : [];
}

function cleanObjectOrNull(value) {
  return isPlainObject(value) ? value : null;
}

function envNumber(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function mergeNumberFields(target, source, keys) {
  if (!isPlainObject(source)) return;
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) target[key] = value;
  }
}

function mergeStringFields(target, source, keys) {
  if (!isPlainObject(source)) return;
  for (const key of keys) {
    if (typeof source[key] === "string") target[key] = source[key];
  }
}

function mergeAccountBalance(saved, source) {
  const snapshot = createAccountBalance(source);
  if (!isPlainObject(saved)) return snapshot;
  mergeNumberFields(snapshot, saved, ["availableCash", "allowance", "signatureType"]);
  mergeNumberFields(snapshot, saved, ["onChainFunderBalance", "onChainSignerBalance"]);
  mergeStringFields(snapshot, saved, [
    "rawBalance",
    "rawAllowance",
    "source",
    "checkedAt",
    "error",
    "signerAddress",
    "funderAddress",
    "apiCredsSource",
    "refreshError",
    "collateralAddress",
    "onChainFunderRawBalance",
    "onChainSignerRawBalance",
    "onChainError",
  ]);
  if (typeof saved.refreshed === "boolean") snapshot.refreshed = saved.refreshed;
  snapshot.signatureTypeBalances = Array.isArray(saved.signatureTypeBalances)
    ? saved.signatureTypeBalances.filter(isPlainObject).slice(0, 4)
    : [];
  return snapshot;
}

function compareEntriesToday(account) {
  const today = utcDay();
  return cleanTradeList(account?.recentTrades, 100).filter(
    (trade) => trade.kind === "compare_entry" && String(trade.ts || "").startsWith(today),
  ).length;
}

function polymarketEntriesToday(account) {
  const today = utcDay();
  return cleanTradeList(account?.recentTrades, 100).filter(
    (trade) => trade.kind === "polymarket_entry" && String(trade.ts || "").startsWith(today),
  ).length;
}

function isEmptyCashState(account) {
  return (
    Math.abs(Number(account?.realizedPnl || 0)) < 0.000001 &&
    !account?.activePosition &&
    !account?.lastTrade &&
    cleanTradeList(account?.recentTrades, 100).length === 0
  );
}

function resetLegacyFallbackCash(account, configuredStartingCash) {
  const starting = Number(account?.startingCash || 0);
  const current = Number(account?.currentEquity || 0);
  const configured = Number(configuredStartingCash.toFixed(6));
  if (starting !== 100 || current !== 100 || configured === 100 || !isEmptyCashState(account)) return false;
  account.startingCash = configured;
  account.currentEquity = configured;
  account.returnPct = 0;
  return true;
}

function resetLegacyPaperFallbackCash() {
  const balances = tradingState.balances;
  const starting = Number(balances.startingCash || 0);
  const current = Number(balances.currentEquity || 0);
  const configured = Number(PAPER_STARTING_CASH.toFixed(6));
  const hasPaperActivity =
    Math.abs(Number(balances.realizedPnl || 0)) >= 0.000001 ||
    tradingState.activePosition ||
    tradingState.lastTrade ||
    cleanTradeList(tradingState.recentTrades, 100).length > 0;
  if (starting !== 100 || current !== 100 || configured === 100 || hasPaperActivity) return false;
  balances.startingCash = configured;
  balances.currentEquity = configured;
  balances.returnPct = 0;
  return true;
}

function mergeCompareAccountState(strategy, saved) {
  const account = createCompareAccount(strategy);
  if (!isPlainObject(saved)) return account;

  mergeNumberFields(account, saved, ["startingCash", "currentEquity", "realizedPnl", "returnPct"]);
  account.activePosition = cleanObjectOrNull(saved.activePosition);
  account.lastSignal = cleanObjectOrNull(saved.lastSignal);
  account.lastTrade = cleanObjectOrNull(saved.lastTrade);
  account.recentTrades = cleanTradeList(saved.recentTrades, 50);
  account.entriesToday = compareEntriesToday(account);
  return account;
}

function mergeLiveCompareState(saved) {
  const state = createLiveCompareState();
  if (!isPlainObject(saved)) return state;

  state.workerStatus = saved.workerStatus === "active" ? "active" : "inactive";
  state.profile = saved.profile === "aggressive" ? "aggressive" : "conservative";
  mergeStringFields(state, saved, [
    "mode",
    "seriesTicker",
    "startedAt",
    "stoppedAt",
    "lastPollAt",
    "lastError",
    "note",
  ]);
  state.primaryStrategy = normalizePrimaryStrategy(saved.primaryStrategy || saved.executionStrategy);
  state.enabledStrategies = ensurePrimaryStrategyEnabled(saved.enabledStrategies || saved.activeStrategies, state.primaryStrategy);
  mergeNumberFields(state, saved, ["pollSeconds"]);
  state.lastReport = cleanObjectOrNull(saved.lastReport);
  state.liveMarket = cleanObjectOrNull(saved.liveMarket);
  state.recentTrades = cleanTradeList(saved.recentTrades, 100);

  const savedStrategies = isPlainObject(saved.strategies) ? saved.strategies : {};
  for (const strategy of COMPARE_STRATEGIES) {
    state.strategies[strategy] = mergeCompareAccountState(strategy, savedStrategies[strategy]);
  }
  return state;
}

function mergePolymarketState(saved) {
  const state = createPolymarketState();
  if (!isPlainObject(saved)) return state;

  state.workerStatus = saved.workerStatus === "active" ? "active" : "inactive";
  state.profile = saved.profile === "aggressive" ? "aggressive" : "conservative";
  state.liveArmed = saved.liveArmed === true && saved.mode === "live";
  state.mode = state.liveArmed ? "live" : "paper";
  if (typeof saved.killSwitch === "boolean") state.killSwitch = saved.killSwitch;
  mergeStringFields(state, saved, [
    "marketSlugPrefix",
    "startedAt",
    "stoppedAt",
    "lastPollAt",
    "lastError",
    "note",
  ]);
  state.primaryStrategy = normalizePrimaryStrategy(saved.primaryStrategy || saved.executionStrategy || DEFAULT_POLYMARKET_PRIMARY_STRATEGY);
  state.enabledStrategies = (() => {
    const explicit = Array.isArray(saved.enabledStrategies || saved.activeStrategies);
    const selected = explicit
      ? parseCompareStrategyList(saved.enabledStrategies || saved.activeStrategies, [], true)
      : normalizePolymarketStrategies(saved.enabledStrategies || saved.activeStrategies);
    return selected.includes(state.primaryStrategy) ? selected : [state.primaryStrategy, ...selected];
  })();
  mergeNumberFields(state, saved, ["pollSeconds"]);
  mergeNumberFields(state.limits, saved.limits, [
    "maxDailyLossUsd",
    "maxDailyLossPct",
    "maxTotalLossUsd",
    "maxTotalLossPct",
    "maxStakeUsd",
    "maxTradesPerDay",
  ]);
  state.limits.maxTradesPerDay = Math.max(1, Math.round(Number(state.limits.maxTradesPerDay || 1)));
  state.lastReport = cleanObjectOrNull(saved.lastReport);
  state.liveMarket = cleanObjectOrNull(saved.liveMarket);
  state.accountBalance = mergeAccountBalance(saved.accountBalance, "Polymarket collateral balance");
  state.recentTrades = cleanTradeList(saved.recentTrades, 100);

  const savedStrategies = isPlainObject(saved.strategies) ? saved.strategies : {};
  for (const strategy of COMPARE_STRATEGIES) {
    state.strategies[strategy] = mergeCompareAccountState(strategy, savedStrategies[strategy]);
    state.strategies[strategy].entriesToday = polymarketEntriesToday(state.strategies[strategy]);
  }
  return state;
}

function mergeTradingState(saved) {
  if (!isPlainObject(saved)) return false;

  tradingState.mode = saved.mode === "live" ? "live" : "paper";
  tradingState.workerStatus = saved.workerStatus === "active" ? "active" : "inactive";
  if (typeof saved.killSwitch === "boolean") tradingState.killSwitch = saved.killSwitch;
  mergeStringFields(tradingState, saved, [
    "updatedAt",
    "startedAt",
    "stoppedAt",
    "lastPollAt",
    "lastError",
    "note",
  ]);
  mergeNumberFields(tradingState.balances, saved.balances, [
    "startingCash",
    "currentEquity",
    "realizedPnl",
    "returnPct",
  ]);
  tradingState.accountBalance = mergeAccountBalance(saved.accountBalance, "Kalshi portfolio balance");
  mergeNumberFields(tradingState.limits, saved.limits, [
    "maxDailyLossUsd",
    "maxDailyLossPct",
    "maxTotalLossUsd",
    "maxTotalLossPct",
    "maxStakeUsd",
    "maxTradesPerDay",
  ]);
  tradingState.limits.maxTradesPerDay = Math.max(1, Math.round(Number(tradingState.limits.maxTradesPerDay || 1)));
  tradingState.lastTrade = cleanObjectOrNull(saved.lastTrade);
  tradingState.recentTrades = cleanTradeList(saved.recentTrades, 100);
  tradingState.activePosition = cleanObjectOrNull(saved.activePosition);
  tradingState.liveMarket = cleanObjectOrNull(saved.liveMarket);
  tradingState.liveCompare = mergeLiveCompareState(saved.liveCompare);
  tradingState.polymarket = mergePolymarketState(saved.polymarket);
  tradingState.strategy.primaryStrategy = normalizePrimaryStrategy(
    saved.strategy?.primaryStrategy || saved.primaryStrategy || tradingState.liveCompare.primaryStrategy,
  );
  tradingState.liveCompare.enabledStrategies = ensurePrimaryStrategyEnabled(
    tradingState.liveCompare.enabledStrategies,
    tradingState.liveCompare.primaryStrategy,
  );
  resetLegacyPaperFallbackCash();
  for (const strategy of COMPARE_STRATEGIES) {
    resetLegacyFallbackCash(tradingState.liveCompare.strategies[strategy], LIVE_COMPARE_STARTING_CASH);
  }
  tradingState.restoredAt = new Date().toISOString();
  updatePaperEquity();
  return true;
}

function tradingStateSnapshot() {
  return {
    version: TRADING_STATE_VERSION,
    savedAt: new Date().toISOString(),
    state: JSON.parse(JSON.stringify(tradingState)),
  };
}

function saveTradingState() {
  try {
    fs.mkdirSync(path.dirname(TRADING_STATE_FILE), { recursive: true });
    const tempPath = `${TRADING_STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(tradingStateSnapshot(), null, 2));
    fs.renameSync(tempPath, TRADING_STATE_FILE);
  } catch (err) {
    console.warn(`Could not save trading state: ${err.message || String(err)}`);
  }
}

function loadTradingState() {
  try {
    if (!fs.existsSync(TRADING_STATE_FILE)) return false;
    const raw = fs.readFileSync(TRADING_STATE_FILE, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    const saved = parsed?.state || parsed?.tradingState || parsed;
    const loaded = mergeTradingState(saved);
    if (loaded) console.log(`Loaded trading state from ${TRADING_STATE_FILE}`);
    return loaded;
  } catch (err) {
    console.warn(`Could not load trading state from ${TRADING_STATE_FILE}: ${err.message || String(err)}`);
    return false;
  }
}

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (key === "KALSHI_PRIVATE_KEY" && value.includes("BEGIN") && !value.includes("END")) {
      const pemLines = [value];
      while (i + 1 < lines.length) {
        i += 1;
        pemLines.push(lines[i]);
        if (lines[i].includes("END") && lines[i].includes("PRIVATE KEY")) break;
      }
      value = pemLines.join("\n");
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowOrigin =
    origin && (FRONTEND_ORIGINS.length === 0 || FRONTEND_ORIGINS.includes(origin)) ? origin : FRONTEND_ORIGINS[0];
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
  if (allowOrigin) {
    headers["access-control-allow-origin"] = allowOrigin;
    headers.vary = "Origin";
  }
  return headers;
}

function send(req, res, status, body, type = "application/json; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, { "content-type": type, ...extraHeaders, ...corsHeaders(req) });
  res.end(body);
}

function sendJson(req, res, status, obj) {
  send(req, res, status, JSON.stringify(obj), "application/json; charset=utf-8");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function asNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeDateTime(value) {
  if (!value || typeof value !== "string") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(".000Z", "Z");
}

function normalizeTradingSettings(input, current = tradingState.limits) {
  return {
    maxDailyLossUsd: asNumber(input.maxDailyLossUsd, current.maxDailyLossUsd, 0, 1_000_000),
    maxDailyLossPct: asNumber(input.maxDailyLossPct, current.maxDailyLossPct, 0, 100),
    maxTotalLossUsd: asNumber(input.maxTotalLossUsd, current.maxTotalLossUsd, 0, 1_000_000),
    maxTotalLossPct: asNumber(input.maxTotalLossPct, current.maxTotalLossPct, 0, 100),
    maxStakeUsd: asNumber(input.maxStakeUsd, current.maxStakeUsd, 0.01, 1_000_000),
    maxTradesPerDay: Math.round(asNumber(input.maxTradesPerDay, current.maxTradesPerDay, 1, 10_000)),
  };
}

function kalshiEnv() {
  return process.env.KALSHI_ENV === "prod" ? "prod" : "demo";
}

function kalshiBaseUrl() {
  if (process.env.KALSHI_API_BASE_URL) return process.env.KALSHI_API_BASE_URL.replace(/\/$/, "");
  return kalshiEnv() === "prod"
    ? `https://external-api.kalshi.com${KALSHI_API_PREFIX}`
    : `https://external-api.demo.kalshi.co${KALSHI_API_PREFIX}`;
}

function kalshiPrivateKeyPem() {
  if (process.env.KALSHI_PRIVATE_KEY_PATH) {
    const p = path.resolve(ROOT, process.env.KALSHI_PRIVATE_KEY_PATH);
    return fs.readFileSync(p, "utf8");
  }
  if (process.env.KALSHI_PRIVATE_KEY_BASE64) {
    return Buffer.from(process.env.KALSHI_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  }
  if (process.env.KALSHI_PRIVATE_KEY) {
    return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  return "";
}

function createKalshiPrivateKey() {
  const keyText = kalshiPrivateKeyPem().trim();
  if (!keyText) {
    throw new Error("Kalshi credentials are not configured");
  }
  if (keyText.includes("-----BEGIN")) {
    return crypto.createPrivateKey(keyText);
  }

  const der = Buffer.from(keyText.replace(/\s/g, ""), "base64");
  try {
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs1" });
  } catch (pkcs1Error) {
    try {
      return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } catch {
      throw pkcs1Error;
    }
  }
}

function kalshiAuthHeaders(method, apiPath) {
  const keyId = process.env.KALSHI_API_KEY_ID || "";
  if (!keyId || !kalshiPrivateKeyPem()) {
    throw new Error("Kalshi credentials are not configured");
  }
  const timestamp = String(Date.now());
  const pathOnly = `${KALSHI_API_PREFIX}${apiPath.split("?")[0]}`;
  const message = `${timestamp}${method.toUpperCase()}${pathOnly}`;
  const signature = crypto.sign("sha256", Buffer.from(message), {
    key: createKalshiPrivateKey(),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
  });
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
  };
}

function kalshiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${kalshiBaseUrl()}${apiPath}`);
    const payload = body === null || body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      url,
      {
        method,
        headers: {
          ...kalshiAuthHeaders(method, apiPath),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = body;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Kalshi ${res.statusCode}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            err.apiPath = apiPath;
            reject(err);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function kalshiPublicRequest(apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${kalshiBaseUrl()}${apiPath}`);
    const req = https.request(url, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = body ? JSON.parse(body) : null;
        } catch {
          parsed = body;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`Kalshi public ${res.statusCode}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
          err.statusCode = res.statusCode;
          err.body = parsed;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsJsonRequest(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const payload = body === null || body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      parsedUrl,
      {
        method,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`${parsedUrl.hostname} ${res.statusCode}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            reject(err);
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function polymarketGammaRequest(pathname) {
  return httpsJsonRequest(`${POLYMARKET_GAMMA_BASE_URL}${pathname}`);
}

function polymarketClobRequest(pathname) {
  return httpsJsonRequest(`${POLYMARKET_CLOB_BASE_URL}${pathname}`);
}

function dollars(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function kalshiPriceDollars(dollarValue, centValue = null, fallback = null) {
  const rawDollar = dollars(dollarValue, null);
  if (rawDollar !== null) {
    if (rawDollar > 0 && rawDollar <= 1) return rawDollar;
    if (rawDollar > 1 && rawDollar <= 100) return rawDollar / 100;
  }
  const rawCents = dollars(centValue, null);
  if (rawCents !== null) {
    if (rawCents > 0 && rawCents < 1) return rawCents;
    if (rawCents >= 1 && rawCents <= 100) return rawCents / 100;
  }
  return fallback;
}

function utcDay(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function updatePaperEquity() {
  const starting = Number(tradingState.balances.startingCash || 0);
  const realized = Number(tradingState.balances.realizedPnl || 0);
  tradingState.balances.currentEquity = Number((starting + realized).toFixed(6));
  tradingState.balances.returnPct = starting > 0 ? Number(((realized / starting) * 100).toFixed(4)) : 0;
}

function todayPaperEntryCount() {
  const today = utcDay();
  return tradingState.recentTrades.filter(
    (trade) =>
      ["paper_entry", "kalshi_live_entry", "kalshi_live_order_no_fill", "kalshi_live_order_no_liquidity", "kalshi_live_order_error"].includes(trade.kind) &&
      String(trade.ts || "").startsWith(today),
  ).length;
}

function failSafeReason() {
  const limits = tradingState.limits;
  const realized = Number(tradingState.balances.realizedPnl || 0);
  const returnPct = Number(tradingState.balances.returnPct || 0);
  if (limits.maxDailyLossUsd > 0 && realized <= -limits.maxDailyLossUsd) return `daily loss $${limits.maxDailyLossUsd} reached`;
  if (limits.maxDailyLossPct > 0 && returnPct <= -limits.maxDailyLossPct) return `daily loss ${limits.maxDailyLossPct}% reached`;
  if (limits.maxTotalLossUsd > 0 && realized <= -limits.maxTotalLossUsd) return `total loss $${limits.maxTotalLossUsd} reached`;
  if (limits.maxTotalLossPct > 0 && returnPct <= -limits.maxTotalLossPct) return `total loss ${limits.maxTotalLossPct}% reached`;
  if (todayPaperEntryCount() >= limits.maxTradesPerDay) return `max trades per day ${limits.maxTradesPerDay} reached`;
  return "";
}

function addTrade(trade) {
  tradingState.lastTrade = trade;
  tradingState.recentTrades = [trade, ...tradingState.recentTrades].slice(0, 100);
  saveTradingState();
}

function kalshiLiveCredentialsConfigured() {
  return Boolean(process.env.KALSHI_API_KEY_ID && kalshiPrivateKeyPem());
}

function kalshiLiveModeConfiguredError() {
  if (!kalshiLiveCredentialsConfigured()) return "Kalshi API credentials are not configured in .env";
  return "";
}

function fixedDollar(value) {
  return Math.min(0.99, Math.max(0.01, Number(value))).toFixed(4);
}

function kalshiOrderSideAndPrice(signalSide, marketPrice) {
  const normalized = String(signalSide || "").toUpperCase();
  const maxPrice = Math.min(0.99, Math.max(0.01, Number(marketPrice || 0) + KALSHI_LIVE_MAX_PRICE_SLIPPAGE));
  if (normalized === "UP" || normalized === "YES") {
    return { side: "bid", price: fixedDollar(maxPrice), resolvedSide: "yes" };
  }
  if (normalized === "DOWN" || normalized === "NO") {
    return { side: "ask", price: fixedDollar(1 - maxPrice), resolvedSide: "no" };
  }
  throw new Error(`Unsupported Kalshi signal side: ${signalSide || "--"}`);
}

function kalshiFillCount(order) {
  return dollars(order?.fill_count ?? order?.fillCount, null);
}

function kalshiEconomicFillPrice(order, fallbackPrice) {
  const yesSidePrice = kalshiPriceDollars(order?.average_fill_price ?? order?.averageFillPrice, null);
  if (yesSidePrice === null) return fallbackPrice;
  return order?.resolvedSide === "no" ? Number((1 - yesSidePrice).toFixed(6)) : yesSidePrice;
}

function kalshiFillFee(order, filledCount, fillPrice) {
  const averageFee = dollars(order?.average_fee_paid ?? order?.averageFeePaid, null);
  if (averageFee !== null) return Number((Number(filledCount || 0) * averageFee).toFixed(6));
  return kalshiEstimatedTakerFee(filledCount, fillPrice);
}

function kalshiEstimatedTakerFee(contracts, price) {
  const count = Number(contracts);
  const p = Number(price);
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return Math.ceil(KALSHI_TAKER_FEE_RATE * count * p * (1 - p) * 100) / 100;
}

function kalshiMaxContractsForBudget(budget, price) {
  const spendable = Number(budget);
  const p = Number(price);
  if (!Number.isFinite(spendable) || spendable <= 0 || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  let low = 0;
  let high = Math.floor(spendable / p);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const total = mid * p + kalshiEstimatedTakerFee(mid, p);
    if (total <= spendable + 1e-9) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function kalshiLiveOrderBudget(signal, availableCash) {
  const suggested = dollars(signal?.suggested_stake_usd, null);
  const fallback = Number(tradingState.limits.maxStakeUsd || 0);
  const target = suggested !== null && suggested > 0 ? suggested : fallback;
  const spendableCash = Math.max(0, Number(availableCash || 0) - KALSHI_LIVE_CASH_BUFFER_USD);
  return Math.min(target, fallback, spendableCash);
}

async function fetchKalshiOrderbook(ticker) {
  const key = String(ticker || "").trim();
  if (!key) throw new Error("Kalshi market ticker is required for orderbook lookup");
  const qs = new URLSearchParams({ depth: String(KALSHI_ORDERBOOK_DEPTH) });
  return kalshiPublicRequest(`/markets/${encodeURIComponent(key)}/orderbook?${qs.toString()}`);
}

function kalshiBookLevels(orderbook, side) {
  const fp = orderbook?.orderbook_fp || {};
  const legacy = orderbook?.orderbook || {};
  const rows =
    side === "yes"
      ? fp.yes_dollars || legacy.yes_dollars || legacy.yes || []
      : fp.no_dollars || legacy.no_dollars || legacy.no || [];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const priceRaw = Array.isArray(row) ? row[0] : row?.price_dollars ?? row?.price;
      const countRaw = Array.isArray(row) ? row[1] : row?.count_fp ?? row?.count;
      let levelPrice = Number(priceRaw);
      if (Number.isFinite(levelPrice) && levelPrice > 1) levelPrice /= 100;
      const count = Number(countRaw);
      return {
        price: levelPrice,
        count,
      };
    })
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.count) && level.price > 0 && level.count > 0);
}

function kalshiLimitEconomicPrice(order) {
  const yesSidePrice = Number(order?.price);
  if (!Number.isFinite(yesSidePrice) || yesSidePrice <= 0 || yesSidePrice >= 1) return null;
  return order.resolvedSide === "no" ? Number((1 - yesSidePrice).toFixed(6)) : yesSidePrice;
}

function kalshiRestingContractsForOrder(orderbook, order) {
  const yesSidePrice = Number(order?.price);
  if (!Number.isFinite(yesSidePrice)) return 0;
  const levels = order.resolvedSide === "yes" ? kalshiBookLevels(orderbook, "no") : kalshiBookLevels(orderbook, "yes");
  const minBid = order.resolvedSide === "yes" ? 1 - yesSidePrice : yesSidePrice;
  const count = levels
    .filter((level) => level.price + 1e-9 >= minBid)
    .reduce((sum, level) => sum + level.count, 0);
  return Math.floor(count);
}

function createKalshiLiquidityError({ ticker, requestedContracts, availableContracts, order, orderbook }) {
  const limitEconomicPrice = kalshiLimitEconomicPrice(order);
  const message = `Kalshi FOK skipped: requested ${requestedContracts} ${order.resolvedSide.toUpperCase()} contracts but only ${availableContracts} were resting within limit ${
    limitEconomicPrice === null ? "--" : limitEconomicPrice.toFixed(4)
  } on ${ticker}`;
  const err = new Error(message);
  err.code = "kalshi_insufficient_resting_volume";
  err.availableContracts = availableContracts;
  err.requestedContracts = requestedContracts;
  err.orderbook = orderbook;
  err.limitEconomicPrice = limitEconomicPrice;
  return err;
}

function kalshiLivePriceSkipReason({ ticker, signalSide, price }) {
  const value = Number(price);
  const side = String(signalSide || "--").toUpperCase();
  const market = ticker ? ` on ${ticker}` : "";
  if (!Number.isFinite(value) || value <= 0) return `Kalshi live skipped${market}: no usable ${side} ask is available.`;
  if (value >= KALSHI_LIVE_MAX_TAKE_PRICE) {
    return `Kalshi live skipped${market}: ${side} ask ${value.toFixed(4)} is at or above max take ${KALSHI_LIVE_MAX_TAKE_PRICE.toFixed(
      4,
    )}.`;
  }
  return "";
}

function isKalshiLiquidityError(err) {
  const apiCode = err?.body?.error?.code || err?.api_error?.error?.code;
  return (
    err?.code === "kalshi_insufficient_resting_volume" ||
    err?.code === "kalshi_unusable_live_price" ||
    apiCode === "fill_or_kill_insufficient_resting_volume"
  );
}

async function placeKalshiLiveOrder({ ticker, signalSide, cost, marketPrice }) {
  const price = kalshiPriceDollars(marketPrice, null);
  if (!ticker) throw new Error("Kalshi market ticker is required");
  const skipReason = kalshiLivePriceSkipReason({ ticker, signalSide, price });
  if (skipReason) {
    const err = new Error(skipReason);
    err.code = "kalshi_unusable_live_price";
    throw err;
  }
  const order = kalshiOrderSideAndPrice(signalSide, price);
  const limitEconomicPrice = kalshiLimitEconomicPrice(order);
  if (limitEconomicPrice === null) throw new Error("Kalshi live limit price must be between 0 and 1");
  const budgetCount = kalshiMaxContractsForBudget(cost, limitEconomicPrice);
  if (budgetCount < 1) throw new Error(`Kalshi stake is too small for one contract plus estimated fees at ${limitEconomicPrice.toFixed(4)}`);
  const orderbook = await fetchKalshiOrderbook(ticker);
  const availableContracts = kalshiRestingContractsForOrder(orderbook, order);
  const count =
    KALSHI_LIVE_TIME_IN_FORCE === "fill_or_kill" ? Math.min(budgetCount, availableContracts) : budgetCount;
  const estimatedFee = kalshiEstimatedTakerFee(count, limitEconomicPrice);
  const estimatedTotalCost = Number((count * limitEconomicPrice + estimatedFee).toFixed(6));
  if (KALSHI_LIVE_TIME_IN_FORCE === "fill_or_kill" && count < 1) {
    throw createKalshiLiquidityError({
      ticker,
      requestedContracts: budgetCount,
      availableContracts,
      order,
      orderbook,
    });
  }
  const body = {
    ticker,
    client_order_id: crypto.randomUUID(),
    side: order.side,
    count: count.toFixed(2),
    price: order.price,
    time_in_force: KALSHI_LIVE_TIME_IN_FORCE,
    self_trade_prevention_type: "taker_at_cross",
    post_only: false,
    cancel_order_on_pause: true,
    reduce_only: false,
    exchange_index: -1,
  };
  let response;
  try {
    response = await kalshiRequest("POST", "/portfolio/events/orders", body);
  } catch (err) {
    err.requestBody = body;
    err.requestedContracts = count;
    err.availableContracts = availableContracts;
    err.limitEconomicPrice = limitEconomicPrice;
    err.estimatedFee = estimatedFee;
    err.estimatedTotalCost = estimatedTotalCost;
    throw err;
  }
  return {
    ...response,
    request: body,
    requestedContracts: count,
    effectivePrice: price,
    limitEconomicPrice,
    restingContractsAvailable: availableContracts,
    estimatedFee,
    estimatedTotalCost,
    resolvedSide: order.resolvedSide,
  };
}

async function currentKalshiBalanceDollars() {
  try {
    const snapshot = await fetchKalshiBalanceSnapshot();
    return snapshot.availableCash;
  } catch {
    return null;
  }
}

function kalshiBalanceDollars(data) {
  const nestedDollars = dollars(data?.balance?.balance_dollars, null);
  if (nestedDollars !== null) return nestedDollars;
  const rootDollars = dollars(data?.balance_dollars, null);
  if (rootDollars !== null) return rootDollars;
  const nestedCents = dollars(data?.balance?.balance, null);
  if (nestedCents !== null) return nestedCents / 100;
  const rootCents = dollars(data?.balance, null);
  return rootCents !== null ? rootCents / 100 : null;
}

async function fetchKalshiBalanceSnapshot() {
  const data = await kalshiRequest("GET", "/portfolio/balance");
  const availableCash = kalshiBalanceDollars(data);
  return {
    ...createAccountBalance("Kalshi portfolio balance"),
    availableCash: availableCash === null ? null : Number(availableCash.toFixed(6)),
    rawBalance: JSON.stringify(data?.balance ?? data ?? null),
    checkedAt: new Date().toISOString(),
  };
}

async function syncKalshiAccountBalance({ force = false } = {}) {
  if (!kalshiLiveCredentialsConfigured()) {
    const snapshot = {
      ...createAccountBalance("Kalshi portfolio balance"),
      checkedAt: new Date().toISOString(),
      error: "Kalshi credentials are not configured in .env",
    };
    tradingState.accountBalance = snapshot;
    return snapshot;
  }
  const now = Date.now();
  if (!force && kalshiAccountBalanceCache.value && kalshiAccountBalanceCache.expiresAt > now) {
    tradingState.accountBalance = kalshiAccountBalanceCache.value;
    return kalshiAccountBalanceCache.value;
  }
  if (kalshiAccountBalanceCache.promise) return kalshiAccountBalanceCache.promise;
  kalshiAccountBalanceCache.promise = fetchKalshiBalanceSnapshot()
    .then((snapshot) => {
      kalshiAccountBalanceCache.value = snapshot;
      kalshiAccountBalanceCache.expiresAt = Date.now() + ACCOUNT_BALANCE_CACHE_MS;
      tradingState.accountBalance = snapshot;
      return snapshot;
    })
    .catch((err) => {
      const snapshot = {
        ...createAccountBalance("Kalshi portfolio balance"),
        checkedAt: new Date().toISOString(),
        error: err.message || String(err),
      };
      tradingState.accountBalance = snapshot;
      return snapshot;
    })
    .finally(() => {
      kalshiAccountBalanceCache.promise = null;
    });
  return kalshiAccountBalanceCache.promise;
}

async function resolvePaperStartingCash() {
  const startingCash = PAPER_STARTING_CASH;
  return {
    startingCash: Number(startingCash.toFixed(6)),
    source: "PAPER_STARTING_CASH",
  };
}

async function syncPaperStartingCash() {
  const { startingCash, source } = await resolvePaperStartingCash();
  const previousStartingCash = Number(tradingState.balances.startingCash || 0);
  if (previousStartingCash === startingCash) return { changed: false, startingCash, source };
  tradingState.balances.startingCash = startingCash;
  updatePaperEquity();
  tradingState.updatedAt = new Date().toISOString();
  saveTradingState();
  return { changed: true, startingCash, source };
}

async function fetchCurrentBtc15mMarket() {
  return (await fetchCurrentBtc15mMarketDetails()).market;
}

function marketCloseTimestamp(market) {
  return Date.parse(market?.close_time || market?.expected_expiration_time || "");
}

function marketOpenTimestamp(market) {
  const parsed = Date.parse(market?.open_time || market?.created_time || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function isUsableLiveMarket(market, now = Date.now()) {
  const closeTs = marketCloseTimestamp(market);
  if (!Number.isFinite(closeTs) || closeTs <= now) return false;
  const openTs = marketOpenTimestamp(market);
  if (openTs > now) return false;
  const status = String(market?.status || "").toLowerCase();
  return status !== "closed" && status !== "settled" && status !== "finalized";
}

function selectCurrentBtc15mMarket(markets, now = Date.now()) {
  return (Array.isArray(markets) ? markets : [])
    .filter((market) => isUsableLiveMarket(market, now))
    .sort((a, b) => marketCloseTimestamp(a) - marketCloseTimestamp(b))[0] || null;
}

function newestReturnedMarket(markets) {
  return (Array.isArray(markets) ? markets : [])
    .filter((market) => Number.isFinite(marketCloseTimestamp(market)))
    .sort((a, b) => marketCloseTimestamp(b) - marketCloseTimestamp(a))[0] || null;
}

function summarizeKalshiMarket(market) {
  if (!market) return null;
  return {
    ticker: market.ticker || null,
    status: market.status || null,
    openTime: market.open_time || null,
    closeTime: market.close_time || market.expected_expiration_time || null,
  };
}

function noCurrentBtc15mMarketMessage(details = {}) {
  const env = details.env || kalshiEnv();
  const latest = summarizeKalshiMarket(details.latestMarket);
  if (env !== "prod") {
    return `No active ${KALSHI_BTC15M_SERIES} market found on Kalshi demo. Set KALSHI_ENV=prod for production live markets.`;
  }
  if (latest) {
    return `No active ${KALSHI_BTC15M_SERIES} market returned by Kalshi prod. Latest returned: ${latest.ticker || "unknown"} ${latest.status || "unknown"} closes ${latest.closeTime || "unknown"}.`;
  }
  return `No active ${KALSHI_BTC15M_SERIES} market returned by Kalshi prod.`;
}

async function fetchCurrentBtc15mMarketDetailsUncached() {
  const qs = new URLSearchParams({
    series_ticker: KALSHI_BTC15M_SERIES,
    status: "open",
    limit: "25",
  });
  const openData = await kalshiPublicRequest(`/markets?${qs.toString()}`);
  const openMarkets = Array.isArray(openData?.markets) ? openData.markets : [];
  const market = selectCurrentBtc15mMarket(openMarkets);
  if (market) {
    return {
      market,
      env: kalshiEnv(),
      source: "markets?status=open",
      returnedMarkets: openMarkets.length,
      latestMarket: newestReturnedMarket(openMarkets),
    };
  }

  const fallbackQs = new URLSearchParams({
    series_ticker: KALSHI_BTC15M_SERIES,
    limit: "100",
  });
  const fallbackData = await kalshiPublicRequest(`/markets?${fallbackQs.toString()}`);
  const fallbackMarkets = Array.isArray(fallbackData?.markets) ? fallbackData.markets : [];
  const fallbackMarket = selectCurrentBtc15mMarket(fallbackMarkets);
  const combinedMarkets = [...openMarkets, ...fallbackMarkets];
  return {
    market: fallbackMarket,
    env: kalshiEnv(),
    source: fallbackMarket ? "markets?series_ticker" : null,
    returnedMarkets: combinedMarkets.length,
    latestMarket: newestReturnedMarket(combinedMarkets),
  };
}

async function fetchCurrentBtc15mMarketDetails({ force = false } = {}) {
  const now = Date.now();
  if (!force && currentBtc15mMarketCache.value && currentBtc15mMarketCache.expiresAt > now) {
    return { ...currentBtc15mMarketCache.value, cached: true };
  }
  if (!force && currentBtc15mMarketCache.promise) return currentBtc15mMarketCache.promise;

  currentBtc15mMarketCache.promise = fetchCurrentBtc15mMarketDetailsUncached()
    .then((details) => {
      currentBtc15mMarketCache.value = details;
      currentBtc15mMarketCache.expiresAt = Date.now() + KALSHI_MARKET_CACHE_MS;
      return details;
    })
    .catch((err) => {
      if (err.statusCode === 429 && currentBtc15mMarketCache.value) {
        currentBtc15mMarketCache.expiresAt = Date.now() + KALSHI_MARKET_CACHE_MS;
        return {
          ...currentBtc15mMarketCache.value,
          cached: true,
          rateLimited: true,
          rateLimitMessage: err.message || String(err),
        };
      }
      throw err;
    })
    .finally(() => {
      currentBtc15mMarketCache.promise = null;
    });
  return currentBtc15mMarketCache.promise;
}

function kalshiMarketSnapshot(market) {
  if (!market) return null;
  const closeTs = Date.parse(market.close_time || market.expected_expiration_time || "");
  return {
    source: "Kalshi public markets API",
    seriesTicker: KALSHI_BTC15M_SERIES,
    ticker: market.ticker || null,
    eventTicker: market.event_ticker || null,
    title: market.title || market.subtitle || null,
    closeTime: market.close_time || market.expected_expiration_time || null,
    secondsLeft: Number.isFinite(closeTs) ? Math.max(0, Math.round((closeTs - Date.now()) / 1000)) : null,
    yesAsk: kalshiPriceDollars(market.yes_ask_dollars, market.yes_ask, null),
    noAsk: kalshiPriceDollars(market.no_ask_dollars, market.no_ask, null),
    yesBid: kalshiPriceDollars(market.yes_bid_dollars, market.yes_bid, null),
    noBid: kalshiPriceDollars(market.no_bid_dollars, market.no_bid, null),
    yesLast: kalshiPriceDollars(market.yes_price_dollars, market.yes_price, null),
    noLast: kalshiPriceDollars(market.no_price_dollars, market.no_price, null),
  };
}

function sideAskFromMarket(snapshot, side) {
  if (!snapshot || !side) return null;
  const normalized = String(side).toUpperCase();
  if (normalized === "UP" || normalized === "YES") return snapshot.yesAsk;
  if (normalized === "DOWN" || normalized === "NO") return snapshot.noAsk;
  return null;
}

function enrichLiveSignal(signal, marketSnapshot) {
  if (!signal || typeof signal !== "object") return;
  const sideAsk = sideAskFromMarket(marketSnapshot, signal.side);
  signal.live_market_price = sideAsk;
  signal.live_market_side = signal.side === "UP" ? "YES" : signal.side === "DOWN" ? "NO" : null;
}

async function attachLiveMarketData(report, input = {}) {
  if (!report || typeof report !== "object" || !String(report.mode || "").startsWith("live_signal")) {
    return report;
  }
  const intervalMinutes = Math.round(asNumber(input.intervalMinutes, 15, 5, 15)) === 5 ? 5 : 15;
  if (intervalMinutes !== 15) {
    report.live_market_note = "Kalshi live market enrichment is only available for the configured 15-minute BTC series.";
    return report;
  }

  try {
    const marketDetails = input.marketDetails || (await fetchCurrentBtc15mMarketDetails());
    const market = marketDetails.market;
    const snapshot = kalshiMarketSnapshot(market);
    if (!snapshot) {
      report.live_market_note = noCurrentBtc15mMarketMessage(marketDetails);
      return report;
    }
    report.live_market = snapshot;
    report.live_market_data_owner = normalizePrimaryStrategy(input.primaryStrategy || tradingState.strategy.primaryStrategy).toUpperCase();
    if (marketDetails.cached) report.live_market_cached = true;
    if (marketDetails.rateLimited) report.live_market_rate_limited = true;
    enrichLiveSignal(report.signal, snapshot);
    enrichLiveSignal(report.summary, snapshot);
    if (report.strategies && typeof report.strategies === "object") {
      for (const strategyReport of Object.values(report.strategies)) {
        enrichLiveSignal(strategyReport.signal, snapshot);
        enrichLiveSignal(strategyReport.summary, snapshot);
        if (Array.isArray(strategyReport.trades)) {
          for (const row of strategyReport.trades) enrichLiveSignal(row, snapshot);
        }
      }
    }
    if (Array.isArray(report.trades)) {
      for (const row of report.trades) enrichLiveSignal(row, snapshot);
    }
    return report;
  } catch (err) {
    report.live_market_error = err.message || String(err);
    return report;
  }
}

async function fetchKalshiMarket(ticker) {
  const key = String(ticker || "").trim();
  if (!key) return null;
  const now = Date.now();
  const cached = kalshiMarketByTickerCache.get(key);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const entry = cached || { value: null, expiresAt: 0, promise: null };
  const qs = new URLSearchParams({ tickers: key, limit: "1" });
  entry.promise = kalshiPublicRequest(`/markets?${qs.toString()}`)
    .then((data) => {
      const market = Array.isArray(data?.markets) ? data.markets[0] || null : null;
      entry.value = market;
      entry.expiresAt = Date.now() + KALSHI_SETTLEMENT_CACHE_MS;
      return market;
    })
    .catch((err) => {
      if (err.statusCode === 429 && entry.value) return entry.value;
      throw err;
    })
    .finally(() => {
      entry.promise = null;
    });
  kalshiMarketByTickerCache.set(key, entry);
  return entry.promise;
}

function parseJsonArrayField(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function polymarketSlugForBucket(bucketSeconds) {
  return `${POLYMARKET_BTC5M_SLUG_PREFIX}-${bucketSeconds}`;
}

function polymarketMarketCloseTimestamp(market) {
  return Date.parse(market?.endDate || market?.endDateIso || "");
}

function polymarketMarketStartTimestamp(market) {
  const parsed = Date.parse(market?.startDate || "");
  if (Number.isFinite(parsed)) return parsed;
  const match = String(market?.slug || "").match(/-(\d{10})$/);
  return match ? Number(match[1]) * 1000 : 0;
}

function isUsablePolymarketMarket(market, now = Date.now()) {
  if (!market) return false;
  const closeTs = polymarketMarketCloseTimestamp(market);
  if (!Number.isFinite(closeTs) || closeTs <= now) return false;
  const startTs = polymarketMarketStartTimestamp(market);
  if (startTs > now + 300_000) return false;
  return market.active !== false && market.closed !== true && market.acceptingOrders !== false;
}

async function fetchPolymarketMarketBySlug(slug, { useCache = true } = {}) {
  const key = String(slug || "").trim();
  if (!key) return null;
  const now = Date.now();
  const cached = polymarketMarketBySlugCache.get(key);
  if (useCache && cached?.value && cached.expiresAt > now) return cached.value;
  if (useCache && cached?.promise) return cached.promise;

  const entry = cached || { value: null, expiresAt: 0, promise: null };
  entry.promise = polymarketGammaRequest(`/markets/slug/${encodeURIComponent(key)}`)
    .then((market) => {
      entry.value = market;
      entry.expiresAt = Date.now() + POLYMARKET_SETTLEMENT_CACHE_MS;
      return market;
    })
    .catch((err) => {
      if (err.statusCode === 404) return null;
      if (err.statusCode === 429 && entry.value) return entry.value;
      throw err;
    })
    .finally(() => {
      entry.promise = null;
    });
  polymarketMarketBySlugCache.set(key, entry);
  return entry.promise;
}

function selectCurrentPolymarketMarket(markets, now = Date.now()) {
  return (Array.isArray(markets) ? markets : [])
    .filter((market) => isUsablePolymarketMarket(market, now))
    .sort((a, b) => polymarketMarketCloseTimestamp(a) - polymarketMarketCloseTimestamp(b))[0] || null;
}

function latestPolymarketMarket(markets) {
  return (Array.isArray(markets) ? markets : [])
    .filter((market) => Number.isFinite(polymarketMarketCloseTimestamp(market)))
    .sort((a, b) => polymarketMarketCloseTimestamp(b) - polymarketMarketCloseTimestamp(a))[0] || null;
}

function bestBookPrice(rows, mode) {
  const prices = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row?.price))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!prices.length) return null;
  return mode === "bid" ? Math.max(...prices) : Math.min(...prices);
}

async function fetchPolymarketBook(tokenId) {
  const key = String(tokenId || "").trim();
  if (!key) return null;
  const now = Date.now();
  const cached = polymarketBookByTokenCache.get(key);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;

  const entry = cached || { value: null, expiresAt: 0, promise: null };
  const qs = new URLSearchParams({ token_id: key });
  entry.promise = polymarketClobRequest(`/book?${qs.toString()}`)
    .then((book) => {
      entry.value = book;
      entry.expiresAt = Date.now() + POLYMARKET_MARKET_CACHE_MS;
      return book;
    })
    .catch((err) => {
      if ((err.statusCode === 404 || err.statusCode === 429) && entry.value) return entry.value;
      if (err.statusCode === 404) return null;
      throw err;
    })
    .finally(() => {
      entry.promise = null;
    });
  polymarketBookByTokenCache.set(key, entry);
  return entry.promise;
}

function polymarketTokenMap(market) {
  const outcomes = parseJsonArrayField(market?.outcomes);
  const tokenIds = parseJsonArrayField(market?.clobTokenIds);
  const bySide = {};
  outcomes.forEach((outcome, index) => {
    const normalized = String(outcome || "").trim().toUpperCase();
    if (normalized === "UP" || normalized === "YES") bySide.UP = String(tokenIds[index] || "");
    if (normalized === "DOWN" || normalized === "NO") bySide.DOWN = String(tokenIds[index] || "");
  });
  return {
    outcomes,
    tokenIds,
    upTokenId: bySide.UP || String(tokenIds[0] || ""),
    downTokenId: bySide.DOWN || String(tokenIds[1] || ""),
  };
}

async function polymarketMarketSnapshot(market) {
  if (!market) return null;
  const closeTs = polymarketMarketCloseTimestamp(market);
  const startTs = polymarketMarketStartTimestamp(market);
  const tokens = polymarketTokenMap(market);
  const [upBook, downBook] = await Promise.all([
    tokens.upTokenId ? fetchPolymarketBook(tokens.upTokenId) : null,
    tokens.downTokenId ? fetchPolymarketBook(tokens.downTokenId) : null,
  ]);
  const upAsk = bestBookPrice(upBook?.asks, "ask");
  const downAsk = bestBookPrice(downBook?.asks, "ask");
  const upBid = bestBookPrice(upBook?.bids, "bid");
  const downBid = bestBookPrice(downBook?.bids, "bid");
  return {
    source: "Polymarket Gamma + CLOB APIs",
    venue: "polymarket",
    slug: market.slug || null,
    conditionId: market.conditionId || null,
    title: market.question || null,
    startTime: Number.isFinite(startTs) && startTs > 0 ? new Date(startTs).toISOString() : null,
    closeTime: Number.isFinite(closeTs) ? new Date(closeTs).toISOString() : null,
    secondsLeft: Number.isFinite(closeTs) ? Math.max(0, Math.round((closeTs - Date.now()) / 1000)) : null,
    upTokenId: tokens.upTokenId || null,
    downTokenId: tokens.downTokenId || null,
    upAsk,
    downAsk,
    upBid,
    downBid,
    upMinOrderSize: dollars(upBook?.min_order_size, null),
    downMinOrderSize: dollars(downBook?.min_order_size, null),
    tickSize: dollars(upBook?.tick_size ?? downBook?.tick_size, null) ?? dollars(market.orderPriceMinTickSize, null),
    negRisk: market.negRisk === true,
    acceptingOrders: market.acceptingOrders !== false,
  };
}

function sideAskFromPolymarket(snapshot, side) {
  const normalized = String(side || "").toUpperCase();
  if (normalized === "UP" || normalized === "YES") return snapshot?.upAsk ?? null;
  if (normalized === "DOWN" || normalized === "NO") return snapshot?.downAsk ?? null;
  return null;
}

function sideTokenFromPolymarket(snapshot, side) {
  const normalized = String(side || "").toUpperCase();
  if (normalized === "UP" || normalized === "YES") return snapshot?.upTokenId || null;
  if (normalized === "DOWN" || normalized === "NO") return snapshot?.downTokenId || null;
  return null;
}

function enrichPolymarketSignal(signal, marketSnapshot) {
  if (!signal || typeof signal !== "object") return;
  const sideAsk = sideAskFromPolymarket(marketSnapshot, signal.side);
  signal.live_market_price = sideAsk;
  signal.live_market_side = signal.side === "UP" ? "UP" : signal.side === "DOWN" ? "DOWN" : null;
}

function noCurrentPolymarketMessage(details = {}) {
  const latest = details.latestMarket;
  if (latest) {
    return `No open ${POLYMARKET_BTC5M_SLUG_PREFIX} market found. Latest checked: ${latest.slug || "unknown"} closes ${latest.endDate || "unknown"}.`;
  }
  return `No open ${POLYMARKET_BTC5M_SLUG_PREFIX} market found.`;
}

async function fetchCurrentPolymarketBtc5mMarketDetails({ force = false } = {}) {
  const now = Date.now();
  if (!force && polymarketBtc5mMarketCache.value && polymarketBtc5mMarketCache.expiresAt > now) {
    return { ...polymarketBtc5mMarketCache.value, cached: true };
  }
  if (!force && polymarketBtc5mMarketCache.promise) return polymarketBtc5mMarketCache.promise;

  polymarketBtc5mMarketCache.promise = (async () => {
    const bucket = Math.floor(now / 1000 / 300) * 300;
    const slugs = [];
    for (let offset = -1; offset <= 4; offset += 1) {
      slugs.push(polymarketSlugForBucket(bucket + offset * 300));
    }
    const markets = (
      await Promise.all(slugs.map((slug) => fetchPolymarketMarketBySlug(slug, { useCache: false }).catch(() => null)))
    ).filter(Boolean);
    const market = selectCurrentPolymarketMarket(markets, now);
    const snapshot = market ? await polymarketMarketSnapshot(market) : null;
    return {
      market,
      snapshot,
      source: "slug-bucket",
      returnedMarkets: markets.length,
      latestMarket: latestPolymarketMarket(markets),
    };
  })()
    .then((details) => {
      polymarketBtc5mMarketCache.value = details;
      polymarketBtc5mMarketCache.expiresAt = Date.now() + POLYMARKET_MARKET_CACHE_MS;
      return details;
    })
    .catch((err) => {
      if (err.statusCode === 429 && polymarketBtc5mMarketCache.value) {
        polymarketBtc5mMarketCache.expiresAt = Date.now() + POLYMARKET_MARKET_CACHE_MS;
        return { ...polymarketBtc5mMarketCache.value, cached: true, rateLimited: true };
      }
      throw err;
    })
    .finally(() => {
      polymarketBtc5mMarketCache.promise = null;
    });
  return polymarketBtc5mMarketCache.promise;
}

async function attachPolymarketMarketData(report, input = {}) {
  if (!report || typeof report !== "object" || !String(report.mode || "").startsWith("live_signal")) {
    return report;
  }
  const details = input.marketDetails || (await fetchCurrentPolymarketBtc5mMarketDetails());
  const snapshot = details.snapshot || null;
  if (!snapshot) {
    report.live_market_note = noCurrentPolymarketMessage(details);
    return report;
  }
  report.live_market = snapshot;
  report.polymarket_live_market = snapshot;
  report.live_market_data_owner = normalizePrimaryStrategy(input.primaryStrategy || DEFAULT_POLYMARKET_PRIMARY_STRATEGY).toUpperCase();
  if (details.cached) report.live_market_cached = true;
  if (details.rateLimited) report.live_market_rate_limited = true;
  enrichPolymarketSignal(report.signal, snapshot);
  enrichPolymarketSignal(report.summary, snapshot);
  if (report.strategies && typeof report.strategies === "object") {
    for (const strategyReport of Object.values(report.strategies)) {
      enrichPolymarketSignal(strategyReport.signal, snapshot);
      enrichPolymarketSignal(strategyReport.summary, snapshot);
      if (Array.isArray(strategyReport.trades)) {
        for (const row of strategyReport.trades) enrichPolymarketSignal(row, snapshot);
      }
    }
  }
  if (Array.isArray(report.trades)) {
    for (const row of report.trades) enrichPolymarketSignal(row, snapshot);
  }
  return report;
}

function polymarketResolvedSide(market) {
  if (!market || market.closed !== true) return "";
  const outcomes = parseJsonArrayField(market.outcomes);
  const prices = parseJsonArrayField(market.outcomePrices).map(Number);
  if (outcomes.length < 2 || prices.length < 2) return "";
  const winningIndex = prices.findIndex((value) => Number.isFinite(value) && value >= 0.99);
  if (winningIndex === -1) return "";
  const outcome = String(outcomes[winningIndex] || "").toUpperCase();
  if (outcome === "UP" || outcome === "YES") return "UP";
  if (outcome === "DOWN" || outcome === "NO") return "DOWN";
  return "";
}

function marketResolvedSide(market) {
  const result = String(market?.result || "").toLowerCase();
  if (result === "yes" || result === "no") return result;
  const settlement = dollars(market?.settlement_value_dollars, null);
  if (settlement !== null) return settlement >= 0.5 ? "yes" : "no";
  return null;
}

function paperEntryFromMarket(market) {
  const yesAsk = dollars(market.yes_ask_dollars, null);
  const noAsk = dollars(market.no_ask_dollars, null);
  const candidates = [];
  if (yesAsk !== null && yesAsk >= PAPER_TRIGGER_PRICE) candidates.push({ side: "yes", price: yesAsk });
  if (noAsk !== null && noAsk >= PAPER_TRIGGER_PRICE) candidates.push({ side: "no", price: noAsk });
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.price - a.price)[0];
}

async function settleActivePaperPosition() {
  const position = tradingState.activePosition;
  if (!position) return;
  const market = await fetchKalshiMarket(position.marketTicker);
  if (!market) return;
  const resolvedSide = marketResolvedSide(market);
  if (!resolvedSide) return;

  const won = resolvedSide === position.side;
  const payout = won ? position.contracts : 0;
  const pnl = Number((payout - position.cost).toFixed(6));
  tradingState.balances.realizedPnl = Number((Number(tradingState.balances.realizedPnl || 0) + pnl).toFixed(6));
  updatePaperEquity();

  addTrade({
    ts: new Date().toISOString(),
    kind: "paper_settlement",
    market: position.marketTicker,
    side: position.side.toUpperCase(),
    status: won ? "won" : "lost",
    pnl_usd: pnl,
    entry_price: position.price,
    exit_value: won ? 1 : 0,
  });
  tradingState.activePosition = null;
}

async function pollPaperWorker() {
  if (paperWorker.polling) return;
  paperWorker.polling = true;
  try {
    tradingState.lastPollAt = new Date().toISOString();
    tradingState.lastError = null;

    if (tradingState.killSwitch) {
      stopPaperWorker("kill switch enabled");
      return;
    }

    await settleActivePaperPosition();
    const blocked = failSafeReason();
    if (blocked) {
      tradingState.killSwitch = true;
      stopPaperWorker(`fail-safe stopped paper worker: ${blocked}`);
      return;
    }

    if (tradingState.activePosition) return;

    if (tradingState.mode === "live") {
      const configError = kalshiLiveModeConfiguredError();
      if (configError) throw new Error(configError);
      const balanceSnapshot = await syncKalshiAccountBalance({ force: true });
      const liveEquity = Number(balanceSnapshot.availableCash);
      if (!Number.isFinite(liveEquity) || liveEquity <= 0) {
        tradingState.note = `Kalshi live worker could not read account balance: ${
          balanceSnapshot.error || "no available balance"
        }`;
        return;
      }

      const primaryStrategy = normalizePrimaryStrategy(tradingState.strategy.primaryStrategy);
      const marketDetails = await fetchCurrentBtc15mMarketDetails();
      const report = await attachLiveMarketData(
        await runSimulator(
          buildSimArgs({
            dataMode: "live",
            strategyMode: primaryStrategy,
            profile: LIVE_COMPARE_PROFILE,
            intervalMinutes: 15,
            startingCash: Math.max(1, liveEquity),
            stakeUsd: tradingState.limits.maxStakeUsd,
            minBtcMoveUsd: 70,
            entrySecondsLeft: PAPER_ENTRY_SECONDS_LEFT,
            thresholdPrice: PAPER_TRIGGER_PRICE,
            maxTrades: tradingState.limits.maxTradesPerDay,
          }),
        ),
        { intervalMinutes: 15, primaryStrategy, marketDetails },
      );
      const snapshot = report.live_market || null;
      const signal = report.signal || report.summary || null;
      tradingState.liveMarket = snapshot;
      if (!snapshot) {
        tradingState.note = report.live_market_note || noCurrentBtc15mMarketMessage(marketDetails);
        return;
      }
      if (!signal || signal.action !== "SIGNAL" || !signal.side) {
        tradingState.note = `Kalshi live ${primaryStrategy.toUpperCase()} ${signal?.action || "--"} ${signal?.side || ""}. Market ${
          snapshot.ticker
        }; ${snapshot.secondsLeft}s left.`;
        return;
      }

      const marketId = snapshot.ticker;
      const alreadyTradedMarket = tradingState.recentTrades.some(
        (trade) =>
          ["paper_entry", "kalshi_live_entry"].includes(trade.kind) &&
          trade.market === marketId,
      );
      if (alreadyTradedMarket) {
        tradingState.note = `Kalshi live already has an entry for ${marketId}.`;
        return;
      }

      const price = kalshiPriceDollars(signal.live_market_price, null);
      const priceSkipReason = kalshiLivePriceSkipReason({ ticker: marketId, signalSide: signal.side, price });
      if (priceSkipReason) {
        tradingState.note = priceSkipReason;
        return;
      }
      const cost = kalshiLiveOrderBudget(signal, liveEquity);
      if (!price || price <= 0 || cost <= 0) {
        tradingState.note = "Kalshi live signal found, but no usable price or fee-adjusted equity is available.";
        return;
      }

      let liveOrder = null;
      try {
        liveOrder = await placeKalshiLiveOrder({
          ticker: marketId,
          signalSide: signal.side,
          cost,
          marketPrice: price,
        });
      } catch (err) {
        const message = err.message || String(err);
        tradingState.lastError = message;
        const liquidityError = isKalshiLiquidityError(err);
        tradingState.note = liquidityError ? `Kalshi live skipped for insufficient resting volume: ${message}` : `Kalshi live order error: ${message}`;
        addTrade({
          ts: new Date().toISOString(),
          kind: liquidityError ? "kalshi_live_order_no_liquidity" : "kalshi_live_order_error",
          market: marketId,
          strategy: primaryStrategy.toUpperCase(),
          side: signal.side,
          status: liquidityError ? "live_order_no_liquidity" : "live_order_error",
          pnl_usd: 0,
          entry_price: price,
          cost_usd: Number(cost.toFixed(6)),
          request: err.requestBody || null,
          api_error: err.body || null,
          requested_contracts: dollars(err.requestedContracts, null),
          available_contracts: dollars(err.availableContracts, null),
          estimated_fee_usd: dollars(err.estimatedFee, null),
          estimated_total_cost_usd: dollars(err.estimatedTotalCost, null),
          error: message,
        });
        return;
      }

      const filledCount = kalshiFillCount(liveOrder);
      if (!Number.isFinite(filledCount) || filledCount <= 0) {
        tradingState.note = `Kalshi live order submitted for ${marketId}, but no fill was reported.`;
        addTrade({
          ts: new Date().toISOString(),
          kind: "kalshi_live_order_no_fill",
          market: marketId,
          strategy: primaryStrategy.toUpperCase(),
          side: signal.side,
          status: "live_order_no_fill",
          pnl_usd: 0,
          entry_price: price,
          cost_usd: Number(cost.toFixed(6)),
          requested_contracts: liveOrder.requestedContracts,
          remaining_contracts: dollars(liveOrder.remaining_count ?? liveOrder.remainingCount, null),
          estimated_fee_usd: liveOrder.estimatedFee,
          estimated_total_cost_usd: liveOrder.estimatedTotalCost,
          live_order_id: liveOrder.order_id || liveOrder.orderID || null,
          client_order_id: liveOrder.client_order_id || liveOrder.request?.client_order_id || null,
        });
        return;
      }

      const fillPrice = kalshiEconomicFillPrice(liveOrder, price);
      const fillFee = kalshiFillFee(liveOrder, filledCount, fillPrice);
      const actualCost = Number((filledCount * fillPrice + fillFee).toFixed(6));
      const position = {
        marketTicker: marketId,
        eventTicker: snapshot.eventTicker || null,
        side: liveOrder.resolvedSide,
        price: fillPrice,
        cost: actualCost,
        fee: fillFee,
        contracts: filledCount,
        enteredAt: new Date().toISOString(),
        marketCloseTime: snapshot.closeTime,
        secondsLeft: snapshot.secondsLeft,
        liveOrderId: liveOrder.order_id || liveOrder.orderID || null,
        clientOrderId: liveOrder.client_order_id || liveOrder.request?.client_order_id || null,
        liveOrder,
      };
      tradingState.activePosition = position;
      addTrade({
        ts: position.enteredAt,
        kind: "kalshi_live_entry",
        market: position.marketTicker,
        strategy: primaryStrategy.toUpperCase(),
        side: String(position.side || "").toUpperCase(),
        status: "live_order_filled",
        pnl_usd: 0,
        entry_price: position.price,
        cost_usd: position.cost,
        fee_usd: position.fee,
        contracts: position.contracts,
        live_order_id: position.liveOrderId,
      });
      tradingState.note = `Kalshi live entered ${String(position.side || "").toUpperCase()} ${position.marketTicker} at ${position.price.toFixed(4)}.`;
      return;
    }

    const marketDetails = await fetchCurrentBtc15mMarketDetails();
    const market = marketDetails.market;
    if (!market) {
      tradingState.note = `${noCurrentBtc15mMarketMessage(marketDetails)} Last checked ${tradingState.lastPollAt}.`;
      return;
    }

    const closeTs = Date.parse(market.close_time);
    const secondsLeft = Math.round((closeTs - Date.now()) / 1000);
    if (secondsLeft > PAPER_ENTRY_SECONDS_LEFT || secondsLeft < PAPER_MIN_SECONDS_LEFT) {
      tradingState.note = `Watching ${market.ticker}; ${secondsLeft}s left. Waiting for entry window.`;
      return;
    }

    const entry = paperEntryFromMarket(market);
    if (!entry) {
      tradingState.note = `Watching ${market.ticker}; no side is above ${PAPER_TRIGGER_PRICE.toFixed(2)}.`;
      return;
    }

    const cost = Math.min(Number(tradingState.limits.maxStakeUsd || 0), Number(tradingState.balances.currentEquity || 0));
    if (cost <= 0) {
      tradingState.note = "Paper worker has no paper equity available.";
      return;
    }

    const contracts = Number((cost / entry.price).toFixed(6));
    const position = {
      marketTicker: market.ticker,
      eventTicker: market.event_ticker,
      side: entry.side,
      price: entry.price,
      cost: Number(cost.toFixed(6)),
      contracts,
      enteredAt: new Date().toISOString(),
      marketCloseTime: market.close_time,
      secondsLeft,
    };
    tradingState.activePosition = position;
    addTrade({
      ts: position.enteredAt,
      kind: "paper_entry",
      market: position.marketTicker,
      side: position.side.toUpperCase(),
      status: "open",
      pnl_usd: 0,
      entry_price: position.price,
      cost_usd: position.cost,
      contracts: position.contracts,
    });
    tradingState.note = `Paper entered ${position.side.toUpperCase()} ${position.marketTicker} at ${position.price.toFixed(4)}.`;
  } catch (err) {
    tradingState.lastError = err.message || String(err);
    tradingState.note = `Paper worker error: ${tradingState.lastError}`;
  } finally {
    paperWorker.polling = false;
    saveTradingState();
  }
}

async function startPaperWorker() {
  const mode = tradingState.mode === "live" ? "live" : "paper";
  if (tradingState.killSwitch) throw new Error(`Turn the kill switch off before starting ${mode} trading`);
  if (mode === "live") {
    const configError = kalshiLiveModeConfiguredError();
    if (configError) throw new Error(configError);
  }
  if (paperWorker.timer) return tradingState;

  if (mode === "live") {
    await syncKalshiAccountBalance({ force: true });
  } else {
    await syncPaperStartingCash();
  }

  tradingState.workerStatus = "active";
  tradingState.startedAt = new Date().toISOString();
  tradingState.stoppedAt = null;
  tradingState.note =
    mode === "live"
      ? `Kalshi live trading active for ${KALSHI_BTC15M_SERIES}. Primary model: ${normalizePrimaryStrategy(
          tradingState.strategy.primaryStrategy,
        ).toUpperCase()}.`
      : `Paper worker active for ${KALSHI_BTC15M_SERIES}. No real orders will be placed.`;
  paperWorker.timer = setInterval(pollPaperWorker, PAPER_POLL_MS);
  await pollPaperWorker();
  saveTradingState();
  return tradingState;
}

function stopPaperWorker(reason = "stopped") {
  if (paperWorker.timer) {
    clearInterval(paperWorker.timer);
    paperWorker.timer = null;
  }
  tradingState.workerStatus = "inactive";
  tradingState.stoppedAt = new Date().toISOString();
  tradingState.note = reason;
  saveTradingState();
  return tradingState;
}

function resetLiveCompareAccounts(startingCash) {
  const primaryStrategy = normalizePrimaryStrategy(tradingState.liveCompare?.primaryStrategy || DEFAULT_PRIMARY_STRATEGY);
  const enabledStrategies = ensurePrimaryStrategyEnabled(tradingState.liveCompare?.enabledStrategies, primaryStrategy);
  const state = createLiveCompareState();
  state.primaryStrategy = primaryStrategy;
  state.enabledStrategies = enabledStrategies;
  for (const strategy of COMPARE_STRATEGIES) {
    state.strategies[strategy].startingCash = startingCash;
    state.strategies[strategy].currentEquity = startingCash;
  }
  tradingState.liveCompare = state;
}

function updateCompareAccountEquity(account) {
  const starting = Number(account.startingCash || 0);
  const realized = Number(account.realizedPnl || 0);
  account.currentEquity = Number((starting + realized).toFixed(6));
  account.returnPct = starting > 0 ? Number(((realized / starting) * 100).toFixed(4)) : 0;
}

function addLiveCompareTrade(strategy, trade) {
  const compare = tradingState.liveCompare;
  const account = compare.strategies[strategy];
  const row = {
    ...trade,
    strategy: strategy.toUpperCase(),
    kind: trade.kind || "compare",
  };
  account.lastTrade = row;
  account.recentTrades = [row, ...account.recentTrades].slice(0, 50);
  account.entriesToday = compareEntriesToday(account);
  compare.recentTrades = [row, ...compare.recentTrades].slice(0, 100);
  saveTradingState();
}

function compareAccountFailSafeReason(strategy) {
  const account = tradingState.liveCompare.strategies[strategy];
  account.entriesToday = compareEntriesToday(account);
  const limits = tradingState.limits;
  const realized = Number(account.realizedPnl || 0);
  const returnPct = Number(account.returnPct || 0);
  if (limits.maxDailyLossUsd > 0 && realized <= -limits.maxDailyLossUsd) return `${strategy.toUpperCase()} daily loss $${limits.maxDailyLossUsd} reached`;
  if (limits.maxDailyLossPct > 0 && returnPct <= -limits.maxDailyLossPct) return `${strategy.toUpperCase()} daily loss ${limits.maxDailyLossPct}% reached`;
  if (limits.maxTotalLossUsd > 0 && realized <= -limits.maxTotalLossUsd) return `${strategy.toUpperCase()} total loss $${limits.maxTotalLossUsd} reached`;
  if (limits.maxTotalLossPct > 0 && returnPct <= -limits.maxTotalLossPct) return `${strategy.toUpperCase()} total loss ${limits.maxTotalLossPct}% reached`;
  if (account.entriesToday >= limits.maxTradesPerDay) return `${strategy.toUpperCase()} max trades per day ${limits.maxTradesPerDay} reached`;
  return "";
}

function liveCompareMarketId(report) {
  return report?.live_market?.ticker || `${report?.market_start || ""}-${report?.market_end || ""}`;
}

function sideToResolvedSide(side) {
  const normalized = String(side || "").toUpperCase();
  if (normalized === "UP" || normalized === "YES") return "yes";
  if (normalized === "DOWN" || normalized === "NO") return "no";
  return "";
}

function liveCompareCost(strategy, signal, account, limits = tradingState.limits) {
  const suggested = dollars(signal?.suggested_stake_usd, null);
  const fallback = Number(limits.maxStakeUsd || 0);
  const target = suggested !== null && suggested > 0 ? suggested : fallback;
  return Math.min(target, Number(limits.maxStakeUsd || 0), Number(account.currentEquity || 0));
}

async function settleLiveComparePositions() {
  const compare = tradingState.liveCompare;
  const openPositions = [];
  for (const strategy of COMPARE_STRATEGIES) {
    const account = compare.strategies[strategy];
    const position = account.activePosition;
    if (position?.marketTicker) openPositions.push({ strategy, account, position });
  }
  if (!openPositions.length) return;

  const marketsByTicker = new Map();
  for (const ticker of [...new Set(openPositions.map((item) => item.position.marketTicker))]) {
    let market = null;
    try {
      market = await fetchKalshiMarket(ticker);
    } catch (err) {
      compare.lastError = err.message || String(err);
      continue;
    }
    marketsByTicker.set(ticker, market);
  }

  const settlementOwner = normalizePrimaryStrategy(compare.primaryStrategy || tradingState.strategy.primaryStrategy).toUpperCase();
  for (const { strategy, account, position } of openPositions) {
    const market = marketsByTicker.get(position.marketTicker);
    const resolvedSide = marketResolvedSide(market);
    if (!resolvedSide) continue;

    const won = resolvedSide === position.resolvedSide;
    const payout = won ? position.contracts : 0;
    const pnl = Number((payout - position.cost).toFixed(6));
    account.realizedPnl = Number((Number(account.realizedPnl || 0) + pnl).toFixed(6));
    updateCompareAccountEquity(account);
    account.activePosition = null;

    addLiveCompareTrade(strategy, {
      ts: new Date().toISOString(),
      market: position.marketTicker,
      side: position.side,
      status: won ? "won" : "lost",
      pnl_usd: pnl,
      entry_price: position.price,
      exit_value: won ? 1 : 0,
      cost_usd: position.cost,
      contracts: position.contracts,
      settlement_source_strategy: settlementOwner,
    });
  }
}

async function pollLiveCompareWorker() {
  if (liveCompareWorker.polling) return;
  liveCompareWorker.polling = true;
  const compare = tradingState.liveCompare;
  const primaryStrategy = normalizePrimaryStrategy(compare.primaryStrategy || tradingState.strategy.primaryStrategy);
  const activeStrategies = enabledCompareStrategies(compare);
  try {
    compare.lastPollAt = new Date().toISOString();
    compare.lastError = null;

    await settleLiveComparePositions();
    for (const strategy of activeStrategies) {
      const blocked = compareAccountFailSafeReason(strategy);
      if (blocked) {
        stopLiveCompareWorker(`fail-safe stopped ${compareStrategyLabel(activeStrategies)} compare worker: ${blocked}`);
        return;
      }
    }

    const marketDetails = await fetchCurrentBtc15mMarketDetails();
    const report = await attachLiveMarketData(
      await runSimulator(
        buildSimArgs({
          dataMode: "live",
          strategyMode: "compare",
          profile: compare.profile,
          intervalMinutes: 15,
          startingCash: Math.max(
            1,
            Math.min(
              ...activeStrategies.map(
                (strategy) => Number(compare.strategies[strategy]?.currentEquity || 0) || LIVE_COMPARE_STARTING_CASH,
              ),
            ),
          ),
          stakeUsd: tradingState.limits.maxStakeUsd,
          minBtcMoveUsd: 70,
          entrySecondsLeft: PAPER_ENTRY_SECONDS_LEFT,
          thresholdPrice: PAPER_TRIGGER_PRICE,
          maxTrades: tradingState.limits.maxTradesPerDay,
        }),
      ),
      { intervalMinutes: 15, primaryStrategy, marketDetails },
    );
    compare.lastReport = report;
    compare.liveMarket = report.live_market || null;
    if (!report.live_market) {
      compare.note = report.live_market_note || noCurrentBtc15mMarketMessage();
      return;
    }

    const marketId = liveCompareMarketId(report);
    for (const strategy of COMPARE_STRATEGIES) {
      const account = compare.strategies[strategy];
      const signal = report.strategies?.[strategy]?.signal || null;
      account.lastSignal = activeStrategies.includes(strategy) ? signal : null;
    }

    for (const strategy of activeStrategies) {
      const account = compare.strategies[strategy];
      const strategyReport = report.strategies?.[strategy];
      const signal = strategyReport?.signal || null;
      if (!signal || signal.action !== "SIGNAL" || !signal.side || account.activePosition) continue;

      const price = kalshiPriceDollars(signal.live_market_price, null);
      const priceSkipReason = kalshiLivePriceSkipReason({ ticker: marketId, signalSide: signal.side, price });
      if (priceSkipReason) {
        compare.note = priceSkipReason;
        continue;
      }
      const cost = liveCompareCost(strategy, signal, account);
      if (!price || price <= 0 || cost <= 0) continue;

      const alreadyTradedMarket = account.recentTrades.some(
        (trade) => trade.kind === "compare_entry" && trade.market === marketId,
      );
      if (alreadyTradedMarket) continue;

      const contracts = Number((cost / price).toFixed(6));
      const position = {
        marketTicker: report.live_market?.ticker || null,
        marketId,
        side: signal.side,
        resolvedSide: sideToResolvedSide(signal.side),
        price,
        cost: Number(cost.toFixed(6)),
        contracts,
        enteredAt: new Date().toISOString(),
        marketEnd: report.market_end,
      };
      account.activePosition = position;
      account.entriesToday += 1;
      addLiveCompareTrade(strategy, {
        ts: position.enteredAt,
        kind: "compare_entry",
        market: marketId,
        side: position.side,
        status: "open",
        pnl_usd: 0,
        entry_price: position.price,
        cost_usd: position.cost,
        contracts: position.contracts,
      });
    }

    const activeSet = new Set(activeStrategies);
    const signalNotes = activeStrategies
      .map((strategy) => {
        const signal = compare.strategies[strategy]?.lastSignal;
        return `${strategy.toUpperCase()} ${signal?.action || "--"} ${signal?.side || ""}`.trim();
      })
      .join("; ");
    const disabled = COMPARE_STRATEGIES.filter((strategy) => !activeSet.has(strategy))
      .map((strategy) => strategy.toUpperCase())
      .join(", ");
    compare.note = `${compareStrategyLabel(activeStrategies)} live compare active. Primary data model: ${primaryStrategy.toUpperCase()}. ${
      signalNotes || "No selected strategy"
    }${
      disabled ? `. Disabled: ${disabled}` : ""
    }. No real orders are posted.`;
  } catch (err) {
    compare.lastError = err.message || String(err);
    compare.note = `${compareStrategyLabel(activeStrategies)} live compare worker error: ${compare.lastError}`;
  } finally {
    liveCompareWorker.polling = false;
    saveTradingState();
  }
}

async function startLiveCompareWorker() {
  if (liveCompareWorker.timer) return tradingState;
  const startingCash = Number(LIVE_COMPARE_STARTING_CASH.toFixed(6));
  resetLiveCompareAccounts(startingCash);
  tradingState.liveCompare.primaryStrategy = normalizePrimaryStrategy(tradingState.liveCompare.primaryStrategy);
  tradingState.liveCompare.enabledStrategies = enabledCompareStrategies(tradingState.liveCompare);
  tradingState.liveCompare.workerStatus = "active";
  tradingState.liveCompare.startedAt = new Date().toISOString();
  tradingState.liveCompare.stoppedAt = null;
  tradingState.liveCompare.note = `${compareStrategyLabel(
    tradingState.liveCompare.enabledStrategies,
  )} live compare active on ${KALSHI_BTC15M_SERIES}. Primary data model: ${tradingState.liveCompare.primaryStrategy.toUpperCase()}. This worker uses live data and virtual paper fills only.`;
  liveCompareWorker.timer = setInterval(pollLiveCompareWorker, LIVE_COMPARE_POLL_MS);
  await pollLiveCompareWorker();
  saveTradingState();
  return tradingState;
}

function stopLiveCompareWorker(reason = "Selected live compare stopped") {
  if (liveCompareWorker.timer) {
    clearInterval(liveCompareWorker.timer);
    liveCompareWorker.timer = null;
  }
  tradingState.liveCompare.workerStatus = "inactive";
  tradingState.liveCompare.stoppedAt = new Date().toISOString();
  tradingState.liveCompare.note = reason;
  saveTradingState();
  return tradingState;
}

function resetPolymarketAccounts(startingCash) {
  const current = tradingState.polymarket || {};
  const primaryStrategy = normalizePrimaryStrategy(current.primaryStrategy || DEFAULT_POLYMARKET_PRIMARY_STRATEGY);
  const enabledStrategies = enabledPolymarketStrategies(current);
  const mode = current.mode === "live" ? "live" : "paper";
  const liveArmed = mode === "live" && current.liveArmed === true;
  const state = createPolymarketState();
  state.primaryStrategy = primaryStrategy;
  state.enabledStrategies = enabledStrategies.includes(primaryStrategy) ? enabledStrategies : [primaryStrategy, ...enabledStrategies];
  state.mode = mode;
  state.liveArmed = liveArmed;
  state.killSwitch = current.killSwitch !== false;
  state.profile = current.profile === "aggressive" ? "aggressive" : "conservative";
  state.limits = normalizeTradingSettings(current.limits || {}, current.limits || createDefaultLimits());
  state.accountBalance = mergeAccountBalance(current.accountBalance, "Polymarket collateral balance");
  for (const strategy of COMPARE_STRATEGIES) {
    state.strategies[strategy].startingCash = startingCash;
    state.strategies[strategy].currentEquity = startingCash;
  }
  tradingState.polymarket = state;
}

function updatePolymarketAccountEquity(account) {
  updateCompareAccountEquity(account);
}

function addPolymarketTrade(strategy, trade) {
  const state = tradingState.polymarket;
  const account = state.strategies[strategy];
  const row = {
    ...trade,
    venue: "POLYMARKET",
    strategy: strategy.toUpperCase(),
    kind: trade.kind || "polymarket",
  };
  account.lastTrade = row;
  account.recentTrades = [row, ...account.recentTrades].slice(0, 50);
  account.entriesToday = polymarketEntriesToday(account);
  state.recentTrades = [row, ...state.recentTrades].slice(0, 100);
  saveTradingState();
}

function polymarketAccountFailSafeReason(strategy) {
  const account = tradingState.polymarket.strategies[strategy];
  account.entriesToday = polymarketEntriesToday(account);
  const limits = tradingState.polymarket.limits || tradingState.limits;
  const realized = Number(account.realizedPnl || 0);
  const returnPct = Number(account.returnPct || 0);
  if (limits.maxDailyLossUsd > 0 && realized <= -limits.maxDailyLossUsd) return `${strategy.toUpperCase()} daily loss $${limits.maxDailyLossUsd} reached`;
  if (limits.maxDailyLossPct > 0 && returnPct <= -limits.maxDailyLossPct) return `${strategy.toUpperCase()} daily loss ${limits.maxDailyLossPct}% reached`;
  if (limits.maxTotalLossUsd > 0 && realized <= -limits.maxTotalLossUsd) return `${strategy.toUpperCase()} total loss $${limits.maxTotalLossUsd} reached`;
  if (limits.maxTotalLossPct > 0 && returnPct <= -limits.maxTotalLossPct) return `${strategy.toUpperCase()} total loss ${limits.maxTotalLossPct}% reached`;
  if (account.entriesToday >= limits.maxTradesPerDay) return `${strategy.toUpperCase()} max trades per day ${limits.maxTradesPerDay} reached`;
  return "";
}

async function settlePolymarketPositions() {
  const state = tradingState.polymarket;
  const openPositions = [];
  for (const strategy of COMPARE_STRATEGIES) {
    const account = state.strategies[strategy];
    const position = account.activePosition;
    if (position?.marketSlug) openPositions.push({ strategy, account, position });
  }
  if (!openPositions.length) return;

  const marketsBySlug = new Map();
  for (const slug of [...new Set(openPositions.map((item) => item.position.marketSlug))]) {
    try {
      marketsBySlug.set(slug, await fetchPolymarketMarketBySlug(slug, { useCache: false }));
    } catch (err) {
      state.lastError = err.message || String(err);
    }
  }

  for (const { strategy, account, position } of openPositions) {
    const market = marketsBySlug.get(position.marketSlug);
    const resolvedSide = polymarketResolvedSide(market);
    if (!resolvedSide) continue;

    const won = resolvedSide === String(position.side || "").toUpperCase();
    const payout = won ? position.contracts : 0;
    const pnl = Number((payout - position.cost).toFixed(6));
    account.realizedPnl = Number((Number(account.realizedPnl || 0) + pnl).toFixed(6));
    updatePolymarketAccountEquity(account);
    account.activePosition = null;

    addPolymarketTrade(strategy, {
      ts: new Date().toISOString(),
      market: position.marketSlug,
      side: position.side,
      status: won ? "won" : "lost",
      pnl_usd: pnl,
      entry_price: position.price,
      exit_value: won ? 1 : 0,
      cost_usd: position.cost,
      contracts: position.contracts,
      live_order_id: position.liveOrderId || null,
    });
  }
}

function polymarketLiveCredentialsConfigured() {
  return Boolean(polymarketEnv(["POLYMARKET_PRIVATE_KEY", "PM_PRIVATE_KEY", "PRIVATE_KEY"]));
}

function polymarketEnv(names, fallback = "") {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return fallback;
}

function polymarketApiCredsConfigured() {
  return Boolean(
    polymarketEnv(["POLYMARKET_API_KEY", "PM_API"]) &&
      polymarketEnv(["POLYMARKET_API_SECRET", "PM_API_SECRET_KEY"]) &&
      polymarketEnv(["POLYMARKET_API_PASSPHRASE", "PM_API_PASSPHRASE", "PM_API_PASS_PHRASE"]),
  );
}

function polymarketSignatureType() {
  const value = Number(polymarketEnv(["POLYMARKET_SIGNATURE_TYPE", "PM_SIGNATURE_TYPE"], "3"));
  return Number.isFinite(value) ? value : 3;
}

function polymarketLiveModeConfiguredError() {
  if (!polymarketLiveCredentialsConfigured()) {
    return "POLYMARKET_PRIVATE_KEY or PM_PRIVATE_KEY is not configured in .env";
  }
  const signatureType = polymarketSignatureType();
  if (![0, 1, 2, 3].includes(signatureType)) {
    return "POLYMARKET_SIGNATURE_TYPE or PM_SIGNATURE_TYPE must be 0, 1, 2, or 3";
  }
  if (signatureType !== 0 && !polymarketEnv(["POLYMARKET_FUNDER_ADDRESS", "PM_FUNDER_ADDRESS"])) {
    return "POLYMARKET_FUNDER_ADDRESS or PM_FUNDER_ADDRESS is required for Polymarket signature types 1, 2, and 3";
  }
  return "";
}

function fetchPolymarketBalanceSnapshot() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join("scripts", "polymarket_balance.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Polymarket balance helper timed out"));
    }, 45_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Polymarket balance helper exited with code ${code}`).trim()));
        return;
      }
      try {
        const payload = JSON.parse(stdout);
        resolve({
          ...createAccountBalance("Polymarket collateral balance"),
          availableCash: dollars(payload.availableCash, null),
          rawBalance: payload.rawBalance === undefined || payload.rawBalance === null ? null : String(payload.rawBalance),
          allowance: dollars(payload.allowance, null),
          rawAllowance: payload.rawAllowance === undefined || payload.rawAllowance === null ? null : String(payload.rawAllowance),
          signerAddress: payload.signerAddress || null,
          funderAddress: payload.funderAddress || null,
          signatureType: dollars(payload.signatureType, null),
          apiCredsSource: payload.apiCredsSource || null,
          refreshed: payload.refreshed === true,
          refreshError: payload.refreshError || null,
          signatureTypeBalances: Array.isArray(payload.signatureTypeBalances)
            ? payload.signatureTypeBalances.filter(isPlainObject).slice(0, 4)
            : [],
          collateralAddress: payload.collateralAddress || null,
          onChainFunderBalance: dollars(payload.onChainFunderBalance?.value, null),
          onChainFunderRawBalance:
            payload.onChainFunderBalance?.raw === undefined || payload.onChainFunderBalance?.raw === null
              ? null
              : String(payload.onChainFunderBalance.raw),
          onChainSignerBalance: dollars(payload.onChainSignerBalance?.value, null),
          onChainSignerRawBalance:
            payload.onChainSignerBalance?.raw === undefined || payload.onChainSignerBalance?.raw === null
              ? null
              : String(payload.onChainSignerBalance.raw),
          onChainError: payload.onChainError || null,
          checkedAt: payload.checkedAt || new Date().toISOString(),
        });
      } catch (err) {
        reject(new Error(`could not parse Polymarket balance helper JSON: ${err.message}`));
      }
    });
  });
}

async function syncPolymarketAccountBalance({ force = false } = {}) {
  const state = tradingState.polymarket;
  const configError = polymarketLiveModeConfiguredError();
  if (configError) {
    const snapshot = {
      ...createAccountBalance("Polymarket collateral balance"),
      checkedAt: new Date().toISOString(),
      error: configError,
    };
    state.accountBalance = snapshot;
    return snapshot;
  }
  const now = Date.now();
  if (!force && polymarketAccountBalanceCache.value && polymarketAccountBalanceCache.expiresAt > now) {
    state.accountBalance = polymarketAccountBalanceCache.value;
    return polymarketAccountBalanceCache.value;
  }
  if (polymarketAccountBalanceCache.promise) return polymarketAccountBalanceCache.promise;
  polymarketAccountBalanceCache.promise = fetchPolymarketBalanceSnapshot()
    .then((snapshot) => {
      polymarketAccountBalanceCache.value = snapshot;
      polymarketAccountBalanceCache.expiresAt = Date.now() + ACCOUNT_BALANCE_CACHE_MS;
      state.accountBalance = snapshot;
      return snapshot;
    })
    .catch((err) => {
      const snapshot = {
        ...createAccountBalance("Polymarket collateral balance"),
        checkedAt: new Date().toISOString(),
        error: err.message || String(err),
      };
      state.accountBalance = snapshot;
      return snapshot;
    })
    .finally(() => {
      polymarketAccountBalanceCache.promise = null;
    });
  return polymarketAccountBalanceCache.promise;
}

function placePolymarketLiveOrder(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join("scripts", "polymarket_market_order.mjs")], {
      cwd: ROOT,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Polymarket order helper timed out"));
    }, 45_000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Polymarket order helper exited with code ${code}`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`could not parse Polymarket order helper JSON: ${err.message}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function maybePlacePolymarketLiveOrder({ strategy, signal, snapshot, cost, price }) {
  const state = tradingState.polymarket;
  const primary = normalizePrimaryStrategy(state.primaryStrategy);
  if (state.mode !== "live" || state.liveArmed !== true || strategy !== primary) return null;

  const configError = polymarketLiveModeConfiguredError();
  if (configError) throw new Error(configError);

  const tokenId = sideTokenFromPolymarket(snapshot, signal.side);
  if (!tokenId) throw new Error(`No Polymarket token ID found for ${signal.side}`);
  const limitPrice = Math.min(0.99, Number((price + POLYMARKET_LIVE_MAX_PRICE_SLIPPAGE).toFixed(4)));
  return placePolymarketLiveOrder({
    tokenId,
    side: "BUY",
    amount: Number(cost.toFixed(6)),
    price: limitPrice,
    tickSize: snapshot.tickSize || 0.01,
    negRisk: snapshot.negRisk === true,
    marketSlug: snapshot.slug,
    strategy: strategy.toUpperCase(),
  });
}

async function pollPolymarketWorker() {
  if (polymarketWorker.polling) return;
  polymarketWorker.polling = true;
  const state = tradingState.polymarket;
  const primaryStrategy = normalizePrimaryStrategy(state.primaryStrategy);
  const activeStrategies = enabledPolymarketStrategies(state);
  try {
    state.lastPollAt = new Date().toISOString();
    state.lastError = null;
    const limits = state.limits || tradingState.limits;
    if (state.mode === "live" && state.liveArmed === true && state.killSwitch) {
      stopPolymarketWorker("Polymarket live worker stopped: kill switch on", { disarmLive: true });
      return;
    }
    let liveBalance = null;
    let liveBalanceError = "";
    if (state.mode === "live" && state.liveArmed === true) {
      const balanceSnapshot = await syncPolymarketAccountBalance({ force: true });
      liveBalance = Number(balanceSnapshot.availableCash);
      if (!Number.isFinite(liveBalance) || liveBalance <= 0) {
        liveBalanceError = balanceSnapshot.error || "no available Polymarket balance";
      }
    }

    await settlePolymarketPositions();
    for (const strategy of activeStrategies) {
      const blocked = polymarketAccountFailSafeReason(strategy);
      if (blocked) {
        stopPolymarketWorker(`fail-safe stopped Polymarket ${compareStrategyLabel(activeStrategies)} worker: ${blocked}`);
        return;
      }
    }

    const marketDetails = await fetchCurrentPolymarketBtc5mMarketDetails();
    const report = await attachPolymarketMarketData(
      await runSimulator(
        buildSimArgs({
          dataMode: "live",
          strategyMode: "compare",
          profile: state.profile,
          intervalMinutes: 5,
          startingCash: Math.max(
            1,
            Math.min(
              ...activeStrategies.map(
                (strategy) => Number(state.strategies[strategy]?.currentEquity || 0) || POLYMARKET_STARTING_CASH,
              ),
            ),
          ),
          stakeUsd: limits.maxStakeUsd,
          minBtcMoveUsd: 70,
          entrySecondsLeft: POLYMARKET_ENTRY_SECONDS_LEFT,
          thresholdPrice: POLYMARKET_TRIGGER_PRICE,
          maxTrades: limits.maxTradesPerDay,
        }),
      ),
      { primaryStrategy, marketDetails },
    );
    state.lastReport = report;
    state.liveMarket = report.polymarket_live_market || report.live_market || null;
    const snapshot = state.liveMarket;
    if (!snapshot) {
      state.note = report.live_market_note || noCurrentPolymarketMessage(marketDetails);
      return;
    }

    const marketId = snapshot.slug;
    for (const strategy of COMPARE_STRATEGIES) {
      const account = state.strategies[strategy];
      const signal = report.strategies?.[strategy]?.signal || null;
      account.lastSignal = activeStrategies.includes(strategy) ? signal : null;
    }

    for (const strategy of activeStrategies) {
      const account = state.strategies[strategy];
      const strategyReport = report.strategies?.[strategy];
      const signal = strategyReport?.signal || null;
      if (!signal || signal.action !== "SIGNAL" || !signal.side || account.activePosition) continue;

      const price = dollars(signal.live_market_price, null) ?? dollars(signal.model_entry_price, null);
      let cost = liveCompareCost(strategy, signal, account, limits);
      if (state.mode === "live" && state.liveArmed === true && strategy === primaryStrategy) {
        if (liveBalanceError) {
          state.note = `Polymarket live signal found, but account balance is unavailable: ${liveBalanceError}`;
          continue;
        }
        cost = Math.min(Number(limits.maxStakeUsd || 0), liveBalance);
      }
      if (!price || price <= 0 || cost <= 0) continue;

      const alreadyTradedMarket = account.recentTrades.some(
        (trade) => (trade.kind === "polymarket_entry" || trade.kind === "polymarket_order_error") && trade.market === marketId,
      );
      if (alreadyTradedMarket) continue;

      let liveOrder = null;
      try {
        liveOrder = await maybePlacePolymarketLiveOrder({ strategy, signal, snapshot, cost, price });
      } catch (err) {
        const message = err.message || String(err);
        state.lastError = message;
        state.note = `Polymarket live order error: ${message}`;
        addPolymarketTrade(strategy, {
          ts: new Date().toISOString(),
          kind: "polymarket_order_error",
          market: marketId,
          side: signal.side,
          status: "live_order_error",
          pnl_usd: 0,
          entry_price: price,
          cost_usd: Number(cost.toFixed(6)),
          error: message,
        });
        continue;
      }

      const contracts = Number((cost / price).toFixed(6));
      const position = {
        marketSlug: snapshot.slug,
        side: signal.side,
        tokenId: sideTokenFromPolymarket(snapshot, signal.side),
        price,
        cost: Number(cost.toFixed(6)),
        contracts,
        enteredAt: new Date().toISOString(),
        marketEnd: snapshot.closeTime,
        liveOrderId: liveOrder?.orderId || liveOrder?.id || liveOrder?.orderID || null,
        liveOrder,
      };
      account.activePosition = position;
      account.entriesToday += 1;
      addPolymarketTrade(strategy, {
        ts: position.enteredAt,
        kind: "polymarket_entry",
        market: marketId,
        side: position.side,
        status: liveOrder ? "live_order_submitted" : "open",
        pnl_usd: 0,
        entry_price: position.price,
        cost_usd: position.cost,
        contracts: position.contracts,
        live_order_id: position.liveOrderId,
      });
    }

    const activeSet = new Set(activeStrategies);
    const signalNotes = activeStrategies
      .map((strategy) => {
        const signal = state.strategies[strategy]?.lastSignal;
        return `${strategy.toUpperCase()} ${signal?.action || "--"} ${signal?.side || ""}`.trim();
      })
      .join("; ");
    const disabled = COMPARE_STRATEGIES.filter((strategy) => !activeSet.has(strategy))
      .map((strategy) => strategy.toUpperCase())
      .join(", ");
    state.note = `Polymarket 5m ${state.mode}${state.liveArmed ? " live armed" : ""}. Primary: ${primaryStrategy.toUpperCase()}. ${
      signalNotes || "No selected strategy"
    }${disabled ? `. Disabled: ${disabled}` : ""}. Market ${snapshot.slug}; ${snapshot.secondsLeft}s left.`;
  } catch (err) {
    state.lastError = err.message || String(err);
    state.note = `Polymarket worker error: ${state.lastError}`;
  } finally {
    polymarketWorker.polling = false;
    saveTradingState();
  }
}

async function startPolymarketWorker() {
  if (polymarketWorker.timer) return tradingState;
  const startingCash = Number(POLYMARKET_STARTING_CASH.toFixed(6));
  resetPolymarketAccounts(startingCash);
  tradingState.polymarket.workerStatus = "active";
  tradingState.polymarket.startedAt = new Date().toISOString();
  tradingState.polymarket.stoppedAt = null;
  tradingState.polymarket.note = `Polymarket 5m worker active in ${tradingState.polymarket.mode} mode. Primary: ${tradingState.polymarket.primaryStrategy.toUpperCase()}.`;
  polymarketWorker.timer = setInterval(pollPolymarketWorker, POLYMARKET_POLL_MS);
  await pollPolymarketWorker();
  saveTradingState();
  return tradingState;
}

function stopPolymarketWorker(reason = "Polymarket 5m worker stopped", options = {}) {
  if (polymarketWorker.timer) {
    clearInterval(polymarketWorker.timer);
    polymarketWorker.timer = null;
  }
  if (options.disarmLive === true) {
    tradingState.polymarket.mode = "paper";
    tradingState.polymarket.liveArmed = false;
  }
  tradingState.polymarket.workerStatus = "inactive";
  tradingState.polymarket.stoppedAt = new Date().toISOString();
  tradingState.polymarket.note = reason;
  saveTradingState();
  return tradingState;
}

async function armPolymarketLive() {
  const configError = polymarketLiveModeConfiguredError();
  if (configError) throw new Error(configError);
  if (tradingState.polymarket.killSwitch) {
    throw new Error("Turn the Polymarket kill switch off before starting live trading");
  }
  tradingState.polymarket.mode = "live";
  tradingState.polymarket.liveArmed = true;
  tradingState.polymarket.note = `Polymarket live trading armed. Primary: ${normalizePrimaryStrategy(
    tradingState.polymarket.primaryStrategy,
  ).toUpperCase()}.`;
  if (!polymarketWorker.timer) await startPolymarketWorker();
  saveTradingState();
  return tradingState;
}

function setPolymarketPaperMode() {
  tradingState.polymarket.mode = "paper";
  tradingState.polymarket.liveArmed = false;
  tradingState.polymarket.note = "Polymarket returned to paper mode. No real Polymarket orders will be posted.";
  saveTradingState();
  return tradingState;
}

function resumePaperWorkerAfterRestart() {
  if (paperWorker.timer || tradingState.workerStatus !== "active") return;
  const mode = tradingState.mode === "live" ? "live" : "paper";
  if (tradingState.killSwitch) {
    stopPaperWorker(`${mode} worker was not resumed after restart because the kill switch is on`);
    return;
  }
  if (mode === "live") {
    const configError = kalshiLiveModeConfiguredError();
    if (configError) {
      stopPaperWorker(`Kalshi live worker was not resumed after restart: ${configError}`);
      return;
    }
  }

  tradingState.note =
    mode === "live"
      ? `Kalshi live worker resumed after server restart for ${KALSHI_BTC15M_SERIES}.`
      : `Paper worker resumed after server restart for ${KALSHI_BTC15M_SERIES}. No real orders will be placed.`;
  paperWorker.timer = setInterval(pollPaperWorker, PAPER_POLL_MS);
  pollPaperWorker();
  saveTradingState();
}

function resumeLiveCompareWorkerAfterRestart() {
  const compare = tradingState.liveCompare;
  if (liveCompareWorker.timer || compare.workerStatus !== "active") return;

  compare.primaryStrategy = normalizePrimaryStrategy(compare.primaryStrategy || tradingState.strategy.primaryStrategy);
  compare.enabledStrategies = enabledCompareStrategies(compare);
  for (const strategy of COMPARE_STRATEGIES) {
    const account = compare.strategies[strategy];
    if (!Number(account.startingCash || 0)) {
      account.startingCash = LIVE_COMPARE_STARTING_CASH;
      account.currentEquity = LIVE_COMPARE_STARTING_CASH;
    }
    account.entriesToday = compareEntriesToday(account);
  }

  compare.note = `${compareStrategyLabel(
    compare.enabledStrategies,
  )} live compare resumed after server restart on ${KALSHI_BTC15M_SERIES}. Primary data model: ${normalizePrimaryStrategy(
    compare.primaryStrategy,
  ).toUpperCase()}. This worker uses live data and virtual paper fills only.`;
  liveCompareWorker.timer = setInterval(pollLiveCompareWorker, LIVE_COMPARE_POLL_MS);
  pollLiveCompareWorker();
  saveTradingState();
}

function resumePolymarketWorkerAfterRestart() {
  const state = tradingState.polymarket;
  if (polymarketWorker.timer || state.workerStatus !== "active") return;

  state.primaryStrategy = normalizePrimaryStrategy(state.primaryStrategy || DEFAULT_POLYMARKET_PRIMARY_STRATEGY);
  state.enabledStrategies = enabledPolymarketStrategies(state);
  for (const strategy of COMPARE_STRATEGIES) {
    const account = state.strategies[strategy];
    if (!Number(account.startingCash || 0)) {
      account.startingCash = POLYMARKET_STARTING_CASH;
      account.currentEquity = POLYMARKET_STARTING_CASH;
    }
    resetLegacyFallbackCash(account, POLYMARKET_STARTING_CASH);
    account.entriesToday = polymarketEntriesToday(account);
  }

  if (state.mode !== "live") state.liveArmed = false;
  state.note = `Polymarket 5m worker resumed in ${state.mode} mode. Primary: ${state.primaryStrategy.toUpperCase()}.`;
  polymarketWorker.timer = setInterval(pollPolymarketWorker, POLYMARKET_POLL_MS);
  pollPolymarketWorker();
  saveTradingState();
}

function resumeWorkersAfterRestart() {
  resumePaperWorkerAfterRestart();
  resumeLiveCompareWorkerAfterRestart();
  resumePolymarketWorkerAfterRestart();
}

function persistBeforeExit() {
  saveTradingState();
}

function buildSimArgs(input) {
  const profile = input.profile === "aggressive" ? "aggressive" : "conservative";
  const strategyMode = COMPARE_STRATEGIES.includes(input.strategyMode) ? input.strategyMode : "compare";
  const dataMode = input.dataMode === "live" ? "live" : "historical";
  const intervalMinutes = Math.round(asNumber(input.intervalMinutes, 15, 5, 15)) === 5 ? 5 : 15;
  const intervalSeconds = intervalMinutes * 60;
  const args = [
    path.join("scripts", "simulate_btc_5m_virtual.py"),
    "--profile",
    profile,
    "--interval-minutes",
    String(intervalMinutes),
    "--starting-cash",
    String(asNumber(input.startingCash, 100, 1, 1_000_000)),
    "--stake-usd",
    String(asNumber(input.stakeUsd, 5, 0.01, 1_000_000)),
    "--threshold-price",
    String(asNumber(input.thresholdPrice, 0.7, 0.01, 0.99)),
    "--min-btc-move-usd",
    String(asNumber(input.minBtcMoveUsd, 70, 0, 10_000)),
    "--entry-seconds-left",
    String(Math.round(asNumber(input.entrySecondsLeft, 120, 1, intervalSeconds - 1))),
    "--max-trades",
    String(Math.round(asNumber(input.maxTrades, profile === "aggressive" ? 20 : 12, 1, 10_000))),
    "--preview-trades",
    "50",
  ];

  if (strategyMode === "compare") {
    args.push("--compare");
  } else {
    args.push("--strategy", strategyMode);
  }

  if (dataMode === "live") {
    args.push("--live", "--live-min-seconds-left", "15");
  } else {
    const start = normalizeDateTime(input.start);
    const end = normalizeDateTime(input.end);
    if (start && end) {
      args.push("--start", start, "--end", end);
    } else {
      args.push("--days", String(asNumber(input.days, 7, 0.01, 365)));
    }
  }
  return args;
}

function cleanSimulatorError(text) {
  const raw = String(text || "").trim();
  if (!raw) return "simulation failed";
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const explicit = [...lines].reverse().find((line) => line.startsWith("ERROR:"));
  if (explicit) return explicit.replace(/^ERROR:\s*/, "");
  const urlError = [...lines].reverse().find((line) => /urlopen error|getaddrinfo|timed out|Could not fetch Coinbase/i.test(line));
  if (urlError) {
    return "Could not fetch Coinbase BTC-USD candles. Check your internet/DNS connection and retry.";
  }
  return lines[lines.length - 1] || "simulation failed";
}

function runSimulator(args) {
  return new Promise((resolve, reject) => {
    const tryCommands = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
    let commandIndex = 0;

    function launch() {
      const child = spawn(tryCommands[commandIndex], args, {
        cwd: ROOT,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("simulation timed out"));
      }, 120_000);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        if (err.code === "ENOENT" && commandIndex < tryCommands.length - 1) {
          commandIndex += 1;
          launch();
          return;
        }
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(cleanSimulatorError(stderr || stdout || `simulator exited with code ${code}`)));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (err) {
          reject(new Error(`could not parse simulator JSON: ${err.message}`));
        }
      });
    }

    launch();
  });
}

function publicPath(reqUrl) {
  const parsed = new URL(reqUrl, "http://localhost");
  const pathname = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const resolved = path.resolve(PUBLIC_DIR, "." + pathname);
  if (!resolved.startsWith(PUBLIC_DIR)) return null;
  return resolved;
}

async function handle(req, res) {
  if (req.method === "OPTIONS") {
    send(req, res, 204, "");
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/api/trading/status") {
    if (tradingState.mode === "paper" && tradingState.workerStatus !== "active") {
      await syncPaperStartingCash();
    }
    await syncKalshiAccountBalance();
    await syncPolymarketAccountBalance();
    sendJson(req, res, 200, tradingState);
    return;
  }

  if (req.method === "GET" && req.url === "/api/polymarket/status") {
    await syncPolymarketAccountBalance();
    sendJson(req, res, 200, {
      configured: polymarketLiveCredentialsConfigured(),
      apiCredsConfigured: polymarketApiCredsConfigured(),
      configError: polymarketLiveModeConfiguredError(),
      gammaBaseUrl: POLYMARKET_GAMMA_BASE_URL,
      clobBaseUrl: POLYMARKET_CLOB_BASE_URL,
      slugPrefix: POLYMARKET_BTC5M_SLUG_PREFIX,
      state: tradingState.polymarket,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/api/kalshi/status") {
    const configured = Boolean(process.env.KALSHI_API_KEY_ID && kalshiPrivateKeyPem());
    if (!configured) {
      sendJson(req, res, 200, {
        configured: false,
        env: kalshiEnv(),
        baseUrl: kalshiBaseUrl(),
      });
      return;
    }
    try {
      const balance = await kalshiRequest("GET", "/portfolio/balance");
      sendJson(req, res, 200, {
        configured: true,
        env: kalshiEnv(),
        baseUrl: kalshiBaseUrl(),
        balance,
      });
    } catch (err) {
      sendJson(req, res, 500, {
        configured: true,
        env: kalshiEnv(),
        baseUrl: kalshiBaseUrl(),
        error: err.message || String(err),
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/settings") {
    try {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      tradingState.mode = input.mode === "live" ? "live" : "paper";
      tradingState.killSwitch = input.killSwitch !== false;
      tradingState.limits = normalizeTradingSettings(input);
      tradingState.strategy.primaryStrategy = normalizePrimaryStrategy(input.primaryStrategy);
      tradingState.updatedAt = new Date().toISOString();
      if (tradingState.workerStatus !== "active") {
        tradingState.note =
          tradingState.mode === "live"
            ? "Kalshi live worker is inactive. Select a model, keep fail-safes set, and turn off the kill switch only when ready."
            : "Kalshi paper worker is inactive.";
      }
      if (paperWorker.timer && tradingState.killSwitch) {
        stopPaperWorker("Kalshi worker stopped by settings change");
      }
      saveTradingState();
      sendJson(req, res, 200, tradingState);
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || String(err) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/live-compare/settings") {
    try {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const compare = tradingState.liveCompare;
      compare.primaryStrategy = normalizePrimaryStrategy(input.primaryStrategy || compare.primaryStrategy);
      compare.enabledStrategies = ensurePrimaryStrategyEnabled(input.compareStrategies, compare.primaryStrategy);
      for (const strategy of COMPARE_STRATEGIES) {
        if (!compare.enabledStrategies.includes(strategy)) {
          compare.strategies[strategy].lastSignal = null;
        }
      }
      saveTradingState();
      sendJson(req, res, 200, tradingState);
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || String(err) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/polymarket/settings") {
    try {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const state = tradingState.polymarket;
      if (input.mode !== "live" || state.liveArmed !== true) {
        state.mode = "paper";
        state.liveArmed = false;
      }
      state.primaryStrategy = normalizePrimaryStrategy(input.primaryStrategy || state.primaryStrategy);
      const explicitStrategies = Array.isArray(input.compareStrategies);
      const selected = explicitStrategies
        ? parseCompareStrategyList(input.compareStrategies, [], true)
        : normalizePolymarketStrategies(input.compareStrategies || state.enabledStrategies);
      state.enabledStrategies = selected.includes(state.primaryStrategy) ? selected : [state.primaryStrategy, ...selected];
      state.profile = input.profile === "aggressive" ? "aggressive" : "conservative";
      const hasSafetySettings = [
        "killSwitch",
        "maxDailyLossUsd",
        "maxDailyLossPct",
        "maxTotalLossUsd",
        "maxTotalLossPct",
        "maxStakeUsd",
        "maxTradesPerDay",
      ].some((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (hasSafetySettings) {
        if (Object.prototype.hasOwnProperty.call(input, "killSwitch")) state.killSwitch = input.killSwitch !== false;
        state.limits = normalizeTradingSettings(input, state.limits || createDefaultLimits());
      }
      for (const strategy of COMPARE_STRATEGIES) {
        if (!state.enabledStrategies.includes(strategy)) {
          state.strategies[strategy].lastSignal = null;
        }
      }
      if (polymarketWorker.timer && state.liveArmed && state.killSwitch) {
        stopPolymarketWorker("Polymarket live worker stopped by settings change", { disarmLive: true });
      }
      saveTradingState();
      sendJson(req, res, 200, tradingState);
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || String(err) });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/start") {
    try {
      const state = await startPaperWorker();
      sendJson(req, res, 200, state);
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || String(err), state: tradingState });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/stop") {
    sendJson(req, res, 200, stopPaperWorker("Kalshi worker stopped by user"));
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/live-compare/start") {
    try {
      const state = await startLiveCompareWorker();
      sendJson(req, res, 200, state);
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || String(err), state: tradingState });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/trading/live-compare/stop") {
    sendJson(req, res, 200, stopLiveCompareWorker("Selected live compare stopped by user"));
    return;
  }

  if (req.method === "POST" && req.url === "/api/polymarket/start") {
    try {
      const state = await startPolymarketWorker();
      sendJson(req, res, 200, state);
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || String(err), state: tradingState });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/polymarket/stop") {
    const wasLive = tradingState.polymarket.mode === "live" || tradingState.polymarket.liveArmed === true;
    sendJson(
      req,
      res,
      200,
      stopPolymarketWorker(
        wasLive ? "Polymarket live trading stopped by user. Polymarket returned to paper mode." : "Polymarket compare stopped by user.",
        { disarmLive: wasLive },
      ),
    );
    return;
  }

  if (req.method === "POST" && req.url === "/api/polymarket/arm-live") {
    try {
      const state = await armPolymarketLive();
      sendJson(req, res, 200, state);
    } catch (err) {
      sendJson(req, res, 400, { error: err.message || String(err), state: tradingState });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/polymarket/paper-mode") {
    sendJson(req, res, 200, setPolymarketPaperMode());
    return;
  }

  if (req.method === "POST" && req.url === "/api/simulate") {
    try {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const report = await runSimulator(buildSimArgs(input));
      sendJson(req, res, 200, await attachLiveMarketData(report, input));
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || String(err) });
    }
    return;
  }

  if (req.method !== "GET") {
    sendJson(req, res, 405, { error: "method not allowed" });
    return;
  }

  const filePath = publicPath(req.url);
  if (!filePath) {
    sendJson(req, res, 403, { error: "forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(req, res, 404, { error: "not found" });
      return;
    }
    send(req, res, 200, data, MIME[path.extname(filePath)] || "application/octet-stream", { "cache-control": "no-store" });
  });
}

function listen(port) {
  const server = http.createServer(handle);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !process.env.PORT && port < START_PORT + 20) {
      listen(port + 1);
      return;
    }
    throw err;
  });
  server.listen(port, HOST, () => {
    console.log(`Kalshi BTC Up/Down simulator UI running at http://${HOST}:${port}`);
  });
}

loadTradingState();

let exiting = false;
function handleShutdown(signal) {
  if (exiting) return;
  exiting = true;
  persistBeforeExit();
  process.exit(signal === "SIGINT" ? 130 : 0);
}

process.once("SIGINT", () => handleShutdown("SIGINT"));
process.once("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("exit", persistBeforeExit);

listen(START_PORT);
setImmediate(resumeWorkersAfterRestart);
