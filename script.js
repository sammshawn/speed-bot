// ============================================
//  ENGINE (REBUILT)
// ============================================

// Remove cachedProposal variable from your state section entirely.

function handleTick(tick) {
  if (tick.symbol && tick.symbol !== marketSelect.value) return;
  const priceStr = formatTick(tick);
  const digit = lastDigit(priceStr);

  if (!isExecuting || tradeLock) return;

  // --- HOOK LOGIC (After a Loss) ---
  if (botState === "HOOK") {
    // Check if the *current* digit satisfies the contract condition
    if (checkWinCondition(digit)) {
      hookTicksCount++;
      if (hookTicksCount >= 2) {
        logInfo("Hook fired. Requesting fresh proposal...");
        hookTicksCount = 0;
        // Do NOT use a cached proposal here. Fetch a new one.
        requestFreshProposal(priceStr, digit);
      }
    } else {
      hookTicksCount = 0;
    }
    return;
  }

  // --- NORMAL TRADING ---
  if (botState === "TRADING") {
    requestFreshProposal(priceStr, digit);
  }
}

// This function is the single entry point for getting a proposal.
function requestFreshProposal(entryPrice, entryDigit) {
  if (!isExecuting || tradeLock || !wsOpen()) return;

  // 1. Set the lock immediately to prevent duplicate requests.
  tradeLock = true;
  botState = "AWAITING_PROPOSAL";
  
  // 2. Store the entry context for logging later.
  currentEntry = { price: entryPrice, digit: entryDigit };
  currentStake = stakeForStep(currentMartingaleStep);

  // 3. Send the proposal request.
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
  
  // Only add barrier if the contract type requires it.
  if (NEEDS_BARRIER.includes(contractType.value)) {
    params.barrier = String(getBarrier());
  }

  const ok = send(params);
  if (!ok) {
    // Connection issue; reset state.
    tradeLock = false;
    if (isExecuting) botState = "TRADING";
  }
}

// Handle the proposal response.
function handleProposal(proposal) {
  // If we're not supposed to be buying, ignore stray proposals.
  if (!tradeLock || botState !== "AWAITING_PROPOSAL") return;

  // We have a fresh proposal. Execute the buy immediately.
  executeBuy(proposal.id, proposal.ask_price);
}

function executeBuy(proposalId, price) {
  // We are already locked. Just update the state.
  botState = "BUYING";
  
  const ok = send({ buy: proposalId, price: price });
  if (!ok) {
    tradeLock = false;
    botState = "TRADING";
    return;
  }

  // Set a timeout to prevent a permanent lock if the buy response never arrives.
  clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    if (tradeLock && !currentContractId && botState === "BUYING") {
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
  botState = "WAITING_RESULT"; // Now we wait for the contract to close.

  if (buy.balance_after !== undefined) {
    balanceEl.textContent = `$${parseFloat(buy.balance_after).toFixed(2)}`;
  }

  send({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
}

function handleContractUpdate(c) {
  if (!c.is_sold) return;
  if (c.contract_id !== currentContractId) return;

  clearTimeout(resultTimer);
  send({ forget: c.id });

  const profit = parseFloat(c.profit) || 0;
  
  const entryPrice = extractPrice(c, true) || currentEntry.price;
  const exitPrice = extractPrice(c, false) || currentEntry.price;
  const entryDigit = lastDigit(entryPrice);
  const exitDigit = lastDigit(exitPrice);

  totalPL += profit;
  updateTotalPL();

  if (profit > 0) {
    wins++;
    winsEl.textContent = wins;
    logTrade("win", entryPrice, entryDigit, exitPrice, exitDigit, currentStake, profit);
    
    // --- WIN: Reset Martingale ---
    currentMartingaleStep = 1;
    // baseStake remains what the user started with.
    updateMartingaleUI();
    
    if (isExecuting) {
      botState = "TRADING";
      tradeLock = false; // Unlock for the next trade.
    }
  } else {
    losses++;
    lossesEl.textContent = losses;
    logTrade("loss", entryPrice, entryDigit, exitPrice, exitDigit, currentStake, profit);

    // --- LOSS: Martingale Step ---
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
      tradeLock = false; // IMPORTANT: Unlock so the hook can monitor ticks.
      logInfo("Hook active. Waiting for 2 winning digits…");
    }
  }

  currentContractId = null;
  // Note: If we won, we already unlocked and set state to TRADING.
  // The next tick will trigger requestFreshProposal.
}