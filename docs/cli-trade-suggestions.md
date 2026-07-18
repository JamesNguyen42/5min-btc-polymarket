# CLI-published trade suggestions

The Live page does not generate suggestions and does not call a paid model API.
It watches a local, Git-ignored suggestion record. Codex CLI can research and
publish that record using the user's existing CLI session.

From this repository, open Codex CLI and ask:

```text
Research and publish a current Kalshi suggestion for the Live page. Do not
place any trade. Include BUY or SELL, YES or NO, the limit price and contract
count, when to enter, when to exit, maximum loss, expiry, rationale, and current
source links. Publish WAIT if the evidence is not strong enough.
```

Repository instructions in `AGENTS.md` tell Codex how to validate and publish
the result. The underlying commands are:

```powershell
npm run suggestion:publish -- --input <json-file>
npm run suggestion:status
npm run suggestion:clear -- --reason "No longer current"
```

The page polls the local record, so a published suggestion appears without a
Generate button. Its state is `NO SUGGESTION`, `WAIT`, `SCHEDULED`, `LIVE`,
`EXPIRED`, or `ACCEPTED`.

Accepting a suggestion only appends a local audit event and changes the local
status. It does not open Kalshi and cannot place, open, close, buy, or sell an
order.

## Input shape

```json
{
  "action": "BUY",
  "ticker": "EXAMPLE-TICKER",
  "title": "Example market question",
  "side": "YES",
  "contracts": 1,
  "limitPriceDollars": 0.42,
  "estimatedFeeDollars": 0.02,
  "maxLossDollars": 0.44,
  "validFrom": "2026-07-18T06:00:00.000Z",
  "expiresAt": "2026-07-18T06:05:00.000Z",
  "entryInstruction": "Buy only at 42 cents or less while the cited evidence remains current.",
  "exitInstruction": "Sell at the stated target or exit before the time shown below.",
  "takeProfitPriceDollars": 0.58,
  "stopLossPriceDollars": 0.32,
  "exitBy": "2026-07-18T06:04:00.000Z",
  "rationale": "Short evidence-based explanation.",
  "sources": [
    {
      "title": "Current source title",
      "source": "Publisher",
      "publishedAt": "2026-07-18T05:55:00.000Z",
      "link": "https://example.com/current-source"
    }
  ]
}
```

Use `SELL` only when the instruction clearly identifies what existing YES or NO
contracts would be sold. Use `WAIT` when no action should be accepted; trade
fields may then be omitted, but the rationale and expiry should still be
present.

For bounded recurring research through the signed-in Codex CLI, see
[`codex-advisory-loop.md`](./codex-advisory-loop.md). That loop is not started
automatically and supports only risk-capped `BUY` or fail-closed `WAIT` because
it deliberately does not read position inventory.
