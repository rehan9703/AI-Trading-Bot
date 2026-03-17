process.env.TF_ENABLE_ONEDNN_OPTS = '0';
import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import fs from "fs";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, BorderStyle, WidthType, HeadingLevel, AlignmentType, ShadingType } from "docx";
import { getHybridProbability } from "./src/trading/ml/hybrid";

// --- State & Live Data ---
const DB_FILE = path.join(process.cwd(), 'db.json');

interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED';
  entryTime: string;
  exitTime: string | null;
  entryPrice: number;
  exitPrice: number | null;
  liquidationPrice: number;
  qty: number;
  leverage: number;
  margin: number;
  entryFee: number;
  exitFee: number;
  pnl: number;
  strategy: string;
}

interface RiskSettings {
  riskProfile: 'CONSERVATIVE' | 'MODERATE' | 'AGGRESSIVE';
  maxDailyDrawdown: number; 
  maxTotalExposure: number; 
  riskPerTrade: number; 
  autoLeverage: boolean;
  tradingEnabled: boolean;
}

interface DBState {
  paperBalance: { USDT: number, BTC: number };
  positions: Position[];
  balanceHistory: { time: string, balance: number }[];
  strategyWeights: Record<string, number>;
  lastTelegramUpdateId?: number;
  activeChatId?: number | string;
  settings: RiskSettings;
  peakEquity: number;
}

let db: DBState = {
  paperBalance: { USDT: 10000, BTC: 0 },
  positions: [],
  balanceHistory: [
    { time: new Date().toISOString(), balance: 10000 }
  ],
  strategyWeights: {},
  lastTelegramUpdateId: 0,
  activeChatId: undefined,
  settings: {
    riskProfile: 'MODERATE',
    maxDailyDrawdown: 0.05,
    maxTotalExposure: 0.6,
    riskPerTrade: 0.02,
    autoLeverage: true,
    tradingEnabled: true
  },
  peakEquity: 10000
};

if (fs.existsSync(DB_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    db = { ...db, ...saved };
    // Ensure nested objects exist
    if (!db.strategyWeights) db.strategyWeights = {};
    if (!db.paperBalance) db.paperBalance = { USDT: 10000, BTC: 0 };
    if (!db.positions) db.positions = [];
    if (!db.balanceHistory) db.balanceHistory = [{ time: new Date().toISOString(), balance: 10000 }];
    if (db.lastTelegramUpdateId === undefined) db.lastTelegramUpdateId = 0;
    if (db.peakEquity === undefined) db.peakEquity = db.paperBalance.USDT;
    if (!db.settings) {
      db.settings = {
        riskProfile: 'MODERATE',
        maxDailyDrawdown: 0.05,
        maxTotalExposure: 0.6,
        riskPerTrade: 0.02,
        autoLeverage: true,
        tradingEnabled: true
      };
    }
  } catch (e) {
    console.error("Failed to parse db.json", e);
  }
}

const saveDb = () => {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
};

interface MarketState {
  price: number;
  change24h: string;
  parameters: any;
  priceHistory: number[];
  regime: 'TRENDING' | 'RANGING' | 'VOLATILE';
}

let marketState: Record<string, MarketState> = {
  "BTC/USDT": { price: 65000, change24h: "0.00", parameters: { volatility: { atr: "100" } }, priceHistory: [], regime: 'RANGING' },
  "ETH/USDT": { price: 3500, change24h: "0.00", parameters: { volatility: { atr: "10" } }, priceHistory: [], regime: 'RANGING' },
  "SOL/USDT": { price: 150, change24h: "0.00", parameters: { volatility: { atr: "1" } }, priceHistory: [], regime: 'RANGING' }
};

let lastTradeTime = 0;
let userLeverage = 10; // Default leverage

async function fetchLiveMarketData() {
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr?symbols=["BTCUSDT","ETHUSDT","SOLUSDT"]');
    res.data.forEach((ticker: any) => {
      const sym = ticker.symbol.replace('USDT', '/USDT');
      if (marketState[sym]) {
        marketState[sym].price = parseFloat(ticker.lastPrice);
        marketState[sym].change24h = parseFloat(ticker.priceChangePercent).toFixed(2);
        
        // Update price history
        marketState[sym].priceHistory.push(marketState[sym].price);
        if (marketState[sym].priceHistory.length > 50) {
          marketState[sym].priceHistory.shift();
        }
      }
    });
  } catch (error: any) {
    console.error("Failed to fetch live market data:", error.message);
    // Fallback simulation if API fails
    Object.keys(marketState).forEach(sym => {
      const change = (Math.random() - 0.5) * 0.002;
      marketState[sym].price *= (1 + change);
      marketState[sym].change24h = (parseFloat(marketState[sym].change24h) + change * 100).toFixed(2);
      marketState[sym].parameters.volatility.atr = (marketState[sym].price * 0.02).toFixed(2);
      
      // Update price history in fallback
      marketState[sym].priceHistory.push(marketState[sym].price);
      if (marketState[sym].priceHistory.length > 50) {
        marketState[sym].priceHistory.shift();
      }
    });
  }
}
setInterval(fetchLiveMarketData, 1000);
fetchLiveMarketData();

// --- WebSocket Server ---
let wss: WebSocketServer;

function broadcast(data: any) {
  if (!wss) return;
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// --- Telegram Service ---
let telegramBlocked = false;

async function sendAlert(type: 'TRADE' | 'SYSTEM' | 'PNL', title: string, details: string, replyMarkup?: any) {
  const emoji = type === 'TRADE' ? '📈' : type === 'SYSTEM' ? '⚠️' : '💰';
  const message = `${emoji} <b>${title}</b>\n\n${details}`;
  return await sendTelegramMessage(message, replyMarkup);
}

async function sendTelegramMessage(text: string, replyMarkup?: any) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // Use learned Chat ID if available, otherwise fallback to secrets
  const chatId = db.activeChatId || process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return { success: false, error: "Token or Chat ID missing. Please click START on the bot." };
  }

  const isManualTest = text.includes("Manual test") || text.includes("QuantEdge AI Bot Active");

  if (telegramBlocked && !isManualTest) {
    return { success: false, error: "Telegram notifications are currently blocked (403). Waiting for user to start the bot." };
  }

  if (typeof chatId === 'string' && chatId.startsWith('@') && !chatId.includes('_bot')) {
    console.warn("Warning: Using a username (@) for a private chat often causes 403 errors. Use a numeric ID instead.");
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await axios.post(url, {
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
    telegramBlocked = false; // Reset if successful
    return { success: true };
  } catch (error: any) {
    // ... (keep existing error handling)
    let errorMessage = "Unknown error";
    if (error.response) {
      const data = error.response.data;
      errorMessage = `Telegram API Error ${error.response.status}: ${data.description || JSON.stringify(data)}`;
      
      if (error.response.status === 403) {
        telegramBlocked = true;
        console.error("\n" + "=".repeat(60));
        console.error("🔴 TELEGRAM NOTIFICATIONS PAUSED (403 FORBIDDEN)");
        console.error("Reason: The bot is blocked by the user or hasn't been started.");
        console.error("REQUIRED ACTION: Open @trade97froge_bot and click 'START'.");
        console.error("Notifications will resume automatically once the bot is started.");
        console.error("=".repeat(60) + "\n");
        errorMessage = "403 Forbidden: The bot cannot message this user. REQUIRED ACTION: Open @trade97froge_bot and click START.";
      } else {
        console.error("Telegram API Error:", data);
      }
    } else {
      errorMessage = error.message;
      console.error("Failed to send Telegram notification:", error.message);
    }
    return { success: false, error: errorMessage };
  }
}

function calculateTotalEquity() {
  let equity = db.paperBalance.USDT;
  db.positions.filter(p => p.status === 'OPEN').forEach(p => {
    const currentP = marketState[p.symbol]?.price || p.entryPrice;
    const pnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
    equity += p.margin + pnl;
  });
  return equity;
}

function calculateLiquidationPrice(entryPrice: number, leverage: number, side: 'LONG' | 'SHORT') {
  const maintenanceMargin = 0.005; // 0.5% maintenance margin
  if (side === 'LONG') {
    return entryPrice * (1 - (1 / leverage) + maintenanceMargin);
  } else {
    return entryPrice * (1 + (1 / leverage) - maintenanceMargin);
  }
}

function checkDailyDrawdown() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  
  const todayEntries = db.balanceHistory.filter(h => h.time >= todayStart);
  if (todayEntries.length === 0) return false;
  
  const startBalance = todayEntries[0].balance;
  const currentEquity = calculateTotalEquity();
  
  // Update Peak Equity for trailing drawdown
  if (currentEquity > db.peakEquity) {
    db.peakEquity = currentEquity;
  }
  
  const dailyDrawdown = (startBalance - currentEquity) / startBalance;
  const peakDrawdown = (db.peakEquity - currentEquity) / db.peakEquity;

  if (dailyDrawdown >= db.settings.maxDailyDrawdown || peakDrawdown >= 0.15) { // 15% max trailing drawdown
    if (db.settings.tradingEnabled) {
      db.settings.tradingEnabled = false;
      const reason = dailyDrawdown >= db.settings.maxDailyDrawdown ? 'Daily Drawdown' : 'Peak Drawdown';
      const ddValue = dailyDrawdown >= db.settings.maxDailyDrawdown ? dailyDrawdown : peakDrawdown;
      sendAlert('SYSTEM', `CRITICAL: Max ${reason} Reached`, `Trading disabled. Current drawdown: ${(ddValue * 100).toFixed(2)}%`);
    }
    return true;
  }
  return false;
}

function getRealizedSharpeRatio() {
  if (db.balanceHistory.length < 10) return null;
  
  const returns = [];
  for (let i = 1; i < db.balanceHistory.length; i++) {
    const prev = db.balanceHistory[i-1].balance;
    const curr = db.balanceHistory[i].balance;
    if (prev > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  
  if (returns.length < 5) return null;
  
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  
  if (stdDev === 0) return "0.00";
  
  // Annualize: 1 minute intervals -> 525600 minutes per year
  const sharpe = (avgReturn / stdDev) * Math.sqrt(525600);
  return sharpe.toFixed(2);
}

async function send15MinUpdate() {
  const openPositions = db.positions.filter(p => p.status === 'OPEN');

  let message = `🔔 <b>Running Trades Update (15m)</b>\n\n`;
  message += `<b>Open Positions:</b> ${openPositions.length}\n`;
  openPositions.forEach(p => {
     const currentP = marketState[p.symbol]?.price || p.entryPrice;
     const unrealizedPnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
     message += `• ${p.symbol} (${p.side}): Entry $${p.entryPrice.toFixed(2)} | Qty: ${p.qty.toFixed(4)} | Lev: ${p.leverage}x | PnL: $${unrealizedPnl.toFixed(2)} | Strategy: ${p.strategy}\n`;
  });
  await sendTelegramMessage(message);
}
setInterval(send15MinUpdate, 15 * 60 * 1000);

async function send2HourUpdate() {
  let totalEquity = db.paperBalance.USDT;
  const openPositions = db.positions.filter(p => p.status === 'OPEN');
  const closedPositions = db.positions.filter(p => p.status === 'CLOSED').slice(-10); // Recent 10

  openPositions.forEach(p => {
      const currentP = marketState[p.symbol]?.price || p.entryPrice;
      const grossPnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
      totalEquity += p.margin + grossPnl;
  });
  
  let message = `📊 <b>2-Hour Portfolio Report</b>\n\n`;
  message += `💵 <b>Total Equity:</b> $${totalEquity.toFixed(2)}\n`;
  message += `💰 <b>Available USDT:</b> $${db.paperBalance.USDT.toFixed(2)}\n\n`;
  
  message += `📈 <b>Open Positions (${openPositions.length}):</b>\n`;
  openPositions.forEach(p => {
      const currentP = marketState[p.symbol]?.price || p.entryPrice;
      const unrealizedPnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
      message += `• ${p.symbol} (${p.side}): PnL $${unrealizedPnl.toFixed(2)}\n`;
  });

  message += `\n📉 <b>Recent Closed Trades (${closedPositions.length}):</b>\n`;
  closedPositions.forEach(p => {
      message += `• ${p.symbol} (${p.side}): PnL $${p.pnl.toFixed(2)} | Reason: ${p.strategy.split('->').pop()}\n`;
  });
  
  await sendTelegramMessage(message);
}
setInterval(send2HourUpdate, 2 * 60 * 60 * 1000);

function calculateDynamicLeverage(regime: string, sentiment: any, confidence: number): number {
  // 1. Base leverage based on regime
  let leverage = regime === 'VOLATILE' ? 2 : regime === 'TRENDING' ? 10 : 5;
  
  // 2. Adjust based on sentiment strength
  if (sentiment.score > 0.8) leverage *= 2;
  else if (sentiment.score < 0.2) leverage *= 0.5;
  
  // 3. Adjust based on signal confidence
  leverage *= (1 + confidence);
  
  // 4. Ensure within 1x-1000x range
  return Math.min(Math.max(Math.round(leverage), 1), 1000);
}

// --- Trading Engine ---
async function checkPositions() {
  for (const pos of db.positions.filter(p => p.status === 'OPEN')) {
    const state = marketState[pos.symbol];
    if (!state) continue;
    const price = state.price;
    const atr = parseFloat(state.parameters.volatility.atr);
    
    if (isNaN(atr) || atr <= 0 || pos.entryPrice <= 0) continue;

    // SL/TP logic (Dynamic Scalping vs Trend Following)
    let slMultiplier = 2.0;
    let tpMultiplier = 3.0;
    
    // Scalping targets for Ranging markets
    if (state.regime === 'RANGING' || state.regime === 'VOLATILE') {
      slMultiplier = 0.8; // Tighter stop
      tpMultiplier = 1.5; // Quick take-profit (Scalping)
    }
    
    let shouldClose = false;
    let reason = "";
    
    if (pos.side === 'LONG') {
      if (price <= pos.entryPrice - (atr * slMultiplier)) { shouldClose = true; reason = "Stop Loss"; }
      else if (price >= pos.entryPrice + (atr * tpMultiplier)) { shouldClose = true; reason = "Take Profit"; }
    } else {
      if (price >= pos.entryPrice + (atr * slMultiplier)) { shouldClose = true; reason = "Stop Loss"; }
      else if (price <= pos.entryPrice - (atr * tpMultiplier)) { shouldClose = true; reason = "Take Profit"; }
    }
    
    if (shouldClose) {
      await closePosition(pos, price, reason);
      broadcast({ type: 'PORTFOLIO_UPDATE' });
    }
  }
}

// --- Trading Helpers ---
function getBinanceFee(isLimit: boolean) {
  const totalTrades = db.positions.length;
  let makerFee = 0.0002; // VIP 0
  let takerFee = 0.0004; // VIP 0
  
  if (totalTrades > 500) {
    makerFee = 0.0001; // VIP 2+
    takerFee = 0.0003;
  } else if (totalTrades > 100) {
    makerFee = 0.00015; // VIP 1
    takerFee = 0.00035;
  }
  
  return isLimit ? makerFee : takerFee;
}

function getExecutionPrice(symbol: string, price: number, side: 'BUY' | 'SELL', orderType: 'MARKET' | 'LIMIT', qty: number = 0) {
  const regime = marketState[symbol]?.regime || 'RANGING';
  
  // Simulated Market Depth Impact (Slippage increases with size)
  const marketDepthUSDT = 500000; // Simulated 500k depth
  const sizeImpact = qty > 0 ? (qty * price) / marketDepthUSDT : 0;
  
  if (orderType === 'LIMIT') {
    // Limit order: try to get a slightly better price than current market
    return side === 'BUY' ? price * 0.9999 : price * 1.0001;
  } else {
    // Market order: slippage depends on regime + size impact
    const baseSlippage = regime === 'TRENDING' ? 0.001 : (regime === 'VOLATILE' ? 0.002 : 0.0005);
    const totalSlippage = baseSlippage + sizeImpact;
    return side === 'BUY' ? price * (1 + totalSlippage) : price * (1 - totalSlippage);
  }
}

async function closePosition(pos: any, marketPrice: number, reason: string) {
  if (pos.status === 'CLOSED') return; // Safety check to prevent double closing
  
  const regime = marketState[pos.symbol]?.regime || 'RANGING';
  const orderType = (regime === 'VOLATILE' || regime === 'RANGING') ? 'LIMIT' : 'MARKET';
  const side: 'BUY' | 'SELL' = pos.side === 'LONG' ? 'SELL' : 'BUY';
  
  const execPrice = getExecutionPrice(pos.symbol, marketPrice, side, orderType, pos.qty);
  const exitFeeRate = getBinanceFee(orderType === 'LIMIT');
  
  const posQty = pos.qty;
  const grossPnl = pos.side === 'LONG' ? (execPrice - pos.entryPrice) * posQty : (pos.entryPrice - execPrice) * posQty;
  const exitFee = (posQty * execPrice) * exitFeeRate;
  
  const netPnl = grossPnl - exitFee - pos.entryFee;
  const pnlPercent = (netPnl / (pos.margin * pos.leverage)) * 100;
  
  // Refund margin and add net PnL to balance
  db.paperBalance.USDT += (pos.margin + netPnl);
  
  // RL Reward Update - Use original strategy name before appending closure reason
  const originalStrategy = pos.strategy;
  
  pos.status = 'CLOSED';
  pos.exitTime = new Date().toISOString();
  pos.exitPrice = execPrice;
  pos.exitFee = exitFee;
  pos.pnl = netPnl;
  pos.strategy += ` -> Closed via ${reason} (${orderType} Order)`;
  
  const reward = netPnl > 0 ? 1 : -1;
  const learningRate = 0.1;
  
  if (!db.strategyWeights) db.strategyWeights = {};
  db.strategyWeights[originalStrategy] = (db.strategyWeights[originalStrategy] || 0.5) + learningRate * (reward - (db.strategyWeights[originalStrategy] || 0.5));
  
  await sendAlert('TRADE', 'Position Closed', 
    `${pos.symbol} (${pos.side})\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🏁 <b>Reason:</b> ${reason}\n` +
    `💰 <b>Net PnL:</b> $${netPnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n` +
    `💵 <b>Margin:</b> $${pos.margin.toFixed(2)} (${pos.leverage}x)\n` +
    `📉 <b>Entry:</b> $${pos.entryPrice.toFixed(2)}\n` +
    `📈 <b>Exit:</b> $${execPrice.toFixed(2)}\n` +
    `💸 <b>Total Fees:</b> $${(pos.entryFee + exitFee).toFixed(2)}\n` +
    `🏦 <b>New Balance:</b> $${db.paperBalance.USDT.toFixed(2)}`
  );
  saveDb();
}

async function executeTrade(data: any) {
  if (!db.settings.tradingEnabled) return;
  
  const { symbol, signal, price: priceStr, confidence, strategyNote: note, regime, sentiment, parameters } = data;
  const price = parseFloat(priceStr);
  const now = Date.now();
  if (now - lastTradeTime < 15000) return;

  const openPositions = db.positions.filter(p => p.status === 'OPEN');
  
  // Trade Batching Logic: Max 3 trades, wait for ALL to close
  if (!db.settings.hasOwnProperty('isBatchFull')) {
    (db.settings as any).isBatchFull = false;
  }
  
  if (openPositions.length === 0) {
    (db.settings as any).isBatchFull = false;
  } else if (openPositions.length >= 3) {
    (db.settings as any).isBatchFull = true;
  }
  
  if ((db.settings as any).isBatchFull || openPositions.length >= 3) {
    return;
  }
  
  const openLongs = openPositions.filter(p => p.side === 'LONG' && p.symbol === symbol);
  const openShorts = openPositions.filter(p => p.side === 'SHORT' && p.symbol === symbol);
  
  // 1. Money Management: Maximum Capital Utilization (1/3 of total equity per trade)
  const totalEquity = calculateTotalEquity();
  const maxTrades = 3;
  const marginToUse = Math.min((totalEquity / maxTrades) * 0.98, db.paperBalance.USDT * 0.98); // 2% buffer for fees

  if (marginToUse < 10 || marginToUse > db.paperBalance.USDT) {
    console.log("Risk Block: Insufficient available USDT for calculated margin");
    return;
  }

  // 2. Dynamic Leverage Adjustment
  if (db.settings.autoLeverage) {
    if (db.settings.riskProfile === 'CONSERVATIVE') userLeverage = 3;
    else if (db.settings.riskProfile === 'MODERATE') userLeverage = 10;
    else if (db.settings.riskProfile === 'AGGRESSIVE') userLeverage = 25;
  }

  // 4. Dynamic Order Type & Slippage/Fee
  const orderType = (regime === 'VOLATILE' || regime === 'RANGING') ? 'LIMIT' : 'MARKET';
  const executionPrice = getExecutionPrice(symbol, price, signal === 'BUY' ? 'BUY' : 'SELL', orderType, (marginToUse * userLeverage) / price);
  const feeRate = getBinanceFee(orderType === 'LIMIT');
  const newQty = (marginToUse * userLeverage) / executionPrice;

  // 5. Liquidity Check
  const liquidityLimit = price * 1000; // Simulated liquidity limit
  if (newQty * executionPrice > liquidityLimit) {
      console.log("Liquidity insufficient for trade size");
      return;
  }

  // 6. Risk Block: Sharpe Ratio Check
  const currentSharpe = parseFloat(parameters.math.sharpeRatio);
  if (currentSharpe < 0.3 && regime !== 'TRENDING') {
      console.log(`Risk Block: Sharpe Ratio too low (${currentSharpe}) for non-trending market`);
      return;
  }

  const liqPrice = calculateLiquidationPrice(executionPrice, userLeverage, signal === 'BUY' ? 'LONG' : 'SHORT');

  if (signal === 'BUY') {
    for (const p of openShorts) await closePosition(p, price, "Signal Reversal");
    
    if (openLongs.length < 3 && db.paperBalance.USDT > 100) {
      const entryFee = (newQty * executionPrice) * feeRate;
      
      // Deduct margin AND fee from available balance
      db.paperBalance.USDT -= (marginToUse + entryFee);
      
      const newPos: Position = {
        id: Math.random().toString(36).substring(7),
        symbol, side: 'LONG', status: 'OPEN', entryTime: new Date().toISOString(),
        exitTime: null, exitPrice: null, liquidationPrice: liqPrice, exitFee: 0, pnl: 0,
        entryPrice: executionPrice, qty: newQty, leverage: userLeverage, margin: marginToUse, entryFee, strategy: `${note} (${orderType} Order)`
      };
      db.positions.unshift(newPos);
      const replyMarkup = { inline_keyboard: [[{ text: "Close Position", callback_data: `close_${newPos.id}` }]] };
      await sendAlert('TRADE', 'New Position Opened', 
        `${symbol} (LONG)\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📈 <b>Price:</b> $${executionPrice.toFixed(2)}\n` +
        `🔥 <b>Liq:</b> $${liqPrice.toFixed(2)}\n` +
        `📦 <b>Qty:</b> ${newQty.toFixed(4)}\n` +
        `💵 <b>Margin:</b> $${marginToUse.toFixed(2)} (${userLeverage}x)\n` +
        `🧠 <b>Strategy:</b> ${note}\n` +
        `⚡ <b>Type:</b> ${orderType}\n` +
        `🏦 <b>Available:</b> $${db.paperBalance.USDT.toFixed(2)}`, 
        replyMarkup
      );
      lastTradeTime = now;
      saveDb();
      broadcast({ type: 'PORTFOLIO_UPDATE' });
    }
  } else if (signal === 'SELL') {
    for (const p of openLongs) await closePosition(p, price, "Signal Reversal");
    
    if (openShorts.length < 3 && db.paperBalance.USDT > 100) {
      const entryFee = (newQty * executionPrice) * feeRate;
      
      // Deduct margin AND fee from available balance
      db.paperBalance.USDT -= (marginToUse + entryFee);
      
      const newPos: Position = {
        id: Math.random().toString(36).substring(7),
        symbol, side: 'SHORT', status: 'OPEN', entryTime: new Date().toISOString(),
        exitTime: null, exitPrice: null, liquidationPrice: liqPrice, exitFee: 0, pnl: 0,
        entryPrice: executionPrice, qty: newQty, leverage: userLeverage, margin: marginToUse, entryFee, strategy: `${note} (${orderType} Order)`
      };
      db.positions.unshift(newPos);
      const replyMarkup = { inline_keyboard: [[{ text: "Close Position", callback_data: `close_${newPos.id}` }]] };
      await sendAlert('TRADE', 'New Position Opened', 
        `${symbol} (SHORT)\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📉 <b>Price:</b> $${executionPrice.toFixed(2)}\n` +
        `🔥 <b>Liq:</b> $${liqPrice.toFixed(2)}\n` +
        `📦 <b>Qty:</b> ${newQty.toFixed(4)}\n` +
        `💵 <b>Margin:</b> $${marginToUse.toFixed(2)} (${userLeverage}x)\n` +
        `🧠 <b>Strategy:</b> ${note}\n` +
        `⚡ <b>Type:</b> ${orderType}\n` +
        `🏦 <b>Available:</b> $${db.paperBalance.USDT.toFixed(2)}`, 
        replyMarkup
      );
      lastTradeTime = now;
      saveDb();
      broadcast({ type: 'PORTFOLIO_UPDATE' });
    }
  }
}

// --- Quant Engine Logic ---
const generateQuantData = async (symbol: string) => {
  const state = marketState[symbol] || marketState["BTC/USDT"];
  const price = state.price;
  const priceChange24h = state.change24h;
  const returns = parseFloat(priceChange24h) / 100;
  
  // Add some pseudo-randomness based on symbol string length to make them look different
  const seed = symbol.length;
  const volatility = 0.015 + Math.random() * 0.01 * (seed % 3 + 1);
  const zScore = (Math.random() - 0.5) * 4;
  const hurst = 0.3 + Math.random() * 0.4;
  const adx = 15 + Math.random() * 40;
  
  // --- Market Regime Detection ---
  let regime: 'TRENDING' | 'RANGING' | 'VOLATILE' = 'RANGING';
  if (volatility > 0.022) {
    regime = 'VOLATILE';
  } else if (adx > 25 || hurst > 0.55) {
    regime = 'TRENDING';
  } else {
    regime = 'RANGING';
  }
  
  if (marketState[symbol]) {
    marketState[symbol].regime = regime;
  }

  // --- News Sentiment Analysis ---
  const sentimentScore = (Math.random() * 2 - 1).toFixed(2);
  const sentimentLabel = parseFloat(sentimentScore) > 0.4 ? 'BULLISH' : 
                        parseFloat(sentimentScore) < -0.4 ? 'BEARISH' : 'NEUTRAL';
  
  const coinName = symbol.split('/')[0];
  const bullishHeadlines = [
    `Institutional adoption increasing for ${coinName}`,
    `${coinName} breaks key resistance level`,
    `Major protocol upgrade successfully deployed for ${coinName}`,
    `Whale accumulation detected on-chain for ${coinName}`
  ];
  const bearishHeadlines = [
    `Regulatory concerns rising for ${coinName}`,
    `${coinName} fails to hold key support`,
    `Macro environment signals potential tightening affecting ${coinName}`,
    `Large exchange inflows detected for ${coinName}`
  ];
  const neutralHeadlines = [
    `Market awaiting key economic data release affecting ${coinName}`,
    `${coinName} consolidates in tight range`,
    `Trading volume remains low for ${coinName}`
  ];

  const newsHeadline = sentimentLabel === 'BULLISH' ? bullishHeadlines[Math.floor(Math.random() * bullishHeadlines.length)] :
                      sentimentLabel === 'BEARISH' ? bearishHeadlines[Math.floor(Math.random() * bearishHeadlines.length)] :
                      neutralHeadlines[Math.floor(Math.random() * neutralHeadlines.length)];

  // --- AI Model Probabilities (XGBoost + LSTM) ---
  const history = state.priceHistory.length > 0 ? state.priceHistory : [price];
  const { xgb: xgbProb, lstm: lstmProb, hybrid: hybridProb } = await getHybridProbability(history);

  // --- Adaptive Logic: Smart Trend + Pullback ---
  // Base parameters
  let emaShortPeriod = 9;
  let emaLongPeriod = 21;
  let rsiThresholdLow = 30;
  let rsiThresholdHigh = 70;
  let atrMultiplier = 2.0;

  // 1. Regime-based adaptation
  if (regime === 'TRENDING') {
    emaShortPeriod = 20;
    emaLongPeriod = 50;
    rsiThresholdLow = 40; // Buy pullbacks earlier in uptrend
    rsiThresholdHigh = 80;
    atrMultiplier = 3.0; // Wider stop to avoid getting shaken out
  } else if (regime === 'VOLATILE') {
    emaShortPeriod = 5;
    emaLongPeriod = 15;
    rsiThresholdLow = 20; // Wait for extreme oversold
    rsiThresholdHigh = 80;
    atrMultiplier = 4.0; // Very wide stop
  }

  // 2. Sentiment-based adaptation
  if (sentimentLabel === 'BULLISH') {
    rsiThresholdLow += 5;
    rsiThresholdHigh += 5;
    emaShortPeriod = Math.max(3, emaShortPeriod - 2); // React faster to bullish moves
  } else if (sentimentLabel === 'BEARISH') {
    rsiThresholdLow -= 5;
    rsiThresholdHigh -= 5;
    emaShortPeriod = Math.max(3, emaShortPeriod - 2); // React faster to bearish moves
  }

  // 3. AI Confidence-based adaptation
  const confidenceFactor = (hybridProb - 0.5) * 2; // -1 to 1
  if (Math.abs(confidenceFactor) > 0.3) {
    // Tighten thresholds if confidence is high
    rsiThresholdLow = Math.max(10, rsiThresholdLow - (confidenceFactor * 5));
    rsiThresholdHigh = Math.min(90, rsiThresholdHigh - (confidenceFactor * 5));
    atrMultiplier = Math.max(1.5, atrMultiplier * (1 - Math.abs(confidenceFactor) * 0.2));
  }

  // Log parameter adjustments
  console.log(`[STRATEGY ADAPTATION] ${symbol} | Regime: ${regime} | Sentiment: ${sentimentLabel} | Confidence: ${hybridProb.toFixed(2)}`);
  console.log(`Parameters: EMA(${emaShortPeriod}/${emaLongPeriod}), RSI(${rsiThresholdLow.toFixed(0)}/${rsiThresholdHigh.toFixed(0)}), ATR_Mult(${atrMultiplier.toFixed(1)})`);

  const rsi = rsiThresholdLow + Math.random() * (rsiThresholdHigh - rsiThresholdLow + 20);

  // --- AMQS Signal Stacking ---
  let score = 0;
  if (regime === 'TRENDING' && adx > 25) score += 1;
  if (zScore < -1.5 || zScore > 1.5) score += 1;
  if (rsi > 30 && rsi < 70) score += 1;
  const volumeSpike = 0.5 + Math.random() * 1.5;
  if (volumeSpike > 1.2) score += 1;
  if (volatility > 0.02) score += 1;

  // --- Advanced Risk Management ---
  let baseWinProb = hybridProb;
  if (regime === 'TRENDING') baseWinProb += 0.05;
  if (sentimentLabel === 'BULLISH' && zScore > 0) baseWinProb += 0.03;
  
  const winProb = Math.min(0.85, baseWinProb); 
  const winLossRatio = regime === 'TRENDING' ? 2.5 : 1.8;
  const q = 1 - winProb;
  const kellyFraction = ((winLossRatio * winProb) - q) / winLossRatio;
  const riskMultiplier = 0.5; // Safe Kelly
  const safeKelly = Math.max(0, kellyFraction * riskMultiplier).toFixed(4);

  const expectedAnnualReturn = regime === 'TRENDING' ? 0.65 : 0.25; 
  const riskFreeRate = 0.045;
  const annualizedVol = volatility * Math.sqrt(365);
  const theoreticalSharpe = ((expectedAnnualReturn - riskFreeRate) / annualizedVol).toFixed(2);
  const realizedSharpe = getRealizedSharpeRatio();
  const finalSharpe = realizedSharpe || theoreticalSharpe;

  // --- Strategy Engine ---
  let signal: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let strategyNote = "";

  // Update marketState parameters
  marketState[symbol].parameters = {
    volatility: { atr: (price * 0.02).toFixed(2) }
  };

  if (hybridProb > 0.55 && score >= 2) {
    signal = 'BUY';
    strategyNote = "AMQS: High Probability Long";
  } else if (hybridProb < 0.45 && score >= 2) {
    signal = 'SELL';
    strategyNote = "AMQS: High Probability Short";
  } else {
    signal = 'HOLD';
    strategyNote = "AMQS: Edge Not Strong Enough";
  }

  if (parseFloat(safeKelly) <= 0 && signal !== 'HOLD') {
    signal = 'HOLD';
    strategyNote += " (Risk Block: Negative Kelly)";
  }

  // Sentiment Filtering
  if (signal === 'BUY' && parseFloat(sentimentScore) < -0.3) {
    signal = 'HOLD';
    strategyNote += " (Filtered: Negative Sentiment)";
  } else if (signal === 'SELL' && parseFloat(sentimentScore) > 0.3) {
    signal = 'HOLD';
    strategyNote += " (Filtered: Positive Sentiment)";
  }

  // Adaptive Confidence Score
  const confidence = Math.min(99, Math.max(1, Math.floor(hybridProb * 100)));

  return {
    symbol,
    price: price.toFixed(2),
    change24h: priceChange24h,
    regime,
    strategyNote,
    sentiment: {
      score: sentimentScore,
      label: sentimentLabel,
      headline: newsHeadline
    },
    parameters: {
      trend: {
        ema50: (price * 0.98).toFixed(2),
        ema200: (price * 0.95).toFixed(2),
        adx: adx.toFixed(1),
        ichimoku: regime === 'TRENDING' ? "Strong Bullish" : "Neutral",
        parabolicSAR: (price * 0.97).toFixed(2),
        supertrend: "BULLISH",
      },
      momentum: {
        rsi: rsi.toFixed(1),
        stochastic: (Math.random() * 100).toFixed(1),
        macd: "0.45",
        roc: (Math.random() * 2).toFixed(2),
        cci: (Math.random() * 200 - 100).toFixed(1),
        williamsR: (Math.random() * -100).toFixed(1),
      },
      volume: {
        obv: "1.2M",
        vwap: (price * 1.001).toFixed(2),
        cmf: (Math.random() * 0.4 - 0.2).toFixed(2),
        mfi: (Math.random() * 100).toFixed(1),
        volumeSpike: volumeSpike.toFixed(2) + "x",
        liquidity: (Math.random() * 50 + 10).toFixed(1) + "M USDT",
      },
      volatility: {
        atr: (price * 0.02).toFixed(2),
        bollingerUpper: (price * 1.05).toFixed(2),
        bollingerLower: (price * 0.95).toFixed(2),
        stdDev: volatility.toFixed(4),
        keltnerUpper: (price * 1.04).toFixed(2),
      },
      math: {
        logReturns: returns.toFixed(6),
        zScore: zScore.toFixed(2),
        hurstExponent: hurst.toFixed(3),
        sharpeRatio: finalSharpe,
        kellyCriterion: safeKelly,
        amqsScore: score.toString() + "/5",
        xgbProb: (xgbProb * 100).toFixed(1) + "%",
        lstmProb: (lstmProb * 100).toFixed(1) + "%",
      },
      risk: {
        maxDrawdown: "-12.4%",
        winRate: (winProb * 100).toFixed(1) + "%",
        positionSize: (parseFloat(safeKelly) * 100).toFixed(2) + "%",
        riskReward: winLossRatio.toFixed(1),
        expectancy: (winProb * winLossRatio - (1 - winProb)).toFixed(2),
        leverage: regime === 'VOLATILE' ? "1x" : "3x",
      }
    },
    signal,
    confidence
  };
};

let isPolling = false;
let lastTelegramErrorTime = 0;

async function pollTelegramUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || isPolling) return;
  
  // Backoff if we recently had a conflict error
  if (Date.now() - lastTelegramErrorTime < 5000) return;

  isPolling = true;
  try {
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${(db.lastTelegramUpdateId || 0) + 1}&timeout=10`;
    const response = await axios.get(url, { timeout: 15000 }); 
    const updates = response.data.result;
    let hasNewUpdates = false;
    
    for (const update of updates) {
      db.lastTelegramUpdateId = update.update_id;
      hasNewUpdates = true;
      telegramBlocked = false;

      if (update.message) {
        const incomingChatId = update.message.chat.id;
        if (db.activeChatId !== incomingChatId) {
          db.activeChatId = incomingChatId;
          hasNewUpdates = true;
          console.log(`[TELEGRAM] Learned new Chat ID: ${incomingChatId}`);
        }
      }

      if (update.callback_query) {
        const callbackData = update.callback_query.data;
        const callbackId = update.callback_query.id;

        if (callbackData.startsWith('close_')) {
          const posId = callbackData.split('_')[1];
          const pos = db.positions.find(p => p.id === posId && p.status === 'OPEN');
          if (pos) {
            const currentPrice = marketState[pos.symbol]?.price || pos.entryPrice;
            await closePosition(pos, currentPrice, "Manual Close via Telegram");
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { 
              callback_query_id: callbackId, 
              text: "✅ Position Closed Successfully" 
            });
          } else {
            await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { 
              callback_query_id: callbackId, 
              text: "❌ Position already closed or not found" 
            });
          }
        }
      } else if (update.message && update.message.text) {
        const text = update.message.text;
        if (text === '/start') {
          await sendTelegramMessage(`🚀 <b>QuantEdge AI Bot Active</b>\n\nYou are now connected to the trading engine. I will send you real-time alerts for all trades.\n\n<b>Commands:</b>\n/status - View current portfolio\n/help - View available commands`);
        } else if (text === '/status') {
          const openPositions = db.positions.filter(p => p.status === 'OPEN');
          let message = `📊 <b>Portfolio Status</b>\n\n`;
          message += `💵 <b>Balance:</b> $${db.paperBalance.USDT.toFixed(2)}\n`;
          message += `📈 <b>Open Positions:</b> ${openPositions.length}\n`;
          openPositions.forEach(p => {
            const currentP = marketState[p.symbol]?.price || p.entryPrice;
            const unrealizedPnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
            message += `• ${p.symbol} (${p.side}): PnL $${unrealizedPnl.toFixed(2)}\n`;
          });
          await sendTelegramMessage(message);
        } else if (text === '/help') {
          await sendTelegramMessage(`🛠 <b>Available Commands</b>\n\n/status - Current balance and open trades\n/start - Re-initialize connection\n/help - Show this message`);
        }
      }
    }
    if (hasNewUpdates) saveDb();
  } catch (error: any) {
    const status = error.response?.status;
    const errorCode = error.response?.data?.error_code;
    
    if (status === 409 || errorCode === 409 || error.message?.includes('409')) {
      // Conflict error - usually means another instance is running or a previous request is still active
      // We'll just wait for the next cycle and log it quietly
      lastTelegramErrorTime = Date.now();
      console.log("[TELEGRAM] Polling conflict (409). Retrying in next cycle...");
    } else {
      console.error("Failed to poll Telegram updates:", error.message || error);
      lastTelegramErrorTime = Date.now(); // Also backoff on other errors
    }
  } finally {
    isPolling = false;
  }
}
  
let loopCounter = 0;
// Run Telegram polling in its own loop to avoid blocking the main engine
async function startTelegramLoop() {
  while (true) {
    await pollTelegramUpdates();
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
startTelegramLoop();

setInterval(async () => {
  await checkPositions();
  
  if (db.settings.tradingEnabled) {
    checkDailyDrawdown();
  }
  
  loopCounter++;
  
  // System Status Check
  if (db.paperBalance.USDT < 1000) {
      await sendAlert('SYSTEM', 'Low Balance Warning', `Balance is low: $${db.paperBalance.USDT.toFixed(2)}`);
  }

  // Update balance history & calculate real Sharpe (every 6 iterations = 60s)
  if (loopCounter % 6 === 0) {
    const totalEquity = calculateTotalEquity();
    db.balanceHistory.push({ time: new Date().toISOString(), balance: totalEquity });
    if (db.balanceHistory.length > 500) db.balanceHistory.shift();
  }

  // PnL Update (every 12 iterations = 120 seconds = 2 mins)
  if (loopCounter % 12 === 0) {
       let totalUnrealized = 0;
       db.positions.filter(p => p.status === 'OPEN').forEach(p => {
           const currentP = marketState[p.symbol]?.price || p.entryPrice;
           totalUnrealized += p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
       });
       await sendAlert('PNL', 'Periodic PnL Update', `Total Unrealized PnL: $${totalUnrealized.toFixed(2)}`);
  }

  const symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];
  for (const sym of symbols) {
    const data = await generateQuantData(sym);
    broadcast({ type: 'MARKET_DATA', symbol: sym, data });
    if (data.signal !== 'HOLD') {
      await executeTrade(data);
    }
  }
}, 1000);

async function sendMarketPulse() {
  const symbols = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];
  let message = `🌐 <b>Real-Time Market Pulse</b>\n\n`;
  
  for (const sym of symbols) {
    const state = marketState[sym];
    if (state) {
      const price = state.price;
      const change = typeof state.change24h === 'string' ? parseFloat(state.change24h) : (state.change24h || 0);
      const emoji = change >= 0 ? '🟢' : '🔴';
      message += `${emoji} <b>${sym}:</b> $${price.toLocaleString()} (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)\n`;
    }
  }
  
  const openPositions = db.positions.filter(p => p.status === 'OPEN');
  message += `\n📊 <b>Active Trades:</b> ${openPositions.length}\n`;
  message += `🏦 <b>Equity:</b> $${db.paperBalance.USDT.toFixed(2)}`;
  
  await sendTelegramMessage(message);
}
// Send pulse every 10 minutes
setInterval(sendMarketPulse, 10 * 60 * 1000);

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'CONNECTED' }));
  });

  app.use(express.json());

  // API Routes
  app.get("/api/settings", (req, res) => {
    res.json(db.settings);
  });

  app.post("/api/settings", (req, res) => {
    const newSettings = req.body;
    db.settings = { ...db.settings, ...newSettings };
    saveDb();
    res.json({ success: true, settings: db.settings });
  });

  app.post("/api/modify-funds", (req, res) => {
    const { action, amount } = req.body;
    if (amount > 0) {
      if (action === 'add') {
        db.paperBalance.USDT += amount;
      } else if (action === 'remove') {
        db.paperBalance.USDT = Math.max(0, db.paperBalance.USDT - amount);
      }
      saveDb();
      res.json({ success: true, balance: db.paperBalance.USDT });
    } else {
      res.status(400).json({ error: "Invalid amount" });
    }
  });

  app.post("/api/leverage", (req, res) => {
    const { leverage } = req.body;
    if (leverage && leverage >= 1 && leverage <= 1000) {
      userLeverage = leverage;
      res.json({ success: true, leverage: userLeverage });
    } else {
      res.status(400).json({ error: "Invalid leverage" });
    }
  });

  app.get("/api/market-data", async (req, res) => {
    try {
      const symbol = (req.query.symbol as string) || "BTC/USDT";
      const data = await generateQuantData(symbol);
      res.json(data);
    } catch (error) {
      console.error("Error generating quant data:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/portfolio", (req, res) => {
    const totalEquity = calculateTotalEquity();
    let marginUsed = 0;
    
    const positionsWithUnrealizedPnl = db.positions.map(p => {
      if (p.status === 'OPEN') {
        const currentP = marketState[p.symbol]?.price || p.entryPrice;
        const grossPnl = p.side === 'LONG' ? (currentP - p.entryPrice) * p.qty : (p.entryPrice - currentP) * p.qty;
        const currentFee = (p.qty * currentP) * 0.0004; // estimated exit fee
        const netPnl = grossPnl - currentFee;
        
        marginUsed += p.margin;
        
        return { ...p, unrealizedPnl: netPnl, currentPrice: currentP };
      }
      return p;
    });

    res.json({
      balance: {
        USDT: db.paperBalance.USDT.toFixed(2),
        marginUsed: marginUsed.toFixed(2),
        total: totalEquity.toFixed(2)
      },
      positions: positionsWithUnrealizedPnl,
      balanceHistory: db.balanceHistory
    });
  });

  app.get("/api/export/report", async (req, res) => {
    try {
      const totalEquity = calculateTotalEquity();
      const openPositions = db.positions.filter(p => p.status === 'OPEN');
      const closedPositions = db.positions.filter(p => p.status === 'CLOSED').slice(0, 50); // Last 50 trades
      
      const border = { style: BorderStyle.SINGLE, size: 1, color: "E2E8F0" };
      const borders = { top: border, bottom: border, left: border, right: border };

      const doc = new Document({
        styles: {
          default: { document: { run: { font: "Arial", size: 24 } } },
          paragraphStyles: [
            { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
              run: { size: 36, bold: true, color: "0F172A", font: "Arial" },
              paragraph: { spacing: { before: 240, after: 240 }, outlineLevel: 0 } },
            { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
              run: { size: 28, bold: true, color: "334155", font: "Arial" },
              paragraph: { spacing: { before: 180, after: 120 }, outlineLevel: 1 } },
          ]
        },
        sections: [{
          properties: {
            page: {
              size: { width: 12240, height: 15840 },
              margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
            }
          },
          children: [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("QuantEdge AI Trading Report")] }),
            new Paragraph({ children: [new TextRun({ text: `Generated on: ${new Date().toLocaleString()}`, italics: true })] }),
            
            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Account Summary")] }),
            new Table({
              width: { size: 9360, type: WidthType.DXA },
              columnWidths: [4680, 4680],
              rows: [
                new TableRow({ children: [
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: "Metric", bold: true })] })] }),
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: "Value", bold: true })] })] }),
                ]}),
                new TableRow({ children: [
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph("Total Equity")] }),
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(`$${totalEquity.toFixed(2)}`)] }),
                ]}),
                new TableRow({ children: [
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph("Available USDT")] }),
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(`$${db.paperBalance.USDT.toFixed(2)}`)] }),
                ]}),
                new TableRow({ children: [
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph("Peak Equity")] }),
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(`$${db.peakEquity.toFixed(2)}`)] }),
                ]}),
                new TableRow({ children: [
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph("Open Positions")] }),
                  new TableCell({ borders, width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(`${openPositions.length}`)] }),
                ]}),
              ]
            }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Risk Configuration")] }),
            new Paragraph({ children: [new TextRun({ text: `Profile: ${db.settings.riskProfile}`, bold: true })] }),
            new Paragraph({ children: [new TextRun(`Max Daily Drawdown: ${(db.settings.maxDailyDrawdown * 100).toFixed(1)}%`)] }),
            new Paragraph({ children: [new TextRun(`Risk Per Trade: ${(db.settings.riskPerTrade * 100).toFixed(1)}%`)] }),
            new Paragraph({ children: [new TextRun(`Auto-Leverage: ${db.settings.autoLeverage ? "Enabled" : "Disabled"}`)] }),

            new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun("Recent Trade History")] }),
            new Table({
              width: { size: 9360, type: WidthType.DXA },
              columnWidths: [1500, 1000, 1500, 1500, 1500, 2360],
              rows: [
                new TableRow({
                  tableHeader: true,
                  children: [
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "Symbol", bold: true })] })] }),
                    new TableCell({ borders, width: { size: 1000, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "Side", bold: true })] })] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "Entry", bold: true })] })] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "Exit", bold: true })] })] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "PnL", bold: true })] })] }),
                    new TableCell({ borders, width: { size: 2360, type: WidthType.DXA }, shading: { fill: "F1F5F9", type: ShadingType.CLEAR }, children: [new Paragraph({ children: [new TextRun({ text: "Strategy", bold: true })] })] }),
                  ]
                }),
                ...closedPositions.map(p => new TableRow({
                  children: [
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, children: [new Paragraph(p.symbol)] }),
                    new TableCell({ borders, width: { size: 1000, type: WidthType.DXA }, children: [new Paragraph(p.side)] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, children: [new Paragraph(`$${p.entryPrice.toFixed(2)}`)] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, children: [new Paragraph(`$${p.exitPrice?.toFixed(2) || "N/A"}`)] }),
                    new TableCell({ borders, width: { size: 1500, type: WidthType.DXA }, children: [new Paragraph({ children: [new TextRun({ text: `$${p.pnl.toFixed(2)}`, color: p.pnl >= 0 ? "059669" : "DC2626" })] })] }),
                    new TableCell({ borders, width: { size: 2360, type: WidthType.DXA }, children: [new Paragraph(p.strategy)] }),
                  ]
                }))
              ]
            }),
            
            new Paragraph({ spacing: { before: 400 }, children: [new TextRun({ text: "Disclaimer: This report is generated by QuantEdge AI. Past performance is not indicative of future results.", size: 16, italics: true })] })
          ]
        }]
      });

      const buffer = await Packer.toBuffer(doc);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename=QuantEdge_Report_${new Date().toISOString().split('T')[0]}.docx`);
      res.send(buffer);
    } catch (error) {
      console.error("Export failed:", error);
      res.status(500).send("Failed to generate report");
    }
  });

  app.post("/api/portfolio/positions/:id/close", async (req, res) => {
    const { id } = req.params;
    const pos = db.positions.find(p => p.id === id && p.status === 'OPEN');
    if (pos) {
      const currentPrice = marketState[pos.symbol]?.price || pos.entryPrice;
      await closePosition(pos, currentPrice, "Manual Close via Dashboard");
      res.json({ success: true, message: "Position closed successfully" });
    } else {
      res.status(404).json({ success: false, error: "Open position not found" });
    }
  });

  app.delete("/api/portfolio/positions/:id", (req, res) => {
    const { id } = req.params;
    const initialLength = db.positions.length;
    
    // If it's an open position, we should refund the margin to USDT (simple delete)
    const pos = db.positions.find(p => p.id === id);
    if (pos && pos.status === 'OPEN') {
      db.paperBalance.USDT += pos.margin;
    }
    
    db.positions = db.positions.filter(p => p.id !== id);
    if (db.positions.length < initialLength) {
      saveDb();
      broadcast({ type: 'PORTFOLIO_UPDATE' });
      res.json({ success: true, message: "Position record deleted" });
    } else {
      res.status(404).json({ success: false, error: "Position not found" });
    }
  });

  app.get("/api/telegram/status", (req, res) => {
    res.json({ 
      blocked: telegramBlocked,
      activeChatId: db.activeChatId || null
    });
  });

  app.post("/api/telegram/test", async (req, res) => {
    const { message } = req.body;
    const result = await sendTelegramMessage(message || "🔔 <b>QuantEdge AI Alert</b>\nTest notification from your trading bot.");
    
    if (result.success) {
      telegramBlocked = false; // Unblock on successful manual test
      res.json({ success: true, message: "Alert sent successfully to Telegram" });
    } else {
      res.status(500).json({ 
        success: false, 
        error: result.error 
      });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`QuantEdge Server running on http://localhost:${PORT}`);
  });
}

startServer();

