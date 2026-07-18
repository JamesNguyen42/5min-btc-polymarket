"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MAX_VALIDITY_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCES = 8;

function cleanText(value, maxLength = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(6));
}

function isoTimestamp(value, fieldName, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`${fieldName} is required`);
    return null;
  }
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error(`${fieldName} must be a valid date and time`);
  return new Date(timestamp).toISOString();
}

function httpsUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SOURCES).map((source) => {
    if (typeof source === "string") {
      const label = cleanText(source, 300);
      return label ? { label, source: null, publishedAt: null, url: null } : null;
    }
    if (!source || typeof source !== "object") return null;
    const label = cleanText(source.label || source.title || source.source, 300);
    if (!label) return null;
    const publishedAt = source.publishedAt ? isoTimestamp(source.publishedAt, "source publishedAt") : null;
    return {
      label,
      source: cleanText(source.source, 120) || null,
      publishedAt,
      url: httpsUrl(source.url || source.link),
    };
  }).filter(Boolean);
}

function canonicalSuggestion(suggestion) {
  return {
    id: suggestion.id || null,
    source: suggestion.source || null,
    action: suggestion.action || null,
    status: suggestion.status || null,
    canAccept: suggestion.canAccept === true,
    createdAt: suggestion.createdAt || null,
    validFrom: suggestion.validFrom || null,
    expiresAt: suggestion.expiresAt || null,
    acceptedAt: suggestion.acceptedAt || null,
    ticker: suggestion.ticker || null,
    title: suggestion.title || null,
    side: suggestion.side || null,
    contracts: suggestion.contracts ?? null,
    limitPriceDollars: suggestion.limitPriceDollars ?? null,
    estimatedFeeDollars: suggestion.estimatedFeeDollars ?? null,
    maxLossDollars: suggestion.maxLossDollars ?? null,
    takeProfitPriceDollars: suggestion.takeProfitPriceDollars ?? null,
    stopLossPriceDollars: suggestion.stopLossPriceDollars ?? null,
    exitBy: suggestion.exitBy || null,
    entryInstruction: suggestion.entryInstruction || null,
    exitInstruction: suggestion.exitInstruction || null,
    rationale: suggestion.rationale || null,
    sources: Array.isArray(suggestion.sources) ? suggestion.sources : [],
    localAcceptanceOnly: suggestion.localAcceptanceOnly === true,
    manualExecutionRequired: suggestion.manualExecutionRequired === true,
    canSubmitOrders: suggestion.canSubmitOrders === true,
    orderSubmitted: suggestion.orderSubmitted === true,
  };
}

function suggestionDigest(suggestion) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalSuggestion(suggestion))).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function createSuggestion(input, nowMs) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Suggestion input must be a JSON object");
  }
  const action = String(input.action || "").trim().toUpperCase();
  if (!["BUY", "SELL", "WAIT"].includes(action)) throw new Error("action must be BUY, SELL, or WAIT");

  const createdAt = new Date(nowMs).toISOString();
  const validFrom = isoTimestamp(input.validFrom || createdAt, "validFrom", { required: true });
  const expiresAt = isoTimestamp(input.expiresAt, "expiresAt", { required: true });
  const validFromMs = Date.parse(validFrom);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= validFromMs) throw new Error("expiresAt must be after validFrom");
  if (expiresAtMs - validFromMs > MAX_VALIDITY_MS) throw new Error("A suggestion cannot remain valid for more than 24 hours");
  if (expiresAtMs <= nowMs) throw new Error("expiresAt must be in the future when published");

  const ticker = cleanText(input.ticker, 160);
  const title = cleanText(input.title, 300);
  const rationale = cleanText(input.rationale, 1_000);
  if (!rationale) throw new Error("rationale is required");
  const sources = normalizeSources(input.sources);

  const base = {
    id: crypto.randomUUID(),
    source: "codex_cli",
    action,
    status: action === "WAIT" ? "informational" : "pending",
    canAccept: action !== "WAIT",
    createdAt,
    validFrom,
    expiresAt,
    acceptedAt: null,
    ticker: ticker || null,
    title: title || (action === "WAIT" ? "No current trade suggestion" : null),
    side: null,
    contracts: null,
    limitPriceDollars: null,
    estimatedFeeDollars: null,
    maxLossDollars: null,
    takeProfitPriceDollars: null,
    stopLossPriceDollars: null,
    exitBy: null,
    entryInstruction: null,
    exitInstruction: null,
    rationale,
    sources,
    localAcceptanceOnly: true,
    manualExecutionRequired: true,
    canSubmitOrders: false,
    orderSubmitted: false,
  };

  const actionableFields = [
    "side",
    "contracts",
    "limitPriceDollars",
    "estimatedFeeDollars",
    "maxLossDollars",
    "takeProfitPriceDollars",
    "stopLossPriceDollars",
    "exitBy",
    "entryInstruction",
    "exitInstruction",
  ];
  if (action === "WAIT") {
    const supplied = actionableFields.find((field) => input[field] !== null && input[field] !== undefined && input[field] !== "");
    if (supplied) throw new Error(`WAIT cannot include actionable order field ${supplied}`);
    base.digest = suggestionDigest(base);
    return base;
  }

  if (!ticker) throw new Error("ticker is required for BUY or SELL");
  if (!title) throw new Error("title is required for BUY or SELL");
  const side = String(input.side || "").trim().toUpperCase();
  if (!["YES", "NO"].includes(side)) throw new Error("side must be YES or NO");
  const contracts = Math.floor(finiteNumber(input.contracts, 0));
  if (contracts < 1 || contracts > 1_000_000) throw new Error("contracts must be a positive whole number");
  const limitPriceDollars = finiteNumber(input.limitPriceDollars, null);
  if (limitPriceDollars === null || limitPriceDollars <= 0 || limitPriceDollars >= 1) {
    throw new Error("limitPriceDollars must be greater than 0 and less than 1");
  }
  const estimatedFeeDollars = finiteNumber(input.estimatedFeeDollars, null);
  if (estimatedFeeDollars === null || estimatedFeeDollars < 0) throw new Error("estimatedFeeDollars must be zero or greater");
  const maxLossDollars = finiteNumber(input.maxLossDollars, null);
  if (maxLossDollars === null || maxLossDollars < 0 || (action === "BUY" && maxLossDollars === 0)) {
    throw new Error("maxLossDollars must describe the maximum loss for this suggestion");
  }
  const entryInstruction = cleanText(input.entryInstruction, 1_000);
  const exitInstruction = cleanText(input.exitInstruction, 1_000);
  if (!entryInstruction || !exitInstruction) throw new Error("entryInstruction and exitInstruction are required");
  if (!sources.length) throw new Error("At least one research source is required for BUY or SELL");

  const optionalPrice = (field) => {
    const value = finiteNumber(input[field], null);
    if (value === null) return null;
    if (value <= 0 || value >= 1) throw new Error(`${field} must be greater than 0 and less than 1`);
    return roundMoney(value);
  };
  const exitBy = isoTimestamp(input.exitBy, "exitBy");
  if (exitBy && (Date.parse(exitBy) < validFromMs || Date.parse(exitBy) - validFromMs > MAX_VALIDITY_MS)) {
    throw new Error("exitBy must be after validFrom and no more than 24 hours later");
  }

  Object.assign(base, {
    side,
    contracts,
    limitPriceDollars: roundMoney(limitPriceDollars),
    estimatedFeeDollars: roundMoney(estimatedFeeDollars),
    maxLossDollars: roundMoney(maxLossDollars),
    takeProfitPriceDollars: optionalPrice("takeProfitPriceDollars"),
    stopLossPriceDollars: optionalPrice("stopLossPriceDollars"),
    exitBy,
    entryInstruction,
    exitInstruction,
  });
  base.digest = suggestionDigest(base);
  return base;
}

function deriveStatus(stored, nowMs) {
  if (stored.status === "accepted") return { ...stored, status: "accepted", canAccept: false };
  if (nowMs >= Date.parse(stored.expiresAt || "")) return { ...stored, status: "expired", canAccept: false };
  if (stored.action === "WAIT" || stored.status === "informational") {
    return { ...stored, status: "informational", canAccept: false };
  }
  if (nowMs < Date.parse(stored.validFrom || "")) return { ...stored, status: "scheduled", canAccept: false };
  return { ...stored, status: "live", canAccept: true };
}

function createTradeProposalStore({ runtimeDir, now = () => Date.now() }) {
  if (!runtimeDir) throw new Error("runtimeDir is required");
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const currentPath = path.join(resolvedRuntimeDir, "current-proposal.json");
  const eventsPath = path.join(resolvedRuntimeDir, "proposal-events.jsonl");
  const lockPath = path.join(resolvedRuntimeDir, "proposal.lock");

  function withLock(operation) {
    fs.mkdirSync(resolvedRuntimeDir, { recursive: true });
    let handle = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        handle = fs.openSync(lockPath, "wx");
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    if (handle === null) throw new Error("Suggestion storage is busy; try again");
    try {
      return operation();
    } finally {
      try { fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  function loadStored() {
    if (!fs.existsSync(currentPath)) return null;
    const suggestion = readJson(currentPath);
    if (suggestion.digest !== suggestionDigest(suggestion)) {
      throw new Error("Stored suggestion failed its integrity check; it may have been tampered with");
    }
    return suggestion;
  }

  function recordEvent(event) {
    appendJsonLine(eventsPath, {
      ...event,
      localOnly: true,
      orderSubmitted: false,
    });
  }

  function current() {
    const stored = loadStored();
    return stored ? deriveStatus(stored, now()) : null;
  }

  function publish(input) {
    return withLock(() => {
      const suggestion = createSuggestion(input, now());
      writeJsonAtomic(currentPath, suggestion);
      recordEvent({
        timestamp: suggestion.createdAt,
        kind: "suggestion_published_from_codex_cli",
        proposalId: suggestion.id,
        action: suggestion.action,
        ticker: suggestion.ticker,
        validFrom: suggestion.validFrom,
        expiresAt: suggestion.expiresAt,
      });
      return deriveStatus(suggestion, now());
    });
  }

  function accept(proposalId, confirmation = {}) {
    return withLock(() => {
      const stored = loadStored();
      if (!stored || stored.id !== proposalId) throw new Error("Suggestion ID was not found or was replaced");
      if (stored.status === "accepted") return deriveStatus(stored, now());
      const suggestion = deriveStatus(stored, now());
      if (suggestion.status !== "live" || suggestion.canAccept !== true) {
        throw new Error(`Suggestion is ${suggestion.status} and cannot be accepted because it is not live`);
      }
      if (confirmation.confirmProposalId !== stored.id || confirmation.acknowledgeLocalAcceptance !== true) {
        throw new Error("Local-acceptance acknowledgment did not match the suggestion");
      }
      const accepted = {
        ...stored,
        status: "accepted",
        canAccept: false,
        acceptedAt: new Date(now()).toISOString(),
        localAcceptanceOnly: true,
        manualExecutionRequired: true,
        canSubmitOrders: false,
        orderSubmitted: false,
      };
      accepted.digest = suggestionDigest(accepted);
      writeJsonAtomic(currentPath, accepted);
      recordEvent({
        timestamp: accepted.acceptedAt,
        kind: "suggestion_accepted_locally",
        proposalId: accepted.id,
        action: accepted.action,
        ticker: accepted.ticker,
        side: accepted.side,
        contracts: accepted.contracts,
        limitPriceDollars: accepted.limitPriceDollars,
        maxLossDollars: accepted.maxLossDollars,
      });
      return deriveStatus(accepted, now());
    });
  }

  function clear(reason = "Suggestion cleared locally") {
    return withLock(() => {
      const stored = loadStored();
      if (fs.existsSync(currentPath)) fs.unlinkSync(currentPath);
      recordEvent({
        timestamp: new Date(now()).toISOString(),
        kind: "suggestion_cleared_locally",
        proposalId: stored?.id || null,
        reason: cleanText(reason, 500) || "Suggestion cleared locally",
      });
      return null;
    });
  }

  return {
    accept,
    clear,
    current,
    publish,
    paths: { currentPath, eventsPath, lockPath },
  };
}

module.exports = {
  createTradeProposalStore,
  createSuggestion,
};
