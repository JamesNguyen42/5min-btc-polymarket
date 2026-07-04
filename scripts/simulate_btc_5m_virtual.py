#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

UTC = dt.timezone.utc


PROFILES: dict[str, dict[str, Any]] = {
    "conservative": {
        "threshold_price": 0.70,
        "stake_usd": 5.0,
        "min_btc_move_usd": 70.0,
        "entry_seconds_left": 120,
        "max_trades": 12,
    },
    "aggressive": {
        "threshold_price": 0.70,
        "stake_usd": 5.0,
        "min_btc_move_usd": 70.0,
        "entry_seconds_left": 120,
        "max_trades": 20,
    },
}


def utc_now() -> dt.datetime:
    return dt.datetime.now(UTC)


def parse_utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def floor_interval(ts: int, interval_sec: int) -> int:
    return ts - (ts % interval_sec)


def ceil_interval(ts: int, interval_sec: int) -> int:
    floored = floor_interval(ts, interval_sec)
    return floored if floored == ts else floored + interval_sec


def iso(ts: int | float) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).isoformat().replace("+00:00", "Z")


def default_runtime_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "runtime"


def fetch_coinbase_1m(start: dt.datetime, end: dt.datetime) -> list[dict[str, float]]:
    """Fetch real BTC-USD 1-minute candles from Coinbase Exchange.

    Coinbase returns at most 300 candles per request, newest-first, with rows:
    [time, low, high, open, close, volume].
    """
    out: dict[int, dict[str, float]] = {}
    cursor = start

    while cursor < end:
        chunk_end = min(cursor + dt.timedelta(minutes=300), end)
        params = {
            "start": cursor.isoformat().replace("+00:00", "Z"),
            "end": chunk_end.isoformat().replace("+00:00", "Z"),
            "granularity": 60,
        }
        url = (
            "https://api.exchange.coinbase.com/products/BTC-USD/candles?"
            + urllib.parse.urlencode(params)
        )
        req = urllib.request.Request(url, headers={"User-Agent": "btc-updown-virtual-simulator/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
        if not isinstance(rows, list):
            raise RuntimeError(f"unexpected Coinbase response: {rows!r}")
        for row in rows:
            if not isinstance(row, list) or len(row) < 6:
                continue
            ts, low, high, open_, close, volume = row[:6]
            out[int(ts)] = {
                "ts": float(ts),
                "open": float(open_),
                "high": float(high),
                "low": float(low),
                "close": float(close),
                "volume": float(volume),
            }
        cursor = chunk_end
        time.sleep(0.04)

    return [out[k] for k in sorted(out)]


def candles_by_ts(candles: list[dict[str, float]]) -> dict[int, dict[str, float]]:
    return {int(c["ts"]): c for c in candles}


def day_key(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).date().isoformat()


def simulate(args: argparse.Namespace) -> dict[str, Any]:
    profile = PROFILES[args.profile]
    interval_minutes = int(args.interval_minutes)
    interval_sec = interval_minutes * 60
    threshold_price = args.threshold_price if args.threshold_price is not None else profile["threshold_price"]
    stake_usd = args.stake_usd if args.stake_usd is not None else profile["stake_usd"]
    min_btc_move_usd = args.min_btc_move_usd if args.min_btc_move_usd is not None else profile["min_btc_move_usd"]
    entry_seconds_left = args.entry_seconds_left if args.entry_seconds_left is not None else profile["entry_seconds_left"]
    max_trades = args.max_trades if args.max_trades is not None else profile["max_trades"]

    if args.end:
        end = parse_utc(args.end)
    else:
        end = utc_now()
    if args.start:
        start = parse_utc(args.start)
    else:
        start = end - dt.timedelta(days=args.days)

    if entry_seconds_left >= interval_sec:
        raise ValueError("--entry-seconds-left must be less than the simulated market interval")

    # Align to completed markets. The final bucket is excluded unless complete.
    sim_start_ts = ceil_interval(int(start.timestamp()), interval_sec)
    sim_end_ts = floor_interval(int(end.timestamp()), interval_sec)
    fetch_start = dt.datetime.fromtimestamp(sim_start_ts - interval_sec, UTC)
    fetch_end = dt.datetime.fromtimestamp(sim_end_ts + 60, UTC)

    data_started = time.perf_counter()
    candles = fetch_coinbase_1m(fetch_start, fetch_end)
    data_elapsed = time.perf_counter() - data_started
    by_ts = candles_by_ts(candles)

    cash = float(args.starting_cash)
    trades: list[dict[str, Any]] = []
    skipped: dict[str, int] = {}
    trades_by_day: dict[str, int] = {}
    equity_curve: list[dict[str, Any]] = []

    replay_started = time.perf_counter()
    for bucket_start in range(sim_start_ts, sim_end_ts, interval_sec):
        bucket_end = bucket_start + interval_sec
        entry_ts = bucket_end - int(entry_seconds_left)
        key = day_key(bucket_start)

        if trades_by_day.get(key, 0) >= max_trades:
            skipped["daily_trade_cap"] = skipped.get("daily_trade_cap", 0) + 1
            continue
        if cash < stake_usd:
            skipped["insufficient_virtual_cash"] = skipped.get("insufficient_virtual_cash", 0) + 1
            continue

        open_candle = by_ts.get(bucket_start)
        entry_candle = by_ts.get(entry_ts)
        settle_candle = by_ts.get(bucket_end - 60)
        if not open_candle or not entry_candle or not settle_candle:
            skipped["missing_candle"] = skipped.get("missing_candle", 0) + 1
            continue

        interval_open = float(open_candle["open"])
        entry_btc = float(entry_candle["close"])
        settle_btc = float(settle_candle["close"])
        move_at_entry = entry_btc - interval_open

        if abs(move_at_entry) < min_btc_move_usd:
            skipped["btc_move_below_threshold"] = skipped.get("btc_move_below_threshold", 0) + 1
            continue

        side = "UP" if move_at_entry > 0 else "DOWN"
        winning_side = "UP" if settle_btc > interval_open else "DOWN"
        if math.isclose(settle_btc, interval_open):
            winning_side = "PUSH"

        cost = min(stake_usd, cash)
        shares = cost / threshold_price
        payout = shares if side == winning_side else 0.0
        pnl = payout - cost
        cash += pnl
        trades_by_day[key] = trades_by_day.get(key, 0) + 1

        trade = {
            "sim_now_entry": iso(entry_ts),
            "market_slug": f"btc-updown-{interval_minutes}m-{bucket_start}",
            "market_interval_minutes": interval_minutes,
            "market_start": iso(bucket_start),
            "market_end": iso(bucket_end),
            "interval_open_btc": round(interval_open, 2),
            "entry_btc": round(entry_btc, 2),
            "settle_btc": round(settle_btc, 2),
            "move_at_entry_usd": round(move_at_entry, 2),
            "side": side,
            "winning_side": winning_side,
            "virtual_entry_price": round(threshold_price, 4),
            "stake_usd": round(cost, 6),
            "shares": round(shares, 6),
            "payout_usd": round(payout, 6),
            "pnl_usd": round(pnl, 6),
            "cash_after": round(cash, 6),
        }
        trades.append(trade)
        equity_curve.append({"ts": trade["market_end"], "cash": round(cash, 6)})

    replay_elapsed = time.perf_counter() - replay_started
    wins = sum(1 for t in trades if t["pnl_usd"] > 0)
    losses = sum(1 for t in trades if t["pnl_usd"] < 0)
    total_pnl = cash - float(args.starting_cash)
    gross_profit = sum(float(t["pnl_usd"]) for t in trades if t["pnl_usd"] > 0)
    gross_loss = abs(sum(float(t["pnl_usd"]) for t in trades if t["pnl_usd"] < 0))

    report = {
        "mode": "virtual_backtest",
        "data_source": "Coinbase Exchange BTC-USD 1m candles",
        "lookahead_note": "Entry decisions use only the interval open and the candle at simulated entry time; settlement uses the real later close.",
        "market_model_note": f"This approximates BTC {interval_minutes}-minute Up/Down binaries with a fixed virtual entry price. It does not replay historical exchange order-book liquidity.",
        "kalshi_note": "Kalshi BTC 15-minute markets settle from CF Benchmarks RTI averaged during the last minute. This simulator uses Coinbase 1-minute candles, so Kalshi settlement is approximate.",
        "simulated_present_started_at": iso(sim_start_ts),
        "simulated_present_finished_at": iso(sim_end_ts),
        "wall_clock_seconds": round(data_elapsed + replay_elapsed, 3),
        "data_fetch_seconds": round(data_elapsed, 3),
        "replay_seconds": round(replay_elapsed, 3),
        "params": {
            "profile": args.profile,
            "interval_minutes": interval_minutes,
            "starting_cash": args.starting_cash,
            "stake_usd": stake_usd,
            "threshold_price": threshold_price,
            "min_btc_move_usd": min_btc_move_usd,
            "entry_seconds_left": entry_seconds_left,
            "max_trades_per_utc_day": max_trades,
            "days": args.days,
        },
        "summary": {
            "markets_replayed": max(0, (sim_end_ts - sim_start_ts) // interval_sec),
            "trades": len(trades),
            "wins": wins,
            "losses": losses,
            "pushes_or_flat": len(trades) - wins - losses,
            "win_rate": round(wins / len(trades), 4) if trades else None,
            "starting_cash": round(float(args.starting_cash), 6),
            "ending_cash": round(cash, 6),
            "total_pnl_usd": round(total_pnl, 6),
            "return_pct": round(total_pnl / float(args.starting_cash) * 100.0, 4) if args.starting_cash else None,
            "gross_profit_usd": round(gross_profit, 6),
            "gross_loss_usd": round(gross_loss, 6),
            "profit_factor": round(gross_profit / gross_loss, 4) if gross_loss else None,
        },
        "skipped": skipped,
        "trades_by_utc_day": trades_by_day,
        "_all_trades": trades,
        "trades": trades if args.include_trades else trades[: args.preview_trades],
    }
    return report


def write_csv(path: Path, trades: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not trades:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(trades[0].keys()))
        writer.writeheader()
        writer.writerows(trades)


def main() -> int:
    ap = argparse.ArgumentParser(description="Fast virtual-money replay for BTC Up/Down strategy.")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="conservative")
    ap.add_argument("--interval-minutes", type=int, choices=[5, 15], default=15, help="Simulated BTC Up/Down market interval.")
    ap.add_argument("--days", type=float, default=7.0, help="Lookback length when --start is omitted.")
    ap.add_argument("--start", help="UTC start timestamp, for example 2026-06-27T00:00:00Z.")
    ap.add_argument("--end", help="UTC end timestamp. Defaults to current wall-clock time.")
    ap.add_argument("--starting-cash", type=float, default=100.0)
    ap.add_argument("--stake-usd", type=float)
    ap.add_argument("--threshold-price", type=float, help="Virtual exchange entry price paid per share.")
    ap.add_argument("--min-btc-move-usd", type=float, help="Required BTC move by simulated entry time.")
    ap.add_argument("--entry-seconds-left", type=int, help="Simulated entry point before each market close.")
    ap.add_argument("--max-trades", type=int, help="Max virtual trades per UTC day.")
    ap.add_argument("--preview-trades", type=int, default=25)
    ap.add_argument("--include-trades", action="store_true", help="Print all trades in the JSON report.")
    ap.add_argument("--out", help="Write JSON report to this path.")
    ap.add_argument("--csv", help="Write all simulated trades to this CSV path.")
    args = ap.parse_args()

    report = simulate(args)

    if args.csv:
        write_csv(Path(args.csv), list(report.get("_all_trades") or []))

    report.pop("_all_trades", None)

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
