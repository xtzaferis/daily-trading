// OKX Perpetual Swap Trader — executes trades based on bot signals
// Demo mode uses the same API with x-simulated-trading header.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://www.okx.com";
const TRADES_FILE = path.join(__dirname, "trades.json");
const DEFAULT_LEVERAGE = 5;

class OKXTrader {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.OKX_API_KEY;
    this.apiSecret = opts.apiSecret || process.env.OKX_API_SECRET;
    this.passphrase = opts.passphrase || process.env.OKX_PASSPHRASE;
    this.demo = opts.demo !== false;
    this.leverage = opts.leverage || +(process.env.LEVERAGE || DEFAULT_LEVERAGE);
    this.riskPct = opts.riskPct || 0.01;
    this.maxPositions = opts.maxPositions || 5;
    this.enabled = !!(this.apiKey && this.apiSecret && this.passphrase);
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
      throw new Error(`OKX ${data.code}: ${data.msg || JSON.stringify(data.data)}`);
    }
    return data.data;
  }

  async getBalance() {
    const data = await this.api("GET", "/api/v5/account/balance?ccy=USDC");
    const detail = data[0]?.details?.find(d => d.ccy === "USDC");
    return {
      available: detail ? +detail.availBal : 0,
      total: detail ? +detail.eq : 0,
    };
  }

  async getPrice(instId) {
    const res = await fetch(`${BASE_URL}/api/v5/market/ticker?instId=${instId}`);
    const data = await res.json();
    return data.data?.[0] ? +data.data[0].last : 0;
  }

  async getInstrument(instId) {
    const res = await fetch(`${BASE_URL}/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
    const data = await res.json();
    return data.data?.[0] || null;
  }

  async setLeverage(instId, leverage, side) {
    try {
      await this.api("POST", "/api/v5/account/set-leverage", {
        instId,
        lever: String(leverage),
        mgnMode: "cross",
      });
    } catch (e) {
      console.log(`[TRADE] Leverage note for ${instId}: ${e.message}`);
    }
  }

  async setAccountMode() {
    try {
      await this.api("POST", "/api/v5/account/set-position-mode", { posMode: "net_mode" });
    } catch {}
  }

  formatSz(value, inst) {
    const lotSz = inst ? +inst.lotSz : 1;
    const rounded = Math.floor(value / lotSz) * lotSz;
    const precision = lotSz < 1 ? Math.round(-Math.log10(lotSz)) : 0;
    return rounded.toFixed(precision);
  }

  formatPx(value, inst) {
    const tickSz = inst ? +inst.tickSz : 0.01;
    const rounded = Math.round(value / tickSz) * tickSz;
    const precision = tickSz < 1 ? Math.round(-Math.log10(tickSz)) : 0;
    return rounded.toFixed(precision);
  }

  async cancelAllOrders(instId) {
    try {
      const orders = await this.api("GET", `/api/v5/trade/orders-pending?instId=${instId}&instType=SWAP`);
      for (const o of orders) {
        await this.api("POST", "/api/v5/trade/cancel-order", { instId, ordId: o.ordId });
      }
    } catch {}
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

    const existing = openPositions.find(p => p.base === signal.base);
    if (existing) {
      return { executed: false, reason: `Already have open position on ${signal.base}` };
    }

    const instId = signal.base + "-USDC-SWAP";
    const side = signal.action === "BUY" ? "buy" : "sell";
    const closeSide = side === "buy" ? "sell" : "buy";
    const posSide = signal.action === "BUY" ? "long" : "short";

    try {
      await this.setAccountMode();

      const [balance, inst] = await Promise.all([
        this.getBalance(),
        this.getInstrument(instId),
      ]);

      if (!inst) return { executed: false, reason: `Instrument ${instId} not found` };

      await this.setLeverage(instId, this.leverage, posSide);

      const price = signal.entry || await this.getPrice(instId);
      const stopDist = Math.abs(price - signal.stop);
      if (stopDist <= 0) return { executed: false, reason: "Invalid stop distance" };

      const ctVal = +inst.ctVal || 1;
      const riskAmount = balance.available * this.riskPct;
      const rawQty = riskAmount / stopDist;
      const contracts = Math.floor((rawQty * price) / (ctVal * price / 1)) || 1;
      const sz = this.formatSz(rawQty / ctVal, inst);

      if (+sz <= 0) return { executed: false, reason: "Position size too small" };

      const notionalValue = +sz * ctVal * price;
      const marginRequired = notionalValue / this.leverage;

      if (marginRequired > balance.available) {
        return { executed: false, reason: `Insufficient margin: need $${marginRequired.toFixed(2)}, have $${balance.available.toFixed(2)}` };
      }

      console.log(`[TRADE] ${side.toUpperCase()} ${instId}: sz=${sz}, notional=$${notionalValue.toFixed(2)}, leverage=${this.leverage}x, stop=${signal.stop}`);

      // 1. Market entry
      const entryOrder = await this.api("POST", "/api/v5/trade/order", {
        instId,
        tdMode: "cross",
        side,
        ordType: "market",
        sz,
      });

      const ordId = entryOrder[0]?.ordId;
      await new Promise(r => setTimeout(r, 500));

      // Get fill details
      let avgPrice = price;
      let filledSz = +sz;
      try {
        const detail = await this.api("GET", `/api/v5/trade/order?instId=${instId}&ordId=${ordId}`);
        if (detail[0]) {
          avgPrice = +detail[0].avgPx || price;
          filledSz = +detail[0].fillSz || +sz;
        }
      } catch {}

      // 2. Stop-loss order
      let stopOrdId = null;
      try {
        const stopResult = await this.api("POST", "/api/v5/trade/order-algo", {
          instId,
          tdMode: "cross",
          side: closeSide,
          ordType: "conditional",
          sz: String(filledSz),
          slTriggerPx: this.formatPx(signal.stop, inst),
          slOrdPx: "-1",
          slTriggerPxType: "mark",
        });
        stopOrdId = stopResult[0]?.algoId;
      } catch (e) {
        console.log(`[TRADE] Stop-loss warning: ${e.message}`);
      }

      // 3. TP1 order (60%)
      let tp1AlgoId = null;
      if (signal.tp1) {
        const tp1Sz = this.formatSz(filledSz * 0.6, inst);
        if (+tp1Sz > 0) {
          try {
            const tp1Result = await this.api("POST", "/api/v5/trade/order-algo", {
              instId,
              tdMode: "cross",
              side: closeSide,
              ordType: "conditional",
              sz: tp1Sz,
              tpTriggerPx: this.formatPx(signal.tp1, inst),
              tpOrdPx: "-1",
              tpTriggerPxType: "mark",
            });
            tp1AlgoId = tp1Result[0]?.algoId;
          } catch (e) {
            console.log(`[TRADE] TP1 warning: ${e.message}`);
          }
        }
      }

      const position = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        base: signal.base,
        instId,
        side: posSide,
        action: signal.action,
        leverage: this.leverage,
        entryPrice: avgPrice,
        entrySz: filledSz,
        remainingSz: filledSz,
        notionalValue,
        stop: signal.stop,
        tp1: signal.tp1 || null,
        tp2: signal.tp2 || null,
        tp3: signal.tp3 || null,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        stopAlgoId: stopOrdId,
        tp1AlgoId,
        tp2AlgoId: null,
        tp3AlgoId: null,
        entryOrdId: ordId,
        status: "open",
        signalKey: signal.key || `${signal.base}-${signal.tf}-${signal.action}`,
        tf: signal.tf,
        openedAt: new Date().toISOString(),
        closedAt: null,
        realizedPnl: 0,
        fills: [{ type: "entry", price: avgPrice, sz: filledSz, time: new Date().toISOString() }],
      };

      trades.positions.push(position);
      this.saveTrades(trades);

      return {
        executed: true,
        position,
        summary: `${side.toUpperCase()} ${sz} ${signal.base} @ $${avgPrice.toFixed(2)} | ${this.leverage}x | Stop: $${signal.stop.toFixed(2)} | Risk: $${riskAmount.toFixed(2)}`,
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
        const inst = await this.getInstrument(pos.instId);
        if (!inst) continue;
        const closeSide = pos.side === "long" ? "sell" : "buy";
        const ctVal = +inst.ctVal || 1;

        // Check algo orders status
        const checkAlgo = async (algoId) => {
          if (!algoId) return null;
          try {
            const data = await this.api("GET", `/api/v5/trade/order-algo?algoId=${algoId}&instType=SWAP`);
            return data[0] || null;
          } catch {
            try {
              const data = await this.api("GET", `/api/v5/trade/orders-algo-history?ordType=conditional&instId=${pos.instId}&state=effective`);
              return data.find(o => o.algoId === algoId) || null;
            } catch { return null; }
          }
        };

        // Check stop-loss
        if (pos.stopAlgoId) {
          const stopStatus = await checkAlgo(pos.stopAlgoId);
          if (stopStatus && (stopStatus.state === "effective" || stopStatus.state === "filled")) {
            await this.cancelAllOrders(pos.instId);
            const price = await this.getPrice(pos.instId);
            const pnl = pos.side === "long"
              ? (price - pos.entryPrice) * pos.remainingSz * ctVal
              : (pos.entryPrice - price) * pos.remainingSz * ctVal;
            pos.realizedPnl += pnl;
            pos.remainingSz = 0;
            pos.status = "closed";
            pos.closedAt = new Date().toISOString();
            pos.fills.push({ type: "stop", price, sz: pos.remainingSz, time: new Date().toISOString() });
            notifications.push({ type: "stop_hit", pos, pnl });
            this.saveTrades(trades);
            continue;
          }
        }

        // Check TP1
        if (!pos.tp1Hit && pos.tp1AlgoId) {
          const tp1Status = await checkAlgo(pos.tp1AlgoId);
          if (tp1Status && (tp1Status.state === "effective" || tp1Status.state === "filled")) {
            pos.tp1Hit = true;
            const tp1Sz = +this.formatSz(pos.entrySz * 0.6, inst);
            const price = pos.tp1;
            const pnl = pos.side === "long"
              ? (price - pos.entryPrice) * tp1Sz * ctVal
              : (pos.entryPrice - price) * tp1Sz * ctVal;
            pos.realizedPnl += pnl;
            pos.remainingSz -= tp1Sz;
            pos.fills.push({ type: "tp1", price, sz: tp1Sz, time: new Date().toISOString() });

            // Cancel old stop, place new at breakeven
            await this.cancelAllOrders(pos.instId);
            try {
              const newStop = await this.api("POST", "/api/v5/trade/order-algo", {
                instId: pos.instId, tdMode: "cross", side: closeSide,
                ordType: "conditional", sz: String(pos.remainingSz),
                slTriggerPx: this.formatPx(pos.entryPrice, inst),
                slOrdPx: "-1", slTriggerPxType: "mark",
              });
              pos.stopAlgoId = newStop[0]?.algoId;
            } catch {}

            // Place TP2
            if (pos.tp2) {
              const tp2Sz = this.formatSz(pos.entrySz * 0.3, inst);
              if (+tp2Sz > 0) {
                try {
                  const tp2Result = await this.api("POST", "/api/v5/trade/order-algo", {
                    instId: pos.instId, tdMode: "cross", side: closeSide,
                    ordType: "conditional", sz: tp2Sz,
                    tpTriggerPx: this.formatPx(pos.tp2, inst),
                    tpOrdPx: "-1", tpTriggerPxType: "mark",
                  });
                  pos.tp2AlgoId = tp2Result[0]?.algoId;
                } catch {}
              }
            }

            pos.stop = pos.entryPrice;
            notifications.push({ type: "tp1_hit", pos, price });
            this.saveTrades(trades);
          }
        }

        // Check TP2
        if (pos.tp1Hit && !pos.tp2Hit && pos.tp2AlgoId) {
          const tp2Status = await checkAlgo(pos.tp2AlgoId);
          if (tp2Status && (tp2Status.state === "effective" || tp2Status.state === "filled")) {
            pos.tp2Hit = true;
            const tp2Sz = +this.formatSz(pos.entrySz * 0.3, inst);
            const price = pos.tp2;
            const pnl = pos.side === "long"
              ? (price - pos.entryPrice) * tp2Sz * ctVal
              : (pos.entryPrice - price) * tp2Sz * ctVal;
            pos.realizedPnl += pnl;
            pos.remainingSz -= tp2Sz;
            pos.fills.push({ type: "tp2", price, sz: tp2Sz, time: new Date().toISOString() });

            await this.cancelAllOrders(pos.instId);
            if (pos.remainingSz > 0) {
              const remSz = this.formatSz(pos.remainingSz, inst);
              try {
                const newStop = await this.api("POST", "/api/v5/trade/order-algo", {
                  instId: pos.instId, tdMode: "cross", side: closeSide,
                  ordType: "conditional", sz: remSz,
                  slTriggerPx: this.formatPx(pos.entryPrice, inst),
                  slOrdPx: "-1", slTriggerPxType: "mark",
                });
                pos.stopAlgoId = newStop[0]?.algoId;
              } catch {}

              if (pos.tp3) {
                try {
                  const tp3Result = await this.api("POST", "/api/v5/trade/order-algo", {
                    instId: pos.instId, tdMode: "cross", side: closeSide,
                    ordType: "conditional", sz: remSz,
                    tpTriggerPx: this.formatPx(pos.tp3, inst),
                    tpOrdPx: "-1", tpTriggerPxType: "mark",
                  });
                  pos.tp3AlgoId = tp3Result[0]?.algoId;
                } catch {}
              }
            }

            notifications.push({ type: "tp2_hit", pos, price });
            this.saveTrades(trades);
          }
        }

        // Check TP3
        if (pos.tp2Hit && !pos.tp3Hit && pos.tp3AlgoId) {
          const tp3Status = await checkAlgo(pos.tp3AlgoId);
          if (tp3Status && (tp3Status.state === "effective" || tp3Status.state === "filled")) {
            pos.tp3Hit = true;
            const price = pos.tp3;
            const pnl = pos.side === "long"
              ? (price - pos.entryPrice) * pos.remainingSz * ctVal
              : (pos.entryPrice - price) * pos.remainingSz * ctVal;
            pos.realizedPnl += pnl;
            pos.fills.push({ type: "tp3", price, sz: pos.remainingSz, time: new Date().toISOString() });
            pos.remainingSz = 0;

            await this.cancelAllOrders(pos.instId);
            pos.status = "closed";
            pos.closedAt = new Date().toISOString();
            notifications.push({ type: "tp3_hit", pos, price });
            this.saveTrades(trades);
          }
        }

      } catch (e) {
        console.error(`[TRADE] Error managing ${pos.instId}:`, e.message);
      }
    }

    return notifications;
  }

  async closePosition(base, reason = "manual") {
    const trades = this.loadTrades();
    const pos = trades.positions.find(p => p.base === base && p.status === "open");
    if (!pos) return null;

    await this.cancelAllOrders(pos.instId);
    const inst = await this.getInstrument(pos.instId);
    const closeSide = pos.side === "long" ? "sell" : "buy";
    const price = await this.getPrice(pos.instId);

    if (pos.remainingSz > 0) {
      await this.api("POST", "/api/v5/trade/order", {
        instId: pos.instId, tdMode: "cross", side: closeSide,
        ordType: "market", sz: this.formatSz(pos.remainingSz, inst),
      });
      const ctVal = inst ? +inst.ctVal : 1;
      const pnl = pos.side === "long"
        ? (price - pos.entryPrice) * pos.remainingSz * ctVal
        : (pos.entryPrice - price) * pos.remainingSz * ctVal;
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
      open: open.length,
      closed: closed.length,
      wins: wins.length,
      winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) : "0",
      totalPnl: totalPnl.toFixed(2),
    };
  }
}

module.exports = OKXTrader;
