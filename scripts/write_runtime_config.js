const fs = require("fs");
const path = require("path");

const outPath = path.join(__dirname, "..", "public", "runtime-config.js");
const apiBaseUrl = String(process.env.SIM_API_BASE_URL || "").replace(/\/$/, "");

const js = `window.SIM_CONFIG = ${JSON.stringify({ apiBaseUrl }, null, 2)};\n`;
fs.writeFileSync(outPath, js, "utf8");
console.log(`wrote ${outPath}`);
