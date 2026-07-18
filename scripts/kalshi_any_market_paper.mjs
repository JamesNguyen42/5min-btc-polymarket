#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  DEFAULT_PAPER_CONFIG,
  candidateFromMarket,
  evaluatePaperOpportunity,
  openPaperPosition,
  selectCandidates,
  settlePaperPosition,
} = require("../lib/kalshi-paper-core");
const { createMarketResearchEngine } = require("../lib/kalshi-market-research");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const API_BASE = "https://external-api.kalshi.com/trade-api/v2";
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "runtime", "kalshi-any-market-paper");
const ALLOWED_ENV_KEYS = new Set([
  "LLAMA_API_KEY",
  "NVIDIA_NIM_BASE_URL",
  "NVIDIA_LLAMA_MODEL",
  "KALSHI_RESEARCH_MODEL",
  "KALSHI_RESEARCH_CACHE_MINUTES",
  "KALSHI_RESEARCH_MAX_REQUESTS_PER_HOUR",
]);

function parseArgs(argv) {
  const args = {
    durationHours: 12,
    startingCash: 8,
    pollSeconds: 60,
    maxPages: 50,
    researchPerCycle: 4,
    outputDir: DEFAULT_OUTPUT_DIR,
    once: false,
    status: false,
    stop: false,
    noAi: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--once") args.once = true;
    else if (name === "--status") args.status = true;
    else if (name === "--stop") args.stop = true;
    else if (name === "--no-ai") args.noAi = true;
    else if (name === "--duration-hours") {
      args.durationHours = Number(value);
      index += 1;
    } else if (name === "--starting-cash") {
      args.startingCash = Number(value);
      index += 1;
    } else if (name === "--poll-seconds") {
      args.pollSeconds = Number(value);
      index += 1;
    } else if (name === "--max-pages") {
      args.maxPages = Number(value);
      index += 1;
    } else if (name === "--research-per-cycle") {
      args.researchPerCycle = Number(value);
      index += 1;
    } else if (name === "--output-dir") {
      args.outputDir = path.resolve(ROOT, value);
      index += 1;
    } else if (name === "--help" || name === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${name}`);
    }
  }
  if (!Number.isFinite(args.durationHours) || args.durationHours <= 0 || args.durationHours > 24) {
    throw new Error("--duration-hours must be greater than 0 and no more than 24");
  }
  if (!Number.isFinite(args.startingCash) || args.startingCash < 1 || args.startingCash > 1_000_000) {
    throw new Error("--starting-cash must be between 1 and 1000000");
  }
  if (!Number.isFinite(args.pollSeconds) || args.pollSeconds < 15 || args.pollSeconds > 900) {
    throw new Error("--poll-seconds must be between 15 and 900");
  }
  args.maxPages = Math.min(50, Math.max(1, Math.floor(args.maxPages)));
  args.researchPerCycle = Math.min(10, Math.max(1, Math.floor(args.researchPerCycle)));
  return args;
}

function printHelp() {
  console.log(`Kalshi all-market paper runner (cannot place real orders)

Usage:
  node scripts/kalshi_any_market_paper.mjs --once
  node scripts/kalshi_any_market_paper.mjs --duration-hours 12 --starting-cash 8
  node scripts/kalshi_any_market_paper.mjs --status
  node scripts/kalshi_any_market_paper.mjs --stop

Options:
  --poll-seconds N          Public-market refresh interval (default 60)
  --max-pages N             Maximum 1000-market catalog pages per scan (default 50)
  --research-per-cycle N    Maximum candidates researched each scan (default 4)
  --no-ai                   Fail closed without calling the configured research model
  --output-dir PATH         Runtime state/log directory

This runner uses production public market data and local virtual fills only. It scrubs
Kalshi credential variables and contains no order-submission endpoint.`);
}

function sanitizeEnvironment() {
  const researchEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) researchEnv[key] = process.env[key];
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("KALSHI_") && !ALLOWED_ENV_KEYS.has(key)) delete process.env[key];
  }
  return researchEnv;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function publicSummary(state) {
  if (!state) return { status: "not_started", paperOnly: true };
  return {
    paperOnly: true,
    sessionId: state.session.id,
    status: state.session.status,
    startedAt: state.session.startedAt,
    endsAt: state.session.endsAt,
    stoppedAt: state.session.stoppedAt,
    startingCash: state.startingCash,
    cash: state.cash,
    reservedCost: state.reservedCost,
    realizedPnl: state.realizedPnl,
    feesPaid: state.feesPaid,
    openPositions: state.positions.length,
    closedTrades: state.closedTrades.length,
    lastScan: state.lastScan,
    lastError: state.lastError,
  };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fs.closeSync(fd);
    return;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {}
  if (processIsAlive(Number(existing?.pid))) {
    throw new Error(`Another paper runner is active with PID ${existing.pid}`);
  }
  fs.unlinkSync(lockPath);
  const fd = fs.openSync(lockPath, "wx");
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), replacedStaleLock: true })}\n`);
  fs.closeSync(fd);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "Kalshi-All-Market-Paper/1.0" },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) throw new Error(`Kalshi returned HTTP ${response.status}`);
      throw new Error(`Kalshi temporary HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(Math.min(10_000, 750 * (2 ** attempt)));
    }
  }
  throw lastError || new Error("Kalshi request failed");
}

async function fetchMarketCatalog({ maxPages, maxHoursToClose }) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const maxCloseSeconds = nowSeconds + Math.floor(maxHoursToClose * 3_600);
  let cursor = "";
  const markets = [];
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${API_BASE}/markets`);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("mve_filter", "exclude");
    url.searchParams.set("min_close_ts", String(nowSeconds));
    url.searchParams.set("max_close_ts", String(maxCloseSeconds));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchJson(url.toString());
    markets.push(...(Array.isArray(response.markets) ? response.markets : []));
    cursor = String(response.cursor || "");
    if (!cursor) break;
  }
  return { markets, truncated: Boolean(cursor) };
}

async function fetchMarket(ticker) {
  const response = await fetchJson(`${API_BASE}/markets/${encodeURIComponent(ticker)}`);
  return response.market || response;
}

const eventMetadataCache = new Map();
const seriesMetadataCache = new Map();

async function fetchCandidateMetadata(candidate) {
  let event = eventMetadataCache.get(candidate.eventTicker);
  if (!event) {
    const response = await fetchJson(`${API_BASE}/events/${encodeURIComponent(candidate.eventTicker)}`);
    event = response.event || response;
    eventMetadataCache.set(candidate.eventTicker, event);
  }
  const seriesTicker = String(event.series_ticker || "").trim();
  if (!seriesTicker) throw new Error(`Kalshi event ${candidate.eventTicker} did not identify a series`);
  let series = seriesMetadataCache.get(seriesTicker);
  if (!series) {
    const response = await fetchJson(`${API_BASE}/series/${encodeURIComponent(seriesTicker)}`);
    series = response.series || response;
    seriesMetadataCache.set(seriesTicker, series);
  }
  return {
    ...candidate,
    seriesTicker,
    category: String(series.category || event.category || ""),
    settlementSources: Array.isArray(series.settlement_sources)
      ? series.settlement_sources
      : Array.isArray(event.settlement_sources)
        ? event.settlement_sources
        : [],
    additionalProhibitions: Array.isArray(series.additional_prohibitions) ? series.additional_prohibitions : [],
    feeType: String(series.fee_type || "").toLowerCase(),
    feeMultiplier: Number(series.fee_multiplier),
  };
}

function standardFeeSupported(candidate) {
  const waiverExpiration = Date.parse(candidate.feeWaiverExpirationTime || "");
  return (
    candidate.feeType === "quadratic" &&
    candidate.feeMultiplier === 1 &&
    (!Number.isFinite(waiverExpiration) || waiverExpiration <= Date.now())
  );
}

function createState(args, config) {
  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + args.durationHours * 3_600_000);
  return {
    version: 1,
    executionMode: "local_paper_only",
    accountCredentialsUsed: false,
    canSubmitOrders: false,
    strategyVersion: "all-market-news-ev-v1",
    session: {
      id: randomUUID(),
      status: "running",
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      stoppedAt: null,
      stopReason: null,
      settlementDeadline: new Date(endsAt.getTime() + 60 * 60_000).toISOString(),
    },
    config,
    startingCash: args.startingCash,
    cash: args.startingCash,
    reservedCost: 0,
    realizedPnl: 0,
    feesPaid: 0,
    positions: [],
    closedTrades: [],
    lastScan: null,
    lastError: null,
    consecutiveErrors: 0,
  };
}

function loadStateForRun(statePath, args, newConfig) {
  if (!fs.existsSync(statePath)) return { state: createState(args, newConfig), resumed: false };
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    throw new Error(`Refusing to overwrite unreadable paper state: ${error.message || String(error)}`);
  }
  if (prior?.executionMode !== "local_paper_only" || prior?.canSubmitOrders !== false || !prior?.session?.id) {
    throw new Error("Refusing to overwrite a runtime state that is not a validated paper-only session");
  }
  prior.positions = Array.isArray(prior.positions) ? prior.positions : [];
  prior.closedTrades = Array.isArray(prior.closedTrades) ? prior.closedTrades : [];
  prior.session.settlementDeadline ||= new Date(Date.parse(prior.session.endsAt) + 60 * 60_000).toISOString();
  const status = String(prior.session.status || "");
  const endPassed = Date.now() >= Date.parse(prior.session.endsAt || "");
  if (status === "running" && endPassed) {
    prior.session.status = prior.positions.length ? "settling" : "completed";
    prior.session.stopReason = "Configured paper-session deadline reached";
  }
  if (["running", "settling"].includes(prior.session.status)) {
    prior.accountCredentialsUsed = false;
    prior.session.stoppedAt = null;
    return { state: prior, resumed: true };
  }
  if (prior.positions.length) {
    prior.session.status = "settling";
    prior.session.stopReason = `Resumed to settle ${prior.positions.length} unresolved paper position(s)`;
    prior.session.stoppedAt = null;
    prior.accountCredentialsUsed = false;
    return { state: prior, resumed: true };
  }
  return { state: createState(args, newConfig), resumed: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const outputDir = path.resolve(args.outputDir);
  const statePath = path.join(outputDir, "state.json");
  const decisionsPath = path.join(outputDir, "decisions.jsonl");
  const stopPath = path.join(outputDir, "STOP");
  const lockPath = path.join(outputDir, "runner.lock");

  if (args.status) {
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
    console.log(JSON.stringify(publicSummary(state), null, 2));
    return;
  }
  if (args.stop) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(stopPath, `${new Date().toISOString()} requested by operator\n`, "utf8");
    console.log(`Stop requested through ${stopPath}`);
    return;
  }

  const researchEnv = sanitizeEnvironment();
  if (args.noAi) delete researchEnv.LLAMA_API_KEY;
  acquireLock(lockPath);
  if (fs.existsSync(stopPath)) fs.unlinkSync(stopPath);

  const newConfig = {
    ...DEFAULT_PAPER_CONFIG,
    startingCash: args.startingCash,
    maxStakeUsd: Number(Math.min(0.8, args.startingCash * 0.1).toFixed(2)),
    maxSessionLossUsd: Number(Math.min(1.6, args.startingCash * 0.2).toFixed(2)),
    maxHoursToClose: Math.max(1, Math.min(DEFAULT_PAPER_CONFIG.maxHoursToClose, args.durationHours - 0.25)),
  };
  const loaded = loadStateForRun(statePath, args, newConfig);
  const state = loaded.state;
  const config = { ...DEFAULT_PAPER_CONFIG, ...(state.config || newConfig) };
  state.config = config;
  const research = createMarketResearchEngine({ env: researchEnv });
  let interrupted = false;
  const requestStop = () => {
    interrupted = true;
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  function persist() {
    writeJsonAtomic(statePath, state);
  }

  function log(kind, payload = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      sessionId: state.session.id,
      paperOnly: true,
      kind,
      ...payload,
    };
    appendJsonLine(decisionsPath, entry);
    console.log(JSON.stringify(entry));
  }

  async function settlePositions() {
    for (const position of [...state.positions]) {
      if (Date.now() < Date.parse(position.closeTime || "")) continue;
      try {
        const market = await fetchMarket(position.ticker);
        const result = settlePaperPosition(state, position.ticker, market);
        if (result.settled) log("paper_settlement", { trade: result.trade });
      } catch (error) {
        log("settlement_retry", { ticker: position.ticker, error: String(error.message || error).slice(0, 300) });
      }
    }
  }

  async function cycle() {
    await settlePositions();
    if (state.realizedPnl <= -config.maxSessionLossUsd) {
      state.session.status = state.positions.length ? "settling" : "risk_stopped";
      state.session.stopReason = "Virtual session loss cap reached";
      return;
    }
    const entryCutoff = Date.parse(state.session.endsAt) - config.settlementBufferMinutes * 60_000;
    const remainingEntryHours = (entryCutoff - Date.now()) / 3_600_000;
    if (remainingEntryHours * 60 < config.minMinutesToClose) {
      state.lastScan = {
        at: new Date().toISOString(),
        catalogMarkets: 0,
        catalogTruncated: false,
        eligibleCandidates: 0,
        researched: 0,
        opened: 0,
        entriesClosed: true,
        researchEngine: research.status(),
      };
      return;
    }
    const scanConfig = { ...config, maxHoursToClose: Math.min(config.maxHoursToClose, remainingEntryHours) };
    const catalog = await fetchMarketCatalog({ maxPages: args.maxPages, maxHoursToClose: scanConfig.maxHoursToClose });
    const candidates = selectCandidates(catalog.markets, Date.now(), scanConfig);
    let researched = 0;
    let opened = 0;
    let unsupported = 0;
    let reviewed = 0;
    for (const discoveredCandidate of candidates) {
      if (researched >= args.researchPerCycle || opened >= 1 || reviewed >= Math.max(8, args.researchPerCycle * 3)) break;
      if (Date.now() >= entryCutoff) break;
      if (state.positions.some((position) => position.ticker === discoveredCandidate.ticker || (position.eventTicker && position.eventTicker === discoveredCandidate.eventTicker))) {
        continue;
      }
      reviewed += 1;
      let candidate;
      try {
        candidate = await fetchCandidateMetadata(discoveredCandidate);
      } catch (error) {
        log("paper_market_skipped", {
          ticker: discoveredCandidate.ticker,
          reason: `Series metadata unavailable: ${String(error.message || error).slice(0, 240)}`,
        });
        continue;
      }
      if (!standardFeeSupported(candidate)) {
        unsupported += 1;
        log("paper_market_skipped", {
          ticker: candidate.ticker,
          seriesTicker: candidate.seriesTicker,
          reason: `Unsupported fee model ${candidate.feeType || "unknown"}/${Number.isFinite(candidate.feeMultiplier) ? candidate.feeMultiplier : "unknown"}`,
        });
        continue;
      }
      researched += 1;
      const evidence = await research.evaluate(candidate);
      const opportunity = evaluatePaperOpportunity(candidate, evidence, config);
      const event = {
        ticker: candidate.ticker,
        eventTicker: candidate.eventTicker,
        title: candidate.title,
        closeTime: candidate.closeTime,
        quote: candidate.quote,
        opportunity,
        research: evidence,
      };
      if (opportunity.approved) {
        const researchAge = Date.now() - Date.parse(evidence.researchedAt || "");
        if (!Number.isFinite(researchAge) || researchAge > 10 * 60_000) {
          event.riskRejection = "Research estimate was stale before the simulated fill.";
        } else if (Date.now() >= entryCutoff) {
          event.riskRejection = "Session entry cutoff reached during research.";
        } else {
          const freshRawMarket = await fetchMarket(candidate.ticker);
          const freshBase = candidateFromMarket(freshRawMarket, Date.now(), scanConfig);
          if (!freshBase) {
            event.riskRejection = "Fresh market detail no longer passed quote, size, spread, or timing filters.";
          } else {
            const freshCandidate = {
              ...freshBase,
              seriesTicker: candidate.seriesTicker,
              category: candidate.category,
              settlementSources: candidate.settlementSources,
              additionalProhibitions: candidate.additionalProhibitions,
              feeType: candidate.feeType,
              feeMultiplier: candidate.feeMultiplier,
            };
            const freshOpportunity = evaluatePaperOpportunity(freshCandidate, evidence, config);
            event.initialQuote = event.quote;
            event.quote = freshCandidate.quote;
            event.opportunity = freshOpportunity;
            if (!freshOpportunity.approved) {
              event.riskRejection = "The fee-adjusted edge disappeared on the fresh pre-fill quote.";
            } else {
              const result = openPaperPosition(state, freshCandidate, freshOpportunity, evidence, config);
              if (result.opened) {
                opened += 1;
                event.paperPosition = result.position;
              } else {
                event.riskRejection = result.reason;
              }
            }
          }
        }
      }
      log("paper_decision", event);
    }
    state.lastScan = {
      at: new Date().toISOString(),
      catalogMarkets: catalog.markets.length,
      catalogTruncated: catalog.truncated,
      eligibleCandidates: candidates.length,
      researched,
      unsupported,
      opened,
      researchEngine: research.status(),
    };
    state.lastError = null;
    state.consecutiveErrors = 0;
  }

  try {
    persist();
    log(loaded.resumed ? "session_resumed" : "session_started", { summary: publicSummary(state) });
    while (["running", "settling"].includes(state.session.status)) {
      if (interrupted || fs.existsSync(stopPath)) {
        state.session.status = "stopped";
        state.session.stopReason = interrupted ? "Process signal received" : "STOP file detected";
        break;
      }
      if (state.session.status === "running" && Date.now() >= Date.parse(state.session.endsAt)) {
        state.session.status = state.positions.length ? "settling" : "completed";
        state.session.stopReason = "Configured paper-session deadline reached";
        persist();
        if (state.session.status === "completed") break;
      }
      if (state.session.status === "settling") {
        await settlePositions();
        if (state.positions.length === 0) {
          state.session.status = state.session.stopReason === "Virtual session loss cap reached" ? "risk_stopped" : "completed";
          break;
        }
        if (Date.now() >= Date.parse(state.session.settlementDeadline || state.session.endsAt)) {
          state.session.status = "completed_unsettled";
          state.session.stopReason = `Settlement deadline reached with ${state.positions.length} unresolved paper position(s)`;
          break;
        }
        persist();
        await delay(Math.min(30_000, args.pollSeconds * 1_000));
        continue;
      }
      try {
        await cycle();
      } catch (error) {
        state.consecutiveErrors += 1;
        state.lastError = String(error.message || error).slice(0, 500);
        log("cycle_error", { consecutiveErrors: state.consecutiveErrors, error: state.lastError });
      }
      persist();
      if (args.once) {
        state.session.status = state.positions.length ? "completed_unsettled" : "completed";
        state.session.stopReason = state.positions.length
          ? "One-cycle smoke run completed with an unresolved paper position"
          : "One-cycle smoke run completed";
        break;
      }
      const waitUntil = Date.now() + args.pollSeconds * 1_000;
      while (!interrupted && !fs.existsSync(stopPath) && Date.now() < waitUntil) {
        await delay(Math.min(1_000, waitUntil - Date.now()));
      }
    }
  } finally {
    state.session.stoppedAt = new Date().toISOString();
    if (state.session.status === "running") {
      state.session.status = "stopped";
      state.session.stopReason = "Runner exited";
    }
    persist();
    log("session_stopped", { summary: publicSummary(state), reason: state.session.stopReason });
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
