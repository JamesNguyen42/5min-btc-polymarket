# Codex CLI trade-suggestion workflow

When the user explicitly asks Codex CLI to create or refresh a trade suggestion
for this repository:

1. Research the current market and its exact resolution rules with current,
   public sources. Do not use project API keys or paid model-provider endpoints.
2. Never place, open, close, buy, or sell a trade. Never enable funded-trading
   environment gates. The output is an advisory record for manual review only.
3. Prefer a short-lived `WAIT` suggestion when evidence, quote freshness,
   liquidity, fees, timing, or resolution criteria are uncertain.
4. For `BUY` or `SELL`, specify the ticker, YES/NO side, contract count, limit
   price, estimated fee, maximum loss, exact entry condition, exact exit
   condition, validity window, rationale, and source links.
5. Publish the validated JSON with:

   `npm run suggestion:publish -- --input <json-file>`

   Use `npm run suggestion:status` to verify what the page will display. Runtime
   suggestion files are local and Git-ignored.

The user can ask simply: `Research and publish a current Kalshi suggestion for
the Live page. Do not place any trade.`
