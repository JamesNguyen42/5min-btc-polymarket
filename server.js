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
  note: "Kalshi live trading worker is not connected yet. These fail-safe settings are saved for the backend and ready for the worker integration.",
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
      sendJson(req, res, 200, tradingState);
    } catch (err) {
      sendJson(req, res, 500, { error: err.message || String(err) });
    }
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
