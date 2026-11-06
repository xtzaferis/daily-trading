// Binance Spot Trader — executes trades based on bot signals
// Supports testnet and live. Spot only (no margin/futures).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TESTNET_BASE = "https://testnet.binance.vision";
const LIVE_BASE = "https://api.binance.com";

const TRADES_FILE = path.join(__dirname, "trades.json");

class BinanceTrader {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.BINANCE_API_KEY;
    this.apiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET;
    this.testnet = opts.testnet !== false;
    this.base = this.testnet ? TESTNET_BASE : LIVE_BASE;
    this.riskPct = opts.riskPct || 0.01;
    this.maxPositions = opts.maxPositions || 5;
    this.enabled = !!(this.apiKey && this.apiSecret);
  }

  sign(params) {
    const qs = new URLSearchParams(params).toString();
    const sig = crypto.createHmac("sha256", this.apiSecret).update(qs).digest("hex");
    return qs + "&signature=" + sig;
  }

  async api(method, endpoint, params = {}) {
    params.timestamp = Date.now();
    params.recvWindow = 10000;
    const signed = this.sign(params);
    const url = method === "GET"
      ? `${this.base}${endpoint}?${signed}`
      : `${this.base}${endpoint}`;
    const opts = {
      method,
      headers: { "X-MBX-APIKEY": this.apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    };
    if (method !== "GET") opts.body = signed;
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw new Error(`Binance ${res.status}: ${text}`);
    return JSON.parse(text);
  }

  async getBalance(asset = "USDT") {
    const info = await this.api("GET", "/api/v3/account");
    const bal = info.balances.find(b => b.asset === asset);
    return bal ? { free: +bal.free, locked: +bal.locked } : { free: 0, locked: 0 };
  }

  async getPrice(symbol) {
    const data = await this.api("GET", "/api/v3/ticker/price", { symbol });
    return +data.price;
  }

  async getExchangeInfo(symbol) {
    const url = `${this.base}/api/v3/exchangeInfo?symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.symbols ? data.symbols[0] : null;
  }

  parseFilters(info) {
    const lot = info.filters.find(f => f.filterType === "LOT_SIZE");
    const price = info.filters.find(f => f.filterType === "PRICE_FILTER");
    const notional = info.filters.find(f => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
    return {
      stepSize: lot ? +lot.stepSize : 0.00001,
      minQty: lot ? +lot.minQty : 0,
      tickSize: price ? +price.tickSize : 0.01,
      minNotional: notional ? +(notional.minNotional || notional.minNotional) : 10,
    };
  }

  roundStep(value, step) {
    if (step <= 0) return value;
    const precision = Math.max(0, Math.round(-Math.log10(step)));
    return Math.floor(value / step) * step;
  }

  roundTick(value, tick) {
    if (tick <= 0) return value;
    return Math.round(value / tick) * tick;
  }

  formatQty(value, step) {
    const precision = Math.max(0, Math.round(-Math.log10(step)));
    return this.roundStep(value, step).toFixed(precision);
  }

  formatPrice(value, tick) {
    const precision = Math.max(0, Math.round(-Math.log10(tick)));
    return this.roundTick(value, tick).toFixed(precision);
  }

  async placeBuy(symbol, quoteQty, filters) {
    const params = {
      symbol,
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: quoteQty.toFixed(2),
    };
    return this.api("POST", "/api/v3/order", params);
  }

  async placeSell(symbol, qty, filters) {
    const params = {
      symbol,
      side: "SELL",
      type: "MARKET",
      quantity: this.formatQty(qty, filters.stepSize),
    };
    return this.api("POST", "/api/v3/order", params);
  }

  async placeOCO(symbol, side, qty, price, stopPrice, limitPrice, filters) {
    const params = {
      symbol,
      side,
      quantity: this.formatQty(qty, filters.stepSize),
      price: this.formatPrice(price, filters.tickSize),
      stopPrice: this.formatPrice(stopPrice, filters.tickSize),
      stopLimitPrice: this.formatPrice(limitPrice, filters.tickSize),
      stopLimitTimeInForce: "GTC",
    };
    return this.api("POST", "/api/v3/order/oco", params);
  }

  async placeLimitOrder(symbol, side, qty, price, filters) {
    const params = {
      symbol,
      side,
      type: "LIMIT",
      timeInForce: "GTC",
      quantity: this.formatQty(qty, filters.stepSize),
      price: this.formatPrice(price, filters.tickSize),
    };
    return this.api("POST", "/api/v3/order", params);
  }

  async placeStopLoss(symbol, side, qty, stopPrice, filters) {
    const params = {
      symbol,
      side,
      type: "STOP_LOSS_LIMIT",
      timeInForce: "GTC",
      quantity: this.formatQty(qty, filters.stepSize),
      stopPrice: this.formatPrice(stopPrice, filters.tickSize),
      price: this.formatPrice(stopPrice * (side === "SELL" ? 0.995 : 1.005), filters.tickSize),
    };
    return this.api("POST", "/api/v3/order", params);
  }

  async cancelAllOrders(symbol) {
    try {
      return await this.api("DELETE", "/api/v3/openOrders", { symbol });
    } catch (e) {
      if (e.message.includes("-2011")) return [];
      throw e;
    }
  }

  async getOpenOrders(symbol) {
    return this.api("GET", "/api/v3/openOrders", symbol ? { symbol } : {});
  }

  // --- Trade management ---

  loadTrades() {
    try { return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8")); }
    catch { return { positions: [] }; }
  }

  saveTrades(trades) {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  }

  async executeSignal(signal) {
    if (!this.enabled) return { executed: false, reason: "Trading not configured (missing API keys)" };

    const trades = this.loadTrades();
    const openPositions = trades.positions.filter(p => p.status === "open");

    if (openPositions.length >= this.maxPositions) {
      return { executed: false, reason: `Max positions reached (${this.maxPositions})` };
    }

    const existing = openPositions.find(p => p.base === signal.base);
    if (existing) {
      return { executed: false, reason: `Already have open position on ${signal.base}` };
    }

    // Spot trading: we can only BUY (go long). SELL signals are skipped.
    if (signal.action === "SELL") {
      return { executed: false, reason: "Spot trading: SELL/short signals skipped (long only)" };
    }

    const symbol = signal.base + "USDT";

    try {
      const [balance, info] = await Promise.all([
        this.getBalance("USDT"),
        this.getExchangeInfo(symbol),
      ]);

      if (!info) return { executed: false, reason: `Symbol ${symbol} not found` };
      const filters = this.parseFilters(info);

      const price = signal.entry || await this.getPrice(symbol);
      const stopDist = Math.abs(price - signal.stop);
      if (stopDist <= 0) return { executed: false, reason: "Invalid stop distance" };

      // Position size: risk % of available balance
      const riskAmount = balance.free * this.riskPct;
      const qty = riskAmount / stopDist;
      const quoteQty = qty * price;

      if (quoteQty < filters.minNotional) {
        return { executed: false, reason: `Order too small: $${quoteQty.toFixed(2)} < min $${filters.minNotional}` };
      }

      if (quoteQty > balance.free) {
        return { executed: false, reason: `Insufficient balance: need $${quoteQty.toFixed(2)}, have $${balance.free.toFixed(2)}` };
      }

      // 1. Market buy
      console.log(`[TRADE] BUY ${symbol}: qty=${qty.toFixed(6)}, quote=$${quoteQty.toFixed(2)}, stop=${signal.stop}`);
      const buyOrder = await this.placeBuy(symbol, quoteQty, filters);

      const filledQty = +buyOrder.executedQty;
      const avgPrice = +buyOrder.cummulativeQuoteQty / filledQty;

      // 2. Place stop-loss
      const stopOrder = await this.placeStopLoss(symbol, "SELL", filledQty, signal.stop, filters);

      // 3. Place TP1 limit order (60% of position)
      let tp1Order = null;
      if (signal.tp1) {
        const tp1Qty = filledQty * 0.6;
        if (tp1Qty * signal.tp1 >= filters.minNotional) {
          tp1Order = await this.placeLimitOrder(symbol, "SELL", tp1Qty, signal.tp1, filters);
        }
      }

      const position = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        base: signal.base,
        symbol,
        side: "long",
        action: signal.action,
        entryPrice: avgPrice,
        entryQty: filledQty,
        remainingQty: filledQty,
        quoteSpent: +buyOrder.cummulativeQuoteQty,
        stop: signal.stop,
        tp1: signal.tp1 || null,
        tp2: signal.tp2 || null,
        tp3: signal.tp3 || null,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        stopOrderId: stopOrder.orderId,
        tp1OrderId: tp1Order ? tp1Order.orderId : null,
        status: "open",
        signalKey: signal.key || `${signal.base}-${signal.tf}-${signal.action}`,
        tf: signal.tf,
        openedAt: new Date().toISOString(),
        closedAt: null,
        realizedPnl: 0,
        fills: [{ type: "entry", price: avgPrice, qty: filledQty, time: new Date().toISOString() }],
      };

      trades.positions.push(position);
      this.saveTrades(trades);

      return {
        executed: true,
        position,
        summary: `BUY ${filledQty.toFixed(6)} ${signal.base} @ $${avgPrice.toFixed(2)} | Stop: $${signal.stop.toFixed(2)} | Risk: $${riskAmount.toFixed(2)}`,
      };

    } catch (e) {
      return { executed: false, reason: `Order failed: ${e.message}` };
    }
  }

  async managePositions() {
    const trades = this.loadTrades();
    const open = trades.positions.filter(p => p.status === "open");
    const notifications = [];

    for (const pos of open) {
      try {
        const price = await this.getPrice(pos.symbol);
        const info = await this.getExchangeInfo(pos.symbol);
        if (!info) continue;
        const filters = this.parseFilters(info);

        // Check if stop was hit (order filled)
        if (pos.stopOrderId) {
          try {
            const stopStatus = await this.api("GET", "/api/v3/order", {
              symbol: pos.symbol,
              orderId: pos.stopOrderId,
            });
            if (stopStatus.status === "FILLED") {
              await this.cancelAllOrders(pos.symbol);
              const exitPrice = +stopStatus.price || price;
              const pnl = (exitPrice - pos.entryPrice) / pos.entryPrice * 100;
              pos.realizedPnl += (exitPrice - pos.entryPrice) * +stopStatus.executedQty;
              pos.remainingQty = 0;
              pos.status = "closed";
              pos.closedAt = new Date().toISOString();
              pos.fills.push({ type: "stop", price: exitPrice, qty: +stopStatus.executedQty, time: new Date().toISOString() });
              notifications.push({ type: "stop_hit", pos, pnl });
              this.saveTrades(trades);
              continue;
            }
          } catch {}
        }

        // Check TP1
        if (!pos.tp1Hit && pos.tp1OrderId) {
          try {
            const tp1Status = await this.api("GET", "/api/v3/order", {
              symbol: pos.symbol,
              orderId: pos.tp1OrderId,
            });
            if (tp1Status.status === "FILLED") {
              pos.tp1Hit = true;
              const tp1Price = +tp1Status.price || pos.tp1;
              const tp1Qty = +tp1Status.executedQty;
              pos.realizedPnl += (tp1Price - pos.entryPrice) * tp1Qty;
              pos.remainingQty -= tp1Qty;
              pos.fills.push({ type: "tp1", price: tp1Price, qty: tp1Qty, time: new Date().toISOString() });

              // Move stop to breakeven
              await this.cancelAllOrders(pos.symbol);
              const newStop = await this.placeStopLoss(pos.symbol, "SELL", pos.remainingQty, pos.entryPrice, filters);
              pos.stopOrderId = newStop.orderId;
              pos.stop = pos.entryPrice;

              // Place TP2 order (30% of original = ~75% of remaining)
              if (pos.tp2) {
                const tp2Qty = pos.entryQty * 0.3;
                if (tp2Qty * pos.tp2 >= filters.minNotional) {
                  const tp2Order = await this.placeLimitOrder(pos.symbol, "SELL", tp2Qty, pos.tp2, filters);
                  pos.tp2OrderId = tp2Order.orderId;
                }
              }

              notifications.push({ type: "tp1_hit", pos, price: tp1Price });
              this.saveTrades(trades);
            }
          } catch {}
        }

        // Check TP2
        if (pos.tp1Hit && !pos.tp2Hit && pos.tp2OrderId) {
          try {
            const tp2Status = await this.api("GET", "/api/v3/order", {
              symbol: pos.symbol,
              orderId: pos.tp2OrderId,
            });
            if (tp2Status.status === "FILLED") {
              pos.tp2Hit = true;
              const tp2Price = +tp2Status.price || pos.tp2;
              const tp2Qty = +tp2Status.executedQty;
              pos.realizedPnl += (tp2Price - pos.entryPrice) * tp2Qty;
              pos.remainingQty -= tp2Qty;
              pos.fills.push({ type: "tp2", price: tp2Price, qty: tp2Qty, time: new Date().toISOString() });

              // Update stop, place TP3
              await this.cancelAllOrders(pos.symbol);
              if (pos.remainingQty > 0) {
                const newStop = await this.placeStopLoss(pos.symbol, "SELL", pos.remainingQty, pos.entryPrice, filters);
                pos.stopOrderId = newStop.orderId;

                if (pos.tp3) {
                  const tp3Order = await this.placeLimitOrder(pos.symbol, "SELL", pos.remainingQty, pos.tp3, filters);
                  pos.tp3OrderId = tp3Order.orderId;
                }
              }

              notifications.push({ type: "tp2_hit", pos, price: tp2Price });
              this.saveTrades(trades);
            }
          } catch {}
        }

        // Check TP3
        if (pos.tp2Hit && !pos.tp3Hit && pos.tp3OrderId) {
          try {
            const tp3Status = await this.api("GET", "/api/v3/order", {
              symbol: pos.symbol,
              orderId: pos.tp3OrderId,
            });
            if (tp3Status.status === "FILLED") {
              pos.tp3Hit = true;
              const tp3Price = +tp3Status.price || pos.tp3;
              const tp3Qty = +tp3Status.executedQty;
              pos.realizedPnl += (tp3Price - pos.entryPrice) * tp3Qty;
              pos.remainingQty -= tp3Qty;
              pos.fills.push({ type: "tp3", price: tp3Price, qty: tp3Qty, time: new Date().toISOString() });

              await this.cancelAllOrders(pos.symbol);
              pos.status = "closed";
              pos.closedAt = new Date().toISOString();
              notifications.push({ type: "tp3_hit", pos, price: tp3Price });
              this.saveTrades(trades);
            }
          } catch {}
        }

      } catch (e) {
        console.error(`[TRADE] Error managing ${pos.symbol}:`, e.message);
      }
    }

    return notifications;
  }

  async closePosition(base, reason = "manual") {
    const trades = this.loadTrades();
    const pos = trades.positions.find(p => p.base === base && p.status === "open");
    if (!pos) return null;

    await this.cancelAllOrders(pos.symbol);
    const price = await this.getPrice(pos.symbol);
    const info = await this.getExchangeInfo(pos.symbol);
    const filters = this.parseFilters(info);

    if (pos.remainingQty > 0) {
      const sellOrder = await this.placeSell(pos.symbol, pos.remainingQty, filters);
      const exitPrice = +sellOrder.cummulativeQuoteQty / +sellOrder.executedQty;
      pos.realizedPnl += (exitPrice - pos.entryPrice) * +sellOrder.executedQty;
      pos.fills.push({ type: reason, price: exitPrice, qty: +sellOrder.executedQty, time: new Date().toISOString() });
    }

    pos.status = "closed";
    pos.closedAt = new Date().toISOString();
    pos.remainingQty = 0;
    this.saveTrades(trades);
    return pos;
  }

  getStats() {
    const trades = this.loadTrades();
    const closed = trades.positions.filter(p => p.status === "closed");
    const open = trades.positions.filter(p => p.status === "open");
    const wins = closed.filter(p => p.realizedPnl > 0);
    const totalPnl = closed.reduce((s, p) => s + p.realizedPnl, 0);
    return {
      open: open.length,
      closed: closed.length,
      wins: wins.length,
      winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) : "0",
      totalPnl: totalPnl.toFixed(2),
    };
  }
}

module.exports = BinanceTrader;
