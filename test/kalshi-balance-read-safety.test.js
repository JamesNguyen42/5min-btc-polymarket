"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return serverSource.slice(start, end);
}

test("read-only Kalshi balance validation does not require the funded-trading flag", () => {
  const credentialValidation = sourceBetween(
    "function kalshiCredentialConfigError()",
    "function kalshiReadCredentialsConfigured()",
  );
  const liveValidation = sourceBetween(
    "function kalshiLiveModeConfiguredError()",
    "function fixedDollar(value)",
  );
  const balanceSync = sourceBetween(
    "async function syncKalshiAccountBalance",
    "async function resolvePaperStartingCash",
  );

  assert.doesNotMatch(credentialValidation, /KALSHI_FUNDED_TRADING_ENABLED/);
  assert.match(liveValidation, /if \(!KALSHI_FUNDED_TRADING_ENABLED\)/);
  assert.match(liveValidation, /return kalshiCredentialConfigError\(\)/);
  assert.match(balanceSync, /const configError = kalshiCredentialConfigError\(\)/);
  assert.doesNotMatch(balanceSync, /kalshiLiveModeConfiguredError\(\)/);
});

test("funded order submission and auto-resume are compile-time disabled", () => {
  assert.match(serverSource, /const KALSHI_FUNDED_TRADING_ENABLED = false;/);
  assert.match(serverSource, /const KALSHI_LIVE_AUTO_RESUME_ENABLED = false;/);
  assert.doesNotMatch(serverSource, /process\.env\.KALSHI_(?:ENABLE_FUNDED_TRADING|ALLOW_LIVE_AUTO_RESUME)/);
});

test("balance remains a GET while the unreachable order path keeps its independent guard", () => {
  const balanceRequest = sourceBetween(
    "async function fetchKalshiBalanceSnapshot()",
    "async function syncKalshiAccountBalance",
  );
  const liveOrder = sourceBetween(
    "async function placeKalshiLiveOrder",
    "function kalshiBalanceDollars",
  );

  assert.match(balanceRequest, /kalshiRequest\("GET", "\/portfolio\/balance"\)/);
  assert.doesNotMatch(balanceRequest, /kalshiRequest\("POST"/);
  assert.match(liveOrder, /if \(!KALSHI_FUNDED_TRADING_ENABLED\)/);
  assert.match(liveOrder, /kalshiRequest\("POST", "\/portfolio\/events\/orders"/);
});
