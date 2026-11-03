// ============================================
//  SPEED BOT — OAuth PKCE Login + UI
//  Frontend-only. Token stays in sessionStorage.
// ============================================

// ---- CONFIG ----
// ⚠️ REPLACE WITH YOUR DERIV OAUTH APP ID
// Register at: https://developers.deriv.com
// Redirect URI must match EXACTLY what you register.
const CLIENT_ID = "34RaG6zRPpQYEeugvLnPq"; // e.g. "app12345"
const REDIRECT_URI = window.location.origin + window.location.pathname;
const AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const TOKEN_URL = "https://auth.deriv.com/oauth2/token";

// ---- DOM ----
const loginCard = document.getElementById("loginCard");
const botDashboard = document.getElementById("botDashboard");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const authDot = document.getElementById("authDot");
const authText = document.getElementById("authText");
const accountInfo = document.getElementById("accountInfo");
const balanceEl = document.getElementById("balance");
const tradeCountEl = document.getElementById("tradeCount");
const winsEl = document.getElementById("wins");
const lossesEl = document.getElementById("losses");
const logBox = document.getElementById("logBox");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

// ---- STATE ----
let accessToken = null;
let accountId = null;
let botRunning = false;

// ---- PKCE HELPERS ----
function generatePKCE() {
  // 1. Random code_verifier (43-128 chars) [citation:6]
  const array = crypto.getRandomValues(new Uint8Array(64));
  const codeVerifier = Array.from(array)
    .map(v => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[v % 66])
    .join('');

  // 2. Random state for CSRF [citation:6]
  const state = crypto.getRandomValues(new Uint8Array(16))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');

  // 3. Store verifier and state in sessionStorage [citation:1][citation:6]
  sessionStorage.setItem('pkce_code_verifier', codeVerifier);
  sessionStorage.setItem('oauth_state', state);

  return { codeVerifier, state };
}

async function generateCodeChallenge(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- LOGIN FLOW ----
async function startLogin() {
  if (CLIENT_ID === "YOUR_APP_ID_HERE") {
    alert("⚠️ Please set your CLIENT_ID in script.js first.\n\nGet it from: developers.deriv.com");
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = "Redirecting…";

  const { codeVerifier, state } = generatePKCE();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "trade", // Required for trading [citation:1][citation:5]
    state: state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// ---- HANDLE CALLBACK (page load after redirect) ----
async function handleCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  const error = urlParams.get('error');

  if (error) {
    log(`Login error: ${error}`, "error");
    return false;
  }

  if (!code || !state) return false;

  // Verify state [citation:1][citation:6]
  const storedState = sessionStorage.getItem('oauth_state');
  if (state !== storedState) {
    log("State mismatch — login failed. Try again.", "error");
    return false;
  }

  const codeVerifier = sessionStorage.getItem('pkce_code_verifier');
  if (!codeVerifier) {
    log("PKCE verifier missing — login failed.", "error");
    return false;
  }

  // Exchange code for token (no client_secret — PKCE flow) [citation:1]
  log("Exchanging authorization code for token…", "info");

  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      log(`Token exchange failed: ${data.error_description || data.error || 'Unknown error'}`, "error");
      return false;
    }

    accessToken = data.access_token;
    sessionStorage.setItem('deriv_access_token', accessToken);

    // Clear PKCE data [citation:1]
    sessionStorage.removeItem('pkce_code_verifier');
    sessionStorage.removeItem('oauth_state');

    // Clean URL
    window.history.replaceState({}, document.title, window.location.pathname);

    log("✅ Login successful!", "success");
    return true;

  } catch (err) {
    log(`Network error: ${err.message}`, "error");
    return false;
  }
}

// ---- FETCH DEMO ACCOUNT ----
async function fetchAccount() {
  log("Fetching your demo account…", "info");

  try {
    const response = await fetch("https://api.derivws.com/trading/v1/options/accounts", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        // No Deriv-App-ID needed for OAuth [citation:5]
      },
    });

    const data = await response.json();

    if (!response.ok) {
      log(`Account fetch failed: ${data.error?.message || 'Unknown error'}`, "error");
      return false;
    }

    const accounts = data.data || [];
    const demoAccount = accounts.find(a => a.account_type === "demo" || a.type === "demo");

    if (!demoAccount) {
      log("No demo account found. Please create one on Deriv.", "error");
      return false;
    }

    accountId = demoAccount.account_id;
    accountInfo.textContent = `Demo Account: ${accountId}`;
    log(`✅ Connected to demo account: ${accountId}`, "success");

    // Enable bot controls
    startBtn.disabled = false;
    return true;

  } catch (err) {
    log(`Network error: ${err.message}`, "error");
    return false;
  }
}

// ---- UI STATE ----
function showDashboard() {
  loginCard.style.display = "none";
  botDashboard.classList.add("show");
  authDot.classList.add("connected");
  authText.textContent = "Connected";
}

function showLogin() {
  loginCard.style.display = "block";
  botDashboard.classList.remove("show");
  authDot.classList.remove("connected");
  authText.textContent = "Not logged in";
}

// ---- LOGGING ----
function log(msg, type = "info") {
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${msg}`;
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}

// ---- BOT CONTROLS (placeholder — trading logic comes next) ----
startBtn.addEventListener("click", () => {
  if (!accountId) return;
  botRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
  log("▶ Bot started (trading logic not yet implemented)", "trade");
  log("Next step: add OTP + WebSocket trading.", "info");
});

stopBtn.addEventListener("click", () => {
  botRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  log("■ Bot stopped", "info");
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem('deriv_access_token');
  accessToken = null;
  accountId = null;
  showLogin();
  log("Logged out.", "info");
});

loginBtn.addEventListener("click", startLogin);

// ---- BOOT ----
async function init() {
  // Check if returning from OAuth redirect
  const success = await handleCallback();

  if (success) {
    // Verify token and fetch account
    const accountOk = await fetchAccount();
    if (accountOk) {
      showDashboard();
    } else {
      showLogin();
    }
  } else {
    // Check for existing token in sessionStorage
    const storedToken = sessionStorage.getItem('deriv_access_token');
    if (storedToken) {
      accessToken = storedToken;
      const accountOk = await fetchAccount();
      if (accountOk) {
        showDashboard();
      } else {
        showLogin();
      }
    } else {
      showLogin();
    }
  }

  log("Speed Bot ready.", "info");
}

init();