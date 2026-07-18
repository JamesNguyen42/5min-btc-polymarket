# Twelve-hour Codex CLI advisory loop

This optional runner refreshes the Live page's local suggestion record every
20 minutes for up to 12 hours. It does not start with the web server and it is
not running merely because localhost is open.

The runner uses `codex exec` only after `codex login status` confirms the user's
saved ChatGPT login. It starts the child with a small operating-system variable
allowlist, so provider, cloud, and exchange secrets are absent. It ignores user
tool configuration, disables shell/plugins/apps/browser/computer/multi-agent
tools, sets project-document loading to zero, and runs ephemerally in an
isolated read-only directory. Native live web search remains enabled, and the
final answer must match
`config/codex-advisory-schema.json`. It never calls an exchange order endpoint,
accepts a suggestion, or enables funded trading.

The localhost server also hard-disables both Kalshi and Polymarket funded order
paths. Accepting a suggestion only records the decision locally.

## Safety checks

Every cycle first reads the local loopback-only `/api/kalshi/status` balance
snapshot. An actionable suggestion is rejected unless funded trading is off and
both the balance and market quote are no more than 60 seconds old.
The quote is not trusted from model output: the wrapper independently fetches
the exact ticker from Kalshi's public unauthenticated market endpoint, requires
the market to be open with a future close time, and overwrites the side ask and
observation timestamp before validation.

For a `BUY`, trusted local code—not the model—does all final sizing and writes
the final entry/exit instructions:

- risk cap = 10% of current available cash, rounded down to cents;
- maximum loss = contracts x limit price + locally calculated estimated fee;
- the contract count is reduced until maximum loss fits the cap;
- the acceptance window ends before either the quote or balance can become 60
  seconds old, even when the research thesis covers up to five minutes;
- official HTTPS Kalshi market/rules links and independent primary evidence are
  required;
- exact entry, take-profit, stop-loss, and time-based exit instructions are
  generated from the validated numbers, so model prose cannot raise the price,
  contract count, or loss cap.

`SELL` is disabled because the runner does not read authenticated positions.
Any missing, stale, malformed, unauthenticated, or otherwise uncertain input is
atomically replaced with a short `WAIT` through the existing local publisher.

The final 90 seconds are reserved for publishing a fail-closed `WAIT` and clean
shutdown, so a late Codex child cannot run past the configured 12-hour end.

## Start, inspect, and stop

The loop is intentionally not started automatically. From the repository:

```powershell
npm run advisory:12h
```

Keep that terminal open. Each start creates a unique directory under
`runtime/codex-advisory/`. Its `status.json`, `runner.lock`, `STOP`, cycle log,
Codex JSONL events, stderr, and publisher logs stay together. Runtime files are
Git-ignored.

From another terminal, inspect or stop the latest run:

```powershell
npm run advisory:status
npm run advisory:stop
```

To target an older/specific run, invoke the script directly:

```powershell
node scripts/codex_advisory_loop.mjs status --run-dir runtime/codex-advisory/run-...
node scripts/codex_advisory_loop.mjs stop --run-dir runtime/codex-advisory/run-...
```

Stopping or completing the run publishes a final short `WAIT`, so a prior live
idea is not left actionable. Accepting anything shown on localhost remains a
local acknowledgement only and still does not place a trade.
