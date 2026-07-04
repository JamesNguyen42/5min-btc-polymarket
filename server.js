const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

loadLocalEnv(path.join(ROOT, ".env"));

const START_PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const KALSHI_API_PREFIX = "/trade-api/v2";
const KALSHI_BTC15M_SERIES = process.env.KALSHI_BTC15M_SERIES || "KXBTC15M";
const PAPER_POLL_MS = Math.max(3000, Number(process.env.PAPER_POLL_MS || 10000));
const PAPER_ENTRY_SECONDS_LEFT = Math.max(10, Number(process.env.PAPER_ENTRY_SECONDS_LEFT || 120));
const PAPER_MIN_SECONDS_LEFT = Math.max(5, Number(process.env.PAPER_MIN_SECONDS_LEFT || 30));
const PAPER_TRIGGER_PRICE = Math.min(0.99, Math.max(0.01, Number(process.env.PAPER_TRIGGER_PRICE || 0.7)));
const FRONTEND_ORIGINS = String(process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const tradingState = {
  mode: "paper",
  workerStatus: "inactive",
  killSwitch: true,
  updatedAt: new Date().toISOString(),
  balances: {
    startingCash: 0,
    currentEquity: 0,
    realizedPnl: 0,
    returnPct: 0,
  },
  strategy: {
    seriesTicker: KALSHI_BTC15M_SERIES,
    triggerPrice: PAPER_TRIGGER_PRICE,
    entrySecondsLeft: PAPER_ENTRY_SECONDS_LEFT,
    minSecondsLeft: PAPER_MIN_SECONDS_LEFT,
    pollSeconds: PAPER_POLL_MS / 1000,
  },
  limits: {
    maxDailyLossUsd: 25,
    maxDailyLossPct: 10,
    maxTotalLossUsd: 50,
    maxTotalLossPct: 20,
    maxStakeUsd: 5,
    maxTradesPerDay: 12,
  },
  lastTrade: null,
  recentTrades: [],
  activePosition: null,
  startedAt: null,
  stoppedAt: null,
  lastPollAt: null,
  lastError: null,
  note: "Kalshi live trading worker is not connected yet. These fail-safe settings are saved for the backend and ready for the worker integration.",
};
const paperWorker = {
  timer: null,
  polling: false,
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

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

function send(req, res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, ...corsHeaders(req) });
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

function normalizeTradingSettings(input) {
  const current = tradingState.limits;
  return {
    maxDailyLossUsd: asNumber(input.maxDailyLossUsd, current.maxDailyLossUsd, 0, 1_000_000),
    maxDailyLossPct: asNumber(input.maxDailyLossPct, current.maxDailyLossPct, 0, 100),
    maxTotalLossUsd: asNumber(input.maxTotalLossUsd, current.maxTotalLossUsd, 0, 1_000_000),
    maxTotalLossPct: asNumber(input.maxTotalLossPct, current.maxTotalLossPct, 0, 100),
    maxStakeUsd: asNumber(input.maxStakeUsd, current.maxStakeUsd, 0.01, 1_000_000),
    maxTradesPerDay: Math.round(asNumber(input.maxTradesPerDay, current.maxTradesPerDay, 1, 10_000)),
  };
}

function kalshiBaseUrl() {
  if (process.env.KALSHI_API_BASE_URL) return process.env.KALSHI_API_BASE_URL.replace(/\/$/, "");
  return process.env.KALSHI_ENV === "prod"
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

function kalshiRequest(method, apiPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${kalshiBaseUrl()}${apiPath}`);
    const req = https.request(
      url,
      {
        method,
        headers: kalshiAuthHeaders(method, apiPath),
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
            reject(new Error(`Kalshi ${res.statusCode}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", reject);
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
          reject(new Error(`Kalshi public ${res.statusCode}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`));
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function dollars(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  return tradingState.recentTrades.filter((trade) => trade.kind === "paper_entry" && String(trade.ts || "").startsWith(today)).length;
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
}

async function currentKalshiBalanceDollars() {
  try {
    const data = await kalshiRequest("GET", "/portfolio/balance");
    return dollars(data?.balance?.balance_dollars, null) ?? dollars(data?.balance_dollars, null) ?? dollars(data?.balance, null) / 100;
  } catch {
    return null;
  }
}

async function fetchCurrentBtc15mMarket() {
  const qs = new URLSearchParams({
    series_ticker: KALSHI_BTC15M_SERIES,
    status: "open",
    limit: "10",
  });
  const data = await kalshiPublicRequest(`/markets?${qs.toString()}`);
  const now = Date.now();
  const markets = Array.isArray(data?.markets) ? data.markets : [];
  return markets
    .filter((market) => {
      const openTs = Date.parse(market.open_time || market.created_time || "");
      const closeTs = Date.parse(market.close_time || market.expected_expiration_time || "");
      return Number.isFinite(openTs) && Number.isFinite(closeTs) && openTs <= now && closeTs > now;
    })
    .sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))[0] || null;
}

async function fetchKalshiMarket(ticker) {
  const qs = new URLSearchParams({ tickers: ticker, limit: "1" });
  const data = await kalshiPublicRequest(`/markets?${qs.toString()}`);
  return Array.isArray(data?.markets) ? data.markets[0] || null : null;
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

    const market = await fetchCurrentBtc15mMarket();
    if (!market) {
      tradingState.note = `No open ${KALSHI_BTC15M_SERIES} market found. Last checked ${tradingState.lastPollAt}.`;
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
  }
}

async function startPaperWorker() {
  if (tradingState.mode !== "paper") throw new Error("Only paper mode can be started from this dashboard");
  if (tradingState.killSwitch) throw new Error("Turn the kill switch off before starting paper trading");
  if (paperWorker.timer) return tradingState;

  const balance = await currentKalshiBalanceDollars();
  if (!tradingState.balances.startingCash) {
    tradingState.balances.startingCash = Number((balance ?? 100).toFixed(6));
    tradingState.balances.realizedPnl = 0;
    updatePaperEquity();
  }

  tradingState.workerStatus = "active";
  tradingState.startedAt = new Date().toISOString();
  tradingState.stoppedAt = null;
  tradingState.note = `Paper worker active for ${KALSHI_BTC15M_SERIES}. No real orders will be placed.`;
  paperWorker.timer = setInterval(pollPaperWorker, PAPER_POLL_MS);
  await pollPaperWorker();
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
  return tradingState;
}

function buildSimArgs(input) {
  const profile = input.profile === "aggressive" ? "aggressive" : "conservative";
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

  const start = normalizeDateTime(input.start);
  const end = normalizeDateTime(input.end);
  if (start && end) {
    args.push("--start", start, "--end", end);
  } else {
    args.push("--days", String(asNumber(input.days, 7, 0.01, 30)));
  }
  return args;
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
          reject(new Error(stderr || `simulator exited with code ${code}`));
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
    sendJson(req, res, 200, tradingState);
    return;
  }

  if (req.method === "GET" && req.url === "/api/kalshi/status") {
    const configured = Boolean(process.env.KALSHI_API_KEY_ID && kalshiPrivateKeyPem());
    if (!configured) {
      sendJson(req, res, 200, {
        configured: false,
        env: process.env.KALSHI_ENV || "demo",
        baseUrl: kalshiBaseUrl(),
      });
      return;
    }
    try {
      const balance = await kalshiRequest("GET", "/portfolio/balance");
      sendJson(req, res, 200, {
        configured: true,
        env: process.env.KALSHI_ENV || "demo",
        baseUrl: kalshiBaseUrl(),
        balance,
      });
    } catch (err) {
      sendJson(req, res, 500, {
        configured: true,
        env: process.env.KALSHI_ENV || "demo",
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
      tradingState.updatedAt = new Date().toISOString();
      if (paperWorker.timer && (tradingState.killSwitch || tradingState.mode !== "paper")) {
        stopPaperWorker("paper worker stopped by settings change");
      }
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
    sendJson(req, res, 200, stopPaperWorker("paper worker stopped by user"));
    return;
  }

  if (req.method === "POST" && req.url === "/api/simulate") {
    try {
      const raw = await readBody(req);
      const input = raw ? JSON.parse(raw) : {};
      const report = await runSimulator(buildSimArgs(input));
      sendJson(req, res, 200, report);
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
    send(req, res, 200, data, MIME[path.extname(filePath)] || "application/octet-stream");
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

listen(START_PORT);
