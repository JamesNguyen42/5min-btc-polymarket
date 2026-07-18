"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function suggestionContext(input, radius = 14) {
  const lines = input.split(/\r?\n/);
  const included = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    if (!/(?:proposal|suggestion)/i.test(lines[index])) continue;
    for (let cursor = Math.max(0, index - radius); cursor <= Math.min(lines.length - 1, index + radius); cursor += 1) {
      included.add(cursor);
    }
  }
  return [...included].sort((left, right) => left - right).map((index) => lines[index]).join("\n");
}

const EXCHANGE_EXECUTION_OR_AUTH =
  /KALSHI-ACCESS-(?:KEY|TIMESTAMP|SIGNATURE)|KALSHI_(?:API_KEY|PRIVATE_KEY|ACCESS_KEY|ACCESS_SIGNATURE)|POLYMARKET_(?:PRIVATE_KEY|API_KEY|API_SECRET)|kalshiAuthHeaders\s*\(|kalshiRequest\s*\(|\/portfolio(?:\/|["'`])|\/orders(?:\/|\b)|authorization\s*:/i;

const NETWORK_OR_PROVIDER_CALL =
  /\bfetch\s*\(|https?\.request\s*\(|new\s+WebSocket\s*\(|https?:\/\/(?:external-api\.)?kalshi|https?:\/\/(?:clob|gamma-api)\.polymarket|createAndPost|placeKalshiLiveOrder|kalshiRequest\s*\(/i;

test("suggestion storage and CLI code have no network, provider, order, or credential capability", () => {
  const packageJson = JSON.parse(source("package.json"));
  const commandNames = ["suggestion:publish", "suggestion:status", "suggestion:clear"];
  const cliPaths = new Set();

  for (const name of commandNames) {
    const command = packageJson.scripts?.[name];
    assert.equal(typeof command, "string", `package.json must define ${name}`);
    assert.ok(command.trim(), `${name} must not be empty`);
    const matches = [...command.matchAll(/(?:^|\s)(scripts[\\/][^\s"';&|]+\.(?:mjs|js|cjs))(?=\s|$)/g)];
    assert.ok(matches.length, `${name} must invoke a local script under scripts/`);
    for (const match of matches) cliPaths.add(match[1].replace(/\\/g, "/"));
  }

  const localPipelineSources = [source("lib/trade-proposals.js")];
  for (const cliPath of cliPaths) localPipelineSources.push(source(cliPath));
  for (const input of localPipelineSources) {
    assert.doesNotMatch(input, NETWORK_OR_PROVIDER_CALL);
    assert.doesNotMatch(input, EXCHANGE_EXECUTION_OR_AUTH);
    assert.doesNotMatch(input, /\b(?:API_KEY|PRIVATE_KEY|ACCESS_SIGNATURE|ACCESS_KEY)\b/);
  }
});

test("server exposes read and local acceptance only, with no generate route", () => {
  const server = source("server.js");
  assert.match(server, /GET["']?\s*&&\s*req\.url\s*===\s*["']\/api\/proposals\/current|req\.method\s*===\s*["']GET["'][\s\S]{0,100}\/api\/proposals\/current/);
  assert.match(server, /proposalAcceptMatch\s*=\s*new URL[\s\S]{0,300}proposals[\s\S]{0,120}accept/);
  assert.doesNotMatch(server, /req\.method\s*===\s*["']POST["'][\s\S]{0,100}\/api\/proposals\/generate/);
  assert.doesNotMatch(server, /proposals\/auto-accept|createNemotronProposalReviewer|nemotronProposalReviewer/i);

  const routes = suggestionContext(server, 18);
  assert.match(routes, /acknowledgeLocalAcceptance/);
  assert.match(routes, /localOriginPolicy\.isAllowedMutation\(req\)/);
  assert.match(routes, /403/);
  assert.match(routes, /recordedOnly:\s*true/);
  assert.match(routes, /orderSubmitted:\s*false/);
  assert.doesNotMatch(routes, EXCHANGE_EXECUTION_OR_AUTH);
  assert.doesNotMatch(routes, /acknowledgeManualPlacement|placeKalshiLiveOrder|startPaperWorker|confirmLive/i);
});

test("suggestion UI posts only local acceptance and has no generate, provider link, or popup path", () => {
  const frontend = source("public/app.js");
  const html = source("public/index.html");
  const ui = suggestionContext(`${html}\n${frontend}`, 20);

  assert.match(frontend, /\/api\/proposals\/current/);
  assert.match(frontend, /\/api\/proposals\/[^"'`]*\$\{[^}]+\}[^"'`]*\/accept|\/api\/proposals\/.*\/accept/);
  assert.match(frontend, /confirmProposalId\s*:\s*id[\s\S]{0,100}acknowledgeLocalAcceptance\s*:\s*true/);
  assert.match(html, /Accept suggestion/i);
  assert.match(ui, /local|record/i);
  assert.match(ui, /no order|does not (?:trade|place|submit|open)/i);

  assert.doesNotMatch(frontend, /\/api\/proposals\/generate|generateKalshiProposal|kalshiGenerateProposal|window\.open\s*\(|https?:\/\/kalshi\.com/i);
  assert.doesNotMatch(`${html}\n${frontend}`, /auto-accept|nemotronAutoAccept|NVIDIA_API_KEY/i);
  assert.doesNotMatch(html, /kalshiGenerateProposal|>\s*Generate (?:proposal|suggestion)\s*</i);
  assert.doesNotMatch(`${html}\n${frontend}`, /acknowledgeManualPlacement/);
  assert.doesNotMatch(ui, EXCHANGE_EXECUTION_OR_AUTH);
  assert.doesNotMatch(ui, NETWORK_OR_PROVIDER_CALL);
});

test("the accept suggestion button is rendered under the live graph", () => {
  const html = source("public/index.html");
  const liveChartPanel = html.match(/<section class="chart-panel" aria-label="Live performance">[\s\S]*?<\/section>/i);

  assert.ok(liveChartPanel, "Live chart panel should exist");
  assert.match(liveChartPanel[0], /id="liveChart"[\s\S]*id="kalshiAcceptProposal"/i);
});

test("there is no provider-backed reviewer that can accept suggestions", () => {
  assert.equal(fs.existsSync(path.join(ROOT, "lib", "nemotron-proposal-reviewer.js")), false);
});

test("legacy live execution is disconnected from every reachable frontend control", () => {
  const frontend = source("public/app.js");
  const html = source("public/index.html");

  assert.doesNotMatch(frontend, /["']\/api\/trading\/(?:settings|start)["']/);
  assert.doesNotMatch(frontend, /["']\/api\/polymarket\/(?:settings|arm-live)["']/);
  assert.doesNotMatch(frontend, /confirmLive/);

  const legacyLiveForm = html.match(/<form\b[^>]*\bid=["']liveForm["'][^>]*>[\s\S]*?<\/form>/i);
  if (legacyLiveForm) {
    assert.match(legacyLiveForm[0], /\bhidden\b/i);
    assert.match(legacyLiveForm[0], /\binert\b/i);
    assert.match(legacyLiveForm[0], /\baria-hidden=["']true["']/i);
    assert.match(legacyLiveForm[0], /<button\b[^>]*\btype=["']submit["'][^>]*\bdisabled\b/i);
  }
});

test("all funded exchange order paths are compile-time disabled", () => {
  const server = source("server.js");
  assert.match(server, /const KALSHI_FUNDED_TRADING_ENABLED = false;/);
  assert.match(server, /const POLYMARKET_FUNDED_TRADING_ENABLED = false;/);
  assert.match(server, /function placePolymarketLiveOrder[\s\S]{0,180}!POLYMARKET_FUNDED_TRADING_ENABLED/);
  assert.match(server, /async function armPolymarketLive[\s\S]{0,180}!POLYMARKET_FUNDED_TRADING_ENABLED/);
});
