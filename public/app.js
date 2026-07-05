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
const paperPolymarketButton = document.querySelector("#paperPolymarketButton");
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
const polymarketMode = document.querySelector("#polymarketMode");
const polymarketPanel = document.querySelector("#polymarketPanel");
const polymarketTradeRows = document.querySelector("#polymarketTradeRows");
const API_BASE_URL = String(window.SIM_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");
const ALL_COMPARE_STRATEGIES = ["v1", "v2", "v3"];
const DEFAULT_COMPARE_STRATEGIES = ["v1", "v3"];
const DEFAULT_PRIMARY_STRATEGY = "v1";
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

function shortAddress(value) {
  const text = String(value || "").trim();
  if (!text) return "--";
  return text.length > 13 ? `${text.slice(0, 6)}...${text.slice(-4)}` : text;
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

function polymarketStrategiesFromForm() {
  const primary = normalizePrimaryStrategy(polymarketForm.elements.primaryStrategy?.value);
  return normalizeCompareStrategies(
    [...polymarketForm.querySelectorAll('input[name="compareStrategies"]:checked')].map((input) => input.value),
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
  return {
    mode: modeOverride || data.mode || "paper",
    profile: data.profile || "conservative",
    primaryStrategy: normalizePrimaryStrategy(data.primaryStrategy),
    compareStrategies: strategiesFromForm(form),
  };
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
      const resultClass = value >= 0 ? "win" : "lose";
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.strategy ? `${trade.strategy} ` : ""}${trade.market || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td>${trade.status || "--"}</td>
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
      const resultClass = value >= 0 ? "win" : "lose";
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.market || "--"}</td>
          <td>${trade.strategy || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td>${trade.status || "--"}</td>
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

function renderPolymarketTrades(items) {
  if (!polymarketTradeRows) return;
  if (!items || items.length === 0) {
    polymarketTradeRows.innerHTML = '<tr><td colspan="5" class="empty">No Polymarket worker trades yet.</td></tr>';
    return;
  }

  polymarketTradeRows.innerHTML = items
    .map((trade) => {
      const value = Number(trade.pnl_usd || 0);
      const resultClass = value >= 0 ? "win" : "lose";
      return `
        <tr>
          <td>${shortDate(trade.ts)}</td>
          <td>${trade.strategy ? `${trade.strategy} ` : ""}${trade.market || "--"}</td>
          <td>${trade.side || "--"}</td>
          <td>${trade.status || "--"}</td>
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
    setStatus(polymarketModeBadge, liveArmed ? "Live armed" : state.mode === "live" ? "Live" : "Paper", liveArmed ? "running" : "");
  }
  if (polymarketEquityLabel) polymarketEquityLabel.textContent = "Account balance";
  if (polymarketEquity) polymarketEquity.textContent = money(accountBalance.availableCash);
  if (polymarketPnl) polymarketPnl.textContent = money(primaryAccount.realizedPnl);
  if (polymarketReturn) polymarketReturn.textContent = pct(primaryAccount.returnPct);
  if (polymarketMode) polymarketMode.textContent = `${state.mode || "paper"} / ${primaryStrategy.toUpperCase()}`;

  if (stopPolymarketButton) stopPolymarketButton.disabled = !active;
  if (paperPolymarketButton) paperPolymarketButton.disabled = state.mode !== "live" && !liveArmed;
  if (startPolyCompareButton) startPolyCompareButton.disabled = active || liveArmed;
  if (stopPolyCompareButton) stopPolyCompareButton.disabled = !active || liveArmed;

  if (polymarketPanel) {
    polymarketPanel.hidden = false;
    const signalStrategy = strategies[primaryStrategy]?.lastSignal
      ? primaryStrategy
      : [...enabledStrategies].reverse().find((strategy) => strategies[strategy]?.lastSignal) || primaryStrategy;
    const signalAccount = strategies[signalStrategy] || {};
    const cards = ALL_COMPARE_STRATEGIES.map((strategy) => {
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
    const balanceHint =
      Number(accountBalance.availableCash || 0) === 0 && !accountBalance.error
        ? "Check signer/funder"
        : accountBalance.error
          ? "Balance error"
          : "CLOB balance";
    polymarketPanel.innerHTML = `
      ${cards}
      <div class="comparison-item">
        <span>${signalStrategy.toUpperCase()} signal</span>
        <strong>${signalAccount.lastSignal?.action || "--"}</strong>
        <small>${signalAccount.lastSignal?.side || "--"} / ${money(signalAccount.lastSignal?.move_at_entry_usd)}</small>
      </div>
      <div class="comparison-item">
        <span>Polymarket ask</span>
        <strong>${market.upAsk === undefined && market.downAsk === undefined ? "--" : `${price(market.upAsk)} / ${price(market.downAsk)}`}</strong>
        <small>UP / DOWN</small>
      </div>
      <div class="comparison-item">
        <span>Balance source</span>
        <strong>${balanceHint}</strong>
        <small>raw ${accountBalance.rawBalance ?? "--"} / allowance ${accountBalance.rawAllowance ?? "--"}</small>
      </div>
      <div class="comparison-item">
        <span>Signer / funder</span>
        <strong>${shortAddress(accountBalance.signerAddress)} / ${shortAddress(accountBalance.funderAddress)}</strong>
        <small>type ${accountBalance.signatureType ?? "--"} / ${accountBalance.apiCredsSource || "--"} / ${shortDate(accountBalance.checkedAt)}</small>
      </div>
    `;
  }

  renderPolymarketTrades(state.recentTrades || []);
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

function fillSafetyForm(state) {
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
}

function fillCompareForm(state) {
  if (!compareForm) return;
  compareForm.elements.primaryStrategy.value = normalizePrimaryStrategy(state.liveCompare?.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(state.liveCompare?.enabledStrategies, compareForm.elements.primaryStrategy.value);
  compareForm.querySelectorAll('input[name="compareStrategies"]').forEach((input) => {
    input.checked = enabledStrategies.includes(input.value);
  });
}

function fillPolymarketForm(state) {
  const polymarket = state.polymarket || {};
  const primaryStrategy = normalizePrimaryStrategy(polymarket.primaryStrategy);
  const enabledStrategies = normalizeCompareStrategies(polymarket.enabledStrategies, primaryStrategy);
  [polymarketForm, polyCompareForm].forEach((form) => {
    if (!form) return;
    if (form.elements.mode) form.elements.mode.value = form === polymarketForm ? "live" : "paper";
    form.elements.primaryStrategy.value = primaryStrategy;
    form.elements.profile.value = polymarket.profile || "conservative";
    form.querySelectorAll('input[name="compareStrategies"]').forEach((input) => {
      input.checked = enabledStrategies.includes(input.value);
    });
  });
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
    fillSafetyForm(payload);
    fillCompareForm(payload);
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    tradingNote.textContent = err.message || String(err);
  } finally {
    saveSafetyButton.disabled = false;
    saveSafetyButton.textContent = "Save live settings";
  }
}

async function savePolymarketSettings(event) {
  event.preventDefault();
  if (!polymarketForm.reportValidity()) return;
  savePolymarketButton.disabled = true;
  savePolymarketButton.textContent = "Saving";

  try {
    const payload = await persistPolymarketSettings();
    fillCompareForm(payload);
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    polymarketNote.textContent = err.message || String(err);
  } finally {
    savePolymarketButton.disabled = false;
    savePolymarketButton.textContent = "Save Polymarket live settings";
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
    const noteTarget = path.includes("polymarket") ? polymarketNote : path.includes("live-compare") ? compareWorkerNote : tradingNote;
    noteTarget.textContent = err.message || String(err);
  } finally {
    button.textContent = label;
  }
}

async function startPaperWorker() {
  if (!safetyForm.reportValidity()) return;
  let started = false;
  startPaperButton.disabled = true;
  startPaperButton.textContent = "Saving settings";
  try {
    await persistSafetySettings();
    startPaperButton.textContent = "Starting Kalshi";
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
    startPaperButton.textContent = "Start Kalshi live";
  }
}

async function startCompareWorker() {
  if (!compareForm.reportValidity()) return;
  let started = false;
  startCompareButton.disabled = true;
  startCompareButton.textContent = "Saving settings";
  try {
    await persistCompareSettings();
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
    startPolyCompareButton.textContent = "Starting";
    const response = await fetch(apiPath("/api/polymarket/start"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not start Polymarket compare");
    }
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
    started = payload.polymarket?.workerStatus === "active";
  } catch (err) {
    polymarketNote.textContent = err.message || String(err);
  } finally {
    if (!started) startPolyCompareButton.disabled = false;
    startPolyCompareButton.textContent = "Start Polymarket compare";
  }
}

async function armPolymarketLive() {
  if (!polymarketForm.reportValidity()) return;
  armPolymarketLiveButton.disabled = true;
  armPolymarketLiveButton.textContent = "Arming";
  try {
    await persistPolymarketSettings(polymarketForm, "live");
    const response = await fetch(apiPath("/api/polymarket/arm-live"), { method: "POST" });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.state) renderTradingStatus(payload.state);
      throw new Error(payload.error || "could not arm Polymarket live mode");
    }
    fillPolymarketForm(payload);
    renderTradingStatus(payload);
  } catch (err) {
    polymarketNote.textContent = err.message || String(err);
  } finally {
    armPolymarketLiveButton.disabled = false;
    armPolymarketLiveButton.textContent = "Arm Polymarket live";
  }
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => showPage(button.dataset.page));
});
simForm.addEventListener("submit", runSimulation);
safetyForm.addEventListener("submit", saveSafetySettings);
polymarketForm.addEventListener("submit", savePolymarketSettings);
startPaperButton.addEventListener("click", startPaperWorker);
stopPaperButton.addEventListener("click", () => postTradingAction("/api/trading/stop", stopPaperButton, "Stop Kalshi"));
startCompareButton.addEventListener("click", startCompareWorker);
stopCompareButton.addEventListener("click", () =>
  postTradingAction("/api/trading/live-compare/stop", stopCompareButton, "Stop Kalshi compare"),
);
stopPolymarketButton.addEventListener("click", () =>
  postTradingAction("/api/polymarket/stop", stopPolymarketButton, "Stop Polymarket"),
);
startPolyCompareButton.addEventListener("click", startPolyCompareWorker);
stopPolyCompareButton.addEventListener("click", () =>
  postTradingAction("/api/polymarket/stop", stopPolyCompareButton, "Stop Polymarket compare"),
);
armPolymarketLiveButton.addEventListener("click", armPolymarketLive);
paperPolymarketButton.addEventListener("click", () =>
  postTradingAction("/api/polymarket/paper-mode", paperPolymarketButton, "Back to paper"),
);
loadTradingStatus();
