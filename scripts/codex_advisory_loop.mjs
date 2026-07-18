#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const {
  buildPublishableSuggestion,
  sanitizedChildEnvironment,
  validateBalancePayload,
  validatePublicMarketPayload,
  waitSuggestion,
} = require("../lib/codex-advisory-core");

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const RUNTIME_ROOT = path.join(ROOT, "runtime");
const DEFAULT_OUTPUT_ROOT = path.join(RUNTIME_ROOT, "codex-advisory");
const DEFAULT_PROPOSAL_RUNTIME = path.join(RUNTIME_ROOT, "trade-proposals");
const SOURCE_SCHEMA = path.join(ROOT, "config", "codex-advisory-schema.json");
const LOCAL_BALANCE_URL = "http://127.0.0.1:3000/api/kalshi/status";
const PUBLIC_MARKET_BASE_URL = "https://external-api.kalshi.com/trade-api/v2/markets";
const FINALIZATION_RESERVE_MS = 90_000;

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function hasOption(argv, name) {
  return argv.includes(name);
}

function numberOption(argv, name, fallback) {
  const value = option(argv, name);
  if (value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a number`);
  return number;
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0].toLowerCase() : "run";
  if (!["run", "status", "stop", "help"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const args = command === "run" && argv[0] === "run" ? argv.slice(1) : command === "run" ? argv : argv.slice(1);
  const knownValueOptions = new Set([
    "--duration-hours",
    "--interval-minutes",
    "--codex-timeout-minutes",
    "--balance-url",
    "--output-root",
    "--proposal-runtime-dir",
    "--run-dir",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help" || name === "-h") continue;
    if (!knownValueOptions.has(name)) throw new Error(`Unknown option: ${name}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
    index += 1;
  }
  const durationHours = numberOption(args, "--duration-hours", 12);
  const intervalMinutes = numberOption(args, "--interval-minutes", 20);
  const codexTimeoutMinutes = numberOption(args, "--codex-timeout-minutes", 12);
  if (durationHours <= 0 || durationHours > 12) throw new Error("--duration-hours must be greater than 0 and no more than 12");
  if (intervalMinutes < 15 || intervalMinutes > 120) throw new Error("--interval-minutes must be between 15 and 120");
  if (codexTimeoutMinutes < 1 || codexTimeoutMinutes >= intervalMinutes) {
    throw new Error("--codex-timeout-minutes must be at least 1 and less than the interval");
  }
  return {
    command: hasOption(args, "--help") || hasOption(args, "-h") ? "help" : command,
    durationHours,
    intervalMinutes,
    codexTimeoutMinutes,
    balanceUrl: option(args, "--balance-url") || LOCAL_BALANCE_URL,
    outputRoot: path.resolve(ROOT, option(args, "--output-root") || DEFAULT_OUTPUT_ROOT),
    proposalRuntimeDir: path.resolve(ROOT, option(args, "--proposal-runtime-dir") || DEFAULT_PROPOSAL_RUNTIME),
    runDir: option(args, "--run-dir") ? path.resolve(ROOT, option(args, "--run-dir")) : null,
  };
}

function usage() {
  return `12-hour Codex CLI advisory loop (research and local publication only)

Usage:
  node scripts/codex_advisory_loop.mjs run
  node scripts/codex_advisory_loop.mjs status [--run-dir <path>]
  node scripts/codex_advisory_loop.mjs stop [--run-dir <path>]

Run options:
  --duration-hours N          Default 12; maximum 12
  --interval-minutes N        Default 20; range 15-120
  --codex-timeout-minutes N   Default 12; must be shorter than interval
  --balance-url URL           Loopback /api/kalshi/status URL only
  --output-root PATH          Must remain under this repository's runtime directory
  --proposal-runtime-dir PATH Must remain under this repository's runtime directory

The runner calls Codex with saved ChatGPT login, live public web search, an
ephemeral read-only sandbox, no inherited secret environment variables, and a
strict JSON schema. It never accepts suggestions or submits exchange orders.`;
}

function assertInsideRuntime(candidate, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(RUNTIME_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child directory of ${RUNTIME_ROOT}`);
  }
  return resolved;
}

function assertRunDirectory(runDir, outputRoot) {
  const resolved = path.resolve(runDir);
  const relative = path.relative(outputRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Run directory must be a child of ${outputRoot}`);
  }
  return resolved;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
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

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolveLatestRun(outputRoot, explicitRunDir = null) {
  if (explicitRunDir) return assertRunDirectory(explicitRunDir, outputRoot);
  const latestPath = path.join(outputRoot, "latest-run.json");
  if (!fs.existsSync(latestPath)) throw new Error("No Codex advisory run has been created");
  const latest = readJson(latestPath);
  if (!latest?.runDir) throw new Error("Latest-run pointer is invalid");
  return assertRunDirectory(latest.runDir, outputRoot);
}

function createUniqueRun(outputRoot) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const latestPath = path.join(outputRoot, "latest-run.json");
  if (fs.existsSync(latestPath)) {
    try {
      const previousRun = resolveLatestRun(outputRoot);
      const statusPath = path.join(previousRun, "status.json");
      const previous = fs.existsSync(statusPath) ? readJson(statusPath) : null;
      if (previous?.status === "running" && processIsAlive(Number(previous.pid))) {
        throw new Error(`A Codex advisory loop is already active with PID ${previous.pid} in ${previousRun}`);
      }
    } catch (error) {
      if (/already active/.test(error.message || "")) throw error;
    }
  }
  const runId = randomUUID();
  const runDir = path.join(outputRoot, `run-${timestampSlug()}-${runId.slice(0, 8)}`);
  fs.mkdirSync(runDir, { recursive: false });
  fs.mkdirSync(path.join(runDir, "research-workspace"), { recursive: false });
  fs.copyFileSync(SOURCE_SCHEMA, path.join(runDir, "advisory-schema.json"));
  writeJsonAtomic(latestPath, { runId, runDir, createdAt: new Date().toISOString() });
  return { runId, runDir };
}

function acquireLock(runDir, runId) {
  const lockPath = path.join(runDir, "runner.lock");
  try {
    const handle = fs.openSync(lockPath, "wx");
    fs.writeFileSync(handle, `${JSON.stringify({ runId, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    fs.closeSync(handle);
    return lockPath;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let lock = null;
  try { lock = readJson(lockPath); } catch {}
  if (processIsAlive(Number(lock?.pid))) throw new Error(`Run is locked by active PID ${lock.pid}`);
  fs.unlinkSync(lockPath);
  const handle = fs.openSync(lockPath, "wx");
  fs.writeFileSync(handle, `${JSON.stringify({ runId, pid: process.pid, createdAt: new Date().toISOString(), replacedStaleLock: true })}\n`);
  fs.closeSync(handle);
  return lockPath;
}

function validateLocalBalanceUrl(value) {
  const url = new URL(String(value || ""));
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/api/kalshi/status" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Balance URL must be an unauthenticated loopback HTTP /api/kalshi/status URL");
  }
  return url.href;
}

function boundedTimeoutMs(deadlineMs, maximumMs, label) {
  const remainingMs = Number(deadlineMs) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error(`${label} deadline was reached`);
  }
  return Math.max(1, Math.min(maximumMs, Math.floor(remainingMs)));
}

async function fetchCurrentBalance(balanceUrl, deadlineMs = Date.now() + 10_000) {
  const url = validateLocalBalanceUrl(balanceUrl);
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(boundedTimeoutMs(deadlineMs, 10_000, "Balance refresh")),
  });
  if (!response.ok) throw new Error(`Local balance endpoint returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Local balance response was unexpectedly large");
  return validateBalancePayload(JSON.parse(text), Date.now());
}

async function fetchTrustedPublicMarketQuote(ticker, side, deadlineMs = Date.now() + 10_000) {
  const normalizedTicker = String(ticker || "").trim().toUpperCase();
  if (!/^[A-Z0-9._:-]+$/.test(normalizedTicker)) throw new Error("Ticker format was not safe for public quote lookup");
  const normalizedSide = String(side || "").trim().toUpperCase();
  if (!["YES", "NO"].includes(normalizedSide)) throw new Error("Side was not safe for public quote lookup");
  const url = `${PUBLIC_MARKET_BASE_URL}/${encodeURIComponent(normalizedTicker)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "Codex-Local-Advisory/1.0" },
    redirect: "error",
    signal: AbortSignal.timeout(boundedTimeoutMs(deadlineMs, 10_000, "Public quote refresh")),
  });
  const observedAtMs = Date.now();
  if (!response.ok) throw new Error(`Public market endpoint returned HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error("Public market response was unexpectedly large");
  return validatePublicMarketPayload(JSON.parse(text), {
    ticker: normalizedTicker,
    side: normalizedSide,
    officialUrl: url,
    observedAtMs,
  });
}

function cyclePrompt(balanceSnapshot, nowMs) {
  const riskCap = Math.floor((balanceSnapshot.availableCash * 0.1 + 1e-9) * 100) / 100;
  return `You are performing a research-only Kalshi advisory cycle at ${new Date(nowMs).toISOString()}.

Use live public web search and public pages only. Do not read local files, run shell commands, use provider API keys, access authenticated account/portfolio/position/order/trade endpoints, or perform/accept any transaction. You have no authority or capability to trade.

The trusted local wrapper verified current available cash of $${balanceSnapshot.availableCash.toFixed(4)} at ${balanceSnapshot.checkedAt}. The absolute maximum loss for any BUY is 10% rounded down to cents: $${riskCap.toFixed(2)}, including estimated fees. Suggest a whole-number contract count and dollar amount, but the wrapper will independently reduce or reject it.

Scan current public Kalshi markets and return BUY only if all conditions hold:
- exact ticker, YES/NO side, current ask observed within the last 60 seconds, and a limit no higher than that ask;
- an official HTTPS Kalshi market page and an exact official HTTPS rules URL;
- source timestamps for every URL; categorize sources as MARKET, RULES, or PRIMARY_EVIDENCE;
- at least one independent primary evidence source published/checked within six hours, with exact resolution criteria checked;
- confidence at least 0.75 and estimated probability at least 0.05 above the limit price;
- exact entry, take-profit, stop-loss, and time-based exit within five minutes.

Otherwise return WAIT. SELL is not supported because no position snapshot is provided; use the exit instruction to state how a newly bought contract should be sold. For WAIT, set every trade-specific nullable field to null. Use ISO-8601 UTC timestamps and direct HTTPS source URLs. Return only the JSON object required by the supplied schema.`;
}

function spawnCaptured(command, args, {
  cwd,
  env,
  stdin = "",
  stdoutPath,
  stderrPath,
  timeoutMs,
  stopRequested = () => false,
  retainStdout = false,
  retainStderr = false,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    let stopPoll = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (stopPoll) clearInterval(stopPoll);
      if (error) reject(error);
      else resolve(result);
    };
    child.on("error", (error) => finish(error));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      fs.appendFileSync(stdoutPath, chunk);
      if (retainStdout && stdout.length < 2_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      fs.appendFileSync(stderrPath, chunk);
      if (retainStderr && stderr.length < 2_000_000) stderr += chunk.toString("utf8");
    });
    child.on("close", (code, signal) => {
      if (code === 0) finish(null, { code, signal, stdout, stderr });
      else finish(new Error(`${path.basename(command)} exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
    });
    child.stdin.end(stdin);
    const terminate = (message) => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
      force.unref?.();
      finish(new Error(message));
    };
    timeout = setTimeout(() => terminate(`${path.basename(command)} timed out`), timeoutMs);
    stopPoll = setInterval(() => {
      if (stopRequested()) terminate(`${path.basename(command)} stopped by operator`);
    }, 1_000);
    timeout.unref?.();
    stopPoll.unref?.();
  });
}

async function runCodexResearch({ runDir, cycleNumber, balanceSnapshot, timeoutMs, stopRequested }) {
  const cycleTag = String(cycleNumber).padStart(3, "0");
  const outputPath = path.join(runDir, `cycle-${cycleTag}-model-output.json`);
  const eventsPath = path.join(runDir, "codex-events.jsonl");
  const stderrPath = path.join(runDir, "codex-stderr.log");
  const nowMs = Date.now();
  appendJsonLine(eventsPath, { type: "local.cycle.started", cycle: cycleNumber, timestamp: new Date(nowMs).toISOString() });
  fs.appendFileSync(stderrPath, `\n[cycle ${cycleNumber} ${new Date(nowMs).toISOString()}]\n`, "utf8");
  const args = [
    "--search",
    "--ask-for-approval", "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--strict-config",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--disable", "shell_tool",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "browser_use",
    "--disable", "browser_use_external",
    "--disable", "browser_use_full_cdp_access",
    "--disable", "in_app_browser",
    "--disable", "computer_use",
    "--disable", "multi_agent",
    "-m", "gpt-5.6-sol",
    "-c", 'model_provider="openai"',
    "-c", 'model_reasoning_effort="high"',
    "-c", 'web_search="live"',
    "-c", 'shell_environment_policy.inherit="none"',
    "-c", "project_doc_max_bytes=0",
    "--cd", path.join(runDir, "research-workspace"),
    "--output-schema", path.join(runDir, "advisory-schema.json"),
    "--output-last-message", outputPath,
    "--color", "never",
    "--json",
    "-",
  ];
  await spawnCaptured("codex", args, {
    cwd: path.join(runDir, "research-workspace"),
    env: sanitizedChildEnvironment(process.env),
    stdin: cyclePrompt(balanceSnapshot, nowMs),
    stdoutPath: eventsPath,
    stderrPath,
    timeoutMs,
    stopRequested,
  });
  if (!fs.existsSync(outputPath)) throw new Error("Codex did not write a structured final response");
  const raw = fs.readFileSync(outputPath, "utf8");
  if (raw.length > 1_000_000) throw new Error("Codex structured response was unexpectedly large");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function verifySavedChatGptLogin(runDir) {
  const result = await spawnCaptured("codex", ["login", "status"], {
    cwd: path.join(runDir, "research-workspace"),
    env: sanitizedChildEnvironment(process.env),
    stdoutPath: path.join(runDir, "auth-stdout.log"),
    stderrPath: path.join(runDir, "auth-stderr.log"),
    timeoutMs: 10_000,
    retainStdout: true,
    retainStderr: true,
  });
  if (!/Logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error("Codex CLI must be logged in using ChatGPT; API-key and access-token authentication are not allowed");
  }
  return "saved_chatgpt_login";
}

async function publishSuggestion({ suggestion, proposalRuntimeDir, runDir, deadlineMs, stopRequested = () => false }) {
  const stdoutPath = path.join(runDir, "publisher-stdout.log");
  const stderrPath = path.join(runDir, "publisher-stderr.log");
  const env = {
    ...sanitizedChildEnvironment(process.env),
    PROPOSAL_RUNTIME_DIR: proposalRuntimeDir,
  };
  const result = await spawnCaptured(process.execPath, [path.join(ROOT, "scripts", "trade_suggestion_cli.mjs"), "publish", "--stdin"], {
    cwd: ROOT,
    env,
    stdin: `${JSON.stringify(suggestion)}\n`,
    stdoutPath,
    stderrPath,
    timeoutMs: boundedTimeoutMs(deadlineMs, 10_000, "Suggestion publication"),
    stopRequested,
    retainStdout: true,
  });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

async function clearCurrentSuggestion({ reason, proposalRuntimeDir, runDir, deadlineMs }) {
  const result = await spawnCaptured(process.execPath, [
    path.join(ROOT, "scripts", "trade_suggestion_cli.mjs"),
    "clear",
    "--reason",
    String(reason || "Advisory publisher failed closed").slice(0, 400),
  ], {
    cwd: ROOT,
    env: {
      ...sanitizedChildEnvironment(process.env),
      PROPOSAL_RUNTIME_DIR: proposalRuntimeDir,
    },
    stdoutPath: path.join(runDir, "publisher-stdout.log"),
    stderrPath: path.join(runDir, "publisher-stderr.log"),
    timeoutMs: boundedTimeoutMs(deadlineMs, 10_000, "Suggestion clear"),
    retainStdout: true,
  });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}

async function publishFailClosed({ suggestion, proposalRuntimeDir, runDir, deadlineMs }) {
  try {
    const publication = await publishSuggestion({ suggestion, proposalRuntimeDir, runDir, deadlineMs });
    return { suggestion, publication, publicationFailure: null, cleared: false };
  } catch (primaryError) {
    const failure = String(primaryError.message || primaryError).slice(0, 400);
    const fallbackWait = waitSuggestion(`WAIT: local publication failed closed and was retried. ${failure}`, Date.now(), 5);
    try {
      const publication = await publishSuggestion({ suggestion: fallbackWait, proposalRuntimeDir, runDir, deadlineMs });
      return { suggestion: fallbackWait, publication, publicationFailure: failure, cleared: false };
    } catch (waitError) {
      const waitFailure = String(waitError.message || waitError).slice(0, 400);
      try {
        const publication = await clearCurrentSuggestion({
          reason: `Both suggestion and fallback WAIT publication failed: ${failure}; ${waitFailure}`,
          proposalRuntimeDir,
          runDir,
          deadlineMs,
        });
        return {
          suggestion: null,
          publication,
          publicationFailure: `${failure}; fallback WAIT failed: ${waitFailure}; prior suggestion cleared`,
          cleared: true,
        };
      } catch (clearError) {
        throw new Error(`Suggestion publication, fallback WAIT, and final clear all failed: ${failure}; ${waitFailure}; ${String(clearError.message || clearError).slice(0, 300)}`);
      }
    }
  }
}

function publicDecision(suggestion, publication) {
  return {
    action: suggestion.action,
    ticker: suggestion.ticker || null,
    side: suggestion.side || null,
    contracts: suggestion.contracts ?? null,
    limitPriceDollars: suggestion.limitPriceDollars ?? null,
    maxLossDollars: suggestion.maxLossDollars ?? null,
    expiresAt: suggestion.expiresAt,
    proposalId: publication?.suggestion?.id || null,
    localOnly: true,
    orderSubmitted: false,
  };
}

function clearedDecision(publication) {
  return {
    action: "CLEARED",
    ticker: null,
    side: null,
    contracts: null,
    limitPriceDollars: null,
    maxLossDollars: null,
    expiresAt: null,
    proposalId: publication?.suggestion?.id || null,
    localOnly: true,
    orderSubmitted: false,
  };
}

async function delayUntil(deadlineMs, stopRequested) {
  while (Date.now() < deadlineMs && !stopRequested()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadlineMs - Date.now())));
  }
}

async function runLoop(args) {
  const outputRoot = assertInsideRuntime(args.outputRoot, "Output root");
  const proposalRuntimeDir = assertInsideRuntime(args.proposalRuntimeDir, "Proposal runtime directory");
  const { runId, runDir } = createUniqueRun(outputRoot);
  const lockPath = acquireLock(runDir, runId);
  const stopPath = path.join(runDir, "STOP");
  const statusPath = path.join(runDir, "status.json");
  const cyclesPath = path.join(runDir, "cycles.jsonl");
  const startedAtMs = Date.now();
  const endsAtMs = startedAtMs + args.durationHours * 3_600_000;
  const operationalDeadlineMs = Math.max(startedAtMs, endsAtMs - FINALIZATION_RESERVE_MS);
  let signalStop = null;
  let completed = false;
  const requestSignalStop = (signal) => { signalStop = signal; };
  process.once("SIGINT", requestSignalStop);
  process.once("SIGTERM", requestSignalStop);
  const operatorStopRequested = () => Boolean(signalStop) || fs.existsSync(stopPath);
  const stopRequested = () => operatorStopRequested() || Date.now() >= operationalDeadlineMs;
  const status = {
    version: 1,
    runId,
    runDir,
    pid: process.pid,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString(),
    stoppedAt: null,
    stopReason: null,
    intervalMinutes: args.intervalMinutes,
    durationHours: args.durationHours,
    cyclesCompleted: 0,
    nextCycleAt: new Date(startedAtMs).toISOString(),
    lastBalance: null,
    lastDecision: null,
    lastError: null,
    safety: {
      researchOnly: true,
      savedChatGptLogin: false,
      authMode: "pending_chatgpt_login_check",
      providerApiKeysAllowed: false,
      readOnlySandbox: true,
      fundedTradingMustBeDisabled: true,
      orderSubmissionCapable: false,
      localAcceptancePerformed: false,
      riskCapFraction: 0.1,
      balanceMaxAgeSeconds: 60,
      quoteMaxAgeSeconds: 60,
      actionableAcceptanceMaxSeconds: 60,
      postEntryExitMaxMinutes: 5,
      operationalDeadline: new Date(operationalDeadlineMs).toISOString(),
    },
    files: {
      lock: lockPath,
      status: statusPath,
      stop: stopPath,
      cycles: cyclesPath,
      codexEvents: path.join(runDir, "codex-events.jsonl"),
      codexStderr: path.join(runDir, "codex-stderr.log"),
      publisherStdout: path.join(runDir, "publisher-stdout.log"),
      publisherStderr: path.join(runDir, "publisher-stderr.log"),
      authStdout: path.join(runDir, "auth-stdout.log"),
      authStderr: path.join(runDir, "auth-stderr.log"),
    },
  };
  const persistStatus = () => writeJsonAtomic(statusPath, status);
  persistStatus();
  process.stdout.write(`${JSON.stringify({ started: true, runId, runDir, statusPath, stopPath }, null, 2)}\n`);

  try {
    status.safety.authMode = await verifySavedChatGptLogin(runDir);
    status.safety.savedChatGptLogin = true;
    persistStatus();
    for (let cycleNumber = 1; Date.now() < operationalDeadlineMs && !stopRequested(); cycleNumber += 1) {
      const cycleStartedAtMs = Date.now();
      let balanceSnapshot = null;
      let suggestion;
      let failure = null;
      try {
        balanceSnapshot = await fetchCurrentBalance(args.balanceUrl, operationalDeadlineMs);
        status.lastBalance = balanceSnapshot;
        const modelOutput = await runCodexResearch({
          runDir,
          cycleNumber,
          balanceSnapshot,
          timeoutMs: boundedTimeoutMs(
            operationalDeadlineMs,
            args.codexTimeoutMinutes * 60_000,
            "Codex research",
          ),
          stopRequested,
        });
        let verifiedModelOutput = modelOutput;
        if (String(modelOutput?.action || "").trim().toUpperCase() === "BUY") {
          const publicQuote = await fetchTrustedPublicMarketQuote(modelOutput.ticker, modelOutput.side, operationalDeadlineMs);
          const primaryEvidence = Array.isArray(modelOutput.sources)
            ? modelOutput.sources.filter((source) => String(source?.kind || "").trim().toUpperCase() === "PRIMARY_EVIDENCE")
            : [];
          verifiedModelOutput = {
            ...modelOutput,
            ...publicQuote,
            title: publicQuote.title || modelOutput.title,
            marketUrl: publicQuote.trustedPublicMarketUrl,
            rulesUrl: publicQuote.trustedPublicMarketUrl,
            sources: [
              {
                kind: "MARKET",
                label: `Verified public market ${publicQuote.ticker}`,
                source: "Kalshi public market endpoint",
                publishedAt: publicQuote.quoteObservedAt,
                url: publicQuote.trustedPublicMarketUrl,
              },
              {
                kind: "RULES",
                label: `Verified primary resolution rules for ${publicQuote.ticker}`,
                source: "Kalshi public market endpoint",
                publishedAt: publicQuote.quoteObservedAt,
                url: publicQuote.trustedPublicMarketUrl,
              },
              ...primaryEvidence,
            ],
          };
        }
        balanceSnapshot = await fetchCurrentBalance(args.balanceUrl, operationalDeadlineMs);
        status.lastBalance = balanceSnapshot;
        const validated = buildPublishableSuggestion(verifiedModelOutput, balanceSnapshot, Date.now(), 5);
        suggestion = validated.suggestion;
        failure = validated.failClosedReason;
      } catch (error) {
        failure = String(error.message || error).slice(0, 700);
        suggestion = waitSuggestion(`WAIT (advisory cycle failed closed): ${failure}`, Date.now(), 5);
      }

      try {
        const safePublication = await publishFailClosed({
          suggestion,
          proposalRuntimeDir,
          runDir,
          deadlineMs: endsAtMs,
        });
        status.lastDecision = safePublication.cleared
          ? clearedDecision(safePublication.publication)
          : publicDecision(safePublication.suggestion, safePublication.publication);
        status.lastError = [failure, safePublication.publicationFailure].filter(Boolean).join("; ") || null;
        appendJsonLine(cyclesPath, {
          timestamp: new Date().toISOString(),
          runId,
          cycle: cycleNumber,
          balance: balanceSnapshot,
          decision: status.lastDecision,
          failClosedReason: failure,
          orderSubmitted: false,
        });
      } catch (error) {
        status.lastError = `Local WAIT/suggestion publication failed: ${String(error.message || error).slice(0, 500)}`;
        appendJsonLine(cyclesPath, {
          timestamp: new Date().toISOString(),
          runId,
          cycle: cycleNumber,
          balance: balanceSnapshot,
          decision: null,
          failClosedReason: status.lastError,
          orderSubmitted: false,
        });
      }
      status.cyclesCompleted = cycleNumber;
      const nextCycleMs = Math.min(operationalDeadlineMs, cycleStartedAtMs + args.intervalMinutes * 60_000);
      status.nextCycleAt = new Date(nextCycleMs).toISOString();
      persistStatus();
      await delayUntil(nextCycleMs, stopRequested);
    }
    completed = !operatorStopRequested() && Date.now() >= operationalDeadlineMs;
    status.status = completed ? "finalizing" : "stopped";
    status.stopReason = completed
      ? "Research window ended; holding a final WAIT until the configured duration ends"
      : signalStop
        ? `Received ${signalStop}`
        : "STOP file requested by operator";
  } catch (error) {
    status.status = "failed";
    status.stopReason = String(error.message || error).slice(0, 700);
    status.lastError = status.stopReason;
  } finally {
    const finalWait = waitSuggestion(`WAIT: advisory run ${status.status}. ${status.stopReason || "No new suggestion is being produced."}`, Date.now(), 5);
    try {
      const safePublication = await publishFailClosed({
        suggestion: finalWait,
        proposalRuntimeDir,
        runDir,
        deadlineMs: endsAtMs,
      });
      status.lastDecision = safePublication.cleared
        ? clearedDecision(safePublication.publication)
        : publicDecision(safePublication.suggestion, safePublication.publication);
      if (safePublication.publicationFailure) status.lastError = safePublication.publicationFailure;
    } catch (error) {
      status.lastError = `Final WAIT publication failed: ${String(error.message || error).slice(0, 500)}`;
    }
    status.nextCycleAt = null;
    persistStatus();
    if (completed && status.status === "finalizing") {
      await delayUntil(endsAtMs, operatorStopRequested);
      const interrupted = operatorStopRequested();
      status.status = interrupted ? "stopped" : "completed";
      status.stopReason = interrupted
        ? signalStop ? `Received ${signalStop}` : "STOP file requested by operator"
        : "Configured 12-hour-or-shorter advisory duration reached";
    }
    status.stoppedAt = new Date().toISOString();
    persistStatus();
    try { fs.unlinkSync(lockPath); } catch {}
    process.stdout.write(`${JSON.stringify({ finished: true, runId, runDir, status: status.status }, null, 2)}\n`);
  }
  if (status.status === "failed") process.exitCode = 1;
}

function printStatus(args) {
  const outputRoot = assertInsideRuntime(args.outputRoot, "Output root");
  const runDir = resolveLatestRun(outputRoot, args.runDir);
  const statusPath = path.join(runDir, "status.json");
  const status = fs.existsSync(statusPath) ? readJson(statusPath) : { status: "not_started", runDir };
  process.stdout.write(`${JSON.stringify({ ...status, processAlive: processIsAlive(Number(status.pid)) }, null, 2)}\n`);
}

function requestStop(args) {
  const outputRoot = assertInsideRuntime(args.outputRoot, "Output root");
  const runDir = resolveLatestRun(outputRoot, args.runDir);
  const stopPath = path.join(runDir, "STOP");
  try {
    fs.writeFileSync(stopPath, `${new Date().toISOString()} requested by operator\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  process.stdout.write(`${JSON.stringify({ stopRequested: true, runDir, stopPath }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.command === "status") {
    printStatus(args);
    return;
  }
  if (args.command === "stop") {
    requestStop(args);
    return;
  }
  await runLoop(args);
}

main().catch((error) => {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
});
