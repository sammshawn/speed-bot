// ============================================
//  SPEED BOT — V6.1 (Safe Proposal Handler)
// ============================================

const CLIENT_ID = "34RaG6zRPpQYEeugvLnPq";
const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const API_BASE = "https://api.derivws.com/trading/v1/options";

let accessToken = null;
let accounts = [];
let activeAccount = null;
let ws = null;
let reqId = 1;

// Session Management
let sessionId = 0; 
let reconnectAttempts = 0;

// Engine State
let isExecuting = false; 
let botState = "IDLE"; 
let hookTicksCount = 0;
let currentMartingaleStep = 1;
let wins = 0, losses = 0, totalTrades = 0;
let baseStake = 0.35;

// Mutex & Safety
let isTradeActive = false; 
let isProposalPending = false;
let safetyTimeout = null; 

// Proposal Caching
let activeProposal = null; 
let currentEntryPrice = null;
let currentEntryDigit = null;

// DOM Elements
const loginCard = document.getElementById("loginCard");
const botDashboard = document.getElementById("botDashboard");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authText = document.getElementById("authText");
const authDot = document.getElementById("authDot");
const accountSwitcher = document.getElementById("accountSwitcher");
const pillDemo = document.getElementById("pillDemo");
const pillReal = document.getElementById("pillReal");
const demoAccId = document.getElementById("demoAccId");
const realAccId = document.getElementById("realAccId");
const activeAccLabel = document.getElementById("activeAccLabel");
const balanceEl = document.getElementById("balance");
const tradeCountEl = document.getElementById("tradeCount");
const winsEl = document.getElementById("wins");
const lossesEl = document.getElementById("losses");
const logBox = document.getElementById("logBox");
const clearLogBtn = document.getElementById("clearLogBtn");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const mbStatus = document.getElementById("mbStatus");
const marketSelect = document.getElementById("marketSelect");
const contractType = document.getElementById("contractType");
const barrierInput = document.getElementById("barrier");
const stakeInput = document.getElementById("stake");
const martingaleMultiplier = document.getElementById("martingaleMultiplier");
const martingaleMaxSteps = document.getElementById("martingaleMaxSteps");

// ---- DYNAMIC DECIMAL PARSER ----
function getLastDigit(quote) {
  const str = quote.toString();
  const parts = str.split('.');
  if (parts.length === 2 && parts[1].length > 0) {
    return parseInt(parts[1].slice(-1), 10);
  }
  return parseInt(str.slice(-1), 10);
}

// ---- LOGGING ----
function logTrade(type, entryPrice, entryDigit, exitPrice, exitDigit, stake, pl) {
  const entryEl = document.createElement("div");
  entryEl.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
  
  const plText = pl >= 0 ? `+$${pl.toFixed(2)}` : `-$${Math.abs(pl).toFixed(2)}`;
  const plClass = pl >= 0 ? "pl-positive" : "pl-negative";
  const digitClass = type === "win" ? "digit-green" : "digit-red";

  entryEl.innerHTML = `
    <span class="log-time">${time}</span>
    <span>Entry: <span class="${digitClass}">${entryDigit}</span> @ ${parseFloat(entryPrice).toFixed(2)}</span>
    <span>Exit: <span class="${digitClass}">${exitDigit}</span> @ ${parseFloat(exitPrice).toFixed(2)}</span>
    <span class="${plClass}">${plText} ($${stake})</span>
  `;
  logBox.appendChild(entryEl);
  logBox.scrollTop = logBox.scrollHeight;
}

function logInfo(msg) {
  const entryEl = document.createElement("div");
  entryEl.className = `log-entry info`;
  entryEl.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' })}</span><span style="grid-column: span 3;">${msg}</span>`;
  logBox.appendChild(entryEl);
  logBox.scrollTop = logBox.scrollHeight;
}

clearLogBtn.addEventListener("click", () => { logBox.innerHTML = ""; });

// ---- AUTH PKCE ----
function generatePKCE() {
  const array = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = Array.from(array).map(v => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[v % 66]).join('');
  const state = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  sessionStorage.setItem('pkce_code_verifier', codeVerifier);
  sessionStorage.setItem('oauth_state', state);
  return { codeVerifier, state };
}
async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function startLogin() {
  loginBtn.disabled = true; loginBtn.textContent = "Redirecting…";
  const { codeVerifier, state } = generatePKCE();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const params = new URLSearchParams({ response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: "trade", state: state, code_challenge: codeChallenge, code_challenge_method: "S256" });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}
async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  if (!code || !state) return false;
  if (state !== sessionStorage.getItem('oauth_state')) { logInfo("State mismatch."); return false; }
  const codeVerifier = sessionStorage.getItem('pkce_code_verifier');
  if (!codeVerifier) { logInfo("PKCE missing."); return false; }
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }),
    });
    const data = await response.json();
    if (!response.ok) { logInfo(`Token error: ${data.error_description || data.error}`); return false; }
    accessToken = data.access_token;
    sessionStorage.setItem('deriv_access_token', accessToken);
    sessionStorage.removeItem('pkce_code_verifier');
    sessionStorage.removeItem('oauth_state');
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (err) { logInfo(`Network error: ${err.message}`); return false; }
}

// ---- FETCH ACCOUNTS ----
async function fetchAccounts() {
  try {
    const res = await fetch(`${API_BASE}/accounts`, { headers: { "Authorization": `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Failed");
    accounts = data.data || [];
    const demo = accounts.find(a => a.type === "demo" || a.account_type === "demo");
    const real = accounts.find(a => a.type === "real" || a.account_type === "real");
    if (demo) demoAccId.textContent = demo.account_id;
    if (real) realAccId.textContent = real.account_id;
    if (demo) selectAccount(demo);
    else if (real) selectAccount(real);
    accountSwitcher.style.display = "flex";
    return true;
  } catch (err) { logInfo(`Account fetch failed: ${err.message}`); return false; }
}

async function selectAccount(acc) {
  activeAccount = { id: acc.account_id, type: acc.type || acc.account_type };
  pillDemo.classList.toggle("active", activeAccount.type === "demo");
  pillReal.classList.toggle("active", activeAccount.type === "real");
  activeAccLabel.textContent = `${activeAccount.type.toUpperCase()} (${activeAccount.id})`;
  balanceEl.textContent = "Connecting...";
  if (ws) { ws.close(); ws = null; }
  await connectWS();
}

pillDemo.addEventListener("click", () => {
  const demo = accounts.find(a => a.type === "demo" || a.account_type === "demo");
  if (demo) selectAccount(demo);
});
pillReal.addEventListener("click", () => {
  const real = accounts.find(a => a.type === "real" || a.account_type === "real");
  if (real) selectAccount(real);
});

// ---- WEBSOCKET & RECONNECT ----
async function connectWS() {
  try {
    const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/otp`, { method: "POST", headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "OTP failed");
    
    ws = new WebSocket(data.data.url);
    ws.onopen = () => {
      reconnectAttempts = 0;
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: reqId++ }));
      subscribeTicks();
      startBtn.disabled = false;
      logInfo("Account ready. Connection established.");
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.error) { logInfo(`WS Error: ${msg.error.message}`); return; }
      
      if (msg.msg_type === "balance") balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
      
      if (!isExecuting) return;

      if (msg.msg_type === "tick") handleTick(msg.tick);
      if (msg.msg_type === "proposal") handleProposal(msg.proposal);
      if (msg.msg_type === "buy") handleBuy(msg.buy);
      if (msg.msg_type === "proposal_open_contract") handleContractUpdate(msg.proposal_open_contract);
    };

    ws.onclose = () => { 
      logInfo("Connection dropped. Reconnecting..."); 
      startBtn.disabled = true; 
      if (isExecuting && reconnectAttempts < 5) {
        reconnectAttempts++;
        const delay = Math.pow(2, reconnectAttempts) * 1000;
        setTimeout(connectWS, delay);
      } else {
        stopBot();
      }
    };
  } catch (err) { logInfo(`Connection failed: ${err.message}`); }
}

function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ticks: marketSelect.value, subscribe: 1, req_id: reqId++ }));
}

// --- VIRTUAL HOOK & TRADING LOGIC ---
function handleTick(tick) {
  if (isTradeActive || botState === "WAITING_RESULT" || botState === "IDLE" || botState === "STOPPED") return;

  if (botState === "HOOK") {
    const digit = getLastDigit(tick.quote);
    const isWinCondition = checkWinCondition(digit);
    
    if (isWinCondition) {
      hookTicksCount++;
      if (hookTicksCount >= 2) {
        logInfo(`Hook fired. Recovering...`);
        fireCachedTrade(tick.quote, digit);
      }
    } else {
      hookTicksCount = 0;
    }
    return; 
  }

  if (botState === "TRADING") {
    fireCachedTrade(tick.quote, getLastDigit(tick.quote));
  }
}

function checkWinCondition(digit) {
  const type = contractType.value;
  const barrier = parseInt(barrierInput.value, 10);
  if (type === "DIGITOVER") return digit > barrier;
  if (type === "DIGITUNDER") return digit < barrier;
  if (type === "DIGITEVEN") return digit % 2 === 0;
  if (type === "DIGITODD") return digit % 2 !== 0;
  return false;
}

// 🚨 THREAD-SAFE BUY
function fireCachedTrade(price, digit) {
  if (!activeProposal) {
    logInfo("Waiting for fresh proposal...");
    fetchProposalInBackground();
    return; 
  }

  isTradeActive = true; 
  botState = "WAITING_RESULT";
  currentEntryPrice = price;
  currentEntryDigit = digit;
  
  clearTimeout(safetyTimeout);
  safetyTimeout = setTimeout(() => {
    if (isTradeActive) {
      logInfo("API Timeout. Unlocking.");
      isTradeActive = false;
      botState = "TRADING";
    }
  }, 4000);

  ws.send(JSON.stringify({
    buy: activeProposal.id,
    price: activeProposal.ask_price,
    req_id: reqId++
  }));
  
  activeProposal = null;
}

function fetchProposalInBackground() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !isExecuting || isProposalPending) return;
  
  isProposalPending = true;

  const req = {
    proposal: 1, amount: stakeInput.value, basis: "stake",
    contract_type: contractType.value, currency: "USD", duration: 1, duration_unit: "t",
    underlying_symbol: marketSelect.value, req_id: reqId++
  };
  if (contractType.value === "DIGITOVER" || contractType.value === "DIGITUNDER") {
    req.barrier = barrierInput.value;
  }
  ws.send(JSON.stringify(req));
}

// 🚨 SAFE PROPOSAL HANDLER (Fixes the crash)
function handleProposal(proposal) {
  isProposalPending = false;

  if (botState === "WAITING_RESULT") {
    activeProposal = { id: proposal.id, ask_price: proposal.ask_price, sessionId: sessionId };
  } else if (botState === "TRADING" || botState === "HOOK") {
    // If a tick fired before the proposal arrived, buy immediately
    isTradeActive = true;
    botState = "WAITING_RESULT";
    currentEntryPrice = proposal.echo_req?.amount ? null : currentEntryPrice; // fallback
    
    ws.send(JSON.stringify({ buy: proposal.id, price: proposal.ask_price, req_id: reqId++ }));
  }
}

function handleBuy(buy) {
  totalTrades++;
  tradeCountEl.textContent = totalTrades;
  
  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: buy.contract_id,
    subscribe: 1,
    req_id: reqId++
  }));
}

function handleContractUpdate(contract) {
  if (!contract.is_sold) return; 

  clearTimeout(safetyTimeout);
  const profit = parseFloat(contract.profit);
  const stake = stakeInput.value;
  const exitPrice = contract.exit_tick || contract.sell_price || currentEntryPrice;
  const exitDigit = getLastDigit(exitPrice);

  if (profit > 0) {
    wins++;
    winsEl.textContent = wins;
    logTrade("win", currentEntryPrice, currentEntryDigit, exitPrice, exitDigit, stake, profit);
    
    currentMartingaleStep = 1;
    stakeInput.value = baseStake;
    updateMartingaleUI();
    botState = "TRADING";
  } else {
    losses++;
    lossesEl.textContent = losses;
    logTrade("loss", currentEntryPrice, currentEntryDigit, exitPrice, exitDigit, stake, profit);
    
    if (currentMartingaleStep >= parseInt(martingaleMaxSteps.value, 10)) {
      logInfo(`Max Steps reached. Stopping.`);
      stopBot();
      return;
    }

    currentMartingaleStep++;
    const newStake = (baseStake * Math.pow(parseFloat(martingaleMultiplier.value), currentMartingaleStep - 1)).toFixed(2);
    stakeInput.value = newStake;
    updateMartingaleUI();

    botState = "HOOK"; 
    hookTicksCount = 0;
    logInfo(`Hook active. Waiting for 2 wins...`);
  }
  
  isTradeActive = false;
  ws.send(JSON.stringify({ forget: contract.id, req_id: reqId++ }));
  fetchProposalInBackground();
}

function updateMartingaleUI() {
  mbStatus.textContent = `Step ${currentMartingaleStep} / ${martingaleMultiplier.value}x`;
}

// ---- CONTROLS ----
startBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) { logInfo("Not connected."); return; }
  if (activeAccount.type === "real" && !confirm("⚠️ WARNING: Real money trading. Are you sure?")) return;
  
  sessionId++; 
  baseStake = parseFloat(stakeInput.value);
  isExecuting = true;
  botState = "TRADING";
  isTradeActive = false;
  isProposalPending = false;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  logInfo("Bot execution started.");
  
  fetchProposalInBackground();
});

stopBtn.addEventListener("click", stopBot);

function stopBot() {
  sessionId++;
  isExecuting = false;
  botState = "STOPPED";
  isTradeActive = false;
  isProposalPending = false;
  activeProposal = null;
  clearTimeout(safetyTimeout);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  logInfo("Bot execution stopped.");
}

logoutBtn.addEventListener("click", () => {
  sessionId++;
  sessionStorage.removeItem('deriv_access_token');
  accessToken = null;
  accounts = [];
  activeAccount = null;
  isExecuting = false;
  if (ws) { ws.close(); ws = null; }
  loginCard.style.display = "block";
  botDashboard.classList.remove("show");
  accountSwitcher.style.display = "none";
  authText.textContent = "Not logged in";
  authDot.classList.remove("connected");
});

loginBtn.addEventListener("click", startLogin);
martingaleMultiplier.addEventListener("change", updateMartingaleUI);
martingaleMaxSteps.addEventListener("change", updateMartingaleUI);

// ---- BOOT ----
async function init() {
  const success = await handleCallback();
  if (success) {
    const accountOk = await fetchAccounts();
    if (accountOk) {
      loginCard.style.display = "none";
      botDashboard.classList.add("show");
      authDot.classList.add("connected");
      authText.textContent = "Connected";
    }
  } else {
    const storedToken = sessionStorage.getItem('deriv_access_token');
    if (storedToken) {
      accessToken = storedToken;
      const accountOk = await fetchAccounts();
      if (accountOk) {
        loginCard.style.display = "none";
        botDashboard.classList.add("show");
        authDot.classList.add("connected");
        authText.textContent = "Connected";
      }
    }
  }
}

init();