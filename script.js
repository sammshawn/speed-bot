// ============================================
//  SPEED BOT — V8.1 (Direct-Buy Engine)
//  - No proposals: trades are bought directly with `buy: 1` + `parameters`
//  - One trade at a time, watchdog timers can never deadlock
//  - Every API error is routed + logged, nothing fails silently
//  - Digits are read with the market's pip_size (no lost trailing zeros)
// ============================================

const CLIENT_ID = "34RaG6zRPpQYEeugvLnPq";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com/trading/v1/options";

// ---- State ----
let accessToken = null;
let accounts = [];
let activeAccount = null;      // { id, type, currency }
let ws = null;
let reqId = 1;
let reconnectAttempts = 0;
let reconnectTimer = null;

let isExecuting = false;       // bot on/off
let botState = "IDLE";         // IDLE | TRADING | HOOK | WAITING_RESULT | STOPPED
let stateBeforeTrade = "TRADING";
let tradeLock = false;         // true from buy request until contract settles
let currentContractId = null;
let buyTimer = null;
let resultTimer = null;
let buyErrors = 0;

let hookTicksCount = 0;
let currentMartingaleStep = 1;
let wins = 0, losses = 0, totalTrades = 0;
let totalPL = 0;
let lastTick = { price: null, digit: null };
let pocSeen = false;
let currentStake = 0.35;
let currentEntry = { price: null, digit: null };
const settledIds = new Set();
const learnedPip = {};         // symbol -> decimals seen

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const loginCard = $("loginCard");
const botDashboard = $("botDashboard");
const loginBtn = $("loginBtn");
const logoutBtn = $("logoutBtn");
const authText = $("authText");
const authDot = $("authDot");
const accountSwitcher = $("accountSwitcher");
const pillDemo = $("pillDemo");
const pillReal = $("pillReal");
const demoAccId = $("demoAccId");
const realAccId = $("realAccId");
const activeAccLabel = $("activeAccLabel");
const balanceEl = $("balance");
const tradeCountEl = $("tradeCount");
const winsEl = $("wins");
const lossesEl = $("losses");
const totalPLEl = $("totalPL");
const logBox = $("logBox");
const clearLogBtn = $("clearLogBtn");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const mbStatus = $("mbStatus");
const marketSelect = $("marketSelect");
const contractType = $("contractType");
const barrierInput = $("barrier");
const stakeInput = $("stake");
const martingaleMultiplier = $("martingaleMultiplier");
const martingaleMaxSteps = $("martingaleMaxSteps");

// ---- Helpers ----
const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;
function send(obj) {
  if (!wsOpen()) return false;
  obj.req_id = reqId++;
  ws.send(JSON.stringify(obj));
  return true;
}
const NEEDS_BARRIER = ["DIGITOVER", "DIGITUNDER", "DIGITMATCH", "DIGITDIFF"];
const round2 = (n) => Math.round(n * 100) / 100;
const getBase = () => parseFloat(stakeInput.value);
const getMult = () => parseFloat(martingaleMultiplier.value) || 2;
const getMaxSteps = () => parseInt(martingaleMaxSteps.value, 10) || 1;
const getBarrier = () => parseInt(barrierInput.value, 10);

function stakeForStep(step) {
  return round2(getBase() * Math.pow(getMult(), step - 1));
}

// Last digit taken from a string so trailing zeros are never lost
function lastDigit(str) {
  const m = String(str).match(/(\d)\D*$/);
  return m ? parseInt(m[1], 10) : 0;
}
function formatTick(tick) {
  const quote = Number(tick.quote);
  const decimals = (String(tick.quote).split(".")[1] || "").length;
  const pip = Number.isInteger(tick.pip_size)
    ? tick.pip_size
    : (learnedPip[tick.symbol] = Math.max(learnedPip[tick.symbol] || 0, decimals));
  return quote.toFixed(pip);
}

function checkWinCondition(digit) {
  const b = getBarrier();
  switch (contractType.value) {
    case "DIGITOVER":  return digit > b;
    case "DIGITUNDER": return digit < b;
    case "DIGITMATCH": return digit === b;
    case "DIGITDIFF":  return digit !== b;
    case "DIGITEVEN":  return digit % 2 === 0;
    case "DIGITODD":   return digit % 2 === 1;
    default:           return true;
  }
}

// ---- Logging ----
function timeNow() {
  return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
// Show a price with its last digit (the digit Deriv trades on) highlighted
function fixDecimals(p, ref) {
  const dec = (String(ref).split(".")[1] || "").length;
  const have = (String(p).split(".")[1] || "").length;
  return have < dec && Number.isFinite(Number(p)) ? Number(p).toFixed(dec) : String(p);
}
function priceHtml(price, digitClass) {
  const s = String(price);
  return `<span class="px">${s.slice(0, -1)}<span class="${digitClass} px-digit">${s.slice(-1)}</span></span>`;
}
function formatPL(pl) {
  return pl >= 0 ? `+$${pl.toFixed(2)}` : `-$${Math.abs(pl).toFixed(2)}`;
}
function updateTotalPL() {
  totalPLEl.textContent = formatPL(totalPL);
  totalPLEl.style.color = totalPL > 0 ? "var(--green)" : totalPL < 0 ? "var(--red)" : "";
}
function logTrade(type, entryPrice, entryDigit, exitPrice, exitDigit, stake, pl) {
  const el = document.createElement("div");
  el.className = `log-entry ${type}`;
  const digitClass = type === "win" ? "digit-green" : "digit-red";
  const plClass = pl >= 0 ? "pl-positive" : "pl-negative";
  el.innerHTML = `
    <div class="log-side log-entry-side">
      <span class="log-time">${timeNow()}</span>
      ${priceHtml(entryPrice, digitClass)}
      <span class="digit-badge ${digitClass}">${entryDigit}</span>
    </div>
    <div class="log-side log-exit-side">
      ${priceHtml(exitPrice, digitClass)}
      <span class="digit-badge ${digitClass}">${exitDigit}</span>
      <span class="${plClass} log-pl">${formatPL(pl)} <small>($${Number(stake).toFixed(2)})</small></span>
    </div>`;
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
}
function logInfo(msg) {
  const el = document.createElement("div");
  el.className = "log-entry info";
  const t = document.createElement("span");
  t.className = "log-time";
  t.textContent = timeNow();
  const m = document.createElement("span");
  m.style.gridColumn = "2 / -1";
  t.style.gridColumn = "1";
  m.textContent = msg;
  el.append(t, m);
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
}
clearLogBtn.addEventListener("click", () => { logBox.innerHTML = ""; });

// ---- AUTH (PKCE) ----
function generatePKCE() {
  const array = crypto.getRandomValues(new Uint8Array(64));
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const codeVerifier = Array.from(array).map((v) => chars[v % chars.length]).join("");
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, "0")).join("");
  sessionStorage.setItem("pkce_code_verifier", codeVerifier);
  sessionStorage.setItem("oauth_state", state);
  return { codeVerifier, state };
}
async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function startLogin() {
  loginBtn.disabled = true;
  loginBtn.textContent = "Redirecting…";
  const { codeVerifier, state } = generatePKCE();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: "trade", state, code_challenge: codeChallenge, code_challenge_method: "S256",
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}
async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");
  if (!code || !state) return false;
  if (state !== sessionStorage.getItem("oauth_state")) { logInfo("State mismatch."); return false; }
  const codeVerifier = sessionStorage.getItem("pkce_code_verifier");
  if (!codeVerifier) { logInfo("PKCE verifier missing."); return false; }
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", client_id: CLIENT_ID, code,
        redirect_uri: REDIRECT_URI, code_verifier: codeVerifier,
      }),
    });
    const data = await response.json();
    if (!response.ok) { logInfo(`Token error: ${data.error_description || data.error}`); return false; }
    accessToken = data.access_token;
    sessionStorage.setItem("deriv_access_token", accessToken);
    sessionStorage.removeItem("pkce_code_verifier");
    sessionStorage.removeItem("oauth_state");
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (err) { logInfo(`Network error: ${err.message}`); return false; }
}

// ---- ACCOUNTS ----
async function fetchAccounts() {
  try {
    const res = await fetch(`${API_BASE}/accounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) sessionStorage.removeItem("deriv_access_token");
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }
    accounts = data.data || [];
    const demo = accounts.find((a) => (a.type || a.account_type) === "demo");
    const real = accounts.find((a) => (a.type || a.account_type) === "real");
    if (demo) demoAccId.textContent = demo.account_id;
    if (real) realAccId.textContent = real.account_id;
    accountSwitcher.style.display = "flex";
    if (demo) selectAccount(demo);
    else if (real) selectAccount(real);
    else throw new Error("No demo or real account found");
    return true;
  } catch (err) { logInfo(`Account fetch failed: ${err.message}`); return false; }
}

async function selectAccount(acc) {
  if (isExecuting) stopBot("Account switched.");
  activeAccount = {
    id: acc.account_id,
    type: acc.type || acc.account_type,
    currency: acc.currency || "USD",
  };
  pillDemo.classList.toggle("active", activeAccount.type === "demo");
  pillReal.classList.toggle("active", activeAccount.type === "real");
  activeAccLabel.textContent = `${activeAccount.type.toUpperCase()} (${activeAccount.id})`;
  balanceEl.textContent = "Connecting...";
  startBtn.disabled = true;
  closeSocket();
  reconnectAttempts = 0;
  await connectWS();
}
pillDemo.addEventListener("click", () => {
  const a = accounts.find((x) => (x.type || x.account_type) === "demo");
  if (a) selectAccount(a);
});
pillReal.addEventListener("click", () => {
  const a = accounts.find((x) => (x.type || x.account_type) === "real");
  if (a) selectAccount(a);
});

// ---- WEBSOCKET ----
function closeSocket() {
  clearTimeout(reconnectTimer);
  if (ws) {
    const old = ws;
    ws = null;                 // handlers ignore sockets that are no longer current
    try { old.close(); } catch (_) {}
  }
}

async function connectWS() {
  if (!accessToken || !activeAccount) return;
  try {
    const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/otp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `OTP failed (HTTP ${res.status})`);

    const socket = new WebSocket(data.data.url);
    ws = socket;

    socket.onopen = () => {
      if (socket !== ws) return;
      reconnectAttempts = 0;
      send({ balance: 1, subscribe: 1 });
      subscribeTicks();
      // Resume tracking a contract that was open when the connection dropped
      if (currentContractId) send({ proposal_open_contract: 1, contract_id: currentContractId, subscribe: 1 });
      startBtn.disabled = isExecuting;
      logInfo("Connected. Ready.");
    };

    socket.onmessage = (event) => {
      if (socket !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (msg.error) { handleError(msg); return; }

      switch (msg.msg_type) {
        case "balance":
          if (msg.balance) {
            balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
            if (msg.balance.currency && activeAccount) activeAccount.currency = msg.balance.currency;
          }
          break;
        case "tick":
          if (msg.tick) handleTick(msg.tick);
          break;
        case "buy":
          handleBuy(msg.buy);
          break;
        case "proposal_open_contract":
          if (msg.proposal_open_contract) handleContractUpdate(msg.proposal_open_contract, msg.subscription);
          break;
      }
    };

    socket.onerror = () => { if (socket === ws) logInfo("Socket error."); };

    socket.onclose = () => {
      if (socket !== ws) return;     // deliberate close / old socket
      ws = null;
      startBtn.disabled = true;
      scheduleReconnect();
    };
  } catch (err) {
    logInfo(`Connection failed: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!accessToken || !activeAccount) return;
  if (reconnectAttempts >= 6) {
    logInfo("Could not reconnect. Refresh the page.");
    if (isExecuting) stopBot("Connection lost.");
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(Math.pow(2, reconnectAttempts) * 500, 10000);
  logInfo(`Connection dropped. Reconnecting in ${Math.round(delay / 1000)}s…`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWS, delay);
}

function subscribeTicks() {
  if (!wsOpen()) return;
  send({ forget_all: "ticks" });
  send({ ticks: marketSelect.value, subscribe: 1 });
}
marketSelect.addEventListener("change", () => {
  if (isExecuting) return;
  subscribeTicks();
});

// ---- ERRORS ----
function handleError(msg) {
  const err = msg.error;
  const echo = msg.echo_req || {};
  console.warn("Deriv error:", msg);
  logInfo(`❌ ${err.code || "Error"}: ${err.message}`);

  const isBuyError = echo.buy !== undefined || msg.msg_type === "buy";
  if (isBuyError) {
    clearTimeout(buyTimer);
    tradeLock = false;
    buyErrors++;
    if (isExecuting) botState = stateBeforeTrade;
    const fatal = ["InvalidToken", "AuthorizationRequired", "InsufficientBalance", "PermissionDenied"];
    if (fatal.includes(err.code) || buyErrors >= 3) stopBot("Stopped after trade errors.");
  }
}

// ---- ENGINE ----
function handleTick(tick) {
  if (tick.symbol && tick.symbol !== marketSelect.value) return;
  const priceStr = formatTick(tick);
  const digit = lastDigit(priceStr);
  lastTick = { price: priceStr, digit };   // always tracked, even while idle
  if (!isExecuting || tradeLock) return;

  if (botState === "HOOK") {
    if (checkWinCondition(digit)) {
      hookTicksCount++;
      if (hookTicksCount >= 2) {
        logInfo("Hook fired. Recovering…");
        hookTicksCount = 0;
        placeTrade(priceStr, digit);
      }
    } else {
      hookTicksCount = 0;
    }
    return;
  }

  if (botState === "TRADING") placeTrade(priceStr, digit);
}

function placeTrade(entryPrice, entryDigit) {
  if (!isExecuting || tradeLock || !wsOpen()) return;

  currentStake = stakeForStep(currentMartingaleStep);
  const params = {
    amount: currentStake,
    basis: "stake",
    contract_type: contractType.value,
    currency: activeAccount?.currency || "USD",
    duration: 1,
    duration_unit: "t",
    underlying_symbol: marketSelect.value,
  };
  if (NEEDS_BARRIER.includes(contractType.value)) params.barrier = String(getBarrier());

  tradeLock = true;
  stateBeforeTrade = botState;
  botState = "WAITING_RESULT";
  currentEntry = { price: entryPrice, digit: entryDigit };
  updateMartingaleUI();

  const ok = send({ buy: 1, price: currentStake, parameters: params, subscribe: 1 });
  if (!ok) {
    tradeLock = false;
    botState = stateBeforeTrade;
    return;
  }

  clearTimeout(buyTimer);
  buyTimer = setTimeout(() => {
    if (tradeLock && !currentContractId) {
      logInfo("No response to buy request. Unlocking.");
      tradeLock = false;
      if (isExecuting) botState = stateBeforeTrade;
    }
  }, 8000);
}

function handleBuy(buy) {
  if (!buy) return;
  clearTimeout(buyTimer);
  buyErrors = 0;
  totalTrades++;
  tradeCountEl.textContent = totalTrades;
  currentContractId = buy.contract_id;
  if (buy.balance_after !== undefined) balanceEl.textContent = `$${parseFloat(buy.balance_after).toFixed(2)}`;

  pocSeen = false;
  const cid = buy.contract_id;
  setTimeout(() => {
    if (!pocSeen && tradeLock && currentContractId === cid) {
      send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 });
    }
  }, 1500);
  armResultTimer(1);
}

// If the result never arrives: re-ask once, then unlock
function armResultTimer(stage) {
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (!tradeLock || !currentContractId) return;
    if (stage === 1) {
      logInfo("Waiting for result… re-checking contract.");
      send({ proposal_open_contract: 1, contract_id: currentContractId, subscribe: 1 });
      armResultTimer(2);
    } else {
      logInfo("Result timed out. Unlocking.");
      tradeLock = false;
      currentContractId = null;
      if (isExecuting) botState = "TRADING";
    }
  }, 20000);
}

function handleContractUpdate(c, subscription) {
  if (c.contract_id === currentContractId) pocSeen = true;
  if (!c.is_sold) return;
  if (c.contract_id !== currentContractId) return;
  if (settledIds.has(c.contract_id)) return;
  settledIds.add(c.contract_id);

  clearTimeout(resultTimer);
  if (subscription?.id) send({ forget: subscription.id });

  const profit = parseFloat(c.profit);
  const entryPrice = String(c.entry_spot_display_value || c.entry_tick_display_value || c.entry_spot || currentEntry.price);
  const exitPrice = fixDecimals(c.exit_tick_display_value || c.exit_tick || c.sell_spot_display_value || currentEntry.price, entryPrice);
  const entryDigit = lastDigit(entryPrice);
  const exitDigit = lastDigit(exitPrice);

  totalPL += Number.isFinite(profit) ? profit : 0;
  updateTotalPL();

  if (profit > 0) {
    wins++;
    winsEl.textContent = wins;
    logTrade("win", entryPrice, entryDigit, exitPrice, exitDigit, currentStake, profit);
    currentMartingaleStep = 1;
    if (isExecuting) botState = "TRADING";
  } else {
    losses++;
    lossesEl.textContent = losses;
    logTrade("loss", entryPrice, entryDigit, exitPrice, exitDigit, currentStake, profit);

    if (currentMartingaleStep >= getMaxSteps()) {
      currentMartingaleStep = 1;
      tradeLock = false;
      currentContractId = null;
      updateMartingaleUI();
      if (isExecuting) stopBot("Max martingale steps reached.");
      return;
    }
    currentMartingaleStep++;
    if (isExecuting) {
      botState = "HOOK";
      hookTicksCount = 0;
      logInfo("Hook active. Waiting for 2 winning digits in a row…");
    }
  }

  tradeLock = false;
  currentContractId = null;
  updateMartingaleUI();

  // Speed: in TRADING mode fire the next trade right now instead of waiting for another tick
  if (isExecuting && botState === "TRADING") placeTrade(lastTick.price, lastTick.digit);
}

function updateMartingaleUI() {
  const step = currentMartingaleStep;
  mbStatus.textContent = `Step ${step} / ${getMaxSteps()} · $${stakeForStep(step).toFixed(2)}`;
}

// ---- CONTROLS ----
startBtn.addEventListener("click", () => {
  if (!wsOpen()) { logInfo("Not connected."); return; }
  if (activeAccount.type === "real" && !confirm("⚠️ WARNING: Real money trading. Are you sure?")) return;

  const base = getBase();
  if (!(base >= 0.35)) { logInfo("Stake must be at least 0.35."); return; }
  if (NEEDS_BARRIER.includes(contractType.value)) {
    const b = getBarrier();
    if (!(b >= 0 && b <= 9)) { logInfo("Barrier must be a digit 0–9."); return; }
    if (contractType.value === "DIGITOVER" && b === 9) { logInfo("Over 9 can never win. Pick a lower barrier."); return; }
    if (contractType.value === "DIGITUNDER" && b === 0) { logInfo("Under 0 can never win. Pick a higher barrier."); return; }
  }

  currentMartingaleStep = 1;
  buyErrors = 0;
  hookTicksCount = 0;
  tradeLock = false;
  currentContractId = null;
  isExecuting = true;
  botState = "TRADING";
  marketSelect.disabled = true;
  contractType.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateMartingaleUI();
  logInfo(`Bot started: ${contractType.value} on ${marketSelect.value}, base stake $${base.toFixed(2)}.`);
});

stopBtn.addEventListener("click", () => stopBot("Bot stopped."));

function stopBot(reason) {
  isExecuting = false;
  botState = "STOPPED";
  hookTicksCount = 0;
  clearTimeout(buyTimer);
  marketSelect.disabled = false;
  contractType.disabled = false;
  startBtn.disabled = !wsOpen();
  stopBtn.disabled = true;
  logInfo(reason || "Bot stopped.");
  // If a contract is still open, its result will still be logged when it settles.
}

logoutBtn.addEventListener("click", () => {
  stopBot("Logged out.");
  closeSocket();
  sessionStorage.removeItem("deriv_access_token");
  accessToken = null;
  accounts = [];
  activeAccount = null;
  tradeLock = false;
  currentContractId = null;
  loginCard.style.display = "block";
  botDashboard.classList.remove("show");
  accountSwitcher.style.display = "none";
  authText.textContent = "Not logged in";
  authDot.classList.remove("connected");
  loginBtn.disabled = false;
  loginBtn.textContent = "Login with Deriv";
});

loginBtn.addEventListener("click", startLogin);
martingaleMultiplier.addEventListener("change", updateMartingaleUI);
martingaleMaxSteps.addEventListener("change", updateMartingaleUI);
stakeInput.addEventListener("input", updateMartingaleUI);

// ---- BOOT ----
function showDashboard() {
  loginCard.style.display = "none";
  botDashboard.classList.add("show");
  authDot.classList.add("connected");
  authText.textContent = "Connected";
}

async function init() {
  stopBtn.disabled = true;
  let ok = await handleCallback();
  if (!ok) {
    const stored = sessionStorage.getItem("deriv_access_token");
    if (stored) accessToken = stored;
    else return;
  }
  if (await fetchAccounts()) {
    showDashboard();
    updateMartingaleUI();
  }
}

init();
