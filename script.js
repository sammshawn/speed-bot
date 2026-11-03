// ============================================
//  SPEED BOT — WebSocket Balance + Strict Trading
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

// Bot State
let botRunning = false;
let currentState = "IDLE"; // IDLE, TRADING, HOOK, STOPPED
let hookTicksCount = 0;
let currentMartingaleStep = 1;
let wins = 0, losses = 0;
let isTradeActive = false; // Locks new trades while one is processing
let currentContractId = null;

// DOM
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
const winsEl = document.getElementById("wins");
const lossesEl = document.getElementById("losses");
const botStateEl = document.getElementById("botState");
const logBox = document.getElementById("logBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const mbStatus = document.getElementById("mbStatus");
const marketSelect = document.getElementById("marketSelect");
const contractType = document.getElementById("contractType");
const barrierInput = document.getElementById("barrier");
const stakeInput = document.getElementById("stake");
const martingaleMultiplier = document.getElementById("martingaleMultiplier");
const martingaleMaxSteps = document.getElementById("martingaleMaxSteps");

// ---- CLEAN LOGGING ----
function log(msg, type = "info") {
  console.log(`[${type}]`, msg);
  if (!logBox) return;
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' });
  
  // Clean up the message for the UI
  entry.textContent = `[${time}] ${msg}`;
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}

// ---- PKCE LOGIN ----
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
  const params = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: "trade", state: state, code_challenge: codeChallenge, code_challenge_method: "S256",
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  if (!code || !state) return false;
  if (state !== sessionStorage.getItem('oauth_state')) { log("State mismatch.", "error"); return false; }
  const codeVerifier = sessionStorage.getItem('pkce_code_verifier');
  if (!codeVerifier) { log("PKCE missing.", "error"); return false; }

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }),
    });
    const data = await response.json();
    if (!response.ok) { log(`Token error: ${data.error_description || data.error}`, "error"); return false; }
    accessToken = data.access_token;
    sessionStorage.setItem('deriv_access_token', accessToken);
    sessionStorage.removeItem('pkce_code_verifier');
    sessionStorage.removeItem('oauth_state');
    window.history.replaceState({}, document.title, window.location.pathname);
    return true;
  } catch (err) { log(`Network error: ${err.message}`, "error"); return false; }
}

// ---- FETCH ACCOUNTS (REST is fine here, no CORS issue for /accounts) ----
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
  } catch (err) { log(`Account fetch failed: ${err.message}`, "error"); return false; }
}

function selectAccount(acc) {
  activeAccount = { id: acc.account_id, type: acc.type || acc.account_type };
  pillDemo.classList.toggle("active", activeAccount.type === "demo");
  pillReal.classList.toggle("active", activeAccount.type === "real");
  activeAccLabel.textContent = `${activeAccount.type.toUpperCase()} (${activeAccount.id})`;
  balanceEl.textContent = "Loading...";
  startBtn.disabled = false;
}

pillDemo.addEventListener("click", () => {
  const demo = accounts.find(a => a.type === "demo" || a.account_type === "demo");
  if (demo) selectAccount(demo);
});
pillReal.addEventListener("click", () => {
  const real = accounts.find(a => a.type === "real" || a.account_type === "real");
  if (real) selectAccount(real);
});

// ---- WEBSOCKET & TRADING ENGINE ----
async function connectWS() {
  log("Connecting...", "info");
  try {
    const res = await fetch(`${API_BASE}/accounts/${activeAccount.id}/otp`, {
      method: "POST", headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "OTP failed");
    
    const wsUrl = data.data.url; 
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      log("Connected.", "success");
      
      // 1. Subscribe to balance via WebSocket (Fixes CORS)
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: reqId++ }));
      
      // 2. Subscribe to ticks
      subscribeTicks();
      
      startBtn.disabled = true;
      stopBtn.disabled = false;
      botRunning = true;
      currentState = "TRADING";
      updateBotStateUI();
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.error) { log(`WS Error: ${msg.error.message}`, "error"); return; }
      
      if (msg.msg_type === "balance") {
        // Update balance from WebSocket
        balanceEl.textContent = `$${parseFloat(msg.balance.balance).toFixed(2)}`;
      }
      
      if (msg.msg_type === "tick") handleTick(msg.tick);
      if (msg.msg_type === "proposal") handleProposal(msg.proposal);
      if (msg.msg_type === "buy") handleBuy(msg.buy);
      if (msg.msg_type === "proposal_open_contract") handleContractUpdate(msg.proposal_open_contract);
    };

    ws.onclose = () => { log("Disconnected.", "info"); stopBot(); };

  } catch (err) { log(`Connection failed: ${err.message}`, "error"); }
}

function subscribeTicks() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ticks: marketSelect.value, subscribe: 1, req_id: reqId++ }));
}

// --- THE VIRTUAL HOOK & TRADING LOGIC ---
function handleTick(tick) {
  if (!botRunning || isTradeActive) return; // Lock prevents trading if one is active

  if (currentState === "HOOK") {
    const digit = getLastDigit(tick.quote);
    const isWinCondition = checkWinCondition(digit);
    
    if (isWinCondition) {
      hookTicksCount++;
      if (hookTicksCount >= 2) {
        log(`Hook fired. Placing recovery...`, "success");
        currentState = "TRADING";
        placeTrade();
      }
    } else {
      hookTicksCount = 0;
    }
    return; 
  }

  if (currentState === "TRADING") {
    placeTrade();
  }
}

function getLastDigit(quote) {
  const decimals = {
    R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2,
    "1HZ10V": 2, "1HZ25V": 2, "1HZ50V": 2, "1HZ75V": 2, "1HZ100V": 2
  }[marketSelect.value] || 2;
  const str = parseFloat(quote).toFixed(decimals);
  return parseInt(str.slice(-1), 10);
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

function placeTrade() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  isTradeActive = true; // Lock it
  
  const stake = parseFloat(stakeInput.value);
  const type = contractType.value;
  const barrier = parseInt(barrierInput.value, 10);

  const req = {
    proposal: 1,
    amount: stake.toFixed(2),
    basis: "stake",
    contract_type: type,
    currency: "USD",
    duration: 1,
    duration_unit: "t",
    underlying_symbol: marketSelect.value,
    req_id: reqId++
  };

  if (type === "DIGITOVER" || type === "DIGITUNDER") {
    req.barrier = barrier.toString();
  }

  ws.send(JSON.stringify(req));
}

function handleProposal(proposal) {
  ws.send(JSON.stringify({
    buy: proposal.id,
    price: proposal.ask_price,
    req_id: reqId++
  }));
}

function handleBuy(buy) {
  currentContractId = buy.contract_id;
  log(`Bought ${contractType.value} $${buy.buy_price}`, "trade");
  
  ws.send(JSON.stringify({
    proposal_open_contract: 1,
    contract_id: buy.contract_id,
    subscribe: 1,
    req_id: reqId++
  }));
}

function handleContractUpdate(contract) {
  if (!contract.is_sold) return; 

  const profit = parseFloat(contract.profit);
  if (profit > 0) {
    wins++;
    winsEl.textContent = wins;
    log(`WIN +$${profit.toFixed(2)}`, "success");
    currentMartingaleStep = 1;
    updateMartingaleUI();
    currentState = "TRADING"; 
  } else {
    losses++;
    lossesEl.textContent = losses;
    log(`LOSS -$${Math.abs(profit).toFixed(2)}`, "error");
    
    const maxSteps = parseInt(martingaleMaxSteps.value, 10);
    if (currentMartingaleStep >= maxSteps) {
      log(`Max Steps reached. Stopped.`, "error");
      stopBot();
      return;
    }

    currentMartingaleStep++;
    const multiplier = parseFloat(martingaleMultiplier.value);
    const newStake = (parseFloat(stakeInput.value) * Math.pow(multiplier, currentMartingaleStep - 1)).toFixed(2);
    stakeInput.value = newStake;
    updateMartingaleUI();

    currentState = "HOOK";
    hookTicksCount = 0;
    log(`Waiting for hook...`, "info");
  }
  
  isTradeActive = false; // Unlock for the next trade
  ws.send(JSON.stringify({ forget: contract.id, req_id: reqId++ }));
  updateBotStateUI();
}

function updateMartingaleUI() {
  const mult = martingaleMultiplier.value;
  mbStatus.textContent = `Step ${currentMartingaleStep} / ${mult}x`;
}

function updateBotStateUI() {
  botStateEl.textContent = currentState;
  botStateEl.style.color = 
    currentState === "TRADING" ? "var(--green)" : 
    currentState === "HOOK" ? "var(--amber)" : "var(--muted)";
}

// ---- CONTROLS ----
startBtn.addEventListener("click", () => {
  if (!activeAccount) return;
  if (activeAccount.type === "real") {
    if (!confirm("⚠️ WARNING: You are about to trade on a REAL account. Real money will be used. Are you sure?")) return;
  }
  connectWS();
});

stopBtn.addEventListener("click", stopBot);

function stopBot() {
  botRunning = false;
  currentState = "STOPPED";
  if (ws) { ws.close(); ws = null; }
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateBotStateUI();
  log("Bot stopped.", "info");
}

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem('deriv_access_token');
  accessToken = null;
  accounts = [];
  activeAccount = null;
  if (ws) ws.close();
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