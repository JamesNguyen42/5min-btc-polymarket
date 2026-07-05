const simForm = document.querySelector("#simForm");
const safetyForm = document.querySelector("#safetyForm");
const statusBadge = document.querySelector("#statusBadge");
const killSwitchBadge = document.querySelector("#killSwitchBadge");
const runButton = document.querySelector("#runButton");
const saveSafetyButton = document.querySelector("#saveSafetyButton");
const startPaperButton = document.querySelector("#startPaperButton");
const stopPaperButton = document.querySelector("#stopPaperButton");
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
const currentEquity = document.querySelector("#currentEquity");
const realizedPnl = document.querySelector("#realizedPnl");
const liveReturn = document.querySelector("#liveReturn");
const tradingMode = document.querySelector("#tradingMode");
const liveTradeRows = document.querySelector("#liveTradeRows");
const API_BASE_URL = String(window.SIM_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");
let tradingRefreshTimer = null;

function apiPath(path) {
  return `${API_BASE_URL}${path}`;
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

function numberFromForm(data, key) {
  const value = Number(data[key]);
  return Number.isFinite(value) ? value : undefined;
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
  if (pageId === "tradingPage") loadTradingStatus();
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
  return {
    mode: data.mode,
    killSwitch: data.killSwitch === "on",
    maxDailyLossUsd: numberFromForm(data, "maxDailyLossUsd"),
    maxDailyLossPct: numberFromForm(data, "maxDailyLossPct"),
    maxTotalLossUsd: numberFromForm(data, "maxTotalLossUsd"),
    maxTotalLossPct: numberFromForm(data, "maxTotalLossPct"),
    maxStakeUsd: numberFromForm(data, "maxStakeUsd"),
    maxTradesPerDay: numberFromForm(data, "maxTradesPerDay"),
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
        <span>Kalshi ask</span>
        <strong>${market.yesAsk === undefined && market.noAsk === undefined ? "--" : `${price(market.yesAsk)} / ${price(market.noAsk)}`}</strong>
        <small>YES / NO</small>
      </div>
    `;
    return;
  }

  const v1 = report.strategies.v1?.summary || {};
  const v2 = report.strategies.v2?.summary || {};
  const comparison = report.comparison || {};
  const delta = Number(comparison.return_pct_delta || 0);
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
      <span>V2 minus V1</span>
      <strong class="${deltaClass}">${pct(comparison.return_pct_delta)}</strong>
      <small>${money(comparison.ending_cash_delta_usd)} / ${comparison.trade_count_delta >= 0 ? "+" : ""}${comparison.trade_count_delta ?? "--"} trades</small>
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
  const primaryReport = isComparison ? report.strategies.v2 || report : report;
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
  if (!items || items.length === 0) {
    liveTradeRows.innerHTML = '<tr><td colspan="5" class="empty">No live worker trades yet.</td></tr>';
    return;
  }

  liveTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value >= 0 ? "win" : "lose";
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.market || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td>${trade.status || "--"}</td>
          <td class="${resultClass}">${money(value)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderReport(report) {
  if (report?.mode === "live_signal" || report?.mode === "live_signal_comparison") {
    renderLiveSignalReport(report);
    return;
  }

  const isComparison = report?.mode === "virtual_backtest_comparison" && report.strategies;
  const primaryReport = isComparison ? report.strategies.v2 || report : report;
  const summary = primaryReport.summary || report.summary || {};
  const returnPct = Number(summary.return_pct || 0);
  const intervalMinutes = primaryReport.params?.interval_minutes || report.params?.interval_minutes || "--";
  const rangePrefix = isComparison ? "Compare V1 vs V2 | V2 table shown" : primaryReport.strategy?.label || "Strategy";

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

function fillSafetyForm(state) {
  const limits = state.limits || {};
  safetyForm.elements.mode.value = state.mode || "paper";
  safetyForm.elements.killSwitch.checked = state.killSwitch !== false;
  safetyForm.elements.maxDailyLossUsd.value = limits.maxDailyLossUsd ?? 25;
  safetyForm.elements.maxDailyLossPct.value = limits.maxDailyLossPct ?? 10;
  safetyForm.elements.maxTotalLossUsd.value = limits.maxTotalLossUsd ?? 50;
  safetyForm.elements.maxTotalLossPct.value = limits.maxTotalLossPct ?? 20;
  safetyForm.elements.maxStakeUsd.value = limits.maxStakeUsd ?? 5;
  safetyForm.elements.maxTradesPerDay.value = limits.maxTradesPerDay ?? 12;
}

function renderTradingStatus(state) {
  const balances = state.balances || {};
  workerStatus.textContent = state.workerStatus || "inactive";
  workerStatus.className = `return-value ${state.workerStatus === "active" ? "gain" : "neutral"}`;
  tradingMode.textContent = state.mode || "--";
  currentEquity.textContent = money(balances.currentEquity);
  realizedPnl.textContent = money(balances.realizedPnl);
  liveReturn.textContent = pct(balances.returnPct);
  tradingNote.textContent = state.note || `Updated ${shortDate(state.updatedAt)}`;
  setStatus(killSwitchBadge, state.killSwitch === false ? "Unprotected" : "Protected", state.killSwitch === false ? "running" : "error");
  renderLiveTrades(state.recentTrades);
  startPaperButton.disabled = state.workerStatus === "active";
  stopPaperButton.disabled = state.workerStatus !== "active";
  if (state.workerStatus === "active" && !tradingRefreshTimer) {
    tradingRefreshTimer = setInterval(loadTradingStatus, 5000);
  }
  if (state.workerStatus !== "active" && tradingRefreshTimer) {
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
    runButton.innerHTML = '<span class="play-icon" aria-hidden="true"></span>Run simulation';
  }
}

async function loadTradingStatus() {
  try {
    const response = await fetch(apiPath("/api/trading/status"));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "could not load trading status");
    fillSafetyForm(payload);
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
    const response = await fetch(apiPath("/api/trading/settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(safetyFormData()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "could not save fail-safes");
    fillSafetyForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    tradingNote.textContent = err.message || String(err);
  } finally {
    saveSafetyButton.disabled = false;
    saveSafetyButton.textContent = "Save fail-safes";
  }
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
    tradingNote.textContent = err.message || String(err);
  } finally {
    button.textContent = label;
  }
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
simForm.addEventListener("submit", runSimulation);
safetyForm.addEventListener("submit", saveSafetySettings);
startPaperButton.addEventListener("click", () => postTradingAction("/api/trading/start", startPaperButton, "Start paper worker"));
stopPaperButton.addEventListener("click", () => postTradingAction("/api/trading/stop", stopPaperButton, "Stop worker"));
loadTradingStatus();
