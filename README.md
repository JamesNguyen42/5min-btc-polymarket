# BTC AI Trading Desk

An AI-assisted paper and live trading dashboard for **Kalshi BTC 15-minute** and
**Polymarket BTC 5-minute** Up/Down markets.

The execution pipeline combines the existing short-horizon momentum strategies
with two independent reviewers: Meta Llama 3.3 and NVIDIA Nemotron, served
through the configured OpenAI-compatible endpoint:

- `meta/llama-3.3-70b-instruct` analyzes the proposed trade.
- `nvidia/llama-3.3-nemotron-super-49b-v1.5` performs an independent review.
- Recent Bitcoin RSS/Atom headlines are supplied as untrusted, read-only context.
- Each workspace can use Llama 3.3, Nemotron, or both. A trade proceeds only
  when every selected reviewer clears the confidence floor and estimates at
  least a 3% edge over the quoted price. Any missing selected model or web
  response blocks the trade.

The app is simulation-first. The **Paper trading** page uses fake bankrolls and
virtual fills; the **Live trading** page can post real orders only after explicit
activation. Live sizing can spend only available venue cash and remains bounded
by the stake, daily-loss, total-loss, and trade-count limits.

> NVIDIA Developer Program hosted endpoints are free for prototyping. They can be
> rate limited and are not a guaranteed free 24/7 production service. For reliable
> unattended deployment, use a production endpoint or self-hosted NIM covered by
> the appropriate NVIDIA terms.

## Llama and Nemotron setup

Create an API key at NVIDIA's API catalog, then add it to `.env`:

```text
LLAMA_API_KEY=nvapi-...
NVIDIA_NIM_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_LLAMA_MODEL=meta/llama-3.3-70b-instruct
NVIDIA_NEMOTRON_MODEL=nvidia/llama-3.3-nemotron-super-49b-v1.5
```

Without `LLAMA_API_KEY`, the dashboard and historical replay still load, but
paper/live workers fail closed at the AI gate and do not enter positions.

## Strategy (Momentum into Close)
This skill is aligned with a short-horizon momentum strategy:

1. Trade BTC 15-minute Up/Down event markets near expiry.
2. Main entry window: around **2 minutes left**.
3. Confirm that BTC has already moved by about **$70-$100** in the active interval.
4. Check market skew (crowd positioning). If flow supports the move direction, enter **with** momentum.
5. Typical sizing: around **50% of trading allocation** (user-defined risk tolerance).
6. Optional micro-hedge when skew is extreme (for example, 95/5): place a small opposite position ($1-$2 equivalent) to reduce tail risk.

This is a momentum-following approach, not a reversal strategy.

## V3 Strategy and Comparison
This branch adds an explicit V3 simulator strategy and keeps V1/V2 intact for
side-by-side comparison.

- **V1 baseline**: fixed entry timing, fixed BTC move threshold, fixed stake,
  and fixed virtual contract entry price.
- **V2 adaptive momentum**: dynamic BTC move threshold, pullback/reversal
  checks, larger daily opportunity budget, and confidence-based sizing capped by
  equity risk and a max stake multiplier.
- **V3 regime-aware momentum**: volatility-adjusted trigger, trend quality and
  close-location checks, broader opportunity budget, and stronger confidence
  sizing with tighter reversal rejection.

Run all three strategies on the same BTC candles:

```bash
npm run sim:compare
```

Or call the simulator directly:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative --compare
```

Run the current-market V1/V2/V3 signal from the terminal:

```bash
npm run sim:live
```

Live direct call:

```bash
python scripts/simulate_btc_5m_virtual.py --live --compare --interval-minutes 15 --profile conservative
```

The historical replay can **Compare V1/V2/V3** and shows V3 as the primary
result. The comparison is still a virtual
backtest: it does not replay historical Kalshi order books, spreads, fees,
liquidity, fill probability, or exact CF Benchmarks settlement values.

For current-market data, switch the dashboard **Data mode** to **Live snapshot**.
Live mode uses the latest completed Coinbase BTC-USD 1-minute candle inside the
active interval and, for 15-minute markets, enriches the signal with the current
open Kalshi `KXBTC15M` YES/NO ask prices when the public market API is
available. It reports the current V1/V2/V3 action, side, BTC move, seconds left,
and live ask price, but it does not show PnL because the market has not settled.

The dashboard separates execution environments with the same minimal controls:

- **Paper** selects a model, bankroll, and present or historical start date.
  Historical ranges advance one day at a time, updating the chart after each
  day while both configured market routes replay concurrently.
- **Live** uses the same controls. A present-time run asks for confirmation and
  then uses configured funded accounts, displays the current Kalshi available
  cash balance, and treats past dates as read-only fast replays.
- Both dark-mode pages put controls and won/lost totals on the left, with a
  chart on the right showing time horizontally and money vertically.

Kalshi live trading uses the selected Trading model, the current Kalshi market
snapshot, and V2 IOC orders capped by `KALSHI_LIVE_MAX_PRICE_SLIPPAGE`.
It skips asks at or above `KALSHI_LIVE_MAX_TAKE_PRICE` and retries later in the
same market instead of burning the market on a liquidity miss. Fill-or-kill is
only used when `KALSHI_LIVE_TIME_IN_FORCE=fill_or_kill` and
`KALSHI_LIVE_ALLOW_FILL_OR_KILL=1` are both set. Kalshi market data and orders
use the configured `KALSHI_ENV`; set `KALSHI_ENV=prod` when you want the worker
pointed at production Kalshi.
The Trading page also has timing controls: Kalshi defaults to trying between
120 and 60 seconds left, while Polymarket defaults to trying between 30 and 10
seconds left. These can be changed without redeploying by saving the venue's
Trading settings.

Polymarket compare defaults to **paper mode**, **V1 primary**, and V1-only
comparison. It finds the current `btc-updown-5m-<unix bucket>` market through
Gamma, reads side-specific UP/DOWN prices from the CLOB order book, and records
paper entries/settlements against live Polymarket data. If you later click
**Arm Polymarket live** on Trading, only the selected primary model may post real
Polymarket orders; enabled secondary models remain virtual comparison accounts.
Polymarket account balance reads and live mode require `POLYMARKET_PRIVATE_KEY`
and the official `@polymarket/clob-client-v2` SDK.
For the usual new API deposit-wallet flow, set `POLYMARKET_SIGNATURE_TYPE=3`
and `POLYMARKET_FUNDER_ADDRESS` to your Polymarket deposit wallet. Use
signature type `0` only if you intentionally trade from a standalone EOA wallet.
The app also accepts `PM_PRIVATE_KEY`, `PM_API`, `PM_API_SECRET_KEY`,
`PM_API_PASSPHRASE`, `PM_FUNDER_ADDRESS`, and `PM_SIGNATURE_TYPE` as aliases
for hosts that already use those names. `PM_API` plus `PM_API_SECRET_KEY` alone
is not enough for authenticated balance reads or live orders; the CLOB SDK also
needs the signer private key and API passphrase.
The dashboard shows the CLOB spendable collateral balance first, then falls back
to the on-chain pUSD balance for the configured funder wallet. A large allowance
does not mean spendable cash; it is only token approval.

Worker status, paper balances, open virtual positions, and recent trade history
are persisted to `runtime/trading_state.json` by default. On Render, the
Blueprint mounts a persistent disk and writes this file to
`/var/data/trading_state.json`, so a deploy restart can reload the previous
state and resume any worker that was active before the restart.

## Repository Structure
- `SKILL.md` — skill definition and operating rules
- `config/` — profiles and risk parameters
- `scripts/` — runners/wrappers/hot commands
- `examples/` — practical command examples

## Deploy / Run
### Prerequisites
- Node.js
- Python 3
- Network access for Coinbase BTC-USD candle data
- Kalshi credentials if you want authenticated balance lookup for paper mode

### Quick Start
```bash
git clone https://github.com/JamesNguyen42/5min-btc-polymarket.git
cd 5min-btc-polymarket
npm run dev
```

Open `http://127.0.0.1:3000`.

## Fast Virtual-Money Simulation
To replay the last week as if each historical Kalshi BTC 15-minute market were happening "now",
use the virtual simulator. It fetches real BTC-USD 1-minute candles, steps forward
chronologically with no sleeps, places virtual trades only from data visible at the
simulated entry time, and settles each market from the real later close.

Start the browser UI:

```bash
npm run dev
```

Then open:

```text
http://localhost:3000
```

The UI lets you set the simulation time range, starting money, stake size, and
signal parameters. It reports ending money, PnL, win rate, trade count, and
percentage gain/loss.

Dashboard pages:

- Paper: model, bankroll, start date, Run/Stop, totals, and performance chart.
- Live: the same interface for funded trading or read-only historical replay.

The Trading page stores backend fail-safe settings, paper balances, open virtual
positions, and recent worker trades. The kill switch defaults to on. Supported
fail-safes include max daily loss, max total loss, max stake per trade, and max
trades per day.

Paper worker behavior:

- Uses live Kalshi `KXBTC15M` market data.
- Places simulated entries only; it never posts real orders.
- Requires mode `Paper` and kill switch off before it starts.
- Stops automatically if any fail-safe is hit.
- Uses the authenticated Kalshi balance as the starting paper equity when
  available.
- Uses the paper bankroll configured in the UI. The local default is `$100` and
  is intentionally independent from the funded Kalshi balance.
- Restarts automatically after a server restart if it was active, mode is still
  `Paper`, and the kill switch is still off.

## Kalshi API Keys
Kalshi authenticated requests use:

- `KALSHI_API_KEY_ID` - your API key ID
- `KALSHI_PRIVATE_KEY` - the RSA private key PEM
- `KALSHI_ENV` - `demo` or `prod`

For local development:

```bash
copy .env.example .env
```

Then edit `.env`. Keep `KALSHI_ENV=demo` until you intentionally switch to
production. For the private key, either paste it with escaped newlines:

```text
KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

or point to a local key file:

```text
KALSHI_PRIVATE_KEY_PATH=./secrets/kalshi.key
```

Do not commit `.env` or private key files. The frontend never receives these
values.

After starting the backend, test credential signing with:

```text
http://127.0.0.1:3000/api/kalshi/status
```

On Render, set these as environment variables on the backend service:

```text
KALSHI_ENV=prod
KALSHI_API_KEY_ID=<your key id>
KALSHI_PRIVATE_KEY=<your private key PEM>
TRADING_STATE_FILE=/var/data/trading_state.json
```

The Render Blueprint defaults to `KALSHI_ENV=prod` because the live market
worker needs production `KXBTC15M` markets. The workers in this app still use
paper fills only and do not post real orders.

Run the same simulation directly in the terminal:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative
```

Run the V2 strategy only:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative --strategy v2
```

Run the V3 strategy only:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative --strategy v3
```

Save a report and full trade ledger:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative --out runtime/kalshi_btc15m_virtual_backtest.json --csv runtime/kalshi_btc15m_virtual_backtest.csv
```

Useful knobs:
- `--starting-cash 100` sets virtual bankroll.
- `--stake-usd 5` sets virtual stake per trade.
- `--min-btc-move-usd 70` requires a BTC move by the simulated entry time.
- `--entry-seconds-left 120` makes the strategy decide with about 2 minutes left.
- `--interval-minutes 15` simulates Kalshi-style BTC 15-minute Up/Down markets.
- `--threshold-price 0.70` sets the assumed virtual contract entry price.

Important limitation: this is a BTC-driven Kalshi-style binary simulation, not
a full historical Kalshi order-book replay. It uses real BTC candles and real
future settlement within each historical interval, but it does not reconstruct
historical Kalshi order-book liquidity, spreads, fees, or fill probability.

For Kalshi 15-minute BTC markets, settlement is only approximate here: Kalshi
uses CF Benchmarks RTI averaged during the final minute, while this simulator
uses Coinbase 1-minute BTC-USD candles.

## Deploy: Render Backend + Vercel Frontend
This repo is configured for a split deployment:

- Render runs the Node API and Python simulator from `Dockerfile`.
- Vercel serves the static dashboard from `public/`.

### 1. Push the repo
Commit and push these files to GitHub before creating services:

```bash
git add .
git commit -m "Add simulator dashboard deployment config"
git push origin main
```

### 2. Deploy the backend on Render
Use Render Blueprint deployment with `render.yaml`, or create a Web Service from
the repo manually.

Blueprint link format:

```text
https://dashboard.render.com/blueprint/new?repo=https://github.com/<user>/<repo>
```

Render should use:

- Runtime: Docker
- Health check path: `/health`
- Service type: Web Service
- Plan: paid/always-on recommended for backend availability
- Persistent disk: `/var/data` for saved worker state and trade history

Render persistent disks keep runtime files across deploys, but they also make
the service single-instance and disable zero-downtime deploys.

Set this Render environment variable after the Vercel site exists:

```text
FRONTEND_ORIGIN=https://your-vercel-app.vercel.app
```

`FRONTEND_ORIGIN` can contain comma-separated exact origins if you also want a
specific Vercel preview deployment to access the API. Avoid allowing arbitrary
`vercel.app` sites because this API can control live trading.

The Blueprint also prompts for the model, Kalshi, and Polymarket secrets needed
by the live workers. For an existing Render service, add newly introduced
`sync: false` variables manually in the Render dashboard; Blueprint updates do
not populate new secret values automatically.

Keep the Render service URL. It will look like:

```text
https://kalshi-btc-updown-api.onrender.com
```

### 3. Deploy the frontend on Vercel
Import the same GitHub repo into Vercel.

Recommended settings:

- Framework Preset: Other
- Root Directory: `./`
- Build Command: `npm run build`
- Output Directory: `public`

Set this Vercel environment variable:

```text
SIM_API_BASE_URL=https://your-render-service.onrender.com
```

Set it for every Vercel environment you deploy (Production and, if used,
Preview), then redeploy. Vercel builds intentionally fail when this variable is
missing. Use the HTTPS origin only, without an `/api` path, so the frontend
cannot deploy with a broken or mixed-content API URL.

### 4. Confirm the connection
Open the Vercel URL, run a short simulation, and confirm the result panel updates.
If it fails, check:

- Render `/health` returns `{ "ok": true }`
- Vercel `SIM_API_BASE_URL` exactly matches the Render service URL
- Render `FRONTEND_ORIGIN` includes the exact Vercel site origin
- The Live page shows the authenticated Kalshi available-cash balance

Unified skill control (recommended):
```bash
scripts/btc5m_ctl.sh start --profile conservative
scripts/btc5m_ctl.sh status
scripts/btc5m_ctl.sh report --limit 20
scripts/btc5m_ctl.sh stop
```

Runtime isolation:
- skill runtime dir: `./runtime`
- auth/env source (default): `<your-workspace>/pm-hl-conservative-plus-repo/.env`
- overrides: `BTC5M_REPO`, `BTC5M_ENV_FILE`, `BTC5M_RUNNER`
- completion auto-report cron (topic 184): `btc5m-completion-autoreport-topic184`

Optional Docker isolation:
```bash
scripts/btc5m_docker.sh up
scripts/btc5m_docker.sh status
scripts/btc5m_docker.sh down
```

## Execution Checklist (Before Live Trade)
Use this quick pre-flight checklist before any real order:

1. **Market validity**
   - Confirm the BTC 5m market is active and not about to close unexpectedly.
2. **Time-to-close window**
   - Prefer entries around ~120 seconds left (with reasonable tolerance).
3. **Impulse confirmation**
   - Confirm the observed BTC move is meaningful (strategy reference: ~$70-$100).
4. **Skew confirmation**
   - Verify market skew supports the intended direction (do not fade strong momentum by default).
5. **Liquidity/spread checks**
   - Ensure spread and top-of-book notional pass your minimum thresholds.
6. **Sizing guardrails**
   - Validate stake, max notional, and daily loss limits before execution.
7. **Stop / exit controls**
   - Confirm stop-loss and `exit_before_sec` are configured.
8. **Execution mode**
   - Start in dry-run when changing parameters; switch to `--execute` only after validation.

## Risk Controls Template
Suggested baseline controls (adapt to your risk profile):

- **Per-trade risk cap**: 1%-15% of account equity (profile dependent)
- **Daily max loss**: hard stop at 10%-15%
- **Max trades/day**: fixed ceiling to avoid overtrading
- **Max notional/trade**: strict upper bound
- **Quote staleness guard**: skip if market data is stale
- **Spread guard**: skip when spread exceeds threshold
- **Liquidity guard**: skip when top ask/bid notional is too thin
- **Extreme skew hedge**: optional small opposite hedge in 95/5-type scenarios
- **Operational kill switch**: immediate stop on repeated API/DNS/execution failures

## Risk Notice
This repository is educational/operational infrastructure, not financial advice.
Use your own risk limits, daily loss caps, and capital controls.

## Contributing
- Fork the repository
- Create a feature branch
- Commit changes
- Open a PR to `main`

PRs are welcome.
