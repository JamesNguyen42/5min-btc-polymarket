const apiBaseUrl = String(window.SIM_CONFIG?.apiBaseUrl || "").replace(/\/$/, "");
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const runState = {
  paper: { running: false, range: "now", amount: 100, controller: null, points: [], trades: [] },
  live: { running: false, range: "now", amount: 10, controller: null, points: [], trades: [] },
};
const kalshiProposalState = {
  proposal: null,
  phase: "idle",
  requestSequence: 0,
  expiresAt: 0,
};
let latestTradingState = null;
let controlsInitialized = false;
let messageTimer = null;
const readOnlyStatsPages = {
  btc5m: {
    prefix: "btc5m",
    pageId: "btcStatsPage",
    label: "BTC 5m",
    endpoint: "/api/btc-5m/stats",
    loaded: false,
    loading: false,
    marketEnd: 0,
  },
  btc15m: {
    prefix: "btc15m",
    pageId: "btcStatsPage",
    label: "BTC 15m",
    endpoint: "/api/btc-15m/stats",
    loaded: false,
    loading: false,
    marketEnd: 0,
  },
};

function apiPath(path) {
  return `${apiBaseUrl}${path}`;
}

async function request(path, options = {}) {
  const response = await fetch(apiPath(path), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function money(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

function percent(value) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : 0;
  return `${safe > 0 ? "+" : ""}${safe.toFixed(2)}%`;
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function probability(value) {
  const number = numericValue(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "--";
}

function btcPrice(value) {
  const number = numericValue(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(number);
}

function formatTime(value, compact = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-US", compact
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function formatTradeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function showMessage(text) {
  const element = $("#message");
  element.textContent = text;
  element.classList.add("visible");
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => element.classList.remove("visible"), 4200);
}

function pageElements(environment) {
  const prefix = environment === "paper" ? "paper" : "live";
  return {
    form: $(`#${prefix}Form`),
    button: $(`#${prefix}RunButton`),
    status: $(`#${prefix}Status`),
    won: $(`#${prefix}Won`),
    wonPct: $(`#${prefix}WonPct`),
    lost: $(`#${prefix}Lost`),
    lostPct: $(`#${prefix}LostPct`),
    balance: $(`#${prefix}Balance`),
    chart: $(`#${prefix}Chart`),
    detail: $(`#${prefix}ChartDetail`),
    kalshiBalance: environment === "live" ? $("#liveKalshiBalance") : null,
    kalshiBalanceError: environment === "live" ? $("#liveKalshiBalanceError") : null,
    trades: $(`#${prefix}Trades`),
    tradeCount: $(`#${prefix}TradeCount`),
  };
}

function proposalElements() {
  return {
    panel: $("#kalshiProposalPanel"),
    status: $("#kalshiProposalStatus"),
    details: $("#kalshiProposalDetails"),
    market: $("#kalshiProposalMarket"),
    action: $("#kalshiSuggestionAction"),
    ticker: $("#kalshiProposalTicker"),
    side: $("#kalshiProposalSide"),
    limitPrice: $("#kalshiProposalLimitPrice"),
    contracts: $("#kalshiProposalContracts"),
    fees: $("#kalshiProposalFees"),
    maxLoss: $("#kalshiProposalMaxLoss"),
    quoteTime: $("#kalshiProposalQuoteTime"),
    entryTiming: $("#kalshiSuggestionEntryTiming"),
    entryInstruction: $("#kalshiSuggestionEntryInstruction"),
    exitTiming: $("#kalshiSuggestionExitTiming"),
    exitInstruction: $("#kalshiSuggestionExitInstruction"),
    takeProfitRow: $("#kalshiSuggestionTakeProfitRow"),
    takeProfit: $("#kalshiSuggestionTakeProfit"),
    stopLossRow: $("#kalshiSuggestionStopLossRow"),
    stopLoss: $("#kalshiSuggestionStopLoss"),
    exitByRow: $("#kalshiSuggestionExitByRow"),
    exitBy: $("#kalshiSuggestionExitBy"),
    expires: $("#kalshiProposalExpires"),
    rationale: $("#kalshiProposalRationale"),
    sources: $("#kalshiProposalSources"),
    accept: $("#kalshiAcceptProposal"),
  };
}

function setRunning(environment, running, label = "") {
  const state = runState[environment];
  const elements = pageElements(environment);
  state.running = running;
  elements.button.textContent = running ? "Stop" : "Run";
  elements.button.classList.toggle("stop", running);
  elements.status.textContent = label || (running ? "Running" : "Stopped");
}

function formValues(environment) {
  const form = pageElements(environment).form;
  return {
    model: String(form.elements.model.value || "llama"),
    amount: Math.max(1, Number(form.elements.amount.value || (environment === "live" ? 10 : 100))),
    range: String(form.elements.range.value || "now"),
    startDate: form.elements.startDate.value || "",
  };
}

function rangeStart(values) {
  const now = new Date();
  if (values.range === "14d") return new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  if (values.range === "custom") {
    const selected = new Date(`${values.startDate}T00:00:00`);
    if (!values.startDate || Number.isNaN(selected.getTime()) || selected >= now) {
      throw new Error("Choose a date before today.");
    }
    return selected;
  }
  return now;
}

function modelStrategy(model) {
  if (model === "nemotron") return "v3";
  if (model === "consensus") return "compare";
  return "v2";
}

function allocationSettings(environment, amount, venue) {
  const allocation = Math.max(1, amount / 2);
  const maxStakeUsd = Math.min(allocation, Math.max(1, allocation * 0.1));
  const common = {
    mode: environment,
    liveBudgetUsd: amount,
    primaryStrategy: "v1",
    killSwitch: false,
    maxDailyLossUsd: allocation,
    maxDailyLossPct: 100,
    maxTotalLossUsd: allocation,
    maxTotalLossPct: 100,
    maxStakeUsd,
    maxTradesPerDay: 100,
  };
  if (venue === "kalshi") {
    return { ...common, paperStartingCash: allocation, entrySecondsLeft: 180, minSecondsLeft: 60 };
  }
  return {
    ...common,
    profile: "conservative",
    compareStrategies: ["v1"],
    entrySecondsLeft: 180,
    minSecondsLeft: 10,
  };
}

function paperSettings(amount, totalAmount = amount, venue = "kalshi") {
  return {
    mode: "paper",
    profile: "conservative",
    paperStartingCash: amount,
    paperBudgetUsd: totalAmount,
    primaryStrategy: "v1",
    compareStrategies: ["v1"],
    maxDailyLossUsd: amount,
    maxDailyLossPct: 100,
    maxTotalLossUsd: amount,
    maxTotalLossPct: 100,
    maxStakeUsd: Math.min(amount, Math.max(1, amount * 0.1)),
    maxTradesPerDay: 100,
    entrySecondsLeft: 180,
    minSecondsLeft: venue === "polymarket" ? 10 : 60,
  };
}

async function saveSelectedModel(environment, model, signal) {
  return request("/api/ai/settings", {
    method: "POST",
    signal,
    body: JSON.stringify(environment === "paper" ? { paperModel: model } : { liveModel: model }),
  });
}

function tradeTimestamp(trade) {
  return trade.sim_now_entry || trade.ts || trade.market_end || new Date().toISOString();
}

function buildCurve(amount, trades, startTime, endTime = new Date()) {
  const sorted = [...trades].sort((a, b) => Date.parse(tradeTimestamp(a)) - Date.parse(tradeTimestamp(b)));
  let balance = amount;
  const points = [{ time: new Date(startTime).toISOString(), money: amount, pnl: 0 }];
  for (const trade of sorted) {
    const pnl = Number(trade.pnl_usd || 0);
    balance += pnl;
    points.push({ time: new Date(tradeTimestamp(trade)).toISOString(), money: balance, pnl });
  }
  const finalTime = new Date(Math.max(new Date(endTime).getTime(), new Date(startTime).getTime() + 60_000));
  if (points.length === 1 || Date.parse(points.at(-1).time) < finalTime.getTime()) {
    points.push({ time: finalTime.toISOString(), money: balance, pnl: 0 });
  }
  return points;
}

function downsample(points, maximum = 240) {
  if (points.length <= maximum) return points;
  const sampled = [points[0]];
  const step = (points.length - 2) / (maximum - 2);
  for (let index = 0; index < maximum - 2; index += 1) {
    sampled.push(points[1 + Math.round(index * step)]);
  }
  sampled.push(points.at(-1));
  return sampled;
}

function tradeName(trade) {
  const market = String(
    trade.title || trade.market || trade.market_slug || trade.marketTicker || trade.eventTicker || "Trade",
  ).trim();
  const side = String(trade.side || trade.live_market_side || "").trim().toUpperCase();
  return side ? `${market} · ${side}` : market;
}

function tradeTimeMs(trade) {
  const parsed = Date.parse(tradeTimestamp(trade));
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderTradeHistory(environment, trades) {
  const elements = pageElements(environment);
  const completed = (Array.isArray(trades) ? trades : [])
    .filter((trade) => !trade.summary_adjustment && Number.isFinite(Number(trade.pnl_usd)))
    .sort((a, b) => tradeTimeMs(b) - tradeTimeMs(a));
  const visible = completed.slice(0, 200);
  elements.tradeCount.textContent = completed.length > visible.length
    ? `Latest ${visible.length} of ${completed.length}`
    : `${completed.length} ${completed.length === 1 ? "trade" : "trades"}`;
  elements.trades.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("li");
    empty.className = "trade-empty";
    empty.textContent = "No completed trades yet.";
    elements.trades.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const trade of visible) {
    const timestampMs = tradeTimeMs(trade);
    const pnl = Number(trade.pnl_usd);
    const row = document.createElement("li");
    row.className = "trade-row";

    const name = document.createElement("span");
    name.className = "trade-name";
    name.textContent = tradeName(trade);

    const time = document.createElement("time");
    time.className = "trade-time";
    if (timestampMs) time.dateTime = new Date(timestampMs).toISOString();
    time.textContent = formatTradeTime(timestampMs || tradeTimestamp(trade));

    const net = document.createElement("span");
    net.className = "trade-net";
    net.textContent = `${pnl > 0 ? "+" : ""}${money(pnl)}`;

    row.append(name, time, net);
    fragment.append(row);
  }
  elements.trades.append(fragment);
}

function renderPerformance(environment, amount, trades, points) {
  const elements = pageElements(environment);
  const won = trades.reduce((sum, trade) => sum + Math.max(0, Number(trade.pnl_usd || 0)), 0);
  const lost = trades.reduce((sum, trade) => sum + Math.min(0, Number(trade.pnl_usd || 0)), 0);
  const current = points.length ? Number(points.at(-1).money) : amount;
  elements.won.textContent = money(won);
  elements.wonPct.textContent = percent((won / amount) * 100);
  elements.lost.textContent = money(lost);
  elements.lostPct.textContent = percent((lost / amount) * 100);
  elements.balance.textContent = money(current);
  renderChart(environment, points.length ? points : buildCurve(amount, [], new Date(), new Date()));
  renderTradeHistory(environment, trades);
}

function renderChart(environment, inputPoints) {
  const elements = pageElements(environment);
  const points = downsample(inputPoints);
  const width = 1000;
  const height = window.innerWidth <= 560 ? 440 : 620;
  const margin = { top: 34, right: 28, bottom: 38, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = points.map((point) => Number(point.money));
  const times = points.map((point) => Date.parse(point.time));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = rawMax - rawMin || Math.max(1, Math.abs(rawMax) * 0.08);
  const minMoney = rawMin - spread * 0.12;
  const maxMoney = rawMax + spread * 0.12;
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpread = maxTime - minTime || 1;
  const x = (value) => margin.left + ((value - minTime) / timeSpread) * plotWidth;
  const y = (value) => margin.top + (1 - (value - minMoney) / (maxMoney - minMoney)) * plotHeight;
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(Date.parse(point.time)).toFixed(2)},${y(point.money).toFixed(2)}`).join(" ");
  const moneyTicks = Array.from({ length: 5 }, (_, index) => minMoney + ((maxMoney - minMoney) * index) / 4);
  const timeTickCount = window.innerWidth <= 560 ? 3 : 5;
  const timeTicks = Array.from(
    { length: timeTickCount },
    (_, index) => minTime + (timeSpread * index) / (timeTickCount - 1),
  );
  const last = points.at(-1);

  const grid = moneyTicks
    .map((tick) => `<line class="grid-line" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}" />
      <text x="${margin.left - 10}" y="${y(tick) + 4}" text-anchor="end">${money(tick)}</text>`)
    .join("");
  const timeAxis = timeTicks
    .map((tick, index) => `<line class="axis-line" x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${height - margin.bottom}" />
      <text x="${x(tick)}" y="${height - 13}" text-anchor="${index === 0 ? "start" : index === timeTicks.length - 1 ? "end" : "middle"}">${formatTime(tick, timeSpread > 3 * 24 * 60 * 60 * 1000)}</text>`)
    .join("");
  const marks = points
    .map((point, index) => `<circle class="money-point" cx="${x(Date.parse(point.time))}" cy="${y(point.money)}" r="${index === points.length - 1 ? 5 : 3}" data-point="${index}" />`)
    .join("");

  elements.chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${environment}ChartTitle ${environment}ChartDesc">
    <title id="${environment}ChartTitle">Money over time</title>
    <desc id="${environment}ChartDesc">Time is on the horizontal axis and money is on the vertical axis. Current balance is ${money(last.money)}.</desc>
    ${grid}
    ${timeAxis}
    <line class="start-line" x1="${margin.left}" y1="${y(points[0].money)}" x2="${width - margin.right}" y2="${y(points[0].money)}" />
    <path class="money-line" d="${path}" />
    ${marks}
    <text class="current-label" x="${Math.min(width - margin.right - 4, x(Date.parse(last.time)) - 6)}" y="${Math.max(margin.top + 12, y(last.money) - 10)}" text-anchor="end">${money(last.money)}</text>
  </svg>`;

  elements.chart.querySelectorAll("[data-point]").forEach((mark) => {
    const show = () => {
      const point = points[Number(mark.dataset.point)];
      elements.detail.textContent = `${formatTime(point.time)} · ${money(point.money)}${point.pnl ? ` · ${point.pnl > 0 ? "+" : ""}${money(point.pnl)}` : ""}`;
    };
    mark.addEventListener("mouseenter", show);
    mark.addEventListener("click", show);
  });
}

function historicalTradesFromReport(report) {
  if (report?.mode === "virtual_backtest_comparison" && report.strategies) {
    return report.strategies.v3?.trades || report.strategies.v2?.trades || report.strategies.v1?.trades || [];
  }
  return report?.trades || [];
}

function primaryHistoricalReport(report) {
  if (report?.mode === "virtual_backtest_comparison" && report.strategies) {
    return report.strategies.v3 || report.strategies.v2 || report.strategies.v1 || report;
  }
  return report;
}

async function showReplayFrame(minimumFrameMs, startedAt) {
  const remaining = Math.max(0, minimumFrameMs - (performance.now() - startedAt));
  await new Promise((resolve) => {
    requestAnimationFrame(() => window.setTimeout(resolve, remaining));
  });
}

async function runHistorical(environment, values) {
  const state = runState[environment];
  const start = rangeStart(values);
  const end = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const totalDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / dayMs));
  const minimumFrameMs = totalDays <= 31 ? 250 : totalDays <= 120 ? 80 : 25;
  const routeBalances = [values.amount / 2, values.amount / 2];
  const strategyMode = modelStrategy(values.model);
  const controller = new AbortController();
  const trades = [];
  let cursor = new Date(start);
  let unavailableRoute = false;
  state.controller = controller;
  state.amount = values.amount;
  state.range = values.range;
  state.trades = [];
  state.points = buildCurve(values.amount, [], start, start);
  renderPerformance(environment, values.amount, [], state.points);
  setRunning(environment, true, `Day 1 of ${totalDays}`);

  const simulate = (intervalMinutes, routeIndex, dayStart, dayEnd) =>
    request("/api/simulate", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        dataMode: "historical",
        profile: "conservative",
        intervalMinutes,
        strategyMode,
        start: dayStart.toISOString(),
        end: dayEnd.toISOString(),
        startingCash: routeBalances[routeIndex],
        stakeUsd: Math.min(routeBalances[routeIndex], Math.max(1, routeBalances[routeIndex] * 0.1)),
        minBtcMoveUsd: 70,
        entrySecondsLeft: intervalMinutes === 5 ? 120 : 180,
        minSecondsLeft: intervalMinutes === 5 ? 10 : 60,
        thresholdPrice: 0.7,
        maxTrades: 100,
      }),
    });

  try {
    await saveSelectedModel(environment, values.model, controller.signal);
    for (let dayIndex = 0; cursor < end; dayIndex += 1) {
      if (controller.signal.aborted) return;
      const frameStartedAt = performance.now();
      const dayEnd = new Date(Math.min(cursor.getTime() + dayMs, end.getTime()));
      setRunning(environment, true, `Day ${dayIndex + 1} of ${totalDays}`);

      const results = await Promise.allSettled([
        simulate(5, 0, cursor, dayEnd),
        simulate(15, 1, cursor, dayEnd),
      ]);
      if (controller.signal.aborted) return;
      if (results.every((result) => result.status === "rejected")) {
        throw results[0].reason || results[1].reason || new Error("Replay failed.");
      }

      results.forEach((result, routeIndex) => {
        if (result.status !== "fulfilled") {
          unavailableRoute = true;
          return;
        }
        const report = result.value;
        const primary = primaryHistoricalReport(report);
        const dayTrades = historicalTradesFromReport(report);
        const reportedNet = Number(primary?.summary?.total_pnl_usd || 0);
        const previewNet = dayTrades.reduce((sum, trade) => sum + Number(trade.pnl_usd || 0), 0);
        const omittedNet = Number((reportedNet - previewNet).toFixed(6));
        trades.push(...dayTrades);
        if (Math.abs(omittedNet) > 0.000001) {
          trades.push({ sim_now_entry: dayEnd.toISOString(), pnl_usd: omittedNet, summary_adjustment: true });
        }
        const endingCash = Number(primary?.summary?.ending_cash);
        routeBalances[routeIndex] = Number.isFinite(endingCash)
          ? endingCash
          : routeBalances[routeIndex] + reportedNet;
      });

      const points = buildCurve(values.amount, trades, start, dayEnd);
      state.trades = [...trades];
      state.points = points;
      renderPerformance(environment, values.amount, trades, points);
      pageElements(environment).detail.textContent = `Day ${dayIndex + 1} of ${totalDays} · through ${formatTime(dayEnd)}`;
      cursor = dayEnd;
      await showReplayFrame(minimumFrameMs, frameStartedAt);
      if (controller.signal.aborted) return;
    }
    pageElements(environment).detail.textContent = `${formatTime(start)} to ${formatTime(end)} · replay complete.`;
    if (unavailableRoute) showMessage("One market route was unavailable for part of the replay.");
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      setRunning(environment, false);
    }
  }
}

async function stopWorkers(environment) {
  const routes = environment === "paper"
    ? ["/api/trading/live-compare/stop", "/api/polymarket/paper/stop"]
    : ["/api/trading/stop", "/api/polymarket/live/stop"];
  const results = await Promise.allSettled(
    routes.map((route) => request(route, { method: "POST", body: "{}" })),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

async function startCurrent(environment, values) {
  if (environment !== "paper") throw new Error("Live mode only creates proposals for manual placement on Kalshi.");

  setRunning(environment, true, "Starting");
  await saveSelectedModel(environment, values.model);
  const settings = await Promise.allSettled([
    request("/api/trading/live-compare/settings", {
      method: "POST",
      body: JSON.stringify(paperSettings(values.amount / 2, values.amount)),
    }),
    request("/api/polymarket/paper/settings", {
      method: "POST",
      body: JSON.stringify(paperSettings(values.amount / 2, values.amount, "polymarket")),
    }),
  ]);
  if (settings.every((result) => result.status === "rejected")) {
    setRunning(environment, false);
    throw settings[0].reason;
  }

  const starts = await Promise.allSettled([
    request("/api/trading/live-compare/start", { method: "POST", body: "{}" }),
    request("/api/polymarket/paper/start", { method: "POST", body: "{}" }),
  ]);
  const succeeded = starts.filter((result) => result.status === "fulfilled");
  if (!succeeded.length) {
    setRunning(environment, false);
    throw starts[0].reason || starts[1].reason || new Error("No configured market route could start.");
  }

  runState[environment].amount = values.amount;
  runState[environment].range = "now";
  runState[environment].trades = [];
  runState[environment].points = buildCurve(values.amount, [], new Date(), new Date());
  setRunning(environment, true);
  if (succeeded.length < starts.length) showMessage("Running on the configured account that was available.");
  await loadStatus();
}

async function stopRun(environment) {
  const state = runState[environment];
  if (state.controller) {
    state.controller.abort();
    state.controller = null;
    setRunning(environment, false);
    return;
  }
  const elements = pageElements(environment);
  elements.button.disabled = true;
  try {
    await stopWorkers(environment);
    setRunning(environment, false);
    await loadStatus();
  } finally {
    elements.button.disabled = false;
  }
}

async function handleRun(event, environment) {
  event.preventDefault();
  if (runState[environment].running) {
    try {
      await stopRun(environment);
    } catch (error) {
      showMessage(`Could not stop ${environment}: ${error.message || String(error)}`);
      await loadStatus();
    }
    return;
  }
  const values = formValues(environment);
  try {
    if (values.range === "now") await startCurrent(environment, values);
    else await runHistorical(environment, values);
  } catch (error) {
    if (error?.name !== "AbortError") showMessage(error.message || String(error));
    setRunning(environment, false);
  }
}

function settledTrades(state, environment) {
  const kalshi = environment === "live"
    ? (state?.recentTrades || []).filter((trade) =>
      ["kalshi_live_settlement", "kalshi_live_order_recovery_pending"].includes(trade.kind),
    )
    : [
      ...(state?.liveCompare?.recentTrades || []).filter((trade) =>
        trade.kind === "paper_settlement" || trade.status === "won" || trade.status === "lost",
      ),
      ...(state?.recentTrades || []).filter((trade) => trade.kind === "paper_settlement"),
    ];
  const poly = (state?.polymarket?.recentTrades || []).filter((trade) => {
    const settled = trade.status === "won" || trade.status === "lost";
    if (environment === "live" && trade.kind === "polymarket_live_order_recovery_pending") return true;
    if (!settled) return false;
    if (environment === "live") return Boolean(trade.live_order_id);
    const paperStrategy = String(state?.polymarket?.paperStrategy || "v3").toUpperCase();
    return !trade.live_order_id && String(trade.strategy || "").toUpperCase() === paperStrategy;
  });
  const unique = new Map();
  for (const trade of [...kalshi, ...poly]) {
    const key = [trade.venue || "KALSHI", trade.market, tradeTimestamp(trade), trade.pnl_usd, trade.live_order_id || ""].join("|");
    if (!unique.has(key)) unique.set(key, trade);
  }
  return [...unique.values()];
}

function renderCurrentState(state, environment) {
  const runner = runState[environment];
  if (runner.range !== "now") return;
  const paperCompareRunning = environment === "paper" && state.liveCompare?.workerStatus === "active";
  const paperPolyRunning = environment === "paper" && state.polymarket?.paperEnabled === true;
  const legacyPaperRunning = environment === "paper" && state.workerStatus === "active" && state.mode === "paper";
  const kalshiRunning = environment === "live" && state.workerStatus === "active" && state.mode === "live";
  const polyRunning = environment === "live" && state.polymarket?.workerStatus === "active" && state.polymarket?.mode === "live";
  const configuredAmount = environment === "paper"
    ? Number(state.paperBudgetUsd)
    : Number(state.liveBudgetUsd);
  if (Number.isFinite(configuredAmount) && configuredAmount > 0) runner.amount = configuredAmount;
  const running = paperCompareRunning || paperPolyRunning || legacyPaperRunning || kalshiRunning || polyRunning;
  setRunning(environment, running);
  if (!running && !runner.points.length) return;
  const trades = settledTrades(state, environment);
  const startedAt = [
    paperCompareRunning ? state.liveCompare?.startedAt : null,
    paperPolyRunning ? state.polymarket?.paperStartedAt : null,
    legacyPaperRunning ? state.startedAt : null,
    kalshiRunning ? state.startedAt : null,
    polyRunning ? state.polymarket?.startedAt : null,
  ].filter(Boolean).sort()[0] || trades.map(tradeTimestamp).sort()[0] || new Date().toISOString();
  const points = buildCurve(runner.amount, trades, startedAt, new Date());
  runner.trades = trades;
  runner.points = points;
  renderPerformance(environment, runner.amount, trades, points);
  pageElements(environment).detail.textContent = running ? `Started ${formatTime(startedAt)}.` : "Stopped.";
}

function renderKalshiBalance(state, requestError = "") {
  const elements = pageElements("live");
  const element = elements.kalshiBalance;
  const value = state?.accountBalance?.availableCash;
  const amount = value === null || value === undefined || value === "" ? NaN : Number(value);
  element.textContent = Number.isFinite(amount) ? money(amount) : "Unavailable";
  elements.kalshiBalanceError.textContent = Number.isFinite(amount)
    ? ""
    : requestError || state?.accountBalance?.error || "Kalshi returned no readable balance.";
}

function proposalValue(proposal, ...names) {
  for (const name of names) {
    const value = proposal?.[name];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function proposalNumber(proposal, ...names) {
  const value = proposalValue(proposal, ...names);
  if (value === null || value === undefined || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function proposalMoney(proposal, ...names) {
  const number = proposalNumber(proposal, ...names);
  return Number.isFinite(number) ? money(number) : "--";
}

function proposalLimitPrice(proposal) {
  const cents = proposalNumber(proposal, "limitPriceCents", "limit_price_cents");
  if (Number.isFinite(cents)) return `${cents.toFixed(Number.isInteger(cents) ? 0 : 1)}¢`;
  const dollars = proposalNumber(proposal, "limitPriceDollars", "limit_price_dollars", "limitPrice", "limit_price", "price");
  if (!Number.isFinite(dollars)) return "--";
  if (dollars >= 0 && dollars <= 1) {
    const value = dollars * 100;
    return `${value.toFixed(Number.isInteger(value) ? 0 : 1)}¢`;
  }
  return money(dollars);
}

function proposalExpiryTimestamp(proposal) {
  const parsed = Date.parse(String(proposalValue(proposal, "expiresAt", "expires_at") || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function proposalTimestamp(proposal, ...names) {
  const parsed = Date.parse(String(proposalValue(proposal, ...names) || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function suggestionAction(proposal) {
  const action = String(proposalValue(proposal, "action", "orderAction", "order_action") || "").toUpperCase();
  return ["BUY", "SELL"].includes(action) ? action : action === "WAIT" ? "WAIT" : "--";
}

function suggestionStatus(proposal) {
  if (!proposal) return "NO SUGGESTION";
  const status = String(proposalValue(proposal, "status") || "").toLowerCase();
  if (status === "accepted") return "ACCEPTED";
  const expiresAt = proposalExpiryTimestamp(proposal);
  if (expiresAt && expiresAt <= Date.now()) return "EXPIRED";
  const validFrom = proposalTimestamp(proposal, "validFrom", "valid_from");
  if (validFrom && validFrom > Date.now()) return "SCHEDULED";
  if (status === "expired") return "EXPIRED";
  if (status === "scheduled") return "SCHEDULED";
  if (status === "live") return "LIVE";
  if (status === "informational" || suggestionAction(proposal) === "WAIT") return "WAIT";
  return "NO SUGGESTION";
}

function proposalCanBeAccepted(proposal) {
  const id = String(proposalValue(proposal, "id", "proposalId", "proposal_id") || "").trim();
  if (!id || suggestionStatus(proposal) !== "LIVE") return false;
  if (!["BUY", "SELL"].includes(suggestionAction(proposal))) return false;
  if (!["YES", "NO"].includes(String(proposalValue(proposal, "side") || "").toUpperCase())) return false;
  if (proposalValue(proposal, "canAccept", "can_accept") !== true) return false;
  return proposalValue(proposal, "orderSubmitted", "order_submitted") !== true;
}

function proposalPhase(proposal) {
  return suggestionStatus(proposal).toLowerCase().replace(/\s+/g, "_");
}

function proposalExpiryText(expiresAt, now = Date.now()) {
  if (!expiresAt) return "--";
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  if (!seconds) return `Expired | ${formatTime(expiresAt)}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  const remaining = minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
  return `${remaining} | ${formatTime(expiresAt)}`;
}

function suggestionTiming(value) {
  if (value === null || value === undefined || value === "") return "--";
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? formatTime(parsed) : String(value);
}

function optionalSuggestionField(row, element, value, formatter = String) {
  const present = value !== null && value !== undefined && value !== "";
  row.hidden = !present;
  element.textContent = present ? formatter(value) : "--";
}

function updateProposalControls() {
  const elements = proposalElements();
  const busy = ["loading", "accepting"].includes(kalshiProposalState.phase);
  elements.panel.setAttribute("aria-busy", String(busy));
  elements.accept.disabled = busy || !proposalCanBeAccepted(kalshiProposalState.proposal);
  elements.accept.textContent = kalshiProposalState.phase === "accepting"
    ? "Recording acceptance…"
    : "Accept suggestion";
}

function renderKalshiProposal(proposal, { phase = "" } = {}) {
  const elements = proposalElements();
  kalshiProposalState.proposal = proposal && typeof proposal === "object" ? proposal : null;
  kalshiProposalState.phase = phase || proposalPhase(kalshiProposalState.proposal);
  kalshiProposalState.expiresAt = proposalExpiryTimestamp(kalshiProposalState.proposal);
  const status = suggestionStatus(kalshiProposalState.proposal);
  elements.status.textContent = status;
  elements.details.hidden = !kalshiProposalState.proposal || status === "NO SUGGESTION";

  if (elements.details.hidden) {
    elements.expires.removeAttribute("datetime");
    updateProposalControls();
    return;
  }

  const current = kalshiProposalState.proposal;
  const title = proposalValue(current, "title", "marketTitle", "market_title", "market") || "Untitled Kalshi market";
  const ticker = proposalValue(current, "ticker", "marketTicker", "market_ticker") || "--";
  const side = String(proposalValue(current, "side") || "--").toUpperCase();
  const contracts = proposalNumber(current, "contracts", "count");
  const actionable = ["BUY", "SELL"].includes(suggestionAction(current));
  const quoteObservedAt = actionable ? proposalValue(
    current,
    "quoteObservedAt",
    "quote_observed_at",
    "sourceDecisionTimestamp",
    "source_decision_timestamp",
    "generatedAt",
    "generated_at",
    "createdAt",
    "created_at",
  ) : null;

  elements.market.textContent = String(title);
  elements.action.textContent = suggestionAction(current);
  elements.ticker.textContent = String(ticker);
  elements.side.textContent = side;
  elements.limitPrice.textContent = proposalLimitPrice(current);
  elements.contracts.textContent = Number.isFinite(contracts) ? new Intl.NumberFormat("en-US").format(contracts) : "--";
  elements.fees.textContent = proposalMoney(
    current,
    "estimatedFeeDollars",
    "estimated_fee_dollars",
    "estimatedFeeUsd",
    "estimated_fee_usd",
    "estimatedFeesUsd",
    "estimated_fees_usd",
  );
  elements.maxLoss.textContent = proposalMoney(current, "maxLossDollars", "max_loss_dollars", "maxLossUsd", "max_loss_usd");
  elements.quoteTime.textContent = quoteObservedAt ? formatTime(quoteObservedAt) : "--";
  elements.entryTiming.textContent = actionable
    ? suggestionTiming(proposalValue(current, "entryTiming", "entry_timing", "validFrom", "valid_from"))
    : "--";
  elements.entryInstruction.textContent = String(proposalValue(current, "entryInstruction", "entry_instruction") || "--");
  elements.exitTiming.textContent = suggestionTiming(proposalValue(current, "exitTiming", "exit_timing", "exitBy", "exit_by"));
  elements.exitInstruction.textContent = String(proposalValue(current, "exitInstruction", "exit_instruction") || "--");
  optionalSuggestionField(
    elements.takeProfitRow,
    elements.takeProfit,
    proposalValue(current, "takeProfitPriceDollars", "take_profit_price_dollars", "takeProfit", "take_profit"),
    (value) => proposalLimitPrice({ limitPriceDollars: value }),
  );
  optionalSuggestionField(
    elements.stopLossRow,
    elements.stopLoss,
    proposalValue(current, "stopLossPriceDollars", "stop_loss_price_dollars", "stopLoss", "stop_loss"),
    (value) => proposalLimitPrice({ limitPriceDollars: value }),
  );
  optionalSuggestionField(
    elements.exitByRow,
    elements.exitBy,
    proposalValue(current, "exitBy", "exit_by"),
    suggestionTiming,
  );
  elements.expires.textContent = proposalExpiryText(kalshiProposalState.expiresAt);
  if (kalshiProposalState.expiresAt) {
    elements.expires.setAttribute("datetime", new Date(kalshiProposalState.expiresAt).toISOString());
  } else {
    elements.expires.removeAttribute("datetime");
  }
  elements.rationale.textContent = String(proposalValue(current, "rationale", "reasoning", "reason") || "No rationale was provided.");
  elements.sources.replaceChildren();
  const sources = proposalValue(current, "sources", "headlines");
  if (!Array.isArray(sources) || !sources.length) {
    const empty = document.createElement("li");
    empty.textContent = "No qualifying sources were attached to this proposal.";
    elements.sources.append(empty);
  } else {
    for (const source of sources) {
      const item = document.createElement("li");
      const title = String(source?.label || source?.title || source?.source || "Research source");
      const titleElement = document.createElement("span");
      titleElement.textContent = title;
      item.append(titleElement);
      const metadata = [source?.source, source?.publishedAt ? formatTime(source.publishedAt) : ""].filter(Boolean).join(" | ");
      if (metadata) {
        const detail = document.createElement("small");
        detail.textContent = metadata;
        item.append(detail);
      }
      elements.sources.append(item);
    }
  }
  updateProposalControls();
}

function updateKalshiProposalTiming() {
  const proposal = kalshiProposalState.proposal;
  if (!proposal) return;
  const elements = proposalElements();
  const actionable = ["BUY", "SELL"].includes(suggestionAction(proposal));
  elements.expires.textContent = proposalExpiryText(kalshiProposalState.expiresAt);
  elements.entryTiming.textContent = actionable
    ? suggestionTiming(proposalValue(proposal, "entryTiming", "entry_timing", "validFrom", "valid_from"))
    : "--";
  elements.exitTiming.textContent = suggestionTiming(proposalValue(proposal, "exitTiming", "exit_timing", "exitBy", "exit_by"));
  elements.status.textContent = suggestionStatus(proposal);
  if (kalshiProposalState.phase !== "accepting") kalshiProposalState.phase = proposalPhase(proposal);
  updateProposalControls();
}

async function loadCurrentKalshiProposal({ announceError = false } = {}) {
  if (kalshiProposalState.phase === "accepting") return;
  const sequence = ++kalshiProposalState.requestSequence;
  if (!kalshiProposalState.proposal) renderKalshiProposal(null, { phase: "loading" });
  try {
    const data = await request("/api/proposals/current");
    if (sequence !== kalshiProposalState.requestSequence) return;
    renderKalshiProposal(data?.proposal || null);
  } catch (error) {
    if (sequence !== kalshiProposalState.requestSequence) return;
    const message = error.message || String(error);
    kalshiProposalState.phase = "error";
    updateProposalControls();
    if (announceError) showMessage(`Could not load a proposal: ${message}`);
  }
}

async function acceptKalshiProposal() {
  const current = kalshiProposalState.proposal;
  if (!proposalCanBeAccepted(current)) {
    renderKalshiProposal(current);
    return;
  }
  const id = String(proposalValue(current, "id", "proposalId", "proposal_id"));
  const sequence = ++kalshiProposalState.requestSequence;
  renderKalshiProposal(current, { phase: "accepting" });
  try {
    const data = await request(`/api/proposals/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify({ confirmProposalId: id, acknowledgeLocalAcceptance: true }),
    });
    if (sequence !== kalshiProposalState.requestSequence) return;
    const accepted = data?.proposal;
    const acceptedId = String(proposalValue(accepted, "id", "proposalId", "proposal_id") || "");
    if (!accepted || acceptedId !== id) throw new Error("The server did not confirm the selected proposal.");
    if (data?.orderSubmitted === true || proposalValue(accepted, "orderSubmitted", "order_submitted") === true) {
      throw new Error("Acceptance response incorrectly reported an exchange order.");
    }
    renderKalshiProposal(accepted);
    showMessage("Suggestion accepted locally. No trade was placed.");
  } catch (error) {
    if (sequence !== kalshiProposalState.requestSequence) return;
    const message = error.message || String(error);
    renderKalshiProposal(current, { phase: "error" });
    showMessage(`Could not record acceptance: ${message}`);
  }
}

async function loadStatus() {
  try {
    const state = await request("/api/trading/status");
    latestTradingState = state;
    if (!controlsInitialized) {
      $("#paperForm").elements.model.value = state.ai?.paperModel || "llama";
      $("#liveForm").elements.model.value = state.ai?.liveModel || "llama";
      $("#paperForm").elements.amount.value = Number(state.paperBudgetUsd || 100);
      $("#liveForm").elements.amount.value = Number(state.liveBudgetUsd || 10);
      controlsInitialized = true;
    }
    renderKalshiBalance(state);
    renderCurrentState(state, "paper");
    renderCurrentState(state, "live");
  } catch (error) {
    renderKalshiBalance(null, `Trading API unavailable: ${error.message || String(error)}`);
  }
}

function updateDateField(form) {
  const custom = form.elements.range.value === "custom";
  const field = form.querySelector(".date-field");
  field.hidden = !custom;
  form.elements.startDate.required = custom;
}

function formatStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "--";
  return text.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statsElement(page, suffix) {
  return $(`#${page.prefix}${suffix}`);
}

function readOnlyStatsPageActive() {
  return Object.values(readOnlyStatsPages).some((page) => $(`#${page.pageId}`).classList.contains("active"));
}

function renderStatsCountdown(page) {
  const countdown = statsElement(page, "Countdown");
  if (!Number.isFinite(page.marketEnd) || page.marketEnd <= 0) {
    countdown.textContent = "--:--";
    return;
  }
  const seconds = Math.max(0, Math.ceil((page.marketEnd - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  countdown.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function renderReadOnlyStats(page, report) {
  const signal = report?.signal || report?.summary || {};
  const up = numericValue(signal.up_probability);
  const down = numericValue(signal.down_probability);
  const side = String(signal.side || "").toUpperCase();
  const predictedSide = side || (Number.isFinite(up) && Number.isFinite(down)
    ? (up === down ? "EVEN" : up > down ? "UP" : "DOWN")
    : "NO DATA");
  const action = String(signal.action || "NO_DATA").toUpperCase();
  const upWidth = Number.isFinite(up) ? Math.max(0, Math.min(100, up)) : 50;
  const downWidth = Number.isFinite(down) ? Math.max(0, Math.min(100, down)) : 50;
  const move = numericValue(signal.move_at_entry_usd);
  const threshold = numericValue(signal.dynamic_min_btc_move_usd);
  const confidence = numericValue(signal.confidence);
  const samples = numericValue(signal.probability_sample_count);
  const observedAt = report.generated_at || report.observed_at;

  statsElement(page, "Prediction").textContent = predictedSide;
  statsElement(page, "Prediction").dataset.direction = predictedSide.toLowerCase();
  statsElement(page, "UpProbability").textContent = probability(up);
  statsElement(page, "DownProbability").textContent = probability(down);
  statsElement(page, "UpBar").style.width = `${upWidth}%`;
  statsElement(page, "DownBar").style.width = `${downWidth}%`;
  statsElement(page, "PredictionDetail").textContent = Number.isFinite(samples)
    ? `Based on ${samples} similar completed intervals from yesterday and today.`
    : report.probability_note || "Probability context is not available yet.";
  statsElement(page, "Signal").textContent = side ? `${side} · ${action}` : action;
  statsElement(page, "SignalStatus").textContent = formatStatus(signal.status);
  statsElement(page, "BtcNow").textContent = btcPrice(signal.latest_btc);
  statsElement(page, "BtcOpen").textContent = btcPrice(signal.interval_open_btc);
  statsElement(page, "Move").textContent = Number.isFinite(move) ? `${move >= 0 ? "+" : "−"}${money(Math.abs(move))}` : "--";
  statsElement(page, "Move").dataset.direction = Number.isFinite(move) ? (move > 0 ? "up" : move < 0 ? "down" : "even") : "";
  statsElement(page, "MoveThreshold").textContent = Number.isFinite(threshold) ? `Trigger ${money(threshold)}` : "Trigger --";
  statsElement(page, "Confidence").textContent = Number.isFinite(confidence) ? `${confidence.toFixed(2)}×` : "--";
  statsElement(page, "Samples").textContent = Number.isFinite(samples) ? new Intl.NumberFormat("en-US").format(samples) : "--";
  statsElement(page, "Source").textContent = report.prediction_basis || report.data_source || "V1 algorithm using Coinbase candles only";
  statsElement(page, "Safety").textContent = report.stale
    ? `Algorithm only · showing cached data${report.refresh_error ? ` · ${report.refresh_error}` : ""}`
    : "Algorithm only · no venue data";
  statsElement(page, "Updated").textContent = observedAt ? `Updated ${formatTime(observedAt)}` : "Snapshot loaded";

  const marketEnd = Date.parse(report.market_end || "");
  page.marketEnd = Number.isFinite(marketEnd) ? marketEnd : 0;
  statsElement(page, "Window").textContent = page.marketEnd ? `Ends ${formatTime(page.marketEnd)}` : "No active interval";
  renderStatsCountdown(page);
}

async function loadReadOnlyStats(page, { announceError = true } = {}) {
  if (page.loading) return;
  page.loading = true;
  const button = statsElement(page, "Refresh");
  button.disabled = true;
  button.textContent = "Refreshing";
  statsElement(page, "Updated").textContent = page.loaded ? "Refreshing snapshot" : "Loading live snapshot";
  try {
    const report = await request(page.endpoint);
    renderReadOnlyStats(page, report);
    page.loaded = true;
  } catch (error) {
    statsElement(page, "Updated").textContent = "Snapshot unavailable";
    statsElement(page, "Prediction").textContent = "UNAVAILABLE";
    statsElement(page, "SignalStatus").textContent = error.message || String(error);
    if (announceError) showMessage(`${page.label} stats unavailable: ${error.message || String(error)}`);
  } finally {
    page.loading = false;
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

$$('.nav-button').forEach((button) => {
  button.addEventListener("click", () => {
    $$('.nav-button').forEach((item) => item.classList.toggle("active", item === button));
    $$('.page').forEach((page) => page.classList.toggle("active", page.id === button.dataset.page));
    const statsPages = Object.values(readOnlyStatsPages).filter((page) => page.pageId === button.dataset.page);
    if (statsPages.length) {
      for (const page of statsPages) loadReadOnlyStats(page);
      return;
    }
    const environment = button.dataset.page === "paperPage" ? "paper" : "live";
    if (environment === "live") loadCurrentKalshiProposal({ announceError: true });
    renderChart(environment, runState[environment].points.length ? runState[environment].points : buildCurve(runState[environment].amount, [], new Date(), new Date()));
  });
});

for (const page of Object.values(readOnlyStatsPages)) {
  statsElement(page, "Refresh").addEventListener("click", () => loadReadOnlyStats(page));
}

proposalElements().accept.addEventListener("click", acceptKalshiProposal);
$("#liveForm").addEventListener("submit", (event) => event.preventDefault());

for (const environment of ["paper", "live"]) {
  const form = pageElements(environment).form;
  if (environment === "paper") {
    const today = new Date().toISOString().slice(0, 10);
    form.elements.startDate.max = today;
    form.elements.startDate.value = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    form.elements.range.addEventListener("change", () => updateDateField(form));
    form.addEventListener("submit", (event) => handleRun(event, environment));
    updateDateField(form);
  }
  const initialAmount = environment === "live" ? 10 : 100;
  const initial = buildCurve(initialAmount, [], new Date(), new Date());
  runState[environment].points = initial;
  renderPerformance(environment, initialAmount, [], initial);
}

window.addEventListener("resize", () => {
  for (const environment of ["paper", "live"]) renderChart(environment, runState[environment].points);
});

renderKalshiProposal(null, { phase: "loading" });
loadCurrentKalshiProposal();
loadStatus();
setInterval(() => {
  if (!readOnlyStatsPageActive()) loadStatus();
}, 3000);
setInterval(() => {
  updateKalshiProposalTiming();
  for (const page of Object.values(readOnlyStatsPages)) renderStatsCountdown(page);
}, 1000);
setInterval(() => {
  loadCurrentKalshiProposal();
}, 5000);
setInterval(() => {
  for (const page of Object.values(readOnlyStatsPages)) {
    if ($(`#${page.pageId}`).classList.contains("active")) loadReadOnlyStats(page, { announceError: false });
  }
}, 15000);
