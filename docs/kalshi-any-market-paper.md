# Kalshi Any-Market Paper Runner

This runner continuously scans current Kalshi markets and simulates trades with
local virtual cash. It cannot submit orders, does not import Kalshi credentials,
and does not touch the funded account balance.

The catalog scanner paginates non-multivariate markets closing within 24 hours,
then filters for two-sided quotes, volume, spread, and time remaining. Candidate
research uses market-specific Google News RSS results and the configured NVIDIA
model. News and market text are treated as untrusted evidence. Research fails
closed when sources are sparse, stale, contradictory, or the model is missing.

An entry requires both a confidence floor and positive expected value after the
published general Kalshi taker-fee model. Paper fills cross the displayed ask,
use whole contracts, include estimated fees, and limit correlated exposure to
one position per event.

## Commands

```powershell
npm test
npm run paper:any:once
npm run paper:any:12h
npm run paper:any:12h:bg
npm run paper:any:status
npm run paper:any:stop
```

## CLI suggestion workflow

The Live page is advisory-only and has no Generate button. A Codex CLI session
can publish a short-lived local BUY, SELL, or WAIT suggestion containing the
exact ticker, side, limit price, whole-contract count, estimated fee, maximum
loss, entry condition, exit condition, expiry, rationale, and research sources.
The page polls that local record and displays whether it is WAIT, scheduled,
live, expired, or accepted.

**Accept suggestion** records the exact suggestion locally. It does not open
Kalshi, authenticate to Kalshi, send an exchange request, prefill an order
ticket, or submit, buy, sell, open, or close anything. See
`docs/cli-trade-suggestions.md` for the Codex prompt and publisher schema.

Proposal snapshots and their local audit events are stored under:

```text
runtime/trade-proposals/current-proposal.json
runtime/trade-proposals/proposal-events.jsonl
```

The background command starts the same runner in a hidden Windows process and
records its PID plus redirected logs in the runtime directory. It inherits only
research settings already present in the launching environment; the runner does
not read the repository `.env` and scrubs inherited `KALSHI_*` credential
variables before starting research.

The 12-hour command starts with an $8 virtual bankroll. Defaults cap a paper
entry at 10% of the virtual bankroll (at most $0.80), session loss at 20% (at
most $1.60), open positions at two, and total trades at twelve. The process
automatically stops at its persisted deadline.

Runtime files are ignored by Git and stored under:

```text
runtime/kalshi-any-market-paper/state.json
runtime/kalshi-any-market-paper/decisions.jsonl
runtime/kalshi-any-market-paper/stdout.log
runtime/kalshi-any-market-paper/stderr.log
```

`state.json` records the deadline, cash, fee model, open positions, settlements,
and last catalog scan. `decisions.jsonl` is an append-only audit trail. A lock
prevents two copies from using the same virtual portfolio.

## Safety boundary

The web server is an advisory-only build. Funded order submission and funded
worker auto-resume are hard-disabled in code, so environment variables cannot
arm them. The authenticated Kalshi integration is limited to read-only account
data such as the available balance; the user executes any decision manually
outside this app.
