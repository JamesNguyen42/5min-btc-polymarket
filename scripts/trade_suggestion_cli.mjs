#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createTradeProposalStore } = require("../lib/trade-proposals.js");
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const configuredRuntime = process.env.PROPOSAL_RUNTIME_DIR || path.join("runtime", "trade-proposals");
const runtimeDir = path.isAbsolute(configuredRuntime) ? configuredRuntime : path.resolve(repositoryRoot, configuredRuntime);
const store = createTradeProposalStore({ runtimeDir });

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  return [
    "Local Codex CLI trade-suggestion publisher (never submits an order)",
    "",
    "  node scripts/trade_suggestion_cli.mjs publish --input <suggestion.json>",
    "  <suggestion.json | node scripts/trade_suggestion_cli.mjs publish --stdin",
    "  node scripts/trade_suggestion_cli.mjs status",
    "  node scripts/trade_suggestion_cli.mjs clear --reason \"No longer current\"",
  ].join("\n");
}

function readPublishInput() {
  const inputPath = option("--input");
  if (inputPath) return fs.readFileSync(path.resolve(inputPath), "utf8");
  if (process.argv.includes("--stdin") || !process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  throw new Error("publish requires --input <json-file> or JSON on stdin with --stdin");
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

try {
  const command = String(process.argv[2] || "").toLowerCase();
  if (command === "publish") {
    const input = JSON.parse(readPublishInput().replace(/^\uFEFF/, ""));
    output({ ok: true, suggestion: store.publish(input), runtimeDir });
  } else if (command === "status") {
    output({ ok: true, suggestion: store.current(), runtimeDir });
  } else if (command === "clear") {
    store.clear(option("--reason") || "Suggestion cleared from the local CLI");
    output({ ok: true, suggestion: null, runtimeDir });
  } else {
    process.stdout.write(`${usage()}\n`);
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(`${error.message || String(error)}\n`);
  process.exitCode = 1;
}
