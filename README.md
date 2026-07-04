# Kalshi BTC Up/Down Dashboard

Dashboard and virtual simulator for **Kalshi-style BTC 15-minute Up/Down** markets.

The active app is simulation-first and uses virtual money by default. Legacy Polymarket/OpenClaw scripts remain in the repo but are not the recommended path for US users.

## Strategy (Momentum into Close)
This skill is aligned with a short-horizon momentum strategy:

1. Trade BTC 15-minute Up/Down event markets near expiry.
2. Main entry window: around **2 minutes left**.
3. Confirm that BTC has already moved by about **$70-$100** in the active interval.
4. Check market skew (crowd positioning). If flow supports the move direction, enter **with** momentum.
5. Typical sizing: around **50% of trading allocation** (user-defined risk tolerance).
6. Optional micro-hedge when skew is extreme (for example, 95/5): place a small opposite position ($1-$2 equivalent) to reduce tail risk.

This is a momentum-following approach, not a reversal strategy.

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
- Kalshi credentials only when a future live worker is connected

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

- Simulation: replay historical BTC 15-minute windows with virtual money.
- Simulation can still run 5-minute windows for comparison.
- Trading: monitor worker status and save fail-safe limits for live/paper mode.

The Trading page currently stores backend fail-safe settings and shows the worker
as inactive until a live trading worker is connected. The kill switch defaults to
on. Supported fail-safes include max daily loss, max total loss, max stake per
trade, and max trades per day.

Run the same simulation directly in the terminal:

```bash
python scripts/simulate_btc_5m_virtual.py --days 7 --interval-minutes 15 --profile conservative
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

Set this Render environment variable after the Vercel site exists:

```text
FRONTEND_ORIGIN=https://your-vercel-app.vercel.app
```

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

Redeploy Vercel after setting `SIM_API_BASE_URL`.

### 4. Confirm the connection
Open the Vercel URL, run a short simulation, and confirm the result panel updates.
If it fails, check:

- Render `/health` returns `{ "ok": true }`
- Vercel `SIM_API_BASE_URL` exactly matches the Render service URL
- Render `FRONTEND_ORIGIN` exactly matches the Vercel site origin

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
