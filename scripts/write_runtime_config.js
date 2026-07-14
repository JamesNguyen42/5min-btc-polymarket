const fs = require("fs");
const path = require("path");

const outPath = path.join(__dirname, "..", "public", "runtime-config.js");
const configuredApiUrl = String(process.env.SIM_API_BASE_URL || "").trim();
let apiBaseUrl = "";

if (process.env.VERCEL && !configuredApiUrl) {
  throw new Error("SIM_API_BASE_URL must be set to the Render service URL for Vercel builds.");
}

if (configuredApiUrl) {
  const parsed = new URL(configuredApiUrl);
  if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("SIM_API_BASE_URL must be an http(s) origin without a path, query, or fragment.");
  }
  if (process.env.VERCEL && parsed.protocol !== "https:") {
    throw new Error("SIM_API_BASE_URL must use https:// for Vercel deployments.");
  }
  apiBaseUrl = parsed.origin;
}

const js = `window.SIM_CONFIG = ${JSON.stringify({ apiBaseUrl }, null, 2)};\n`;
fs.writeFileSync(outPath, js, "utf8");
console.log(`wrote ${outPath}`);
