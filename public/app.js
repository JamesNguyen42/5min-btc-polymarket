const simForm = document.querySelector("#simForm");
const safetyForm = document.querySelector("#safetyForm");
const compareForm = document.querySelector("#compareForm");
const polymarketForm = document.querySelector("#polymarketForm");
const polyCompareForm = document.querySelector("#polyCompareForm");
const statusBadge = document.querySelector("#statusBadge");
const killSwitchBadge = document.querySelector("#killSwitchBadge");
const compareBadge = document.querySelector("#compareBadge");
const polymarketModeBadge = document.querySelector("#polymarketModeBadge");
const runButton = document.querySelector("#runButton");
const saveSafetyButton = document.querySelector("#saveSafetyButton");
const savePolymarketButton = document.querySelector("#savePolymarketButton");
const startPaperButton = document.querySelector("#startPaperButton");
const stopPaperButton = document.querySelector("#stopPaperButton");
const startCompareButton = document.querySelector("#startCompareButton");
const stopCompareButton = document.querySelector("#stopCompareButton");
const stopPolymarketButton = document.querySelector("#stopPolymarketButton");
const armPolymarketLiveButton = document.querySelector("#armPolymarketLiveButton");
const startPolyCompareButton = document.querySelector("#startPolyCompareButton");
const stopPolyCompareButton = document.querySelector("#stopPolyCompareButton");
const returnValue = document.querySelector("#returnValue");
const rangeText = document.querySelector("#rangeText");
const endingCash = document.querySelector("#endingCash");
const pnl = document.querySelector("#pnl");
const winRate = document.querySelector("#winRate");
const trades = document.querySelector("#trades");
const metricLabel1 = document.querySelector("#metricLabel1");
const metricLabel2 = document.querySelector("#metricLabel2");
const metricLabel3 = document.querySelector("#metricLabel3");
const metricLabel4 = document.querySelector("#metricLabel4");
const tradeRows = document.querySelector("#tradeRows");
const tradeHead1 = document.querySelector("#tradeHead1");
const tradeHead2 = document.querySelector("#tradeHead2");
const tradeHead3 = document.querySelector("#tradeHead3");
const tradeHead4 = document.querySelector("#tradeHead4");
const tradeHead5 = document.querySelector("#tradeHead5");
const comparisonPanel = document.querySelector("#comparisonPanel");
const workerStatus = document.querySelector("#workerStatus");
const tradingNote = document.querySelector("#tradingNote");
const kalshiEquityLabel = document.querySelector("#kalshiEquityLabel");
const currentEquity = document.querySelector("#currentEquity");
const realizedPnl = document.querySelector("#realizedPnl");
const liveReturn = document.querySelector("#liveReturn");
const tradingMode = document.querySelector("#tradingMode");
const kalshiLiveOddsPanel = document.querySelector("#kalshiLiveOddsPanel");
const liveTradeRows = document.querySelector("#liveTradeRows");
const compareWorkerStatus = document.querySelector("#compareWorkerStatus");
const compareWorkerNote = document.querySelector("#compareWorkerNote");
const liveComparePanel = document.querySelector("#liveComparePanel");
const compareTradeRows = document.querySelector("#compareTradeRows");
const polymarketStatus = document.querySelector("#polymarketStatus");
const polymarketNote = document.querySelector("#polymarketNote");
const polymarketEquityLabel = document.querySelector("#polymarketEquityLabel");
const polymarketEquity = document.querySelector("#polymarketEquity");
const polymarketPnl = document.querySelector("#polymarketPnl");
const polymarketReturn = document.querySelector("#polymarketReturn");
const polymarketPredictionLabel = document.querySelector("#polymarketPredictionLabel");
const polymarketMode = document.querySelector("#polymarketMode");
const polymarketLiveOddsPanel = document.querySelector("#polymarketLiveOddsPanel");
const polymarketPanel = document.querySelector("#polymarketPanel");
const polymarketTradeRows = document.querySelector("#polymarketTradeRows");
const polyCompareStatus = document.querySelector("#polyCompareStatus");
const polyCompareNote = document.querySelector("#polyCompareNote");
const polyComparePanel = document.querySelector("#polyComparePanel");
const polyCompareTradeRows = document.querySelector("#polyCompareTradeRows");
const API_BASE_URL = String(window.SIM_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");
const ALL_COMPARE_STRATEGIES = ["v1", "v2", "v3"];
const DEFAULT_COMPARE_STRATEGIES = ["v1", "v3"];
const DEFAULT_PRIMARY_STRATEGY = "v1";
let tradingRefreshTimer = null;
const dirtyForms = new WeakSet();

function apiPath(path) {
  return `${API_BASE_URL}${path}`;
}

function markFormDirty(form) {
  if (form) dirtyForms.add(form);
}

function clearFormDirty(form) {
  if (form) dirtyForms.delete(form);
}

function isFormDirty(form) {
  return form ? dirtyForms.has(form) : false;
}

function trackFormDirty(form) {
  if (!form) return;
  form.addEventListener("input", () => markFormDirty(form));
  form.addEventListener("change", () => markFormDirty(form));
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const sign = Number(value) > 0 ? "+" : "";
  return `${sign}${Number(value).toFixed(2)}%`;
}

function price(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(2);
}

function probability(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(1)}%`;
}

function impliedOdds(upAsk, downAsk) {
  const up = Number(upAsk);
  const down = Number(downAsk);
  const hasUp = Number.isFinite(up) && up > 0;
  const hasDown = Number.isFinite(down) && down > 0;
  if (hasUp && hasDown) {
    const total = up + down;
    if (total > 0) {
      return {
        up: (up / total) * 100,
        down: (down / total) * 100,
      };
    }
  }
  if (hasUp) {
    const upPct = Math.max(0, Math.min(100, up * 100));
    return { up: upPct, down: 100 - upPct };
  }
  if (hasDown) {
    const downPct = Math.max(0, Math.min(100, down * 100));
    return { up: 100 - downPct, down: downPct };
  }
  return { up: null, down: null };
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizedSignalSide(value) {
  const side = String(value || "").toUpperCase();
  if (side === "YES" || side === "UP") return "UP";
  if (side === "NO" || side === "DOWN") return "DOWN";
  return "";
}

function algorithmPredictionText({ signal, market, workerActive }) {
  if (!workerActive) {
    return {
      text: "Inactive",
      title: "Start the Polymarket worker to show algorithm odds.",
      active: false,
    };
  }

  const secondsLeft = Number(signal?.seconds_left ?? market?.secondsLeft);
  const hasSecondsLeft = Number.isFinite(secondsLeft);
  const action = String(signal?.action || "").toUpperCase();
  const signalSide = normalizedSignalSide(signal?.side);
  let direction = signalSide;
  let edge = 0;

  if (action === "SIGNAL" && direction) {
    const confidence = Number(signal?.confidence);
    const confidenceScore = clamp((confidence - 1) / 3.1, 0, 1);
    edge = 5 + confidenceScore * 30;
  } else {
    const move = Number(signal?.move_at_entry_usd);
    const threshold = Math.max(1, Number(signal?.dynamic_min_btc_move_usd || 70));
    if (Number.isFinite(move) && move !== 0) {
      direction = move > 0 ? "UP" : "DOWN";
      edge = clamp(Math.abs(move) / threshold, 0, 1) * 8;
    }
  }

  const leadPct = direction ? clamp(50 + edge, 50, 85) : 50;
  const upPct = direction === "DOWN" ? 100 - leadPct : leadPct;
  const downPct = 100 - upPct;
  const status = action || "NO_DATA";

  return {
    text: `UP ${probability(upPct)} / DOWN ${probability(downPct)}`,
    title: `${status}${direction ? ` ${direction}` : ""}; ${hasSecondsLeft ? `${secondsText(secondsLeft)} left` : "no market timer"}.`,
    active: true,
  };
}

function oddsCardHtml({ label, market, upAsk, downAsk, upLabel = "UP", downLabel = "DOWN" }) {
  const odds = impliedOdds(upAsk, downAsk);
  const hasOdds = Number.isFinite(odds.up) && Number.isFinite(odds.down);
  const upWidth = hasOdds ? Math.max(0, Math.min(100, odds.up)) : 0;
  const downWidth = hasOdds ? Math.max(0, Math.min(100, odds.down)) : 0;
  return `
    <div class="comparison-item odds-card">
      <span>${label}</span>
      <strong>${upLabel} ${probability(odds.up)} / ${downLabel} ${probability(odds.down)}</strong>
      <div class="odds-bars" aria-hidden="true">
        <div class="odds-bar up" style="width: ${upWidth}%"></div>
        <div class="odds-bar down" style="width: ${downWidth}%"></div>
      </div>
      <small>${secondsText(market?.secondsLeft)} left / ask ${price(upAsk)} / ${price(downAsk)}</small>
    </div>
  `;
}

function modelSignalCardHtml({ label = "Algorithm signal", strategy, signal }) {
  const data = signal || {};
  const action = String(data.action || "--");
  const side = String(data.side || "").toUpperCase();
  const sideText = side === "YES" ? "UP" : side === "NO" ? "DOWN" : side || "";
  const headline = sideText ? `${sideText} ${action}` : action;
  const details = [];
  if (strategy) details.push(String(strategy).toUpperCase());
  if (Number.isFinite(Number(data.confidence))) details.push(`confidence ${Number(data.confidence).toFixed(2)}x`);
  if (Number.isFinite(Number(data.move_at_entry_usd))) details.push(`move ${money(data.move_at_entry_usd)}`);
  if (!sideText && data.status) details.push(String(data.status).replace(/_/g, " "));
  return `
    <div class="comparison-item odds-card model-signal-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(headline)}</strong>
      <small>${escapeHtml(details.join(" / ") || "--")}</small>
    </div>
  `;
}

function secondsText(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Math.max(0, Math.round(Number(value)))}s`;
}

function shortDate(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortAddress(value) {
  const text = String(value || "").trim();
  if (!text) return "--";
  return text.length > 13 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tradeErrorText(trade) {
  const apiError = trade?.api_error?.error?.message || trade?.api_error?.message || "";
  return String(trade?.error || apiError || "").trim();
}

function tradeStatusText(trade) {
  const status = String(trade?.status || "--");
  const error = tradeErrorText(trade);
  return error ? `${status}: ${error}` : status;
}

function signatureTypeScanText(items) {
  const rows = Array.isArray(items) ? items : [];
  const summaries = rows.map((item) => (item.error ? `${item.signatureType}: error` : `${item.signatureType}: ${money(item.availableCash)}`));
  return summaries.length ? summaries.join(" | ") : "--";
}

function signatureTypeBestBalance(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows
    .filter((item) => Number(item.availableCash || 0) > 0)
    .sort((a, b) => Number(b.availableCash || 0) - Number(a.availableCash || 0))[0] || null;
}

function polymarketDisplayBalance(accountBalance) {
  const clobBalance = Number(accountBalance?.availableCash);
  if (Number.isFinite(clobBalance) && clobBalance > 0) return clobBalance;
  const onChainBalance = Number(accountBalance?.onChainFunderBalance);
  if (Number.isFinite(onChainBalance) && onChainBalance > 0) return onChainBalance;
  return accountBalance?.availableCash;
}

function numberFromForm(data, key) {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : undefined;
}

function normalizePrimaryStrategy(value) {
  const strategy = String(value || "").trim().toLowerCase();
  return ALL_COMPARE_STRATEGIES.includes(strategy) ? strategy : DEFAULT_PRIMARY_STRATEGY;
}

function normalizeCompareStrategies(value, primaryStrategy = DEFAULT_PRIMARY_STRATEGY) {
  const explicitList = Array.isArray(value);
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const selected = [];
  const primary = normalizePrimaryStrategy(primaryStrategy);
  raw.forEach((item) => {
    const strategy = String(item || "").trim().toLowerCase();
    if (ALL_COMPARE_STRATEGIES.includes(strategy) && !selected.includes(strategy)) selected.push(strategy);
  });
  const normalized = selected.length ? selected : explicitList ? [] : [...DEFAULT_COMPARE_STRATEGIES];
  return normalized.includes(primary) ? normalized : [primary, ...normalized];
}

function compareStrategiesFromForm() {
  const primary = normalizePrimaryStrategy(compareForm.elements.primaryStrategy?.value);
  return normalizeCompareStrategies(
    [...compareForm.querySelectorAll('input[name="compareStrategies"]:checked')].map((input) => input.value),
    primary,
  );
}

function strategiesFromForm(form) {
  const primary = normalizePrimaryStrategy(form.elements.primaryStrategy?.value);
  return normalizeCompareStrategies(
    [...form.querySelectorAll('input[name="compareStrategies"]:checked')].map((input) => input.value),
    primary,
  );
}

function polymarketFormData(form = polymarketForm, modeOverride = null) {
  const data = Object.fromEntries(new FormData(form).entries());
  const primaryStrategy = normalizePrimaryStrategy(data.primaryStrategy);
  const payload = {
    mode: modeOverride || data.mode || "paper",
    profile: data.profile || "conservative",
    primaryStrategy,
    compareStrategies: form === polymarketForm ? [primaryStrategy] : strategiesFromForm(form),
  };
  if (form === polymarketForm) {
    payload.killSwitch = data.killSwitch === "on";
    payload.maxDailyLossUsd = numberFromForm(data, "maxDailyLossUsd");
    payload.maxDailyLossPct = numberFromForm(data, "maxDailyLossPct");
    payload.maxTotalLossUsd = numberFromForm(data, "maxTotalLossUsd");
    payload.maxTotalLossPct = numberFromForm(data, "maxTotalLossPct");
    payload.maxStakeUsd = numberFromForm(data, "maxStakeUsd");
    payload.maxTradesPerDay = numberFromForm(data, "maxTradesPerDay");
    payload.entrySecondsLeft = numberFromForm(data, "entrySecondsLeft");
    payload.minSecondsLeft = numberFromForm(data, "minSecondsLeft");
  }
  return payload;
}

function setStatus(el, text, state) {
  el.textContent = text;
  el.className = `status ${state || ""}`.trim();
}

function showPage(pageId) {
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("active", page.id === pageId);
  });
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === pageId);
  });
  if (pageId === "tradingPage" || pageId === "comparePage") loadTradingStatus();
}

function simFormData() {
  const data = Object.fromEntries(new FormData(simForm).entries());
  return {
    intervalMinutes: numberFromForm(data, "intervalMinutes"),
    dataMode: data.dataMode || "historical",
    profile: data.profile,
    strategyMode: data.strategyMode || "compare",
    days: numberFromForm(data, "days"),
    start: data.start || null,
    end: data.end || null,
    startingCash: numberFromForm(data, "startingCash"),
    stakeUsd: numberFromForm(data, "stakeUsd"),
    minBtcMoveUsd: numberFromForm(data, "minBtcMoveUsd"),
    entrySecondsLeft: numberFromForm(data, "entrySecondsLeft"),
    thresholdPrice: numberFromForm(data, "thresholdPrice"),
    maxTrades: numberFromForm(data, "maxTrades"),
  };
}

function safetyFormData() {
  const data = Object.fromEntries(new FormData(safetyForm).entries());
  const primaryStrategy = normalizePrimaryStrategy(data.primaryStrategy);
  return {
    mode: "live",
    killSwitch: data.killSwitch === "on",
    primaryStrategy,
    compareStrategies: [primaryStrategy],
    maxDailyLossUsd: numberFromForm(data, "maxDailyLossUsd"),
    maxDailyLossPct: numberFromForm(data, "maxDailyLossPct"),
    maxTotalLossUsd: numberFromForm(data, "maxTotalLossUsd"),
    maxTotalLossPct: numberFromForm(data, "maxTotalLossPct"),
    maxStakeUsd: numberFromForm(data, "maxStakeUsd"),
    maxTradesPerDay: numberFromForm(data, "maxTradesPerDay"),
    entrySecondsLeft: numberFromForm(data, "entrySecondsLeft"),
    minSecondsLeft: numberFromForm(data, "minSecondsLeft"),
  };
}

function compareFormData() {
  return {
    primaryStrategy: normalizePrimaryStrategy(compareForm.elements.primaryStrategy?.value),
    compareStrategies: compareStrategiesFromForm(),
  };
}

function setMetricLabels(labels) {
  [metricLabel1, metricLabel2, metricLabel3, metricLabel4].forEach((label, index) => {
    if (label) label.textContent = labels[index];
  });
}

function setTableHeaders(labels) {
  [tradeHead1, tradeHead2, tradeHead3, tradeHead4, tradeHead5].forEach((header, index) => {
    if (header) header.textContent = labels[index];
  });
}

function setHistoricalLabels() {
  setMetricLabels(["Ending money", "PnL", "Win rate", "Trades"]);
  setTableHeaders(["Time", "Side", "Move", "Result", "PnL"]);
}

function setLiveLabels() {
  setMetricLabels(["Side", "BTC move", "Seconds left", "Market ask"]);
  setTableHeaders(["Strategy", "Action", "Side", "Move", "Ask"]);
}

function renderTrades(items) {
  setHistoricalLabels();
  if (!items || items.length === 0) {
    tradeRows.innerHTML = '<tr><td colspan="5" class="empty">No trades matched these settings.</td></tr>';
    return;
  }

  tradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value > 0 ? "win" : value < 0 ? "lose" : "neutral-cell";
      const result = value > 0 ? "Win" : value < 0 ? "Loss" : "Flat";
      return `
        <tr>
          <td>${shortDate(trade.sim_now_entry)}</td>
          <td>${trade.side}</td>
          <td>${Number(trade.move_at_entry_usd).toFixed(2)}</td>
          <td class="${resultClass}">${result}</td>
          <td class="${resultClass}">${money(trade.pnl_usd)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderComparison(report) {
  if (!comparisonPanel) return;
  const isBacktestComparison = report?.mode === "virtual_backtest_comparison" && report.strategies;
  const isLiveComparison = report?.mode === "live_signal_comparison" && report.strategies;
  if (!isBacktestComparison && !isLiveComparison) {
    comparisonPanel.hidden = true;
    comparisonPanel.innerHTML = "";
    return;
  }

  if (isLiveComparison) {
    const v1Signal = report.strategies.v1?.signal || {};
    const v2Signal = report.strategies.v2?.signal || {};
    const v3Signal = report.strategies.v3?.signal || {};
    const market = report.live_market || {};
    comparisonPanel.hidden = false;
    comparisonPanel.innerHTML = `
      <div class="comparison-item">
        <span>V1 live</span>
        <strong>${v1Signal.action || "--"}</strong>
        <small>${v1Signal.side || "--"} / ${money(v1Signal.move_at_entry_usd)}</small>
      </div>
      <div class="comparison-item">
        <span>V2 live</span>
        <strong>${v2Signal.action || "--"}</strong>
        <small>${v2Signal.side || "--"} / ${money(v2Signal.move_at_entry_usd)}</small>
      </div>
      <div class="comparison-item">
        <span>V3 live</span>
        <strong>${v3Signal.action || "--"}</strong>
        <small>${v3Signal.side || "--"} / ${money(v3Signal.move_at_entry_usd)}</small>
      </div>
      <div class="comparison-item">
        <span>Kalshi ask</span>
        <strong>${market.yesAsk === undefined && market.noAsk === undefined ? "--" : `${price(market.yesAsk)} / ${price(market.noAsk)}`}</strong>
        <small>YES / NO</small>
      </div>
    `;
    return;
  }

  const v1 = report.strategies.v1?.summary || {};
  const v2 = report.strategies.v2?.summary || {};
  const v3 = report.strategies.v3?.summary || {};
  const comparison = report.comparison || {};
  const delta = Number(comparison.deltas?.v3_vs_v2?.return_pct_delta ?? comparison.return_pct_delta ?? 0);
  const deltaClass = delta > 0 ? "gain" : delta < 0 ? "loss" : "neutral";

  comparisonPanel.hidden = false;
  comparisonPanel.innerHTML = `
    <div class="comparison-item">
      <span>V1 baseline</span>
      <strong>${pct(v1.return_pct)}</strong>
      <small>${money(v1.ending_cash)} / ${v1.trades ?? "--"} trades</small>
    </div>
    <div class="comparison-item">
      <span>V2 adaptive</span>
      <strong>${pct(v2.return_pct)}</strong>
      <small>${money(v2.ending_cash)} / ${v2.trades ?? "--"} trades</small>
    </div>
    <div class="comparison-item">
      <span>V3 regime-aware</span>
      <strong>${pct(v3.return_pct)}</strong>
      <small>${money(v3.ending_cash)} / ${v3.trades ?? "--"} trades</small>
    </div>
    <div class="comparison-item">
      <span>V3 minus V2</span>
      <strong class="${deltaClass}">${pct(comparison.deltas?.v3_vs_v2?.return_pct_delta ?? comparison.return_pct_delta)}</strong>
      <small>${money(comparison.deltas?.v3_vs_v2?.ending_cash_delta_usd ?? comparison.ending_cash_delta_usd)} / ${(comparison.deltas?.v3_vs_v2?.trade_count_delta ?? comparison.trade_count_delta) >= 0 ? "+" : ""}${comparison.deltas?.v3_vs_v2?.trade_count_delta ?? comparison.trade_count_delta ?? "--"} trades</small>
    </div>
  `;
}

function renderLiveSignalRows(report) {
  setLiveLabels();
  const reports = report.strategies ? Object.values(report.strategies) : [report];
  const rows = reports
    .map((strategyReport) => {
      const signal = strategyReport.signal || {};
      const strategy = strategyReport.strategy?.id?.toUpperCase() || "--";
      const actionClass = signal.action === "SIGNAL" ? "win" : signal.action === "TOO_LATE" ? "lose" : "neutral-cell";
      return `
        <tr>
          <td>${strategy}</td>
          <td class="${actionClass}">${signal.action || "--"}</td>
          <td>${signal.side || "--"}</td>
          <td>${money(signal.move_at_entry_usd)}</td>
          <td>${price(signal.live_market_price ?? signal.model_entry_price)}</td>
        </tr>
      `;
    })
    .join("");
  tradeRows.innerHTML = rows || '<tr><td colspan="5" class="empty">No live signal is available yet.</td></tr>';
}

function renderLiveSignalReport(report) {
  const isComparison = report?.mode === "live_signal_comparison" && report.strategies;
  const primaryReport = isComparison ? report.strategies.v3 || report.strategies.v2 || report : report;
  const signal = primaryReport.signal || report.signal || {};
  const action = signal.action || "--";
  const actionClass = action === "SIGNAL" ? "gain" : action === "TOO_LATE" ? "loss" : "neutral";
  const intervalMinutes = primaryReport.params?.interval_minutes || report.params?.interval_minutes || "--";
  const status = signal.status || report.live_market_note || report.live_market_error || "live snapshot";

  returnValue.textContent = action;
  returnValue.className = `return-value ${actionClass}`;
  endingCash.textContent = signal.side || "--";
  pnl.textContent = money(signal.move_at_entry_usd);
  winRate.textContent = secondsText(signal.seconds_left);
  trades.textContent = price(signal.live_market_price ?? signal.model_entry_price);
  rangeText.textContent = `Live ${intervalMinutes}m | latest ${shortDate(report.latest_candle_at)} | ends ${shortDate(report.market_end)} | ${status}`;
  renderComparison(report);
  renderLiveSignalRows(report);
}

function renderLiveTrades(items) {
  if (!liveTradeRows) return;
  if (!items || items.length === 0) {
    liveTradeRows.innerHTML = '<tr><td colspan="5" class="empty">No worker trades yet.</td></tr>';
    return;
  }

  liveTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value > 0 ? "win" : value < 0 ? "lose" : "neutral-cell";
      const status = tradeStatusText(trade);
      const error = tradeErrorText(trade);
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.strategy ? `${trade.strategy} ` : ""}${trade.market || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td title="${escapeHtml(error)}">${escapeHtml(status)}</td>
          <td class="${resultClass}">${money(value)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderCompareTrades(items) {
  if (!compareTradeRows) return;
  if (!items || items.length === 0) {
    compareTradeRows.innerHTML = '<tr><td colspan="6" class="empty">No compare trades yet.</td></tr>';
    return;
  }

  compareTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value > 0 ? "win" : value < 0 ? "lose" : "neutral-cell";
      const status = tradeStatusText(trade);
      const error = tradeErrorText(trade);
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.market || "--"}</td>
          <td>${trade.strategy || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td title="${escapeHtml(error)}">${escapeHtml(status)}</td>
          <td class="${resultClass}">${money(value)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderLiveCompareStatus(compare) {
  const state = compare || {};
  const active = state.workerStatus === "active";
  if (compareBadge) {
    setStatus(compareBadge, active ? "Active" : "Inactive", active ? "done" : "");
  }
  if (compareWorkerStatus) {
    compareWorkerStatus.textContent = state.workerStatus || "inactive";
    compareWorkerStatus.className = `return-value ${active ? "gain" : "neutral"}`;
  }
  if (compareWorkerNote) {
    compareWorkerNote.textContent = state.note || "Live compare worker is inactive.";
  }

  if (startCompareButton) startCompareButton.disabled = active;
  if (stopCompareButton) stopCompareButton.disabled = !active;

  const strategies = state.strategies || {};
  const primaryStrategy = normalizePrimaryStrategy(state.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(state.enabledStrategies, primaryStrategy);
  const enabledSet = new Set(enabledStrategies);
  const signalStrategy = strategies[primaryStrategy]?.lastSignal
    ? primaryStrategy
    : [...enabledStrategies].reverse().find((strategy) => strategies[strategy]?.lastSignal) || primaryStrategy;
  const signalAccount = strategies[signalStrategy] || {};
  if (!liveComparePanel) return;
  liveComparePanel.hidden = false;
  const accountCards = ALL_COMPARE_STRATEGIES.map((strategy) => {
    const account = strategies[strategy] || {};
    const enabled = enabledSet.has(strategy);
    return `
      <div class="comparison-item ${enabled ? "" : "muted-card"}">
        <span>${strategy.toUpperCase()} paper${strategy === primaryStrategy ? " primary" : ""}</span>
        <strong class="${enabled ? "" : "neutral"}">${enabled ? pct(account.returnPct) : "Disabled"}</strong>
        <small>${enabled ? `${money(account.currentEquity)} / ${account.entriesToday ?? 0} entries` : "Enable in controls"}</small>
      </div>
    `;
  }).join("");
  liveComparePanel.innerHTML = `
    ${accountCards}
    <div class="comparison-item">
      <span>${signalStrategy.toUpperCase()} signal</span>
      <strong>${signalAccount.lastSignal?.action || "--"}</strong>
      <small>${signalAccount.lastSignal?.side || "--"} / ${money(signalAccount.lastSignal?.move_at_entry_usd)}</small>
    </div>
  `;
  renderCompareTrades(state.recentTrades || []);
}

function renderKalshiLiveOdds(state) {
  if (!kalshiLiveOddsPanel) return;
  const market = state?.liveMarket || null;
  const active = state?.workerStatus === "active";
  if (!active || !market) {
    kalshiLiveOddsPanel.hidden = true;
    kalshiLiveOddsPanel.innerHTML = "";
    return;
  }
  kalshiLiveOddsPanel.hidden = false;
  const strategy = normalizePrimaryStrategy(state?.strategy?.primaryStrategy);
  kalshiLiveOddsPanel.innerHTML = `
    ${oddsCardHtml({
      label: "Market prediction",
      market,
      upAsk: market.yesAsk,
      downAsk: market.noAsk,
    })}
    ${modelSignalCardHtml({
      label: "Algorithm signal",
      strategy,
      signal: state?.lastSignal,
    })}
  `;
}

function renderPolymarketLiveOdds(state) {
  if (!polymarketLiveOddsPanel) return;
  const market = state?.liveMarket || null;
  const active = state?.workerStatus === "active";
  if (!active || !market) {
    polymarketLiveOddsPanel.hidden = true;
    polymarketLiveOddsPanel.innerHTML = "";
    return;
  }
  const primaryStrategy = normalizePrimaryStrategy(state?.primaryStrategy);
  const signal = state?.strategies?.[primaryStrategy]?.lastSignal || null;
  polymarketLiveOddsPanel.hidden = false;
  polymarketLiveOddsPanel.innerHTML = `
    ${oddsCardHtml({
      label: "Market prediction",
      market,
      upAsk: market.upAsk,
      downAsk: market.downAsk,
    })}
    ${modelSignalCardHtml({
      label: "Algorithm signal",
      strategy: primaryStrategy,
      signal,
    })}
  `;
}

function renderPolymarketTrades(items) {
  if (!polymarketTradeRows) return;
  if (!items || items.length === 0) {
    polymarketTradeRows.innerHTML = '<tr><td colspan="5" class="empty">No Polymarket worker trades yet.</td></tr>';
    return;
  }

  polymarketTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value > 0 ? "win" : value < 0 ? "lose" : "neutral-cell";
      const status = tradeStatusText(trade);
      const error = tradeErrorText(trade);
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.strategy ? `${trade.strategy} ` : ""}${trade.market || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td title="${escapeHtml(error)}">${escapeHtml(status)}</td>
          <td class="${resultClass}">${money(value)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderPolymarketCompareTrades(items) {
  if (!polyCompareTradeRows) return;
  if (!items || items.length === 0) {
    polyCompareTradeRows.innerHTML = '<tr><td colspan="6" class="empty">No Polymarket compare trades yet.</td></tr>';
    return;
  }

  polyCompareTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value > 0 ? "win" : value < 0 ? "lose" : "neutral-cell";
      const status = tradeStatusText(trade);
      const error = tradeErrorText(trade);
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.market || "--"}</td>
          <td>${trade.strategy || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td title="${escapeHtml(error)}">${escapeHtml(status)}</td>
          <td class="${resultClass}">${money(value)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderPolymarketStatus(polymarket) {
  const state = polymarket || {};
  const active = state.workerStatus === "active";
  const liveArmed = state.mode === "live" && state.liveArmed === true;
  const paperCompareActive = active && !liveArmed;
  const liveTradingActive = active && liveArmed;
  const primaryStrategy = normalizePrimaryStrategy(state.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(state.enabledStrategies, primaryStrategy);
  const enabledSet = new Set(enabledStrategies);
  const strategies = state.strategies || {};
  const primaryAccount = strategies[primaryStrategy] || {};
  const accountBalance = state.accountBalance || {};

  if (polymarketStatus) {
    polymarketStatus.textContent = state.workerStatus || "inactive";
    polymarketStatus.className = `return-value ${active ? "gain" : "neutral"}`;
  }
  if (polymarketNote) {
    polymarketNote.textContent = accountBalance.error
      ? `${state.note || "Polymarket worker is inactive."} Balance: ${accountBalance.error}`
      : state.note || "Polymarket worker is inactive.";
  }
  if (polymarketModeBadge) {
    setStatus(
      polymarketModeBadge,
      state.killSwitch === false ? "Unprotected" : "Protected",
      state.killSwitch === false ? "running" : "error",
    );
  }
  if (polymarketEquityLabel) polymarketEquityLabel.textContent = "Account balance";
  if (polymarketEquity) polymarketEquity.textContent = money(polymarketDisplayBalance(accountBalance));
  if (polymarketPnl) polymarketPnl.textContent = money(primaryAccount.realizedPnl);
  if (polymarketReturn) polymarketReturn.textContent = pct(primaryAccount.returnPct);
  if (polymarketPredictionLabel) polymarketPredictionLabel.textContent = `${primaryStrategy.toUpperCase()} algorithm odds`;
  if (polymarketMode) {
    const prediction = algorithmPredictionText({
      signal: primaryAccount.lastSignal,
      market: state.liveMarket,
      workerActive: active,
    });
    polymarketMode.textContent = prediction.text;
    polymarketMode.title = prediction.title;
    polymarketMode.className = prediction.active ? "algorithm-prediction" : "algorithm-prediction inactive-prediction";
  }
  renderPolymarketLiveOdds(state);

  if (armPolymarketLiveButton) {
    armPolymarketLiveButton.disabled = liveTradingActive || paperCompareActive;
    armPolymarketLiveButton.textContent = liveTradingActive ? "Polymarket live trading active" : "Start Polymarket live trading";
  }
  if (stopPolymarketButton) stopPolymarketButton.disabled = !liveArmed;
  if (startPolyCompareButton) startPolyCompareButton.disabled = active;
  if (stopPolyCompareButton) stopPolyCompareButton.disabled = !paperCompareActive;

  const signalStrategy = strategies[primaryStrategy]?.lastSignal
    ? primaryStrategy
    : [...enabledStrategies].reverse().find((strategy) => strategies[strategy]?.lastSignal) || primaryStrategy;
  const signalAccount = strategies[signalStrategy] || {};
  const paperCards = ALL_COMPARE_STRATEGIES.map((strategy) => {
    const account = strategies[strategy] || {};
    const enabled = enabledSet.has(strategy);
    return `
      <div class="comparison-item ${enabled ? "" : "muted-card"}">
        <span>${strategy.toUpperCase()} paper${strategy === primaryStrategy ? " primary" : ""}</span>
        <strong class="${enabled ? "" : "neutral"}">${enabled ? pct(account.returnPct) : "Disabled"}</strong>
        <small>${enabled ? `${money(account.currentEquity)} / ${account.entriesToday ?? 0} entries` : "Enable in controls"}</small>
      </div>
    `;
  }).join("");
  const market = state.liveMarket || {};
  const bestSignatureBalance = signatureTypeBestBalance(accountBalance.signatureTypeBalances);
  const balanceHint =
    Number(accountBalance.availableCash || 0) === 0 && !accountBalance.error
      ? bestSignatureBalance
        ? `Try type ${bestSignatureBalance.signatureType}`
        : "Check signer/funder"
      : accountBalance.error
        ? "Balance error"
        : "CLOB balance";
  const signalCard = `
    <div class="comparison-item diagnostic-card">
      <span>${signalStrategy.toUpperCase()} signal</span>
      <strong class="compact-value">${signalAccount.lastSignal?.action || "--"}</strong>
      <small class="detail-value">${signalAccount.lastSignal?.side || "--"} / ${money(signalAccount.lastSignal?.move_at_entry_usd)}</small>
    </div>`;
  const marketCard = `
    ${oddsCardHtml({
      label: "End window odds",
      market,
      upAsk: market.upAsk,
      downAsk: market.downAsk,
    })}`;
  const diagnosticCards = `
    <div class="comparison-item diagnostic-card">
      <span>Balance source</span>
      <strong class="compact-value">${balanceHint}</strong>
      <small class="detail-value">CLOB raw ${accountBalance.rawBalance ?? "--"} / on-chain ${money(accountBalance.onChainFunderBalance)}</small>
    </div>
    <div class="comparison-item diagnostic-card">
      <span>Signer / funder</span>
      <strong class="compact-value">${shortAddress(accountBalance.signerAddress)} / ${shortAddress(accountBalance.funderAddress)}</strong>
      <small class="detail-value">type ${accountBalance.signatureType ?? "--"} / ${accountBalance.apiCredsSource || "--"} / ${shortDate(accountBalance.checkedAt)}</small>
    </div>
    <div class="comparison-item diagnostic-card">
      <span>Signature scan</span>
      <strong class="compact-value">${bestSignatureBalance ? `type ${bestSignatureBalance.signatureType} has ${money(bestSignatureBalance.availableCash)}` : "--"}</strong>
      <small class="detail-value">${signatureTypeScanText(accountBalance.signatureTypeBalances)}</small>
    </div>
  `;
  const tradingPanelHtml = `${signalCard}${diagnosticCards}`;
  const comparePanelHtml = `${paperCards}${signalCard}${marketCard}${diagnosticCards}`;

  if (polymarketPanel) {
    polymarketPanel.hidden = false;
    polymarketPanel.innerHTML = tradingPanelHtml;
  }
  if (polyComparePanel) {
    polyComparePanel.hidden = false;
    polyComparePanel.innerHTML = comparePanelHtml;
  }
  if (polyCompareStatus) {
    polyCompareStatus.textContent = state.workerStatus || "inactive";
    polyCompareStatus.className = `return-value ${active ? "gain" : "neutral"}`;
  }
  if (polyCompareNote) {
    polyCompareNote.textContent = accountBalance.error
      ? `${state.note || "Polymarket compare worker is inactive."} Balance: ${accountBalance.error}`
      : state.note || "Polymarket compare worker is inactive.";
  }

  renderPolymarketTrades(state.recentTrades || []);
  renderPolymarketCompareTrades(state.recentTrades || []);
}

function renderReport(report) {
  if (report?.mode === "live_signal" || report?.mode === "live_signal_comparison") {
    renderLiveSignalReport(report);
    return;
  }

  const isComparison = report?.mode === "virtual_backtest_comparison" && report.strategies;
  const primaryReport = isComparison ? report.strategies.v3 || report.strategies.v2 || report : report;
  const summary = primaryReport.summary || report.summary || {};
  const returnPct = Number(summary.return_pct || 0);
  const intervalMinutes = primaryReport.params?.interval_minutes || report.params?.interval_minutes || "--";
  const rangePrefix = isComparison ? "Compare V1/V2/V3 | V3 table shown" : primaryReport.strategy?.label || "Strategy";

  returnValue.textContent = pct(returnPct);
  returnValue.className = `return-value ${returnPct > 0 ? "gain" : returnPct < 0 ? "loss" : "neutral"}`;
  endingCash.textContent = money(summary.ending_cash);
  pnl.textContent = money(summary.total_pnl_usd);
  winRate.textContent = summary.win_rate === null || summary.win_rate === undefined ? "--" : pct(summary.win_rate * 100);
  trades.textContent = summary.trades ?? "--";
  rangeText.textContent = `${rangePrefix} | ${intervalMinutes}m | ${shortDate(report.simulated_present_started_at)} to ${shortDate(report.simulated_present_finished_at)} | ${summary.markets_replayed || 0} markets replayed`;
  renderComparison(report);
  renderTrades(primaryReport.trades || report.trades);
}

function fillSafetyForm(state, { force = false } = {}) {
  if (!force && isFormDirty(safetyForm)) return;
  const limits = state.limits || {};
  if (safetyForm.elements.mode) safetyForm.elements.mode.value = "live";
  safetyForm.elements.killSwitch.checked = state.killSwitch !== false;
  safetyForm.elements.primaryStrategy.value = normalizePrimaryStrategy(state.strategy?.primaryStrategy);
  safetyForm.elements.maxDailyLossUsd.value = limits.maxDailyLossUsd ?? 25;
  safetyForm.elements.maxDailyLossPct.value = limits.maxDailyLossPct ?? 10;
  safetyForm.elements.maxTotalLossUsd.value = limits.maxTotalLossUsd ?? 50;
  safetyForm.elements.maxTotalLossPct.value = limits.maxTotalLossPct ?? 20;
  safetyForm.elements.maxStakeUsd.value = limits.maxStakeUsd ?? 5;
  safetyForm.elements.maxTradesPerDay.value = limits.maxTradesPerDay ?? 12;
  safetyForm.elements.entrySecondsLeft.value = state.strategy?.entrySecondsLeft ?? 180;
  safetyForm.elements.minSecondsLeft.value = state.strategy?.minSecondsLeft ?? 60;
}

function fillCompareForm(state, { force = false } = {}) {
  if (!compareForm) return;
  if (!force && isFormDirty(compareForm)) return;
  compareForm.elements.primaryStrategy.value = normalizePrimaryStrategy(state.liveCompare?.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(state.liveCompare?.enabledStrategies, compareForm.elements.primaryStrategy.value);
  compareForm.querySelectorAll('input[name="compareStrategies"]').forEach((input) => {
    input.checked = enabledStrategies.includes(input.value);
  });
}

function fillPolymarketForm(state, { force = false, forceTrading = force, forceCompare = force } = {}) {
  const polymarket = state.polymarket || {};
  const primaryStrategy = normalizePrimaryStrategy(polymarket.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(polymarket.enabledStrategies, primaryStrategy);
  if (polymarketForm && (forceTrading || !isFormDirty(polymarketForm))) {
    const limits = polymarket.limits || {};
    if (polymarketForm.elements.mode) polymarketForm.elements.mode.value = "live";
    polymarketForm.elements.primaryStrategy.value = primaryStrategy;
    polymarketForm.elements.profile.value = polymarket.profile || "conservative";
    polymarketForm.elements.killSwitch.checked = polymarket.killSwitch !== false;
    polymarketForm.elements.maxDailyLossUsd.value = limits.maxDailyLossUsd ?? 25;
    polymarketForm.elements.maxDailyLossPct.value = limits.maxDailyLossPct ?? 10;
    polymarketForm.elements.maxTotalLossUsd.value = limits.maxTotalLossUsd ?? 50;
    polymarketForm.elements.maxTotalLossPct.value = limits.maxTotalLossPct ?? 20;
    polymarketForm.elements.maxStakeUsd.value = limits.maxStakeUsd ?? 5;
    polymarketForm.elements.maxTradesPerDay.value = limits.maxTradesPerDay ?? 12;
    polymarketForm.elements.entrySecondsLeft.value = polymarket.entrySecondsLeft ?? 180;
    polymarketForm.elements.minSecondsLeft.value = polymarket.minSecondsLeft ?? 10;
  }
  if (polyCompareForm && (forceCompare || !isFormDirty(polyCompareForm))) {
    if (polyCompareForm.elements.mode) polyCompareForm.elements.mode.value = "paper";
    polyCompareForm.elements.primaryStrategy.value = primaryStrategy;
    polyCompareForm.elements.profile.value = polymarket.profile || "conservative";
    polyCompareForm.querySelectorAll('input[name="compareStrategies"]').forEach((input) => {
      input.checked = enabledStrategies.includes(input.value);
    });
  }
}

function renderTradingStatus(state) {
  const balances = state.balances || {};
  const accountBalance = state.accountBalance || {};
  workerStatus.textContent = state.workerStatus || "inactive";
  workerStatus.className = `return-value ${state.workerStatus === "active" ? "gain" : "neutral"}`;
  tradingMode.textContent = state.mode || "--";
  if (kalshiEquityLabel) kalshiEquityLabel.textContent = state.mode === "live" ? "Account balance" : "Paper equity";
  currentEquity.textContent = state.mode === "live" ? money(accountBalance.availableCash) : money(balances.currentEquity);
  if (realizedPnl) realizedPnl.textContent = money(balances.realizedPnl);
  if (liveReturn) liveReturn.textContent = pct(balances.returnPct);
  tradingNote.textContent =
    state.mode === "live" && accountBalance.error
      ? `${state.note || `Updated ${shortDate(state.updatedAt)}`} Balance: ${accountBalance.error}`
      : state.note || `Updated ${shortDate(state.updatedAt)}`;
  setStatus(killSwitchBadge, state.killSwitch === false ? "Unprotected" : "Protected", state.killSwitch === false ? "running" : "error");
  renderKalshiLiveOdds(state);
  renderLiveCompareStatus(state.liveCompare);
  renderPolymarketStatus(state.polymarket);
  renderLiveTrades(state.recentTrades || []);
  startPaperButton.disabled = state.workerStatus === "active";
  stopPaperButton.disabled = state.workerStatus !== "active";
  const compareActive = state.liveCompare?.workerStatus === "active";
  const polymarketActive = state.polymarket?.workerStatus === "active";
  if ((state.workerStatus === "active" || compareActive || polymarketActive) && !tradingRefreshTimer) {
    tradingRefreshTimer = setInterval(loadTradingStatus, 5000);
  }
  if (state.workerStatus !== "active" && !compareActive && !polymarketActive && tradingRefreshTimer) {
    clearInterval(tradingRefreshTimer);
    tradingRefreshTimer = null;
  }
}

async function runSimulation(event) {
  event.preventDefault();
  if (!simForm.reportValidity()) return;
  setStatus(statusBadge, "Running", "running");
  runButton.disabled = true;
  runButton.textContent = "Running simulation";

  try {
    const response = await fetch(apiPath("/api/simulate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(simFormData()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "simulation failed");
    renderReport(payload);
    setStatus(statusBadge, "Done", "done");
  } catch (err) {
    setStatus(statusBadge, "Error", "error");
    rangeText.textContent = err.message || String(err);
  } finally {
    runButton.disabled = false;
    runButton.innerHTML = '<span class="play-icon" aria-hidden="true"></span>Run model test';
  }
}

async function loadTradingStatus() {
  try {
    const response = await fetch(apiPath("/api/trading/status"));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "could not load trading status");
    fillSafetyForm(payload);
    fillCompareForm(payload);
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    tradingNote.textContent = err.message || String(err);
    workerStatus.textContent = "error";
    workerStatus.className = "return-value loss";
  }
}

async function saveSafetySettings(event) {
  event.preventDefault();
  if (!safetyForm.reportValidity()) return;
  saveSafetyButton.disabled = true;
  saveSafetyButton.textContent = "Saving";

  try {
    const payload = await persistSafetySettings();
    clearFormDirty(safetyForm);
    fillSafetyForm(payload, { force: true });
    fillCompareForm(payload);
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    tradingNote.textContent = err.message || String(err);
  } finally {
    saveSafetyButton.disabled = false;
    saveSafetyButton.textContent = "Save Kalshi settings only";
  }
}

async function savePolymarketSettings(event) {
  event.preventDefault();
  if (!polymarketForm.reportValidity()) return;
  savePolymarketButton.disabled = true;
  savePolymarketButton.textContent = "Saving";

  try {
    const payload = await persistPolymarketSettings();
    clearFormDirty(polymarketForm);
    fillCompareForm(payload);
    fillPolymarketForm(payload, { forceTrading: true });
    renderTradingStatus(payload);
  } catch (err) {
    polymarketNote.textContent = err.message || String(err);
  } finally {
    savePolymarketButton.disabled = false;
    savePolymarketButton.textContent = "Save Polymarket settings only";
  }
}

async function persistSafetySettings() {
  const response = await fetch(apiPath("/api/trading/settings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(safetyFormData()),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "could not save fail-safes");
  return payload;
}

async function persistCompareSettings() {
  const response = await fetch(apiPath("/api/trading/live-compare/settings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(compareFormData()),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "could not save compare settings");
  return payload;
}

async function persistPolymarketSettings(form = polymarketForm, modeOverride = null) {
  const response = await fetch(apiPath("/api/polymarket/settings"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(polymarketFormData(form, modeOverride)),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "could not save Polymarket settings");
  return payload;
}

async function postTradingAction(path, button, label) {
  button.disabled = true;
  button.textContent = "Working";
  try {
    const response = await fetch(apiPath(path), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "trading action failed");
    renderTradingStatus(payload);
  } catch (err) {
    const noteTarget =
      path.includes("polymarket") && button === stopPolyCompareButton
        ? polyCompareNote
        : path.includes("polymarket")
          ? polymarketNote
          : path.includes("live-compare")
            ? compareWorkerNote
            : tradingNote;
    noteTarget.textContent = err.message || String(err);
  } finally {
    button.textContent = label;
    await loadTradingStatus().catch(() => {
      button.disabled = false;
    });
  }
}

async function startPaperWorker() {
  if (!safetyForm.reportValidity()) return;
  let started = false;
  startPaperButton.disabled = true;
  startPaperButton.textContent = "Saving settings";
  try {
    await persistSafetySettings();
    clearFormDirty(safetyForm);
    startPaperButton.textContent = "Starting Kalshi live";
    const response = await fetch(apiPath("/api/trading/start"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not start Kalshi live");
    }
    renderTradingStatus(payload);
    started = payload.workerStatus === "active";
  } catch (err) {
    tradingNote.textContent = err.message || String(err);
  } finally {
    if (!started) startPaperButton.disabled = false;
    startPaperButton.textContent = "Start Kalshi live trading";
  }
}

async function startCompareWorker() {
  if (!compareForm.reportValidity()) return;
  let started = false;
  startCompareButton.disabled = true;
  startCompareButton.textContent = "Saving settings";
  try {
    await persistCompareSettings();
    clearFormDirty(compareForm);
    startCompareButton.textContent = "Starting compare";
    const response = await fetch(apiPath("/api/trading/live-compare/start"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not start Kalshi compare");
    }
    renderTradingStatus(payload);
    started = payload.liveCompare?.workerStatus === "active";
  } catch (err) {
    compareWorkerNote.textContent = err.message || String(err);
  } finally {
    if (!started) startCompareButton.disabled = false;
    startCompareButton.textContent = "Start Kalshi compare";
  }
}

async function startPolyCompareWorker() {
  if (!polyCompareForm.reportValidity()) return;
  let started = false;
  startPolyCompareButton.disabled = true;
  startPolyCompareButton.textContent = "Saving settings";
  try {
    await persistPolymarketSettings(polyCompareForm, "paper");
    clearFormDirty(polyCompareForm);
    startPolyCompareButton.textContent = "Starting";
    const response = await fetch(apiPath("/api/polymarket/start"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not start Polymarket compare");
    }
    fillPolymarketForm(payload, { forceCompare: true });
    renderTradingStatus(payload);
    started = payload.polymarket?.workerStatus === "active";
  } catch (err) {
    polyCompareNote.textContent = err.message || String(err);
  } finally {
    if (!started) startPolyCompareButton.disabled = false;
    startPolyCompareButton.textContent = "Start Polymarket compare";
  }
}

async function armPolymarketLive() {
  if (!polymarketForm.reportValidity()) return;
  let armed = false;
  armPolymarketLiveButton.disabled = true;
  armPolymarketLiveButton.textContent = "Starting Polymarket live";
  try {
    await persistPolymarketSettings(polymarketForm, "live");
    clearFormDirty(polymarketForm);
    const response = await fetch(apiPath("/api/polymarket/arm-live"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not arm Polymarket live mode");
    }
    fillPolymarketForm(payload, { forceTrading: true });
    renderTradingStatus(payload);
    armed = payload.polymarket?.mode === "live" && payload.polymarket?.liveArmed === true;
  } catch (err) {
    polymarketNote.textContent = err.message || String(err);
  } finally {
    armPolymarketLiveButton.disabled = armed;
    armPolymarketLiveButton.textContent = "Start Polymarket live trading";
    loadTradingStatus().catch(() => {});
  }
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
trackFormDirty(safetyForm);
trackFormDirty(compareForm);
trackFormDirty(polymarketForm);
trackFormDirty(polyCompareForm);
simForm.addEventListener("submit", runSimulation);
safetyForm.addEventListener("submit", saveSafetySettings);
polymarketForm.addEventListener("submit", savePolymarketSettings);
startPaperButton.addEventListener("click", startPaperWorker);
stopPaperButton.addEventListener("click", () => postTradingAction("/api/trading/stop", stopPaperButton, "Stop Kalshi live trading"));
startCompareButton.addEventListener("click", startCompareWorker);
stopCompareButton.addEventListener("click", () =>
  postTradingAction("/api/trading/live-compare/stop", stopCompareButton, "Stop Kalshi compare"),
);
stopPolymarketButton.addEventListener("click", () =>
  postTradingAction("/api/polymarket/stop", stopPolymarketButton, "Stop Polymarket live trading"),
);
startPolyCompareButton.addEventListener("click", startPolyCompareWorker);
stopPolyCompareButton.addEventListener("click", () =>
  postTradingAction("/api/polymarket/stop", stopPolyCompareButton, "Stop Polymarket compare"),
);
armPolymarketLiveButton.addEventListener("click", armPolymarketLive);
loadTradingStatus();
