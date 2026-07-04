const form = document.querySelector("#simForm");
const statusBadge = document.querySelector("#statusBadge");
const runButton = document.querySelector("#runButton");
const returnValue = document.querySelector("#returnValue");
const rangeText = document.querySelector("#rangeText");
const endingCash = document.querySelector("#endingCash");
const pnl = document.querySelector("#pnl");
const winRate = document.querySelector("#winRate");
const trades = document.querySelector("#trades");
const tradeRows = document.querySelector("#tradeRows");
const API_BASE_URL = String(window.SIM_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");

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

function setStatus(text, state) {
  statusBadge.textContent = text;
  statusBadge.className = `status ${state || ""}`.trim();
}

function formData() {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    profile: data.profile,
    days: data.days,
    start: data.start || null,
    end: data.end || null,
    startingCash: data.startingCash,
    stakeUsd: data.stakeUsd,
    minBtcMoveUsd: data.minBtcMoveUsd,
    entrySecondsLeft: data.entrySecondsLeft,
    thresholdPrice: data.thresholdPrice,
    maxTrades: data.maxTrades,
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

function renderReport(report) {
  const summary = report.summary || {};
  const returnPct = Number(summary.return_pct || 0);

  returnValue.textContent = pct(returnPct);
  returnValue.className = `return-value ${returnPct > 0 ? "gain" : returnPct < 0 ? "loss" : "neutral"}`;
  endingCash.textContent = money(summary.ending_cash);
  pnl.textContent = money(summary.total_pnl_usd);
  winRate.textContent = summary.win_rate === null || summary.win_rate === undefined ? "--" : pct(summary.win_rate * 100);
  trades.textContent = summary.trades ?? "--";
  rangeText.textContent = `${shortDate(report.simulated_present_started_at)} to ${shortDate(report.simulated_present_finished_at)} | ${summary.markets_replayed || 0} markets replayed`;
  renderTrades(report.trades);
}

async function runSimulation(event) {
  event.preventDefault();
  setStatus("Running", "running");
  runButton.disabled = true;
  runButton.textContent = "Running simulation";

  try {
    const response = await fetch(`${API_BASE_URL}/api/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(formData()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "simulation failed");
    renderReport(payload);
    setStatus("Done", "done");
  } catch (err) {
    setStatus("Error", "error");
    rangeText.textContent = err.message || String(err);
  } finally {
    runButton.disabled = false;
    runButton.innerHTML = '<span class="play-icon" aria-hidden="true"></span>Run simulation';
  }
}

form.addEventListener("submit", runSimulation);
