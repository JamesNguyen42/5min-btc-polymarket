#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import json
import math
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

UTC = dt.timezone.utc
COINBASE_FETCH_RETRIES = 3

STRATEGY_V1 = "v1"
STRATEGY_V2 = "v2"
STRATEGY_V3 = "v3"
STRATEGIES = (STRATEGY_V1, STRATEGY_V2, STRATEGY_V3)

STRATEGY_NOTES = {
    STRATEGY_V1: (
        "V1 baseline: fixed entry timing, fixed move threshold, fixed stake, "
        "and fixed virtual entry price."
    ),
    STRATEGY_V2: (
        "V2 adaptive momentum: dynamic move filter, pullback and continuation "
        "checks, larger daily opportunity budget, and confidence sizing capped "
        "by equity risk and max stake multiplier."
    ),
    STRATEGY_V3: (
        "V3 regime-aware momentum: volatility-adjusted trigger, trend quality "
        "and close-location checks, broader opportunity budget, and stronger "
        "confidence sizing with tighter reversal rejection."
    ),
}

STRATEGY_LABELS = {
    STRATEGY_V1: "V1 Baseline Momentum",
    STRATEGY_V2: "V2 Adaptive Momentum",
    STRATEGY_V3: "V3 Regime-Aware Momentum",
}

PROFILES: dict[str, dict[str, Any]] = {
    "conservative": {
        "threshold_price": 0.70,
        "stake_usd": 5.0,
        "min_btc_move_usd": 70.0,
        "entry_seconds_left": 120,
        "max_trades": 12,
        "v2_max_trades_multiplier": 2.0,
        "v2_max_stake_multiplier": 3.0,
        "v2_equity_risk_pct": 0.12,
        "v3_max_trades_multiplier": 3.0,
        "v3_max_stake_multiplier": 4.0,
        "v3_equity_risk_pct": 0.16,
    },
    "aggressive": {
        "threshold_price": 0.70,
        "stake_usd": 5.0,
        "min_btc_move_usd": 70.0,
        "entry_seconds_left": 120,
        "max_trades": 20,
        "v2_max_trades_multiplier": 2.25,
        "v2_max_stake_multiplier": 4.0,
        "v2_equity_risk_pct": 0.18,
        "v3_max_trades_multiplier": 3.2,
        "v3_max_stake_multiplier": 5.0,
        "v3_equity_risk_pct": 0.24,
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


def fetch_json_with_retries(req: urllib.request.Request, timeout: int = 20) -> Any:
    last_error: Exception | None = None
    for attempt in range(1, COINBASE_FETCH_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, socket.gaierror, json.JSONDecodeError) as err:
            last_error = err
            if attempt < COINBASE_FETCH_RETRIES:
                time.sleep(0.35 * attempt)
                continue
    message = str(last_error) if last_error else "unknown network error"
    raise RuntimeError(
        "Could not fetch Coinbase BTC-USD candles. Check your internet/DNS connection and retry. "
        f"Last error: {message}"
    )


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
        req = urllib.request.Request(url, headers={"User-Agent": "btc-updown-virtual-simulator/2.0"})
        rows = fetch_json_with_retries(req)
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


def coinbase_cache_path() -> Path:
    return default_runtime_dir() / "coinbase_btc_usd_1m_cache.json"


def load_coinbase_cache() -> dict[int, dict[str, float]]:
    path = coinbase_cache_path()
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[int, dict[str, float]] = {}
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        try:
            ts = int(key)
            out[ts] = {
                "ts": float(value["ts"]),
                "open": float(value["open"]),
                "high": float(value["high"]),
                "low": float(value["low"]),
                "close": float(value["close"]),
                "volume": float(value.get("volume") or 0.0),
            }
        except (KeyError, TypeError, ValueError):
            continue
    return out


def save_coinbase_cache(candles: dict[int, dict[str, float]], keep_after_ts: int) -> None:
    path = coinbase_cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    pruned = {str(ts): candle for ts, candle in sorted(candles.items()) if ts >= keep_after_ts}
    tmp_path = path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(pruned, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(path)


def contiguous_minute_ranges(timestamps: list[int]) -> list[tuple[int, int]]:
    if not timestamps:
        return []
    ranges: list[tuple[int, int]] = []
    start = timestamps[0]
    previous = start
    for ts in timestamps[1:]:
        if ts == previous + 60:
            previous = ts
            continue
        ranges.append((start, previous + 60))
        start = ts
        previous = ts
    ranges.append((start, previous + 60))
    return ranges


def fetch_coinbase_1m_cached(start: dt.datetime, end: dt.datetime) -> list[dict[str, float]]:
    start_ts = floor_interval(int(start.timestamp()), 60)
    end_ts = floor_interval(int(end.timestamp()), 60)
    if end_ts <= start_ts:
        return []

    cached = load_coinbase_cache()
    needed = list(range(start_ts, end_ts, 60))
    missing = [ts for ts in needed if ts not in cached]
    for missing_start, missing_end in contiguous_minute_ranges(missing):
        fetched = fetch_coinbase_1m(
            dt.datetime.fromtimestamp(missing_start, UTC),
            dt.datetime.fromtimestamp(missing_end, UTC),
        )
        for candle in fetched:
            cached[int(candle["ts"])] = candle

    if missing:
        save_coinbase_cache(cached, start_ts - 3 * 24 * 60 * 60)

    return [cached[ts] for ts in needed if ts in cached]


def candles_by_ts(candles: list[dict[str, float]]) -> dict[int, dict[str, float]]:
    return {int(c["ts"]): c for c in candles}


def day_key(ts: int) -> str:
    return dt.datetime.fromtimestamp(ts, UTC).date().isoformat()


def sign(value: float) -> int:
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def clamp(value: float, low: float, high: float) -> float:
    return min(high, max(low, value))


def closed_range(start_ts: int, end_ts: int, step: int = 60) -> range:
    return range(start_ts, end_ts + 1, step)


def build_market_snapshot(
    by_ts: dict[int, dict[str, float]],
    bucket_start: int,
    bucket_end: int,
    entry_ts: int,
    require_settlement: bool = True,
) -> dict[str, Any] | None:
    open_candle = by_ts.get(bucket_start)
    entry_candle = by_ts.get(entry_ts)
    settle_candle = by_ts.get(bucket_end - 60)
    if not open_candle or not entry_candle or (require_settlement and not settle_candle):
        return None

    visible = [by_ts[t] for t in closed_range(bucket_start, entry_ts) if t in by_ts]
    closes = [float(c["close"]) for c in visible]
    close_deltas = [abs(closes[i] - closes[i - 1]) for i in range(1, len(closes))]
    interval_open = float(open_candle["open"])
    entry_btc = float(entry_candle["close"])
    settle_btc = float(settle_candle["close"]) if settle_candle else None
    move_at_entry = entry_btc - interval_open
    direction = sign(move_at_entry)

    high_so_far = max((float(c["high"]) for c in visible), default=entry_btc)
    low_so_far = min((float(c["low"]) for c in visible), default=entry_btc)
    previous_close = closes[-2] if len(closes) >= 2 else interval_open
    lookback_close = closes[-4] if len(closes) >= 4 else closes[0] if closes else interval_open
    signed_close_moves = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    same_direction_moves = sum(1 for delta in signed_close_moves if sign(delta) == direction)
    trend_quality = same_direction_moves / len(signed_close_moves) if signed_close_moves else 0.0
    visible_range = max(0.0, high_so_far - low_so_far)
    close_location = (entry_btc - low_so_far) / visible_range if visible_range > 0 else 0.5

    return {
        "bucket_start": bucket_start,
        "bucket_end": bucket_end,
        "entry_ts": entry_ts,
        "interval_open": interval_open,
        "entry_btc": entry_btc,
        "settle_btc": settle_btc,
        "move_at_entry": move_at_entry,
        "direction": direction,
        "visible_candles": visible,
        "avg_abs_1m_move": mean(close_deltas),
        "recent_1m_move": entry_btc - previous_close,
        "recent_3m_move": entry_btc - lookback_close,
        "high_so_far": high_so_far,
        "low_so_far": low_so_far,
        "trend_quality": trend_quality,
        "close_location": close_location,
    }


def v1_decision(snapshot: dict[str, Any], min_btc_move_usd: float) -> dict[str, Any]:
    move = float(snapshot["move_at_entry"])
    move_abs = abs(move)
    if move_abs < min_btc_move_usd:
        return {"side": None, "skip_reason": "btc_move_below_threshold"}

    return {
        "side": "UP" if move > 0 else "DOWN",
        "skip_reason": None,
        "entry_reason": "fixed_move_threshold",
        "confidence": round(move_abs / max(min_btc_move_usd, 1.0), 4),
        "stake_multiplier": 1.0,
        "dynamic_min_btc_move_usd": min_btc_move_usd,
        "pullback_ratio": 0.0,
    }


def v2_decision(snapshot: dict[str, Any], min_btc_move_usd: float) -> dict[str, Any]:
    move = float(snapshot["move_at_entry"])
    direction = int(snapshot["direction"])
    move_abs = abs(move)
    if direction == 0:
        return {"side": None, "skip_reason": "v2_no_direction"}

    avg_abs_1m_move = float(snapshot["avg_abs_1m_move"])
    recent_1m_signed = float(snapshot["recent_1m_move"]) * direction
    recent_3m_signed = float(snapshot["recent_3m_move"]) * direction
    dynamic_min_move = max(min_btc_move_usd * 0.72, avg_abs_1m_move * 1.25, 20.0)

    if move_abs < dynamic_min_move:
        return {
            "side": None,
            "skip_reason": "v2_btc_move_below_dynamic_threshold",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
        }

    interval_open = float(snapshot["interval_open"])
    entry_btc = float(snapshot["entry_btc"])
    if direction > 0:
        favorable_excursion = max(0.0, float(snapshot["high_so_far"]) - interval_open)
        pullback = max(0.0, float(snapshot["high_so_far"]) - entry_btc)
    else:
        favorable_excursion = max(0.0, interval_open - float(snapshot["low_so_far"]))
        pullback = max(0.0, entry_btc - float(snapshot["low_so_far"]))
    pullback_ratio = pullback / favorable_excursion if favorable_excursion > 0 else 0.0

    if pullback_ratio > 0.58 and move_abs < min_btc_move_usd * 1.15:
        return {
            "side": None,
            "skip_reason": "v2_pullback_too_deep",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
        }
    if recent_3m_signed < -max(12.0, move_abs * 0.18):
        return {
            "side": None,
            "skip_reason": "v2_recent_reversal",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
        }
    if recent_1m_signed < -max(10.0, avg_abs_1m_move * 0.85) and move_abs < min_btc_move_usd * 1.35:
        return {
            "side": None,
            "skip_reason": "v2_last_minute_reversal",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
        }

    move_score = move_abs / max(dynamic_min_move, 1.0)
    continuation_score = max(0.0, recent_3m_signed) / max(dynamic_min_move, 1.0)
    pullback_score = max(0.0, 1.0 - pullback_ratio)
    confidence = clamp(0.65 + 0.62 * move_score + 0.28 * continuation_score + 0.22 * pullback_score, 1.0, 3.2)
    stake_multiplier = clamp(0.85 + (confidence - 1.0) * 0.95, 1.0, 3.0)

    return {
        "side": "UP" if direction > 0 else "DOWN",
        "skip_reason": None,
        "entry_reason": "adaptive_momentum_follow_through",
        "confidence": round(confidence, 4),
        "stake_multiplier": round(stake_multiplier, 4),
        "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
        "pullback_ratio": round(pullback_ratio, 4),
        "recent_1m_signed_usd": round(recent_1m_signed, 4),
        "recent_3m_signed_usd": round(recent_3m_signed, 4),
    }


def v3_decision(snapshot: dict[str, Any], min_btc_move_usd: float) -> dict[str, Any]:
    move = float(snapshot["move_at_entry"])
    direction = int(snapshot["direction"])
    move_abs = abs(move)
    if direction == 0:
        return {"side": None, "skip_reason": "v3_no_direction"}

    avg_abs_1m_move = float(snapshot["avg_abs_1m_move"])
    recent_1m_signed = float(snapshot["recent_1m_move"]) * direction
    recent_3m_signed = float(snapshot["recent_3m_move"]) * direction
    trend_quality = float(snapshot.get("trend_quality") or 0.0)
    close_location = float(snapshot.get("close_location") or 0.5)
    direction_close_location = close_location if direction > 0 else 1.0 - close_location
    dynamic_min_move = max(min_btc_move_usd * 0.62, avg_abs_1m_move * 1.08, 18.0)

    if move_abs < dynamic_min_move:
        return {
            "side": None,
            "skip_reason": "v3_btc_move_below_dynamic_threshold",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
        }

    interval_open = float(snapshot["interval_open"])
    entry_btc = float(snapshot["entry_btc"])
    if direction > 0:
        favorable_excursion = max(0.0, float(snapshot["high_so_far"]) - interval_open)
        pullback = max(0.0, float(snapshot["high_so_far"]) - entry_btc)
    else:
        favorable_excursion = max(0.0, interval_open - float(snapshot["low_so_far"]))
        pullback = max(0.0, entry_btc - float(snapshot["low_so_far"]))
    pullback_ratio = pullback / favorable_excursion if favorable_excursion > 0 else 0.0

    if trend_quality < 0.42 and move_abs < min_btc_move_usd * 1.25:
        return {
            "side": None,
            "skip_reason": "v3_low_trend_quality",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
            "trend_quality": round(trend_quality, 4),
        }
    if direction_close_location < 0.50 and move_abs < min_btc_move_usd * 1.45:
        return {
            "side": None,
            "skip_reason": "v3_poor_close_location",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
            "trend_quality": round(trend_quality, 4),
        }
    if pullback_ratio > 0.50 and move_abs < min_btc_move_usd * 1.45:
        return {
            "side": None,
            "skip_reason": "v3_pullback_too_deep",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
            "trend_quality": round(trend_quality, 4),
        }
    if recent_3m_signed < -max(14.0, move_abs * 0.15):
        return {
            "side": None,
            "skip_reason": "v3_recent_reversal",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
            "trend_quality": round(trend_quality, 4),
        }
    if recent_1m_signed < -max(12.0, avg_abs_1m_move * 0.75) and move_abs < min_btc_move_usd * 1.55:
        return {
            "side": None,
            "skip_reason": "v3_last_minute_reversal",
            "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
            "pullback_ratio": round(pullback_ratio, 4),
            "trend_quality": round(trend_quality, 4),
        }

    move_score = move_abs / max(dynamic_min_move, 1.0)
    continuation_score = max(0.0, recent_3m_signed) / max(dynamic_min_move, 1.0)
    pullback_score = max(0.0, 1.0 - pullback_ratio)
    location_score = clamp(direction_close_location, 0.0, 1.0)
    confidence = clamp(
        0.55
        + 0.72 * move_score
        + 0.30 * continuation_score
        + 0.34 * pullback_score
        + 0.30 * trend_quality
        + 0.22 * location_score,
        1.05,
        4.1,
    )
    stake_multiplier = clamp(0.85 + (confidence - 1.0) * 0.90, 1.0, 4.0)

    return {
        "side": "UP" if direction > 0 else "DOWN",
        "skip_reason": None,
        "entry_reason": "regime_aware_momentum_follow_through",
        "confidence": round(confidence, 4),
        "stake_multiplier": round(stake_multiplier, 4),
        "dynamic_min_btc_move_usd": round(dynamic_min_move, 4),
        "pullback_ratio": round(pullback_ratio, 4),
        "trend_quality": round(trend_quality, 4),
        "close_location": round(direction_close_location, 4),
        "recent_1m_signed_usd": round(recent_1m_signed, 4),
        "recent_3m_signed_usd": round(recent_3m_signed, 4),
    }


def strategy_label(strategy: str) -> str:
    return STRATEGY_LABELS.get(strategy, strategy.upper())


def strategy_decision(strategy: str, snapshot: dict[str, Any], min_btc_move_usd: float) -> dict[str, Any]:
    if strategy == STRATEGY_V3:
        return v3_decision(snapshot, min_btc_move_usd)
    if strategy == STRATEGY_V2:
        return v2_decision(snapshot, min_btc_move_usd)
    return v1_decision(snapshot, min_btc_move_usd)


def safe_float(value: Any, fallback: float = 0.0) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return fallback
    return numeric if math.isfinite(numeric) else fallback


def signal_side_from_decision(decision: dict[str, Any]) -> str | None:
    side = str(decision.get("side") or "").upper()
    return side if side in {"UP", "DOWN"} else None


def context_similarity_weight(
    current_snapshot: dict[str, Any],
    sample_snapshot: dict[str, Any],
    current_decision: dict[str, Any],
    sample_decision: dict[str, Any],
    min_btc_move_usd: float,
) -> float:
    current_move = safe_float(current_snapshot.get("move_at_entry"))
    sample_move = safe_float(sample_snapshot.get("move_at_entry"))
    current_threshold = safe_float(current_decision.get("dynamic_min_btc_move_usd"), min_btc_move_usd)
    sample_threshold = safe_float(sample_decision.get("dynamic_min_btc_move_usd"), min_btc_move_usd)
    move_scale = max(abs(current_move), abs(sample_move), current_threshold, sample_threshold, 20.0)
    vol_scale = max(
        safe_float(current_snapshot.get("avg_abs_1m_move")),
        safe_float(sample_snapshot.get("avg_abs_1m_move")),
        1.0,
    )

    score = 0.0
    score += abs(current_move - sample_move) / move_scale
    score += 0.65 * abs(safe_float(current_snapshot.get("recent_1m_move")) - safe_float(sample_snapshot.get("recent_1m_move"))) / move_scale
    score += 0.45 * abs(safe_float(current_snapshot.get("recent_3m_move")) - safe_float(sample_snapshot.get("recent_3m_move"))) / move_scale
    score += 0.35 * abs(safe_float(current_snapshot.get("avg_abs_1m_move")) - safe_float(sample_snapshot.get("avg_abs_1m_move"))) / vol_scale
    score += 0.30 * abs(safe_float(current_snapshot.get("trend_quality")) - safe_float(sample_snapshot.get("trend_quality")))
    score += 0.25 * abs(safe_float(current_snapshot.get("close_location"), 0.5) - safe_float(sample_snapshot.get("close_location"), 0.5))

    weight = math.exp(-1.35 * score)
    current_direction = int(current_snapshot.get("direction") or 0)
    sample_direction = int(sample_snapshot.get("direction") or 0)
    if current_direction and sample_direction and current_direction != sample_direction:
        weight *= 0.42

    current_side = signal_side_from_decision(current_decision)
    sample_side = signal_side_from_decision(sample_decision)
    if current_side and sample_side:
        weight *= 1.25 if current_side == sample_side else 0.58
    elif current_side and not sample_side:
        weight *= 0.78
    return max(0.001, weight)


def live_context_probabilities(
    args: argparse.Namespace,
    strategy: str,
    current_snapshot: dict[str, Any] | None,
    current_decision: dict[str, Any] | None,
    context_candles: list[dict[str, float]],
    context_start_ts: int,
    current_bucket_start: int,
) -> dict[str, Any] | None:
    if not current_snapshot or not current_decision or not context_candles:
        return None

    params = resolve_params(args)
    interval_sec = int(args.interval_minutes) * 60
    elapsed_seconds = int(current_snapshot["entry_ts"]) - int(current_snapshot["bucket_start"])
    if elapsed_seconds < 0 or elapsed_seconds >= interval_sec:
        return None

    by_ts = candles_by_ts(context_candles)
    sim_start_ts = ceil_interval(context_start_ts, interval_sec)
    up_weight = 0.0
    total_weight = 0.0
    sample_count = 0
    matched_signal_count = 0
    current_side = signal_side_from_decision(current_decision)

    for bucket_start in range(sim_start_ts, current_bucket_start, interval_sec):
        bucket_end = bucket_start + interval_sec
        entry_ts = bucket_start + elapsed_seconds
        sample_snapshot = build_market_snapshot(by_ts, bucket_start, bucket_end, entry_ts, require_settlement=True)
        if not sample_snapshot:
            continue
        sample_decision = strategy_decision(strategy, sample_snapshot, params["min_btc_move_usd"])
        sample_side = signal_side_from_decision(sample_decision)
        if current_side and sample_side == current_side:
            matched_signal_count += 1
        weight = context_similarity_weight(
            current_snapshot,
            sample_snapshot,
            current_decision,
            sample_decision,
            params["min_btc_move_usd"],
        )
        interval_open = safe_float(sample_snapshot.get("interval_open"))
        settle_btc = safe_float(sample_snapshot.get("settle_btc"))
        if math.isclose(settle_btc, interval_open):
            up_weight += weight * 0.5
        elif settle_btc > interval_open:
            up_weight += weight
        total_weight += weight
        sample_count += 1

    if sample_count == 0 or total_weight <= 0:
        return None

    prior_weight = min(16.0, max(4.0, math.sqrt(sample_count)))
    up_probability = ((up_weight + prior_weight * 0.5) / (total_weight + prior_weight)) * 100.0
    up_probability = clamp(up_probability, 5.0, 95.0)
    return {
        "up_probability": round(up_probability, 2),
        "down_probability": round(100.0 - up_probability, 2),
        "probability_source": "yesterday_today_similar_setups",
        "probability_sample_count": sample_count,
        "probability_effective_sample_weight": round(total_weight, 4),
        "probability_matching_signal_count": matched_signal_count,
        "probability_context_start": iso(context_start_ts),
        "probability_context_end": iso(current_bucket_start),
    }


def max_drawdown_pct(starting_cash: float, equity_curve: list[dict[str, Any]]) -> float:
    peak = starting_cash
    max_drawdown = 0.0
    for point in equity_curve:
        cash = float(point["cash"])
        peak = max(peak, cash)
        if peak > 0:
            max_drawdown = max(max_drawdown, (peak - cash) / peak)
    return round(max_drawdown * 100.0, 4)


def resolve_params(args: argparse.Namespace) -> dict[str, Any]:
    profile = PROFILES[args.profile]
    threshold_price = args.threshold_price if args.threshold_price is not None else profile["threshold_price"]
    stake_usd = args.stake_usd if args.stake_usd is not None else profile["stake_usd"]
    min_btc_move_usd = args.min_btc_move_usd if args.min_btc_move_usd is not None else profile["min_btc_move_usd"]
    entry_seconds_left = args.entry_seconds_left if args.entry_seconds_left is not None else profile["entry_seconds_left"]
    max_trades = args.max_trades if args.max_trades is not None else profile["max_trades"]
    v2_max_trades_multiplier = (
        args.v2_max_trades_multiplier
        if args.v2_max_trades_multiplier is not None
        else profile["v2_max_trades_multiplier"]
    )
    v2_max_stake_multiplier = (
        args.v2_max_stake_multiplier
        if args.v2_max_stake_multiplier is not None
        else profile["v2_max_stake_multiplier"]
    )
    v2_equity_risk_pct = (
        args.v2_equity_risk_pct
        if args.v2_equity_risk_pct is not None
        else profile["v2_equity_risk_pct"]
    )
    v3_max_trades_multiplier = (
        args.v3_max_trades_multiplier
        if args.v3_max_trades_multiplier is not None
        else profile["v3_max_trades_multiplier"]
    )
    v3_max_stake_multiplier = (
        args.v3_max_stake_multiplier
        if args.v3_max_stake_multiplier is not None
        else profile["v3_max_stake_multiplier"]
    )
    v3_equity_risk_pct = (
        args.v3_equity_risk_pct
        if args.v3_equity_risk_pct is not None
        else profile["v3_equity_risk_pct"]
    )

    return {
        "threshold_price": float(threshold_price),
        "stake_usd": float(stake_usd),
        "min_btc_move_usd": float(min_btc_move_usd),
        "entry_seconds_left": int(entry_seconds_left),
        "max_trades": int(max_trades),
        "v2_max_trades_multiplier": float(v2_max_trades_multiplier),
        "v2_max_stake_multiplier": float(v2_max_stake_multiplier),
        "v2_equity_risk_pct": float(v2_equity_risk_pct),
        "v3_max_trades_multiplier": float(v3_max_trades_multiplier),
        "v3_max_stake_multiplier": float(v3_max_stake_multiplier),
        "v3_equity_risk_pct": float(v3_equity_risk_pct),
    }


def resolve_time_range(args: argparse.Namespace, interval_sec: int) -> tuple[int, int, dt.datetime, dt.datetime]:
    if args.end:
        end = parse_utc(args.end)
    else:
        end = utc_now()
    if args.start:
        start = parse_utc(args.start)
    else:
        start = end - dt.timedelta(days=args.days)

    sim_start_ts = ceil_interval(int(start.timestamp()), interval_sec)
    sim_end_ts = floor_interval(int(end.timestamp()), interval_sec)
    fetch_start = dt.datetime.fromtimestamp(sim_start_ts - interval_sec, UTC)
    fetch_end = dt.datetime.fromtimestamp(sim_end_ts + 60, UTC)
    return sim_start_ts, sim_end_ts, fetch_start, fetch_end


def simulate_strategy(
    args: argparse.Namespace,
    strategy: str,
    candles: list[dict[str, float]],
    sim_start_ts: int,
    sim_end_ts: int,
) -> dict[str, Any]:
    params = resolve_params(args)
    interval_minutes = int(args.interval_minutes)
    interval_sec = interval_minutes * 60
    threshold_price = params["threshold_price"]
    stake_usd = params["stake_usd"]
    min_btc_move_usd = params["min_btc_move_usd"]
    entry_seconds_left = params["entry_seconds_left"]
    max_trades = params["max_trades"]

    if strategy == STRATEGY_V3:
        effective_max_trades = max(1, int(math.ceil(max_trades * params["v3_max_trades_multiplier"])))
    elif strategy == STRATEGY_V2:
        effective_max_trades = max(1, int(math.ceil(max_trades * params["v2_max_trades_multiplier"])))
    else:
        effective_max_trades = max_trades

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

        if trades_by_day.get(key, 0) >= effective_max_trades:
            skipped["daily_trade_cap"] = skipped.get("daily_trade_cap", 0) + 1
            continue
        if cash <= 0:
            skipped["insufficient_virtual_cash"] = skipped.get("insufficient_virtual_cash", 0) + 1
            continue

        snapshot = build_market_snapshot(by_ts, bucket_start, bucket_end, entry_ts)
        if not snapshot:
            skipped["missing_candle"] = skipped.get("missing_candle", 0) + 1
            continue

        decision = strategy_decision(strategy, snapshot, min_btc_move_usd)
        if not decision.get("side"):
            reason = str(decision.get("skip_reason") or "strategy_skip")
            skipped[reason] = skipped.get(reason, 0) + 1
            continue

        if strategy == STRATEGY_V3:
            multiplier_cap = max(1.0, params["v3_max_stake_multiplier"])
            risk_cap = max(0.01, cash * clamp(params["v3_equity_risk_pct"], 0.001, 1.0))
            target_stake = stake_usd * clamp(float(decision["stake_multiplier"]), 1.0, multiplier_cap)
            cost = min(target_stake, risk_cap, cash)
        elif strategy == STRATEGY_V2:
            multiplier_cap = max(1.0, params["v2_max_stake_multiplier"])
            risk_cap = max(0.01, cash * clamp(params["v2_equity_risk_pct"], 0.001, 1.0))
            target_stake = stake_usd * clamp(float(decision["stake_multiplier"]), 1.0, multiplier_cap)
            cost = min(target_stake, risk_cap, cash)
        else:
            cost = min(stake_usd, cash)

        if cost <= 0:
            skipped["insufficient_virtual_cash"] = skipped.get("insufficient_virtual_cash", 0) + 1
            continue

        interval_open = float(snapshot["interval_open"])
        entry_btc = float(snapshot["entry_btc"])
        settle_btc = float(snapshot["settle_btc"])
        side = str(decision["side"])
        winning_side = "UP" if settle_btc > interval_open else "DOWN"
        if math.isclose(settle_btc, interval_open):
            winning_side = "PUSH"

        shares = cost / threshold_price
        payout = shares if side == winning_side else 0.0
        pnl = payout - cost
        cash += pnl
        trades_by_day[key] = trades_by_day.get(key, 0) + 1

        trade = {
            "strategy": strategy,
            "sim_now_entry": iso(entry_ts),
            "market_slug": f"btc-updown-{interval_minutes}m-{bucket_start}",
            "market_interval_minutes": interval_minutes,
            "market_start": iso(bucket_start),
            "market_end": iso(bucket_end),
            "interval_open_btc": round(interval_open, 2),
            "entry_btc": round(entry_btc, 2),
            "settle_btc": round(settle_btc, 2),
            "move_at_entry_usd": round(float(snapshot["move_at_entry"]), 2),
            "side": side,
            "winning_side": winning_side,
            "virtual_entry_price": round(threshold_price, 4),
            "entry_reason": decision.get("entry_reason"),
            "confidence": decision.get("confidence"),
            "dynamic_min_btc_move_usd": decision.get("dynamic_min_btc_move_usd"),
            "pullback_ratio": decision.get("pullback_ratio"),
            "trend_quality": decision.get("trend_quality"),
            "close_location": decision.get("close_location"),
            "stake_multiplier": decision.get("stake_multiplier"),
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
    stakes = [float(t["stake_usd"]) for t in trades]

    report = {
        "mode": "virtual_backtest",
        "strategy": {
            "id": strategy,
            "label": strategy_label(strategy),
            "note": STRATEGY_NOTES[strategy],
        },
        "data_source": "Coinbase Exchange BTC-USD 1m candles",
        "lookahead_note": "Entry decisions use only the interval open and the candle at simulated entry time; settlement uses the real later close.",
        "market_model_note": f"This approximates BTC {interval_minutes}-minute Up/Down binaries with a fixed virtual entry price. It does not replay historical exchange order-book liquidity, spreads, fees, or fill probability.",
        "kalshi_note": "Kalshi BTC 15-minute markets settle from CF Benchmarks RTI averaged during the last minute. This simulator uses Coinbase 1-minute candles, so Kalshi settlement is approximate.",
        "simulated_present_started_at": iso(sim_start_ts),
        "simulated_present_finished_at": iso(sim_end_ts),
        "wall_clock_seconds": round(replay_elapsed, 3),
        "data_fetch_seconds": 0.0,
        "replay_seconds": round(replay_elapsed, 3),
        "params": {
            "profile": args.profile,
            "strategy": strategy,
            "interval_minutes": interval_minutes,
            "starting_cash": args.starting_cash,
            "stake_usd": stake_usd,
            "threshold_price": threshold_price,
            "min_btc_move_usd": min_btc_move_usd,
            "entry_seconds_left": entry_seconds_left,
            "max_trades_per_utc_day": effective_max_trades,
            "base_max_trades_per_utc_day": max_trades,
            "days": args.days,
            "v2_max_trades_multiplier": params["v2_max_trades_multiplier"],
            "v2_max_stake_multiplier": params["v2_max_stake_multiplier"],
            "v2_equity_risk_pct": params["v2_equity_risk_pct"],
            "v3_max_trades_multiplier": params["v3_max_trades_multiplier"],
            "v3_max_stake_multiplier": params["v3_max_stake_multiplier"],
            "v3_equity_risk_pct": params["v3_equity_risk_pct"],
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
            "avg_stake_usd": round(mean(stakes), 6) if stakes else 0.0,
            "largest_stake_usd": round(max(stakes), 6) if stakes else 0.0,
            "max_drawdown_pct": max_drawdown_pct(float(args.starting_cash), equity_curve),
        },
        "skipped": skipped,
        "trades_by_utc_day": trades_by_day,
        "_all_trades": trades,
        "trades": trades if args.include_trades else trades[: args.preview_trades],
    }
    return report


def build_comparison_report(
    args: argparse.Namespace,
    reports: dict[str, dict[str, Any]],
    sim_start_ts: int,
    sim_end_ts: int,
    data_elapsed: float,
) -> dict[str, Any]:
    baseline = reports[STRATEGY_V1]
    candidate = reports[STRATEGY_V3] if STRATEGY_V3 in reports else reports[STRATEGY_V2]
    baseline_summary = baseline["summary"]
    candidate_summary = candidate["summary"]

    def summary_delta(candidate_id: str, baseline_id: str) -> dict[str, Any]:
        cand = reports[candidate_id]["summary"]
        base = reports[baseline_id]["summary"]
        ending_delta = float(cand["ending_cash"]) - float(base["ending_cash"])
        pnl_delta = float(cand["total_pnl_usd"]) - float(base["total_pnl_usd"])
        return_delta = float(cand["return_pct"] or 0.0) - float(base["return_pct"] or 0.0)
        win_rate_delta = (
            float(cand["win_rate"] or 0.0) - float(base["win_rate"] or 0.0)
            if cand["win_rate"] is not None and base["win_rate"] is not None
            else None
        )
        return {
            "baseline_strategy": baseline_id,
            "candidate_strategy": candidate_id,
            "better_strategy": candidate_id if ending_delta > 0 else baseline_id if ending_delta < 0 else "tie",
            "ending_cash_delta_usd": round(ending_delta, 6),
            "total_pnl_delta_usd": round(pnl_delta, 6),
            "return_pct_delta": round(return_delta, 4),
            "trade_count_delta": int(cand["trades"]) - int(base["trades"]),
            "win_rate_delta": round(win_rate_delta, 4) if win_rate_delta is not None else None,
            "avg_stake_delta_usd": round(float(cand["avg_stake_usd"]) - float(base["avg_stake_usd"]), 6),
            "largest_stake_delta_usd": round(float(cand["largest_stake_usd"]) - float(base["largest_stake_usd"]), 6),
        }

    public_reports: dict[str, dict[str, Any]] = {}
    combined_trades: list[dict[str, Any]] = []
    for strategy, report in reports.items():
        public = dict(report)
        combined_trades.extend(report.get("_all_trades") or [])
        public.pop("_all_trades", None)
        public_reports[strategy] = public

    comparison = summary_delta(candidate["strategy"]["id"], STRATEGY_V1)
    comparison["deltas"] = {
        "v2_vs_v1": summary_delta(STRATEGY_V2, STRATEGY_V1) if STRATEGY_V2 in reports else None,
        "v3_vs_v1": summary_delta(STRATEGY_V3, STRATEGY_V1) if STRATEGY_V3 in reports else None,
        "v3_vs_v2": summary_delta(STRATEGY_V3, STRATEGY_V2) if STRATEGY_V3 in reports and STRATEGY_V2 in reports else None,
    }
    comparison["ranked_strategies"] = sorted(
        (
            {
                "strategy": strategy,
                "ending_cash": report["summary"]["ending_cash"],
                "return_pct": report["summary"]["return_pct"],
                "trades": report["summary"]["trades"],
                "max_drawdown_pct": report["summary"]["max_drawdown_pct"],
            }
            for strategy, report in reports.items()
        ),
        key=lambda row: float(row["ending_cash"]),
        reverse=True,
    )

    return {
        "mode": "virtual_backtest_comparison",
        "data_source": "Coinbase Exchange BTC-USD 1m candles",
        "lookahead_note": baseline["lookahead_note"],
        "market_model_note": baseline["market_model_note"],
        "kalshi_note": baseline["kalshi_note"],
        "risk_note": "Backtest improvement is not a promise of live profitability. The model still omits historical exchange order books, fills, fees, and exact Kalshi settlement data.",
        "simulated_present_started_at": iso(sim_start_ts),
        "simulated_present_finished_at": iso(sim_end_ts),
        "wall_clock_seconds": round(
            data_elapsed + sum(float(r.get("replay_seconds") or 0.0) for r in reports.values()), 3
        ),
        "data_fetch_seconds": round(data_elapsed, 3),
        "replay_seconds": round(sum(float(r.get("replay_seconds") or 0.0) for r in reports.values()), 3),
        "params": {
            "profile": args.profile,
            "strategy": "compare",
            "interval_minutes": int(args.interval_minutes),
            "starting_cash": args.starting_cash,
            "days": args.days,
        },
        "comparison": comparison,
        "summary": candidate_summary,
        "strategies": public_reports,
        "_all_trades": sorted(combined_trades, key=lambda t: (t.get("sim_now_entry") or "", t.get("strategy") or "")),
        "trades": candidate.get("trades", []),
    }


def live_window_status(seconds_left: int, entry_seconds_left: int, min_seconds_left: int) -> dict[str, Any]:
    if seconds_left > entry_seconds_left:
        return {
            "eligible": False,
            "action_if_signal": "WAIT",
            "reason": "waiting_for_entry_window",
        }
    if seconds_left < min_seconds_left:
        return {
            "eligible": False,
            "action_if_signal": "TOO_LATE",
            "reason": "too_late_to_enter",
        }
    return {
        "eligible": True,
        "action_if_signal": "SIGNAL",
        "reason": "inside_entry_window",
    }


def live_signal_for_strategy(
    args: argparse.Namespace,
    strategy: str,
    snapshot: dict[str, Any] | None,
    observed_at_ts: int,
    latest_candle_ts: int | None,
    bucket_start: int,
    bucket_end: int,
    context_candles: list[dict[str, float]] | None = None,
    context_start_ts: int | None = None,
) -> dict[str, Any]:
    params = resolve_params(args)
    interval_minutes = int(args.interval_minutes)
    seconds_left = max(0, int(bucket_end - observed_at_ts))
    min_seconds_left = int(getattr(args, "live_min_seconds_left", 15))
    window = live_window_status(seconds_left, params["entry_seconds_left"], min_seconds_left)

    base = {
        "mode": "live_signal",
        "strategy": {
            "id": strategy,
            "label": strategy_label(strategy),
            "note": STRATEGY_NOTES[strategy],
        },
        "data_source": "Live Coinbase Exchange BTC-USD 1m candles",
        "live_note": "Live mode uses the latest completed 1-minute candle and does not know final settlement yet.",
        "market_model_note": f"This is a live BTC {interval_minutes}-minute Up/Down signal snapshot, not a settled backtest.",
        "probability_note": "Algorithm odds compare this partial interval with completed similar intervals from UTC yesterday and today.",
        "observed_at": iso(observed_at_ts),
        "latest_candle_at": iso(latest_candle_ts) if latest_candle_ts else None,
        "market_start": iso(bucket_start),
        "market_end": iso(bucket_end),
        "params": {
            "profile": args.profile,
            "strategy": strategy,
            "interval_minutes": interval_minutes,
            "starting_cash": args.starting_cash,
            "stake_usd": params["stake_usd"],
            "threshold_price": params["threshold_price"],
            "min_btc_move_usd": params["min_btc_move_usd"],
            "entry_seconds_left": params["entry_seconds_left"],
            "live_min_seconds_left": min_seconds_left,
            "v2_max_stake_multiplier": params["v2_max_stake_multiplier"],
            "v2_equity_risk_pct": params["v2_equity_risk_pct"],
            "v3_max_stake_multiplier": params["v3_max_stake_multiplier"],
            "v3_equity_risk_pct": params["v3_equity_risk_pct"],
        },
    }

    if not snapshot:
        signal = {
            "action": "NO_DATA",
            "side": None,
            "status": "no_completed_live_candle",
            "seconds_left": seconds_left,
            "reason": "waiting_for_first_completed_candle_in_interval",
        }
        base["signal"] = signal
        base["summary"] = signal
        base["trades"] = []
        return base

    decision = strategy_decision(strategy, snapshot, params["min_btc_move_usd"])
    probability = live_context_probabilities(
        args,
        strategy,
        snapshot,
        decision,
        context_candles or [],
        int(context_start_ts) if context_start_ts is not None else bucket_start,
        bucket_start,
    )

    side = decision.get("side")
    if side:
        action = str(window["action_if_signal"])
        status = str(window["reason"])
        if strategy == STRATEGY_V3:
            multiplier_cap = max(1.0, params["v3_max_stake_multiplier"])
            risk_cap = max(0.01, float(args.starting_cash) * clamp(params["v3_equity_risk_pct"], 0.001, 1.0))
            target_stake = params["stake_usd"] * clamp(float(decision["stake_multiplier"]), 1.0, multiplier_cap)
            suggested_stake = min(target_stake, risk_cap, float(args.starting_cash))
        elif strategy == STRATEGY_V2:
            multiplier_cap = max(1.0, params["v2_max_stake_multiplier"])
            risk_cap = max(0.01, float(args.starting_cash) * clamp(params["v2_equity_risk_pct"], 0.001, 1.0))
            target_stake = params["stake_usd"] * clamp(float(decision["stake_multiplier"]), 1.0, multiplier_cap)
            suggested_stake = min(target_stake, risk_cap, float(args.starting_cash))
        else:
            suggested_stake = min(params["stake_usd"], float(args.starting_cash))
    else:
        action = "NO_SIGNAL"
        status = str(decision.get("skip_reason") or "strategy_skip")
        suggested_stake = 0.0

    signal = {
        "action": action,
        "side": side,
        "status": status,
        "seconds_left": seconds_left,
        "entry_window_eligible": bool(window["eligible"]),
        "interval_open_btc": round(float(snapshot["interval_open"]), 2),
        "latest_btc": round(float(snapshot["entry_btc"]), 2),
        "move_at_entry_usd": round(float(snapshot["move_at_entry"]), 2),
        "confidence": decision.get("confidence"),
        "dynamic_min_btc_move_usd": decision.get("dynamic_min_btc_move_usd"),
        "pullback_ratio": decision.get("pullback_ratio"),
        "trend_quality": decision.get("trend_quality"),
        "close_location": decision.get("close_location"),
        "stake_multiplier": decision.get("stake_multiplier"),
        "suggested_stake_usd": round(float(suggested_stake), 6),
        "model_entry_price": round(params["threshold_price"], 4),
        "entry_reason": decision.get("entry_reason"),
    }
    if probability:
        signal.update(probability)
    base["signal"] = signal
    base["summary"] = signal
    base["trades"] = [
        {
            "strategy": strategy,
            "sim_now_entry": iso(latest_candle_ts or observed_at_ts),
            "side": side or "--",
            "move_at_entry_usd": signal["move_at_entry_usd"],
            "action": action,
            "status": status,
            "suggested_stake_usd": signal["suggested_stake_usd"],
            "model_entry_price": signal["model_entry_price"],
        }
    ]
    return base


def build_live_comparison_report(
    args: argparse.Namespace,
    reports: dict[str, dict[str, Any]],
    observed_at_ts: int,
    latest_candle_ts: int | None,
    bucket_start: int,
    bucket_end: int,
    data_elapsed: float,
) -> dict[str, Any]:
    v1_signal = reports[STRATEGY_V1].get("signal") or {}
    v2_signal = reports[STRATEGY_V2].get("signal") or {}
    v3_signal = reports[STRATEGY_V3].get("signal") or {}
    candidate_signal = v3_signal if STRATEGY_V3 in reports else v2_signal
    return {
        "mode": "live_signal_comparison",
        "data_source": "Live Coinbase Exchange BTC-USD 1m candles",
        "live_note": "Live mode compares current V1, V2, and V3 signals only; no PnL exists until settlement.",
        "risk_note": "A live signal is not financial advice or an order instruction. It omits full historical order-book replay, fees, fill probability, and exact settlement uncertainty.",
        "observed_at": iso(observed_at_ts),
        "latest_candle_at": iso(latest_candle_ts) if latest_candle_ts else None,
        "market_start": iso(bucket_start),
        "market_end": iso(bucket_end),
        "wall_clock_seconds": round(data_elapsed, 3),
        "data_fetch_seconds": round(data_elapsed, 3),
        "params": {
            "profile": args.profile,
            "strategy": "compare",
            "interval_minutes": int(args.interval_minutes),
            "starting_cash": args.starting_cash,
        },
        "comparison": {
            "baseline_strategy": STRATEGY_V1,
            "candidate_strategy": STRATEGY_V3 if STRATEGY_V3 in reports else STRATEGY_V2,
            "v1_action": v1_signal.get("action"),
            "v2_action": v2_signal.get("action"),
            "v3_action": v3_signal.get("action"),
            "v1_side": v1_signal.get("side"),
            "v2_side": v2_signal.get("side"),
            "v3_side": v3_signal.get("side"),
            "actions_match": len({signal.get("action") for signal in (v1_signal, v2_signal, v3_signal)}) == 1,
            "sides_match": len({signal.get("side") for signal in (v1_signal, v2_signal, v3_signal)}) == 1,
        },
        "summary": candidate_signal,
        "signal": candidate_signal,
        "strategies": reports,
        "trades": reports[STRATEGY_V3].get("trades", []) if STRATEGY_V3 in reports else reports[STRATEGY_V2].get("trades", []),
    }


def simulate_live(args: argparse.Namespace) -> dict[str, Any]:
    interval_minutes = int(args.interval_minutes)
    interval_sec = interval_minutes * 60
    params = resolve_params(args)
    if params["entry_seconds_left"] >= interval_sec:
        raise ValueError("--entry-seconds-left must be less than the live market interval")

    observed_at_ts = int(utc_now().timestamp())
    bucket_start = floor_interval(observed_at_ts, interval_sec)
    bucket_end = bucket_start + interval_sec
    latest_candle_ts = floor_interval(observed_at_ts, 60) - 60
    today_start = dt.datetime.fromtimestamp(observed_at_ts, UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    context_start_dt = today_start - dt.timedelta(days=1)
    context_start_ts = int(context_start_dt.timestamp())

    data_started = time.perf_counter()
    candles: list[dict[str, float]] = []
    if latest_candle_ts >= bucket_start:
        fetch_end = dt.datetime.fromtimestamp(latest_candle_ts + 60, UTC)
        candles = fetch_coinbase_1m_cached(context_start_dt, fetch_end)
    data_elapsed = time.perf_counter() - data_started

    snapshot = None
    if latest_candle_ts >= bucket_start and candles:
        by_ts = candles_by_ts(candles)
        snapshot = build_market_snapshot(
            by_ts,
            bucket_start,
            bucket_end,
            latest_candle_ts,
            require_settlement=False,
        )

    if args.compare:
        reports = {
            strategy: live_signal_for_strategy(
                args,
                strategy,
                snapshot,
                observed_at_ts,
                latest_candle_ts if latest_candle_ts >= bucket_start else None,
                bucket_start,
                bucket_end,
                candles,
                context_start_ts,
            )
            for strategy in STRATEGIES
        }
        return build_live_comparison_report(
            args,
            reports,
            observed_at_ts,
            latest_candle_ts if latest_candle_ts >= bucket_start else None,
            bucket_start,
            bucket_end,
            data_elapsed,
        )

    return live_signal_for_strategy(
        args,
        args.strategy,
        snapshot,
        observed_at_ts,
        latest_candle_ts if latest_candle_ts >= bucket_start else None,
        bucket_start,
        bucket_end,
        candles,
        context_start_ts,
    )


def simulate(args: argparse.Namespace) -> dict[str, Any]:
    if args.live:
        return simulate_live(args)

    interval_minutes = int(args.interval_minutes)
    interval_sec = interval_minutes * 60
    params = resolve_params(args)
    if params["entry_seconds_left"] >= interval_sec:
        raise ValueError("--entry-seconds-left must be less than the simulated market interval")

    # Align to completed markets. The final bucket is excluded unless complete.
    sim_start_ts, sim_end_ts, fetch_start, fetch_end = resolve_time_range(args, interval_sec)
    data_started = time.perf_counter()
    candles = fetch_coinbase_1m(fetch_start, fetch_end)
    data_elapsed = time.perf_counter() - data_started

    if args.compare:
        reports = {
            strategy: simulate_strategy(args, strategy, candles, sim_start_ts, sim_end_ts)
            for strategy in STRATEGIES
        }
        return build_comparison_report(args, reports, sim_start_ts, sim_end_ts, data_elapsed)

    report = simulate_strategy(args, args.strategy, candles, sim_start_ts, sim_end_ts)
    report["data_fetch_seconds"] = round(data_elapsed, 3)
    report["wall_clock_seconds"] = round(data_elapsed + float(report.get("replay_seconds") or 0.0), 3)
    return report


def write_csv(path: Path, trades: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not trades:
        path.write_text("", encoding="utf-8")
        return
    fieldnames: list[str] = []
    for trade in trades:
        for key in trade.keys():
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(trades)


def strip_private_trades(report: dict[str, Any]) -> dict[str, Any]:
    report.pop("_all_trades", None)
    strategies = report.get("strategies")
    if isinstance(strategies, dict):
        for strategy_report in strategies.values():
            if isinstance(strategy_report, dict):
                strategy_report.pop("_all_trades", None)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description="Fast virtual-money replay for BTC Up/Down strategy.")
    ap.add_argument("--profile", choices=sorted(PROFILES), default="conservative")
    ap.add_argument("--strategy", choices=STRATEGIES, default=STRATEGY_V1, help="Strategy to run when --compare is omitted.")
    ap.add_argument("--compare", action="store_true", help="Run V1, V2, and V3 on the same candles and report the deltas.")
    ap.add_argument("--live", action="store_true", help="Use live current BTC candles and return an unsettled signal snapshot.")
    ap.add_argument("--interval-minutes", type=int, choices=[5, 15], default=15, help="Simulated BTC Up/Down market interval.")
    ap.add_argument("--days", type=float, default=7.0, help="Lookback length when --start is omitted.")
    ap.add_argument("--start", help="UTC start timestamp, for example 2026-06-27T00:00:00Z.")
    ap.add_argument("--end", help="UTC end timestamp. Defaults to current wall-clock time.")
    ap.add_argument("--starting-cash", type=float, default=100.0)
    ap.add_argument("--stake-usd", type=float)
    ap.add_argument("--threshold-price", type=float, help="Virtual exchange entry price paid per share.")
    ap.add_argument("--min-btc-move-usd", type=float, help="Required BTC move by simulated entry time.")
    ap.add_argument("--entry-seconds-left", type=int, help="Simulated entry point before each market close.")
    ap.add_argument("--max-trades", type=int, help="Max virtual trades per UTC day for V1; V2 applies its multiplier.")
    ap.add_argument("--v2-max-trades-multiplier", type=float, help="V2 daily trade cap multiplier over --max-trades.")
    ap.add_argument("--v2-max-stake-multiplier", type=float, help="V2 maximum stake multiplier over --stake-usd.")
    ap.add_argument("--v2-equity-risk-pct", type=float, help="V2 maximum stake as a fraction of current virtual equity.")
    ap.add_argument("--v3-max-trades-multiplier", type=float, help="V3 daily trade cap multiplier over --max-trades.")
    ap.add_argument("--v3-max-stake-multiplier", type=float, help="V3 maximum stake multiplier over --stake-usd.")
    ap.add_argument("--v3-equity-risk-pct", type=float, help="V3 maximum stake as a fraction of current virtual equity.")
    ap.add_argument("--live-min-seconds-left", type=int, default=15, help="Live mode skips entries with fewer seconds remaining.")
    ap.add_argument("--preview-trades", type=int, default=25)
    ap.add_argument("--include-trades", action="store_true", help="Print all trades in the JSON report.")
    ap.add_argument("--out", help="Write JSON report to this path.")
    ap.add_argument("--csv", help="Write all simulated trades to this CSV path.")
    args = ap.parse_args()

    report = simulate(args)

    if args.csv:
        write_csv(Path(args.csv), list(report.get("_all_trades") or []))

    text = json.dumps(strip_private_trades(report), ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:
        print(f"ERROR: {err}", file=sys.stderr)
        raise SystemExit(1)
