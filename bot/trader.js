// Binance USDT-M Futures Trader — executes trades based on bot signals
// Supports testnet and live. Both LONG and SHORT.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TESTNET_BASE = "https://testnet.binancefuture.com";
const LIVE_BASE = "https://fapi.binance.com";

const TRADES_FILE = path.join(__dirname, "trades.json");
const DEFAULT_LEVERAGE = 5;

class BinanceTrader {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.BINANCE_API_KEY;
    this.apiSecret = opts.apiSecret || process.env.BINANCE_API_SECRET;
    this.testnet = opts.testnet !== false;
    this.base = this.testnet ? TESTNET_BASE : LIVE_BASE;
    this.leverage = opts.leverage || +(process.env.LEVERAGE || DEFAULT_LEVERAGE);
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

  async getBalance() {
    const info = await this.api("GET", "/fapi/v2/balance");
    const usdt = info.find(b => b.asset === "USDT");
    return usdt ? { available: +usdt.availableBalance, total: +usdt.balance } : { available: 0, total: 0 };
  }

  async getPrice(symbol) {
    const data = await this.api("GET", "/fapi/v1/ticker/price", { symbol });
    return +data.price;
  }

  async setLeverage(symbol, leverage) {
    try {
      await this.api("POST", "/fapi/v1/leverage", { symbol, leverage });
    } catch (e) {
      console.log(`[TRADE] Leverage warning for ${symbol}: ${e.message}`);
    }
  }

  async getExchangeInfo(symbol) {
    const url = `${this.base}/fapi/v1/exchangeInfo`;
    const res = await fetch(url);
    const data = await res.json();
    const sym = data.symbols ? data.symbols.find(s => s.symbol === symbol) : null;
    return sym;
  }

  parseFilters(info) {
    const lot = info.filters.find(f => f.filterType === "LOT_SIZE");
    const price = info.filters.find(f => f.filterType === "PRICE_FILTER");
    const minNotional = info.filters.find(f => f.filterType === "MIN_NOTIONAL");
    return {
      stepSize: lot ? +lot.stepSize : 0.001,
      minQty: lot ? +lot.minQty : 0.001,
      tickSize: price ? +price.tickSize : 0.01,
      minNotional: minNotional ? +minNotional.notional : 5,
      pricePrecision: info.pricePrecision || 2,
      quantityPrecision: info.quantityPrecision || 3,
    };
  }

  formatQty(value, precision) {
    return (+value.toFixed(precision)).toString();
  }

  formatPrice(value, precision) {
    return (+value.toFixed(precision)).toString();
  }

  async placeOrder(symbol, side, type, qty, filters, extra = {}) {
    const params = {
      symbol,
      side,
      type,
      quantity: this.formatQty(qty, filters.quantityPrecision),
      ...extra,
    };
    return this.api("POST", "/fapi/v1/order", params);
  }

  async cancelAllOrders(symbol) {
    try {
      return await this.api("DELETE", "/fapi/v1/allOpenOrders", { symbol });
    } catch (e) {
      if (e.message.includes("-2011")) return {};
      throw e;
    }
  }

  async getOpenOrders(symbol) {
    return this.api("GET", "/fapi/v1/openOrders", symbol ? { symbol } : {});
  }

  async getPositions() {
    const data = await this.api("GET", "/fapi/v2/positionRisk");
    return data.filter(p => +p.positionAmt !== 0);
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

    const symbol = signal.base + "USDT";
    const side = signal.action === "BUY" ? "BUY" : "SELL";
    const closeSide = side === "BUY" ? "SELL" : "BUY";
    const positionSide = signal.action === "BUY" ? "long" : "short";

    try {
      const [balance, info] = await Promise.all([
        this.getBalance(),
        this.getExchangeInfo(symbol),
      ]);

      if (!info) return { executed: false, reason: `Symbol ${symbol} not found on futures` };
      const filters = this.parseFilters(info);

      await this.setLeverage(symbol, this.leverage);

      const price = signal.entry || await this.getPrice(symbol);
      const stopDist = Math.abs(price - signal.stop);
      if (stopDist <= 0) return { executed: false, reason: "Invalid stop distance" };

      // Position size: risk % of balance, amplified by leverage
      const riskAmount = balance.available * this.riskPct;
      const qty = riskAmount / stopDist;
      const notionalValue = qty * price;
      const marginRequired = notionalValue / this.leverage;

      if (marginRequired > balance.available) {
        return { executed: false, reason: `Insufficient margin: need $${marginRequired.toFixed(2)}, have $${balance.available.toFixed(2)}` };
      }

      if (notionalValue < filters.minNotional) {
        return { executed: false, reason: `Order too small: $${notionalValue.toFixed(2)} < min $${filters.minNotional}` };
      }

      // 1. Market entry
      console.log(`[TRADE] ${side} ${symbol}: qty=${qty.toFixed(filters.quantityPrecision)}, notional=$${notionalValue.toFixed(2)}, leverage=${this.leverage}x, stop=${signal.stop}`);
      const entryOrder = await this.placeOrder(symbol, side, "MARKET", qty, filters);

      const filledQty = +entryOrder.executedQty;
      const avgPrice = +entryOrder.avgPrice || price;

      // 2. Stop-loss (STOP_MARKET)
      const stopOrder = await this.placeOrder(symbol, closeSide, "STOP_MARKET", filledQty, filters, {
        stopPrice: this.formatPrice(signal.stop, filters.pricePrecision),
        closePosition: "false",
        workingType: "MARK_PRICE",
      });

      // 3. TP1 limit order (60% of position)
      let tp1Order = null;
      if (signal.tp1) {
        const tp1Qty = filledQty * 0.6;
        if (tp1Qty >= filters.minQty) {
          tp1Order = await this.placeOrder(symbol, closeSide, "TAKE_PROFIT_MARKET", tp1Qty, filters, {
            stopPrice: this.formatPrice(signal.tp1, filters.pricePrecision),
            workingType: "MARK_PRICE",
          });
        }
      }

      const position = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        base: signal.base,
        symbol,
        side: positionSide,
        action: signal.action,
        leverage: this.leverage,
        entryPrice: avgPrice,
        entryQty: filledQty,
        remainingQty: filledQty,
        notionalValue,
        marginUsed: marginRequired,
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
        summary: `${side} ${filledQty.toFixed(filters.quantityPrecision)} ${signal.base} @ $${avgPrice.toFixed(2)} | ${this.leverage}x | Stop: $${signal.stop.toFixed(2)} | Risk: $${riskAmount.toFixed(2)}`,
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
        const closeSide = pos.side === "long" ? "SELL" : "BUY";

        // Check if stop was hit (order filled)
        if (pos.stopOrderId) {
          try {
            const stopStatus = await this.api("GET", "/fapi/v1/order", {
              symbol: pos.symbol,
              orderId: pos.stopOrderId,
            });
            if (stopStatus.status === "FILLED") {
              await this.cancelAllOrders(pos.symbol);
              const exitPrice = +stopStatus.avgPrice || price;
              const pnl = pos.side === "long"
                ? (exitPrice - pos.entryPrice) * pos.remainingQty
                : (pos.entryPrice - exitPrice) * pos.remainingQty;
              pos.realizedPnl += pnl;
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
            const tp1Status = await this.api("GET", "/fapi/v1/order", {
              symbol: pos.symbol,
              orderId: pos.tp1OrderId,
            });
            if (tp1Status.status === "FILLED") {
              pos.tp1Hit = true;
              const tp1Price = +tp1Status.avgPrice || pos.tp1;
              const tp1Qty = +tp1Status.executedQty;
              const pnl = pos.side === "long"
                ? (tp1Price - pos.entryPrice) * tp1Qty
                : (pos.entryPrice - tp1Price) * tp1Qty;
              pos.realizedPnl += pnl;
              pos.remainingQty -= tp1Qty;
              pos.fills.push({ type: "tp1", price: tp1Price, qty: tp1Qty, time: new Date().toISOString() });

              // Cancel old stop, place new stop at breakeven
              await this.cancelAllOrders(pos.symbol);
              const newStop = await this.placeOrder(pos.symbol, closeSide, "STOP_MARKET", pos.remainingQty, filters, {
                stopPrice: this.formatPrice(pos.entryPrice, filters.pricePrecision),
                closePosition: "false",
                workingType: "MARK_PRICE",
              });
              pos.stopOrderId = newStop.orderId;
              pos.stop = pos.entryPrice;

              // Place TP2 (30% of original)
              if (pos.tp2) {
                const tp2Qty = pos.entryQty * 0.3;
                if (tp2Qty >= filters.minQty) {
                  const tp2Order = await this.placeOrder(pos.symbol, closeSide, "TAKE_PROFIT_MARKET", tp2Qty, filters, {
                    stopPrice: this.formatPrice(pos.tp2, filters.pricePrecision),
                    workingType: "MARK_PRICE",
                  });
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
            const tp2Status = await this.api("GET", "/fapi/v1/order", {
              symbol: pos.symbol,
              orderId: pos.tp2OrderId,
            });
            if (tp2Status.status === "FILLED") {
              pos.tp2Hit = true;
              const tp2Price = +tp2Status.avgPrice || pos.tp2;
              const tp2Qty = +tp2Status.executedQty;
              const pnl = pos.side === "long"
                ? (tp2Price - pos.entryPrice) * tp2Qty
                : (pos.entryPrice - tp2Price) * tp2Qty;
              pos.realizedPnl += pnl;
              pos.remainingQty -= tp2Qty;
              pos.fills.push({ type: "tp2", price: tp2Price, qty: tp2Qty, time: new Date().toISOString() });

              // Update stop, place TP3 for remaining 10%
              await this.cancelAllOrders(pos.symbol);
              if (pos.remainingQty >= filters.minQty) {
                const newStop = await this.placeOrder(pos.symbol, closeSide, "STOP_MARKET", pos.remainingQty, filters, {
                  stopPrice: this.formatPrice(pos.entryPrice, filters.pricePrecision),
                  closePosition: "false",
                  workingType: "MARK_PRICE",
                });
                pos.stopOrderId = newStop.orderId;

                if (pos.tp3) {
                  const tp3Order = await this.placeOrder(pos.symbol, closeSide, "TAKE_PROFIT_MARKET", pos.remainingQty, filters, {
                    stopPrice: this.formatPrice(pos.tp3, filters.pricePrecision),
                    workingType: "MARK_PRICE",
                  });
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
            const tp3Status = await this.api("GET", "/fapi/v1/order", {
              symbol: pos.symbol,
              orderId: pos.tp3OrderId,
            });
            if (tp3Status.status === "FILLED") {
              pos.tp3Hit = true;
              const tp3Price = +tp3Status.avgPrice || pos.tp3;
              const tp3Qty = +tp3Status.executedQty;
              const pnl = pos.side === "long"
                ? (tp3Price - pos.entryPrice) * tp3Qty
                : (pos.entryPrice - tp3Price) * tp3Qty;
              pos.realizedPnl += pnl;
              pos.remainingQty = 0;
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
    const closeSide = pos.side === "long" ? "SELL" : "BUY";

    if (pos.remainingQty >= filters.minQty) {
      const closeOrder = await this.placeOrder(pos.symbol, closeSide, "MARKET", pos.remainingQty, filters);
      const exitPrice = +closeOrder.avgPrice || price;
      const pnl = pos.side === "long"
        ? (exitPrice - pos.entryPrice) * +closeOrder.executedQty
        : (pos.entryPrice - exitPrice) * +closeOrder.executedQty;
      pos.realizedPnl += pnl;
      pos.fills.push({ type: reason, price: exitPrice, qty: +closeOrder.executedQty, time: new Date().toISOString() });
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
