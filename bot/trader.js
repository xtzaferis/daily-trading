// OKX EEA Trader — spot longs + X-Perp shorts
// Spot USDC pairs for BUY, X-Perp futures for SELL (short).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.OKX_BASE_URL || "https://eea.okx.com";
const TRADES_FILE = path.join(__dirname, "trades.json");

const SYMBOL_MAP = { RNDR: "RENDER", MKR: "SKY" };
const OKX_BLACKLIST = new Set([
  "XAUT", "POPCAT", "BRETT", "ACT", "SPX", "FARTCOIN", "AI16Z",
  "MOG", "CHILLGUY", "1000SATS", "MUBARAK", "BANANAS31", "TST", "CHEEMS",
]);

class OKXTrader {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.OKX_API_KEY;
    this.apiSecret = opts.apiSecret || process.env.OKX_API_SECRET;
    this.passphrase = opts.passphrase || process.env.OKX_PASSPHRASE;
    this.demo = opts.demo !== false;
    this.riskPct = opts.riskPct || 0.01;
    this.maxPositions = opts.maxPositions || 5;
    this.maxDailyLoss = opts.maxDailyLoss || +(process.env.MAX_DAILY_LOSS || 5);
    this.leverage = opts.leverage || +(process.env.LEVERAGE || 5);
    this.enabled = !!(this.apiKey && this.apiSecret && this.passphrase);
    this._xperpCache = null;
  }

  sign(timestamp, method, path, body = "") {
    const msg = timestamp + method + path + body;
    return crypto.createHmac("sha256", this.apiSecret).update(msg).digest("base64");
  }

  async api(method, endpoint, body = null) {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const signature = this.sign(timestamp, method, endpoint, bodyStr);

    const headers = {
      "OK-ACCESS-KEY": this.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase,
      "Content-Type": "application/json",
    };
    if (this.demo) headers["x-simulated-trading"] = "1";

    const opts = { method, headers };
    if (body) opts.body = bodyStr;

    const res = await fetch(BASE_URL + endpoint, opts);
    const data = await res.json();

    if (data.code !== "0") {
      throw new Error(`OKX ${data.code}: ${data.msg || data.data?.[0]?.sMsg || JSON.stringify(data.data)}`);
    }
    return data.data;
  }

  async getBalance() {
    const data = await this.api("GET", "/api/v5/account/balance");
    const usdc = data[0]?.details?.find(d => d.ccy === "USDC");
    const usd = data[0]?.details?.find(d => d.ccy === "USD");
    const best = usdc && +usdc.availBal > 0 ? usdc : usd;
    return {
      available: best ? +best.availBal : 0,
      total: best ? +best.eq : 0,
      ccy: best?.ccy || "USDC",
    };
  }

  async getPrice(instId) {
    const res = await fetch(`${BASE_URL}/api/v5/market/ticker?instId=${instId}`);
    const data = await res.json();
    return data.data?.[0] ? +data.data[0].last : 0;
  }

  async getSpotInstrument(instId) {
    const res = await fetch(`${BASE_URL}/api/v5/public/instruments?instType=SPOT&instId=${instId}`);
    const data = await res.json();
    return data.data?.[0] || null;
  }

  async getXPerpInstrument(base) {
    if (!this._xperpCache) {
      const res = await fetch(`${BASE_URL}/api/v5/public/instruments?instType=FUTURES`);
      const data = await res.json();
      this._xperpCache = (data.data || []).filter(i => i.instId.includes("XPERP"));
    }
    const matches = this._xperpCache
      .filter(i => i.instId.startsWith(base + "-USD_UM_XPERP-"))
      .sort((a, b) => b.instId.localeCompare(a.instId));
    return matches[0] || null;
  }

  async setLeverage(instId, lever) {
    try {
      await this.api("POST", "/api/v5/account/set-leverage", {
        instId, lever: String(lever), mgnMode: "cross",
      });
    } catch (e) {
      console.log(`[TRADE] Set leverage warning: ${e.message}`);
    }
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
    if (!this.enabled) return { executed: false, reason: "Trading not configured (missing OKX API keys)" };

    const trades = this.loadTrades();
    const openPositions = trades.positions.filter(p => p.status === "open");

    if (openPositions.length >= this.maxPositions) {
      return { executed: false, reason: `Max positions reached (${this.maxPositions})` };
    }

    const today = new Date().toISOString().slice(0, 10);
    const dailyLoss = trades.positions
      .filter(p => p.status === "closed" && p.closedAt?.startsWith(today) && p.realizedPnl < 0)
      .reduce((s, p) => s + Math.abs(p.realizedPnl), 0);
    if (dailyLoss >= this.maxDailyLoss) {
      return { executed: false, reason: `Daily loss limit reached ($${dailyLoss.toFixed(2)} / $${this.maxDailyLoss})` };
    }

    const existing = openPositions.find(p => p.base === signal.base);
    if (existing) {
      return { executed: false, reason: `Already have open position on ${signal.base}` };
    }

    const base = SYMBOL_MAP[signal.base] || signal.base;
    if (OKX_BLACKLIST.has(signal.base)) {
      return { executed: false, reason: `${signal.base} not available on OKX EEA` };
    }

    if (signal.action === "BUY") {
      return this._executeLong(signal, base, trades);
    } else {
      return this._executeShort(signal, base, trades);
    }
  }

  async _executeLong(signal, base, trades) {
    const instId = base + "-USDC";
    try {
      const [balance, inst] = await Promise.all([
        this.getBalance(),
        this.getSpotInstrument(instId),
      ]);

      if (!inst) return { executed: false, reason: `Instrument ${instId} not found` };

      const price = signal.entry || await this.getPrice(instId);
      const stopDist = Math.abs(price - signal.stop);
      if (stopDist <= 0) return { executed: false, reason: "Invalid stop distance" };

      const riskAmount = balance.available * this.riskPct;
      const qty = riskAmount / stopDist;
      const minSz = +inst.minSz || 0.0001;
      const lotSz = +inst.lotSz || 0.0001;
      const roundedQty = Math.floor(qty / lotSz) * lotSz;
      const precision = lotSz < 1 ? Math.round(-Math.log10(lotSz)) : 0;
      const sz = roundedQty.toFixed(precision);

      if (+sz < minSz) return { executed: false, reason: `Position size ${sz} below minimum ${minSz}` };

      const notionalValue = +sz * price;
      if (notionalValue > balance.available) {
        return { executed: false, reason: `Insufficient balance: need $${notionalValue.toFixed(2)}, have $${balance.available.toFixed(2)}` };
      }

      console.log(`[TRADE] BUY ${instId}: sz=${sz}, cost=$${notionalValue.toFixed(2)}, stop=$${signal.stop}`);

      const entryOrder = await this.api("POST", "/api/v5/trade/order", {
        instId, tdMode: "cash", side: "buy", ordType: "market", sz, tgtCcy: "base_ccy",
      });

      const ordId = entryOrder[0]?.ordId;
      await new Promise(r => setTimeout(r, 500));

      let avgPrice = price;
      let filledSz = +sz;
      try {
        const detail = await this.api("GET", `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
        if (detail[0]) { avgPrice = +detail[0].avgPx || price; filledSz = +detail[0].fillSz || +sz; }
      } catch {}

      const position = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        base: signal.base, instId, side: "long", action: "BUY", mode: "spot",
        entryPrice: avgPrice, entrySz: filledSz, remainingSz: filledSz, notionalValue,
        stop: signal.stop, tp1: signal.tp1 || null, tp2: signal.tp2 || null, tp3: signal.tp3 || null,
        tp1Hit: false, tp2Hit: false, tp3Hit: false, entryOrdId: ordId,
        status: "open", signalKey: signal.key || `${signal.base}-${signal.tf}-${signal.action}`,
        tf: signal.tf, openedAt: new Date().toISOString(), closedAt: null, realizedPnl: 0,
        fills: [{ type: "entry", price: avgPrice, sz: filledSz, time: new Date().toISOString() }],
      };

      trades.positions.push(position);
      this.saveTrades(trades);

      return {
        executed: true, position,
        summary: `BUY ${sz} ${signal.base} @ $${avgPrice.toFixed(2)} | Cost: $${notionalValue.toFixed(2)} | Stop: $${signal.stop.toFixed(2)}`,
      };
    } catch (e) {
      return { executed: false, reason: `Order failed: ${e.message}` };
    }
  }

  async _executeShort(signal, base, trades) {
    const inst = await this.getXPerpInstrument(base);
    if (!inst) return { executed: false, reason: `No X-Perp found for ${base}` };

    const instId = inst.instId;
    const ctVal = +inst.ctVal;

    try {
      const balance = await this.getBalance();
      const price = signal.entry || await this.getPrice(instId);
      const stopDist = Math.abs(signal.stop - price);
      if (stopDist <= 0) return { executed: false, reason: "Invalid stop distance" };

      const riskAmount = balance.available * this.riskPct;
      const qtyBase = riskAmount / stopDist;
      const contracts = Math.floor(qtyBase / ctVal);
      const minSz = +inst.minSz || 1;

      if (contracts < minSz) return { executed: false, reason: `Contracts ${contracts} below minimum ${minSz}` };

      const notionalValue = contracts * ctVal * price;
      const margin = notionalValue / this.leverage;
      if (margin > balance.available) {
        return { executed: false, reason: `Insufficient margin: need $${margin.toFixed(2)}, have $${balance.available.toFixed(2)}` };
      }

      await this.setLeverage(instId, this.leverage);

      console.log(`[TRADE] SHORT ${instId}: ${contracts} contracts, notional=$${notionalValue.toFixed(2)}, margin=$${margin.toFixed(2)}, stop=$${signal.stop}`);

      const entryOrder = await this.api("POST", "/api/v5/trade/order", {
        instId, tdMode: "cross", side: "sell", ordType: "market", sz: String(contracts),
      });

      const ordId = entryOrder[0]?.ordId;
      await new Promise(r => setTimeout(r, 500));

      let avgPrice = price;
      let filledSz = contracts;
      try {
        const detail = await this.api("GET", `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
        if (detail[0]) { avgPrice = +detail[0].avgPx || price; filledSz = +detail[0].fillSz || contracts; }
      } catch {}

      const position = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        base: signal.base, instId, side: "short", action: "SELL", mode: "xperp",
        ctVal, leverage: this.leverage,
        entryPrice: avgPrice, entrySz: filledSz, remainingSz: filledSz, notionalValue,
        stop: signal.stop, tp1: signal.tp1 || null, tp2: signal.tp2 || null, tp3: signal.tp3 || null,
        tp1Hit: false, tp2Hit: false, tp3Hit: false, entryOrdId: ordId,
        status: "open", signalKey: signal.key || `${signal.base}-${signal.tf}-${signal.action}`,
        tf: signal.tf, openedAt: new Date().toISOString(), closedAt: null, realizedPnl: 0,
        fills: [{ type: "entry", price: avgPrice, sz: filledSz, time: new Date().toISOString() }],
      };

      trades.positions.push(position);
      this.saveTrades(trades);

      return {
        executed: true, position,
        summary: `SHORT ${contracts} ct ${signal.base} @ $${avgPrice.toFixed(2)} | ${this.leverage}x | Margin: $${margin.toFixed(2)} | Stop: $${signal.stop.toFixed(2)}`,
      };
    } catch (e) {
      return { executed: false, reason: `Short order failed: ${e.message}` };
    }
  }

  async managePositions() {
    const trades = this.loadTrades();
    const open = trades.positions.filter(p => p.status === "open");
    const notifications = [];

    for (const pos of open) {
      try {
        const price = await this.getPrice(pos.instId);
        if (!price) continue;

        const isShort = pos.side === "short";

        // Check stop-loss
        const stopHit = isShort ? price >= pos.stop : price <= pos.stop;
        if (stopHit) {
          const closed = await this.closePosition(pos.base, "stop");
          if (closed) notifications.push({ type: "stop_hit", pos: closed, pnl: closed.realizedPnl });
          continue;
        }

        // Check TP1 (close 60%)
        const tp1Hit = pos.tp1 && (isShort ? price <= pos.tp1 : price >= pos.tp1);
        if (!pos.tp1Hit && tp1Hit) {
          const tp1Qty = Math.floor(pos.entrySz * 0.6);
          if (tp1Qty > 0) {
            try {
              const closeOrder = this._buildCloseOrder(pos, tp1Qty);
              await this.api("POST", "/api/v5/trade/order", closeOrder);
              const pnl = this._calcPnl(pos, price, tp1Qty);
              pos.tp1Hit = true;
              pos.remainingSz -= tp1Qty;
              pos.realizedPnl += pnl;
              pos.stop = pos.entryPrice;
              pos.fills.push({ type: "tp1", price, sz: tp1Qty, time: new Date().toISOString() });
              notifications.push({ type: "tp1_hit", pos, price });
              this.saveTrades(trades);
            } catch (e) {
              console.log(`[TRADE] TP1 error: ${e.message}`);
            }
          }
        }

        // Check TP2 (close 30%)
        const tp2Hit = pos.tp2 && (isShort ? price <= pos.tp2 : price >= pos.tp2);
        if (pos.tp1Hit && !pos.tp2Hit && tp2Hit) {
          const tp2Qty = Math.floor(pos.entrySz * 0.3);
          if (tp2Qty > 0) {
            try {
              const closeOrder = this._buildCloseOrder(pos, tp2Qty);
              await this.api("POST", "/api/v5/trade/order", closeOrder);
              const pnl = this._calcPnl(pos, price, tp2Qty);
              pos.tp2Hit = true;
              pos.remainingSz -= tp2Qty;
              pos.realizedPnl += pnl;
              pos.fills.push({ type: "tp2", price, sz: tp2Qty, time: new Date().toISOString() });
              notifications.push({ type: "tp2_hit", pos, price });
              this.saveTrades(trades);
            } catch (e) {
              console.log(`[TRADE] TP2 error: ${e.message}`);
            }
          }
        }

        // Check TP3 (close remaining)
        const tp3Hit = pos.tp3 && (isShort ? price <= pos.tp3 : price >= pos.tp3);
        if (pos.tp2Hit && !pos.tp3Hit && tp3Hit) {
          const closed = await this.closePosition(pos.base, "tp3");
          if (closed) notifications.push({ type: "tp3_hit", pos: closed, price });
        }

        // Breakeven stop (after TP1)
        const beHit = isShort ? price >= pos.entryPrice : price <= pos.entryPrice;
        if (pos.tp1Hit && beHit) {
          const closed = await this.closePosition(pos.base, "breakeven");
          if (closed) notifications.push({ type: "stop_hit", pos: closed, pnl: closed.realizedPnl });
        }

      } catch (e) {
        console.error(`[TRADE] Error managing ${pos.instId}:`, e.message);
      }
    }

    return notifications;
  }

  _buildCloseOrder(pos, sz) {
    if (pos.mode === "xperp") {
      return { instId: pos.instId, tdMode: "cross", side: "buy", ordType: "market", sz: String(sz), reduceOnly: true };
    }
    const precision = pos.entrySz < 1 ? Math.round(-Math.log10(pos.entrySz / pos.remainingSz * 0.01)) : 0;
    const lotSz = pos.entrySz < 1 ? 0.0001 : 1;
    const adjSz = (Math.floor(sz / lotSz) * lotSz).toFixed(precision > 0 ? precision : 4);
    return { instId: pos.instId, tdMode: "cash", side: "sell", ordType: "market", sz: adjSz, tgtCcy: "base_ccy" };
  }

  _calcPnl(pos, price, sz) {
    const baseQty = pos.mode === "xperp" ? sz * (pos.ctVal || 1) : sz;
    return pos.side === "short"
      ? (pos.entryPrice - price) * baseQty
      : (price - pos.entryPrice) * baseQty;
  }

  async closePosition(base, reason = "manual") {
    const trades = this.loadTrades();
    const pos = trades.positions.find(p => p.base === base && p.status === "open");
    if (!pos) return null;

    const price = await this.getPrice(pos.instId);

    if (pos.remainingSz > 0) {
      try {
        const closeOrder = this._buildCloseOrder(pos, pos.remainingSz);
        await this.api("POST", "/api/v5/trade/order", closeOrder);
      } catch (e) {
        console.log(`[TRADE] Close error: ${e.message}`);
      }

      const pnl = this._calcPnl(pos, price, pos.remainingSz);
      pos.realizedPnl += pnl;
      pos.fills.push({ type: reason, price, sz: pos.remainingSz, time: new Date().toISOString() });
    }

    pos.status = "closed";
    pos.closedAt = new Date().toISOString();
    pos.remainingSz = 0;
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
      open: open.length, closed: closed.length, wins: wins.length,
      winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) : "0",
      totalPnl: totalPnl.toFixed(2),
    };
  }
}

module.exports = OKXTrader;
