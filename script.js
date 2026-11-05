// ============================================
//  SPEED BOT — V9.0 (Official Flow + Error Logging)
//  Fixes: Buy rejection, Silent errors
// ============================================

const CLIENT_ID = "34RaG6zRPpQYEeugvLnPq";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com/trading/v1/options";

// ---- State ----
let accessToken = null;
let accounts = [];
let activeAccount = null;      
let ws = null;
let reqId = 1;
let reconnectAttempts = 0;
let reconnectTimer = null;

let isExecuting = false;       
let botState = "IDLE";         
let tradeLock = false;         
let currentContractId = null;
let resultTimer = null;

let hookTicksCount = 0;
let currentMartingaleStep = 1;
let wins = 0, losses = 0, totalTrades = 0;
let totalPL = 0;
let currentStake = 0.35;
let currentEntry = { price: null, digit: null };
let cachedProposal = null; // Stores { id, ask_price }

// DOM
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
const NEEDS_BARRIER = ["DIGITOVER", "DIGITUNDER"];
const round2 = (n) => Math.round(n * 100) / 100;
const getBase = () => parseFloat(stakeInput.value);
const getMult = () => parseFloat(martingaleMultiplier.value) || 2;
const getMaxSteps = () => parseInt(martingaleMaxSteps.value, 10) || 1;
const getBarrier = () => parseInt(barrierInput.value, 10);

function stakeForStep(step) {
  return round2(getBase() * Math.pow(getMult(), step - 1));
}

function lastDigit(str) {
  const m = String(str).match(/(\d)\D*$/);
  return m ? parseInt(m[1], 10) : 0;
}
function formatTick(tick) {
  const quote = Number(tick.quote);
  const decimals = (String(tick.quote).split(".")[1] || "").length;
  return quote.toFixed(decimals);
}

function checkWinCondition(digit) {
  const b = getBarrier();
  switch (contractType.value) {
    case "DIGITOVER":  return digit > b;
    case "DIGITUNDER": return digit < b;
    case "DIGITEVEN":  return digit % 2 === 0;
    case "DIGITODD":   return digit % 2 === 1;
    default:           return true;
  }
}

// ---- Logging ----
function timeNow() {
  return new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  m.textContent = msg;
  el.append(t, m);
  logBox.appendChild(el);
  logBox.scrollTop = logBox.scrollHeight;
}
clearLogBtn.addEventListener("click", () => { logBox.innerHTML = ""; });

// ---- AUTH ----
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
    ws = null;                 
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
      startBtn.disabled = isExecuting;
      logInfo("Connected. Ready.");
    };

    socket.onmessage = (event) => {
      if (socket !== ws) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      
      if (msg.error) { 
        // 🚨 LOG THE EXACT ERROR
        console.error("Deriv Error:", msg.error);
        logInfo(`❌ API Error: ${msg.error.message} (${msg.error.code})`);
        
        // If the buy request failed, unlock the trade
        if (msg.echo_req && (msg.echo_req.buy || msg.echo_req.proposal)) {
           tradeLock = false;
           if (isExecuting) botState = "TRADING";
        }
        return; 
      }

      switch (msg.msg_type) {
        case "balance":
          if (msg.balance) balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
          break;
        case "tick":
          if (msg.tick) handleTick(msg.tick);
          break;
        case "proposal":
          if (msg.proposal) handleProposal(msg.proposal);
          break;
        case "buy":
          if (msg.buy) handleBuy(msg.buy);
          break;
        case "proposal_open_contract":
          if (msg.proposal_open_contract) handleContractUpdate(msg.proposal_open_contract);
          break;
      }
    };

    socket.onerror = () => { if (socket === ws) logInfo("Socket error."); };
    socket.onclose = () => {
      if (socket !== ws) return;     
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

// ---- ENGINE (Proposal -> Buy Flow) ----
function handleTick(tick) {
  if (tick.symbol && tick.symbol !== marketSelect.value) return;
  const priceStr = formatTick(tick);
  const digit = lastDigit(priceStr);
  
  if (!isExecuting || tradeLock) return;

  if (botState === "HOOK") {
    if (checkWinCondition(digit)) {
      hookTicksCount++;
      if (hookTicksCount >= 2) {
        logInfo("Hook fired. Recovering…");
        hookTicksCount = 0;
        triggerTrade(priceStr, digit);
      }
    } else {
      hookTicksCount = 0;
    }
    return;
  }

  if (botState === "TRADING") triggerTrade(priceStr, digit);
}

function triggerTrade(entryPrice, entryDigit) {
  if (!isExecuting || tradeLock || !wsOpen()) return;

  currentStake = stakeForStep(currentMartingaleStep);
  currentEntry = { price: entryPrice, digit: entryDigit };

  if (cachedProposal) {
    executeBuy(cachedProposal.id, cachedProposal.ask_price);
    cachedProposal = null;
    requestProposal(); // Pre-fetch next
  } else {
    logInfo("Fetching proposal...");
    requestProposal();
  }
}

function requestProposal() {
  if (!wsOpen() || !isExecuting) return;
  const params = {
    proposal: 1,
    amount: currentStake,
    basis: "stake",
    contract_type: contractType.value,
    currency: activeAccount?.currency || "USD",
    duration: 1,
    duration_unit: "t",
    underlying_symbol: marketSelect.value,
  };
  if (NEEDS_BARRIER.includes(contractType.value)) params.barrier = String(getBarrier());
  send(params);
}

function handleProposal(proposal) {
  // If we are locked (waiting for result), cache this proposal for the next trade
  if (tradeLock) {
    cachedProposal = { id: proposal.id, ask_price: proposal.ask_price };
    return;
  }

  // If not locked, a tick triggered this request. Buy immediately.
  executeBuy(proposal.id, proposal.ask_price);
  requestProposal(); // Pre-fetch next
}

function executeBuy(proposalId, price) {
  tradeLock = true;
  botState = "WAITING_RESULT";
  
  // 🚨 OFFICIAL BUY FORMAT: buy = proposalId, price = ask_price
  const ok = send({ buy: proposalId, price: price });
  if (!ok) {
    tradeLock = false;
    botState = "TRADING";
    return;
  }

  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (tradeLock && !currentContractId) {
      logInfo("Buy request timed out. Unlocking.");
      tradeLock = false;
      if (isExecuting) botState = "TRADING";
    }
  }, 5000);
}

function handleBuy(buy) {
  if (!buy) return;
  clearTimeout(resultTimer);
  totalTrades++;
  tradeCountEl.textContent = totalTrades;
  currentContractId = buy.contract_id;
  if (buy.balance_after !== undefined) balanceEl.textContent = `$${parseFloat(buy.balance_after).toFixed(2)}`;

  send({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
}

function handleContractUpdate(c) {
  if (!c.is_sold) return;
  if (c.contract_id !== currentContractId) return;

  clearTimeout(resultTimer);
  send({ forget: c.id });

  const profit = parseFloat(c.profit);
  const entryPrice = String(c.entry_spot_display_value || c.entry_tick_display_value || currentEntry.price);
  const exitPrice = String(c.exit_tick_display_value || c.exit_tick || c.sell_spot_display_value || currentEntry.price);
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
      if (isExecuting) stopBot("Max martingale steps reached.");
      return;
    }
    currentMartingaleStep++;
    if (isExecuting) {
      botState = "HOOK";
      hookTicksCount = 0;
      logInfo("Hook active. Waiting for 2 winning digits…");
    }
  }

  tradeLock = false;
  currentContractId = null;
  
  if (isExecuting && botState === "TRADING") {
    requestProposal(); // Pre-fetch next
  }
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

  currentMartingaleStep = 1;
  hookTicksCount = 0;
  tradeLock = false;
  currentContractId = null;
  cachedProposal = null;
  isExecuting = true;
  botState = "TRADING";
  marketSelect.disabled = true;
  contractType.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  updateMartingaleUI();
  logInfo(`Bot started: ${contractType.value} on ${marketSelect.value}, base $${base.toFixed(2)}.`);
  
  requestProposal();
});

stopBtn.addEventListener("click", () => stopBot("Bot stopped."));

function stopBot(reason) {
  isExecuting = false;
  botState = "STOPPED";
  hookTicksCount = 0;
  tradeLock = false;
  cachedProposal = null;
  clearTimeout(resultTimer);
  marketSelect.disabled = false;
  contractType.disabled = false;
  startBtn.disabled = !wsOpen();
  stopBtn.disabled = true;
  logInfo(reason || "Bot stopped.");
}

logoutBtn.addEventListener("click", () => {
  stopBot("Logged out.");
  closeSocket();
  sessionStorage.removeItem("deriv_access_token");
  accessToken = null;
  accounts = [];
  activeAccount = null;
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