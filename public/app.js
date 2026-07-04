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
const tradeRows = document.querySelector("#tradeRows");
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
    profile: data.profile,
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

function renderTrades(items) {
  if (!items || items.length === 0) {
    tradeRows.innerHTML = '<tr><td colspan="5" class="empty">No trades matched these settings.</td></tr>';
    return;
  }

  tradeRows.innerHTML = items
    .map((trade) => {
      const won = Number(trade.pnl_usd) > 0;
      const resultClass = won ? "win" : "lose";
      const result = won ? "Win" : "Loss";
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
  const summary = report.summary || {};
  const returnPct = Number(summary.return_pct || 0);

  returnValue.textContent = pct(returnPct);
  returnValue.className = `return-value ${returnPct > 0 ? "gain" : returnPct < 0 ? "loss" : "neutral"}`;
  endingCash.textContent = money(summary.ending_cash);
  pnl.textContent = money(summary.total_pnl_usd);
  winRate.textContent = summary.win_rate === null || summary.win_rate === undefined ? "--" : pct(summary.win_rate * 100);
  trades.textContent = summary.trades ?? "--";
  rangeText.textContent = `${report.params?.interval_minutes || "--"}m | ${shortDate(report.simulated_present_started_at)} to ${shortDate(report.simulated_present_finished_at)} | ${summary.markets_replayed || 0} markets replayed`;
  renderTrades(report.trades);
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
