// Telegram Signal Bot — runs the same analysis as the dashboard
// and sends BUY/SELL signals to a Telegram channel.
// Optionally executes spot trades on Binance.
// Requires Node 18+ (native fetch).

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars");
  process.exit(1);
}

const BinanceTrader = require("./trader");
const trader = new BinanceTrader({
  testnet: process.env.BINANCE_LIVE !== "true",
  riskPct: +(process.env.RISK_PCT || 0.01),
  maxPositions: +(process.env.MAX_POSITIONS || 5),
});

if (trader.enabled) {
  console.log(`Trading ENABLED (${trader.testnet ? "TESTNET" : "LIVE"}) | Risk: ${trader.riskPct * 100}% | Max positions: ${trader.maxPositions}`);
} else {
  console.log("Trading DISABLED (no BINANCE_API_KEY/SECRET)");
}

// ---------- configuration ----------
const CONFIG = { poolSize: 40, minQuoteVolume: 5_000_000, candlesLimit: 500, htfLimit: 150, topN: 10 };
const HTF_MAP = { "5m": "15m", "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w", "1w": "1M" };
const TF_MS = { "5m": 5 * 60000, "15m": 15 * 60000, "1h": 3600000, "4h": 4 * 3600000, "1d": 86400000, "1w": 7 * 86400000 };

const STABLE_BASES = new Set([
  "USDC","FDUSD","TUSD","DAI","USDP","BUSD","EUR","GBP","TRY","BRL","AUD",
  "GYEN","USTC","UST","USDD","USDJ","PAX","EURI","XUSD","USD1","USDE",
  "PYUSD","USDS","FRAX","GUSD","LUSD","USDX","EURC","AEUR","RLUSD"
]);
const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)USDT$/;
const MEME_BASES = new Set([
  "DOGE","SHIB","PEPE","WIF","BONK","FLOKI","BOME","MEME","POPCAT","MEW","BRETT","TURBO",
  "NEIRO","DOGS","PNUT","ACT","MOODENG","GOAT","SPX","FARTCOIN","AI16Z","PENGU","TRUMP",
  "MOG","BABYDOGE","CHILLGUY","PEOPLE","ORDI","1000SATS","MUBARAK","BANANAS31","TST","CHEEMS"
]);

// ---------- indicators ----------
const sma = (v, p) => v.map((_, i) => {
  if (i < p - 1) return NaN;
  let s = 0; for (let j = i - p + 1; j <= i; j++) s += v[j];
  return s / p;
});

function ema(v, p) {
  const k = 2 / (p + 1), o = Array(v.length).fill(NaN);
  let e = null;
  for (let i = 0; i < v.length; i++) {
    if (i < p - 1) continue;
    if (e === null) { let s = 0; for (let j = 0; j < p; j++) s += v[j]; e = s / p; }
    else e = v[i] * k + e * (1 - k);
    o[i] = e;
  }
  return o;
}

function rsi(c, p = 14) {
  const o = Array(c.length).fill(NaN);
  if (c.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  g /= p; l /= p; o[p] = 100 - 100 / (1 + g / (l || 1e-9));
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (p - 1) + Math.max(d, 0)) / p;
    l = (l * (p - 1) + Math.max(-d, 0)) / p;
    o[i] = 100 - 100 / (1 + g / (l || 1e-9));
  }
  return o;
}

function macd(c) {
  const a = ema(c, 12), b = ema(c, 26), line = c.map((_, i) => a[i] - b[i]);
  const first = line.findIndex(x => !isNaN(x)), sig = Array(c.length).fill(NaN);
  if (first >= 0) ema(line.slice(first), 9).forEach((v, i) => sig[first + i] = v);
  return { line, sig, hist: line.map((v, i) => v - sig[i]) };
}

function boll(c, p = 20, m = 2) {
  const mid = sma(c, p); const up = [], lo = [];
  for (let i = 0; i < c.length; i++) {
    if (i < p - 1) { up.push(NaN); lo.push(NaN); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / p);
    up.push(mid[i] + m * sd); lo.push(mid[i] - m * sd);
  }
  return { mid, up, lo };
}

function atr(cs, p = 14) {
  const o = Array(cs.length).fill(NaN);
  if (cs.length <= p) return o;
  const tr = cs.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - cs[i - 1].c), Math.abs(x.l - cs[i - 1].c)) : x.h - x.l);
  let a = 0; for (let i = 1; i <= p; i++) a += tr[i]; a /= p; o[p] = a;
  for (let i = p + 1; i < cs.length; i++) { a = (a * (p - 1) + tr[i]) / p; o[i] = a; }
  return o;
}

function dmi(cs, p = 14) {
  const n = cs.length, adx = Array(n).fill(NaN), diPlus = Array(n).fill(NaN), diMinus = Array(n).fill(NaN);
  if (n <= p + 1) return { adx, diPlus, diMinus };
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < n; i++) {
    const up = cs[i].h - cs[i - 1].h, down = cs[i - 1].l - cs[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c)));
  }
  const wilderSmooth = arr => {
    const o = Array(arr.length).fill(NaN);
    let s = 0; for (let i = 0; i < p; i++) s += arr[i];
    o[p - 1] = s;
    for (let i = p; i < arr.length; i++) o[i] = o[i - 1] - o[i - 1] / p + arr[i];
    return o;
  };
  const trS = wilderSmooth(tr), pdmS = wilderSmooth(plusDM), mdmS = wilderSmooth(minusDM);
  const diP = trS.map((v, i) => isNaN(v) ? NaN : 100 * pdmS[i] / (v || 1e-9));
  const diM = trS.map((v, i) => isNaN(v) ? NaN : 100 * mdmS[i] / (v || 1e-9));
  const dx = trS.map((v, i) => isNaN(v) ? NaN : 100 * Math.abs(pdmS[i] - mdmS[i]) / ((pdmS[i] + mdmS[i]) || 1e-9));
  const firstValid = dx.findIndex(x => !isNaN(x));
  if (firstValid >= 0 && dx.length >= firstValid + p) {
    let s = 0; for (let i = firstValid; i < firstValid + p; i++) s += dx[i];
    let a = s / p; adx[firstValid + p] = a;
    for (let i = firstValid + p; i < dx.length; i++) { a = (a * (p - 1) + dx[i]) / p; adx[i + 1] = a; }
  }
  for (let i = 0; i < diP.length; i++) { diPlus[i + 1] = diP[i]; diMinus[i + 1] = diM[i]; }
  return { adx, diPlus, diMinus };
}

function obv(cs) {
  const o = Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) o[i] = o[i - 1] + (cs[i].c > cs[i - 1].c ? cs[i].v : cs[i].c < cs[i - 1].c ? -cs[i].v : 0);
  return o;
}

function stochRsi(rArr, p = 14) {
  const n = rArr.length, raw = Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i < p - 1 || isNaN(rArr[i])) continue;
    let lo = Infinity, hi = -Infinity, ok = true;
    for (let j = i - p + 1; j <= i; j++) { if (isNaN(rArr[j])) { ok = false; break; } lo = Math.min(lo, rArr[j]); hi = Math.max(hi, rArr[j]); }
    if (ok) raw[i] = hi > lo ? (rArr[i] - lo) / (hi - lo) : 0;
  }
  const k = sma(raw, 3), d = sma(k, 3);
  return { k, d };
}

function divergence(c, r, i, lookback = 20) {
  if (i < lookback || isNaN(r[i])) return { bearish: false, bullish: false };
  let hiIdx = i - 1, loIdx = i - 1;
  for (let j = Math.max(0, i - lookback); j < i; j++) {
    if (isNaN(r[j])) continue;
    if (c[j] > c[hiIdx]) hiIdx = j;
    if (c[j] < c[loIdx]) loIdx = j;
  }
  const bearish = c[i] >= c[hiIdx] && r[i] < r[hiIdx] - 2;
  const bullish = c[i] <= c[loIdx] && r[i] > r[loIdx] + 2;
  return { bearish, bullish };
}

function vwapCalc(cs, tf) {
  const n = cs.length, out = Array(n).fill(NaN);
  const isIntraday = (TF_MS[tf] || 86400000) < 86400000;
  let cumVol = 0, cumTP = 0, lastDay = -1;
  for (let i = 0; i < n; i++) {
    if (isIntraday) {
      const day = Math.floor(cs[i].t / 86400000);
      if (day !== lastDay) { cumVol = 0; cumTP = 0; lastDay = day; }
    }
    const tp = (cs[i].h + cs[i].l + cs[i].c) / 3;
    cumTP += tp * cs[i].v; cumVol += cs[i].v;
    out[i] = cumVol > 0 ? cumTP / cumVol : tp;
  }
  return out;
}

function findSR(cs, left = 5, right = 2) {
  const raw = [];
  for (let i = left; i < cs.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (cs[j].h >= cs[i].h) isHigh = false;
      if (cs[j].l <= cs[i].l) isLow = false;
    }
    if (isHigh) raw.push({ price: cs[i].h, type: "R", idx: i, strength: 1 });
    if (isLow) raw.push({ price: cs[i].l, type: "S", idx: i, strength: 1 });
  }
  const merged = [];
  const tol = 0.005;
  for (const l of raw) {
    const m = merged.find(x => Math.abs(x.price - l.price) / l.price < tol && x.type === l.type);
    if (m) { m.strength++; m.price = (m.price + l.price) / 2; } else merged.push({ ...l });
  }
  return merged.sort((a, b) => b.strength - a.strength);
}

function mktStructure(cs, lookback = 30) {
  const n = cs.length;
  if (n < lookback + 4) return { structure: "unknown", score: 0 };
  const swings = [];
  for (let i = Math.max(2, n - lookback); i < n - 2; i++) {
    if (cs[i].h > cs[i - 1].h && cs[i].h > cs[i + 1].h && cs[i].h > cs[i - 2].h && cs[i].h >= cs[i + 2].h)
      swings.push({ type: "H", price: cs[i].h, idx: i });
    if (cs[i].l < cs[i - 1].l && cs[i].l < cs[i + 1].l && cs[i].l < cs[i - 2].l && cs[i].l <= cs[i + 2].l)
      swings.push({ type: "L", price: cs[i].l, idx: i });
  }
  const highs = swings.filter(s => s.type === "H").slice(-3);
  const lows = swings.filter(s => s.type === "L").slice(-3);
  let sc = 0;
  if (highs.length >= 2) sc += highs[highs.length - 1].price > highs[highs.length - 2].price ? 1 : -1;
  if (lows.length >= 2) sc += lows[lows.length - 1].price > lows[lows.length - 2].price ? 1 : -1;
  const structure = sc >= 2 ? "uptrend" : sc <= -2 ? "downtrend" : "ranging";
  return { structure, score: sc };
}

function indicators(cs, tf = "1d") {
  const c = cs.map(x => x.c), v = cs.map(x => x.v);
  const r = rsi(c), bb = boll(c), d = dmi(cs), ob = obv(cs);
  const bbw = bb.mid.map((m, i) => isNaN(m) ? NaN : (bb.up[i] - bb.lo[i]) / (m || 1e-9));
  return {
    cs, c, e9: ema(c, 9), e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200),
    r, m: macd(c), bb, bbw, a: atr(cs), vm: sma(v, 20),
    adx: d.adx, diPlus: d.diPlus, diMinus: d.diMinus, sr: stochRsi(r),
    obv: ob, obvE: ema(ob, 20),
    vwap: vwapCalc(cs, tf), levels: findSR(cs), ms: mktStructure(cs)
  };
}

function marketContext(btcCs) {
  if (!btcCs || btcCs.length < 55) return null;
  const I = indicators(btcCs), i = btcCs.length - 1;
  if (isNaN(I.e20[i]) || isNaN(I.e50[i])) return null;
  const lookback = 20;
  return {
    trend: I.e20[i] > I.e50[i] ? 1 : -1,
    adx: isNaN(I.adx[i]) ? null : I.adx[i],
    ret20: i >= lookback ? I.c[i] / I.c[i - lookback] - 1 : 0
  };
}

function trendDir(cs) {
  if (!cs || cs.length < 55) return 0;
  const c = cs.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), i = c.length - 1;
  if (isNaN(e20[i]) || isNaN(e50[i])) return 0;
  return e20[i] > e50[i] ? 1 : -1;
}

// ---------- scoring ----------
function scoreAt(I, i) {
  if ([I.e50[i], I.m.sig[i], I.a[i], I.vm[i], I.r[i], I.bb.up[i]].some(isNaN))
    return { score: 0, why: ["Not enough data"], confluence: 0, grade: "C" };
  let s = 0; const why = [];
  const add = (n, t) => { s += n; why.push((n >= 0 ? "+" : "") + Math.round(n) + "  " + t); };
  const c = I.c[i];
  const adxVal = I.adx[i];
  const trendDamp = isNaN(adxVal) ? 1 : adxVal < 18 ? 0.5 : adxVal > 25 ? 1.15 : 1;
  const trendBull = I.e20[i] > I.e50[i];
  add((trendBull ? 20 : -20) * trendDamp, trendBull ? "EMA20>EMA50 uptrend" : "EMA20<EMA50 downtrend");
  add((c > I.e50[i] ? 10 : -10) * trendDamp, c > I.e50[i] ? "Above EMA50" : "Below EMA50");
  if (!isNaN(I.e200[i])) add(c > I.e200[i] ? 8 : -8, c > I.e200[i] ? "Above EMA200" : "Below EMA200");
  const r = I.r[i];
  if (r < 30) add(15, "RSI " + r.toFixed(0) + " oversold");
  else if (r > 70) add(-15, "RSI " + r.toFixed(0) + " overbought");
  else add((r - 50) / 50 * 10, "RSI " + r.toFixed(0));
  const h = I.m.hist[i], hp = I.m.hist[i - 1];
  add((h > 0 ? 15 : -15) * trendDamp, h > 0 ? "MACD positive" : "MACD negative");
  if (!isNaN(hp)) {
    add(h > hp ? 5 : -5, h > hp ? "MACD rising" : "MACD falling");
    if (hp <= 0 && h > 0) add(10, "MACD bullish cross");
    if (hp >= 0 && h < 0) add(-10, "MACD bearish cross");
  }
  const pb = (c - I.bb.lo[i]) / ((I.bb.up[i] - I.bb.lo[i]) || 1e-9);
  if (pb < 0.05) add(10, "At lower BB");
  else if (pb > 0.95) add(-10, "At upper BB");
  const vr = I.cs[i].v / I.vm[i];
  if (vr > 1.5) { const up = I.cs[i].c >= I.cs[i].o; add(up ? 10 : -10, "Volume " + vr.toFixed(1) + "x on " + (up ? "green" : "red")); }
  if (!isNaN(I.diPlus[i]) && !isNaN(I.diMinus[i]))
    add(I.diPlus[i] > I.diMinus[i] ? 6 : -6, I.diPlus[i] > I.diMinus[i] ? "DI+ > DI-" : "DI- > DI+");
  const sk = I.sr.k[i];
  if (!isNaN(sk)) {
    if (sk < 0.2) add(6, "StochRSI oversold");
    else if (sk > 0.8) add(-6, "StochRSI overbought");
  }
  if (!isNaN(I.obvE[i]))
    add(I.obv[i] > I.obvE[i] ? 6 : -6, I.obv[i] > I.obvE[i] ? "OBV rising" : "OBV falling");
  if (!isNaN(I.bbw[i]) && i >= 50) {
    const w = I.bbw.slice(i - 49, i + 1).filter(x => !isNaN(x));
    if (w.length > 20) {
      const q = [...w].sort((a, b) => a - b)[Math.floor(w.length * 0.25)];
      if (I.bbw[i] <= q) {
        if (pb > 0.85) add(8, "BB squeeze breakout up");
        else if (pb < 0.15) add(-8, "BB squeeze breakdown");
      }
    }
  }
  if (!isNaN(I.vwap[i])) {
    add(c > I.vwap[i] ? 6 : -6, c > I.vwap[i] ? "Above VWAP" : "Below VWAP");
  }
  const ms = I.ms;
  if (ms.score >= 2) add(5, "HH+HL uptrend");
  else if (ms.score <= -2) add(-5, "LH+LL downtrend");
  else if (ms.score !== 0) add(ms.score > 0 ? 2 : -2, "Mixed structure");
  const div = divergence(I.c, I.r, i);
  if (div.bearish) add(-12, "Bearish RSI divergence");
  if (div.bullish) add(12, "Bullish RSI divergence");
  if (!isNaN(I.e9[i])) {
    const nearE9 = Math.abs(c - I.e9[i]) / c < 0.004;
    if (nearE9 && trendBull && r > 40 && r < 65) add(4, "EMA9 pullback entry (uptrend)");
    else if (nearE9 && !trendBull && r > 35 && r < 60) add(-4, "EMA9 pullback entry (downtrend)");
  }
  s = Math.max(-100, Math.min(100, s));
  const dir = s > 0 ? 1 : s < 0 ? -1 : 0;
  let conf = 0;
  if (dir !== 0) {
    if ((trendBull ? 1 : -1) === dir) conf++;
    if ((r > 55 ? 1 : r < 45 ? -1 : 0) === dir) conf++;
    if ((h > 0 ? 1 : -1) === dir) conf++;
    if (!isNaN(I.obvE[i]) && (I.obv[i] > I.obvE[i] ? 1 : -1) === dir) conf++;
    if (!isNaN(I.diPlus[i]) && (I.diPlus[i] > I.diMinus[i] ? 1 : -1) === dir) conf++;
    if (!isNaN(I.vwap[i]) && (c > I.vwap[i] ? 1 : -1) === dir) conf++;
    if (ms.score !== 0 && Math.sign(ms.score) === dir) conf++;
  }
  const grade = conf >= 5 ? "A" : conf >= 3 ? "B" : "C";
  return { score: s, why, adx: adxVal, confluence: conf, grade };
}

function calcRR(price, stop, levels, side) {
  const risk = side === "long" ? price - stop : stop - price;
  if (risk <= 0) return { rr: NaN, target: null, method: null, tp1: null, tp2: null, tp3: null };
  const candidates = [];
  if (side === "long") {
    levels.filter(l => l.type === "R" && l.price > price * 1.003)
      .sort((a, b) => a.price - b.price).slice(0, 5)
      .forEach(l => candidates.push({ price: l.price, method: "S/R (" + l.strength + ")" }));
  } else {
    levels.filter(l => l.type === "S" && l.price < price * 0.997)
      .sort((a, b) => b.price - a.price).slice(0, 5)
      .forEach(l => candidates.push({ price: l.price, method: "S/R (" + l.strength + ")" }));
  }
  const fib1 = side === "long" ? price + risk * 1.618 : price - risk * 1.618;
  const fib2 = side === "long" ? price + risk * 2.618 : price - risk * 2.618;
  candidates.push({ price: fib1, method: "Fib 1.618" });
  candidates.push({ price: fib2, method: "Fib 2.618" });
  candidates.push({ price: side === "long" ? price + risk * 2 : price - risk * 2, method: "2R ATR" });

  const scored = candidates
    .map(t => ({ ...t, rr: (side === "long" ? t.price - price : price - t.price) / risk }))
    .filter(t => t.rr > 0)
    .sort((a, b) => a.rr - b.rr);

  // TP1 = nearest S/R or Fib 1.0 (conservative), TP2 = Fib 1.618, TP3 = Fib 2.618
  const tp1Price = side === "long" ? price + risk * 1.0 : price - risk * 1.0;
  const nearSR = scored.find(t => t.rr >= 0.8 && t.rr <= 1.5 && t.method.startsWith("S/R"));
  const tp1 = { price: nearSR ? nearSR.price : tp1Price, method: nearSR ? nearSR.method : "1R ATR",
    rr: nearSR ? nearSR.rr : 1.0 };
  const tp2 = { price: fib1, method: "Fib 1.618", rr: 1.618 };
  const tp3 = { price: fib2, method: "Fib 2.618", rr: 2.618 };

  const good = scored.filter(t => t.rr >= 1.5);
  const primary = good.length ? good[0] : scored.length ? scored[scored.length - 1] : null;
  if (primary) return { rr: primary.rr, target: primary.price, method: primary.method, tp1, tp2, tp3 };
  return { rr: 1, target: tp1.price, method: "1R ATR", tp1, tp2, tp3 };
}

function backtest(I, side = "long", enter = 25, fee = 0.001) {
  const n = I.c.length; let pos = null, trades = [], eq = 1;
  const sc = Array(n).fill(0); for (let i = 50; i < n; i++) sc[i] = scoreAt(I, i).score;
  for (let i = 51; i < n; i++) {
    if (pos) {
      const k = I.cs[i];
      if (!pos.trailed) {
        if (side === "long" && k.h >= pos.entry + pos.risk) { pos.stop = pos.entry * (1 + fee * 2); pos.trailed = true; }
        else if (side === "short" && k.l <= pos.entry - pos.risk) { pos.stop = pos.entry * (1 - fee * 2); pos.trailed = true; }
      }
      let exit = null;
      if (side === "long") {
        if (k.l <= pos.stop) exit = Math.min(pos.stop, k.o);
        else if (sc[i] <= 0) exit = k.c;
      } else {
        if (k.h >= pos.stop) exit = Math.max(pos.stop, k.o);
        else if (sc[i] >= 0) exit = k.c;
      }
      if (exit !== null) {
        const ret = side === "long"
          ? (exit / pos.entry) * (1 - fee) / (1 + fee) - 1
          : (pos.entry / exit) * (1 - fee) / (1 + fee) - 1;
        trades.push(ret); eq *= 1 + ret; pos = null;
      }
    } else if (side === "long" && sc[i] >= enter && sc[i - 1] < enter) {
      const risk = 1.5 * I.a[i]; pos = { entry: I.c[i], stop: I.c[i] - risk, risk, trailed: false };
    } else if (side === "short" && sc[i] <= -enter && sc[i - 1] > -enter) {
      const risk = 1.5 * I.a[i]; pos = { entry: I.c[i], stop: I.c[i] + risk, risk, trailed: false };
    }
  }
  const wins = trades.filter(x => x > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -trades.filter(x => x <= 0).reduce((a, b) => a + b, 0);
  return {
    trades: trades.length, win: trades.length ? wins.length / trades.length : NaN,
    ret: eq - 1, exp: trades.length ? trades.reduce((a, b) => a + b, 0) / trades.length : NaN,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN), grossWin, grossLoss
  };
}

function analyze(cs, htfTrend = 0, market = null, tf = "1d", funding = null) {
  const I = indicators(cs, tf), i = cs.length - 1, base = scoreAt(I, i), a = I.a[i], c = I.c[i];
  let score = base.score, why = [...base.why], counterTrend = false, aligned = false, squeezeRisk = null;
  if (htfTrend !== 0 && score !== 0) {
    aligned = (score > 0 && htfTrend > 0) || (score < 0 && htfTrend < 0);
    if (aligned) { score += score > 0 ? 8 : -8; why.push("Aligned with HTF"); }
    else { score *= 0.5; counterTrend = true; why.push("Against HTF — halved"); }
  }
  if (market && i >= 20) {
    const rs = (I.c[i] / I.c[i - 20] - 1) - market.ret20;
    const rsPoints = Math.max(-15, Math.min(15, rs * 100));
    if (Math.abs(rsPoints) >= 2) score += rsPoints;
  }
  let marketAligned = null;
  if (market && market.trend !== 0 && score !== 0) {
    marketAligned = (score > 0 && market.trend > 0) || (score < 0 && market.trend < 0);
    if (marketAligned) score *= 1.1; else { score *= 0.7; why.push("Against BTC trend — discounted"); }
  }
  let positioningAligned = null;
  if (funding && score !== 0) {
    const fr = funding.funding;
    const extreme = Math.abs(fr) > 0.0002, veryExtreme = Math.abs(fr) > 0.0006;
    const dir = score > 0 ? 1 : -1;
    if (extreme) {
      if (fr > 0 && dir > 0) { score *= veryExtreme ? 0.6 : 0.8; squeezeRisk = "long"; positioningAligned = false; }
      else if (fr > 0 && dir < 0) { score *= veryExtreme ? 1.15 : 1.08; positioningAligned = true; }
      else if (fr < 0 && dir < 0) { score *= veryExtreme ? 0.6 : 0.8; squeezeRisk = "short"; positioningAligned = false; }
      else if (fr < 0 && dir > 0) { score *= veryExtreme ? 1.15 : 1.08; positioningAligned = true; }
    }
  }
  score = Math.max(-100, Math.min(100, score));
  let confluence = base.confluence;
  if (aligned) confluence = Math.min(8, confluence + 1);
  if (positioningAligned === true) confluence = Math.min(8, confluence + 1);
  else if (positioningAligned === false) confluence = Math.max(0, confluence - 1);
  const side = score >= 20 ? "long" : score <= -20 ? "short" : "none";
  const stopDist = 1.5 * a;
  const plan = side === "long" ? { side: "LONG", entry: c, stop: c - stopDist, t1: c + stopDist, t2: c + 3 * a }
    : side === "short" ? { side: "SHORT", entry: c, stop: c + stopDist, t1: c - stopDist, t2: c - 3 * a }
    : null;
  let rr = null;
  if (plan) { rr = calcRR(c, plan.stop, I.levels, side); if (rr.target) plan.srTarget = rr.target; }
  const grade = confluence >= 6 ? "A" : confluence >= 4 ? "B" : "C";
  const bt = backtest(I, side === "short" ? "short" : "long");
  return { I, score, why, side, plan, rsi: I.r[i], counterTrend, marketAligned, atr: a, bt, confluence, grade, rr, levels: I.levels, ms: I.ms, squeezeRisk, positioningAligned, funding };
}

function refinePositioning(result, lsRatio) {
  if (!lsRatio || result.side === "none") return;
  result.lsRatio = lsRatio;
  const { longPct, shortPct } = lsRatio;
  const dir = result.side === "long" ? 1 : -1;
  const crowdedLongs = longPct > 56, crowdedShorts = shortPct > 56, balanced = !crowdedLongs && !crowdedShorts;
  if (result.positioningAligned === true && balanced) {
    result.positioningAligned = null; result.confluence = Math.max(0, result.confluence - 1);
    result.squeezeRisk = result.side; result.score = Math.max(-100, Math.min(100, result.score * 0.82));
  } else if (result.positioningAligned === true) {
    if ((dir < 0 && crowdedShorts) || (dir > 0 && crowdedLongs)) {
      result.positioningAligned = false; result.confluence = Math.max(0, result.confluence - 2);
      result.squeezeRisk = result.side; result.score = Math.max(-100, Math.min(100, result.score * 0.65));
    }
  }
  if (result.positioningAligned === null && !balanced) {
    if ((dir > 0 && crowdedLongs) || (dir < 0 && crowdedShorts)) {
      result.positioningAligned = false; result.confluence = Math.max(0, result.confluence - 1);
      result.squeezeRisk = result.side; result.score = Math.max(-100, Math.min(100, result.score * 0.8));
    } else if ((dir > 0 && crowdedShorts) || (dir < 0 && crowdedLongs)) {
      result.positioningAligned = true; result.confluence = Math.min(8, result.confluence + 1);
      result.score = Math.max(-100, Math.min(100, result.score * 1.05));
    }
  }
  if (result.squeezeRisk) result.grade = result.confluence >= 4 ? "B" : "C";
  else result.grade = result.confluence >= 6 ? "A" : result.confluence >= 4 ? "B" : "C";
}

function computeAction(d, edgeData) {
  if (d.side === "none") return { action: "WAIT", reason: "No signal", cautions: [] };
  if (d.grade === "C") return { action: "WAIT", reason: "Low confidence", cautions: [] };
  if (!d.rr || isNaN(d.rr.rr) || d.rr.rr < 1.0) return { action: "WAIT", reason: "R:R < 1", cautions: [] };
  const cautions = [];
  if (d.rr.rr < 1.5) cautions.push("Tight R:R");
  if (d.counterTrend) cautions.push("Against HTF");
  if (d.squeezeRisk) cautions.push("Squeeze risk");
  if (d.marketAligned === false) cautions.push("Against BTC");
  const coinPf = d.bt && d.bt.pf;
  if (coinPf !== undefined && isFinite(coinPf) && coinPf < 1.0) cautions.push("Weak backtest");
  if (edgeData) {
    const pf = edgeData[d.side === "long" ? "long" : "short"];
    if (pf && isFinite(pf.pf) && pf.pf < 1.0) cautions.push("TF edge weak");
  }
  return { action: d.side === "long" ? "BUY" : "SELL", reason: null, cautions };
}

// ---------- Binance data ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(path, retries = 2) {
  const bases = ["https://data-api.binance.vision", "https://api.binance.com"];
  let err;
  for (const b of bases) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(b + path);
        if (r.ok) return await r.json();
        if ((r.status === 429 || r.status === 418) && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
        err = new Error(`${r.status}`); break;
      } catch (e) { err = e; if (attempt < retries) await sleep(300 * (attempt + 1)); }
    }
  }
  throw err;
}

async function futuresJSON(path, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch("https://fapi.binance.com" + path);
      if (r.ok) return await r.json();
      if ((r.status === 429 || r.status === 418) && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
      throw new Error(`${r.status}`);
    } catch (e) { if (attempt >= retries) throw e; await sleep(300 * (attempt + 1)); }
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length); let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}

async function fetchKlines(sym, tf, limit = CONFIG.candlesLimit) {
  try { return await getJSON(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`); }
  catch { return null; }
}
async function fetchBulkFunding() {
  try {
    const data = await futuresJSON("/fapi/v1/premiumIndex");
    const map = {};
    for (const p of data) map[p.symbol] = { funding: +p.lastFundingRate, markPrice: +p.markPrice };
    return map;
  } catch { return {}; }
}
async function fetchLongShortRatio(symbol) {
  try {
    const data = await futuresJSON(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`);
    const row = Array.isArray(data) && data[0];
    return row ? { longPct: +row.longAccount * 100, shortPct: +row.shortAccount * 100 } : null;
  } catch { return null; }
}

function filterUniverse(all, minVol) {
  return all.filter(t => {
    if (!t.symbol.endsWith("USDT")) return false;
    const base = t.symbol.slice(0, -4);
    if (STABLE_BASES.has(base)) return false;
    if (LEVERAGED_RE.test(t.symbol)) return false;
    if (+t.quoteVolume < minVol) return false;
    return true;
  }).sort((a, b) => +b.quoteVolume - +a.quoteVolume);
}

function buildUniverse(all, minVol, poolSize) {
  const eligible = filterUniverse(all, minVol);
  const cat = {}, list = [], seen = new Set();
  const add = (t, c) => { if (t && !seen.has(t.symbol)) { seen.add(t.symbol); list.push(t); cat[t.symbol] = c; } };
  eligible.slice(0, 20).forEach(t => add(t, "major"));
  eligible.filter(t => MEME_BASES.has(t.symbol.slice(0, -4))).slice(0, 10).forEach(t => add(t, "meme"));
  eligible.slice().sort((a, b) => +b.priceChangePercent - +a.priceChangePercent).slice(0, 5).forEach(t => add(t, "trend"));
  return { list, cat };
}

const toCandles = raw => raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1);
const fmt = p => p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toFixed(6);

// ---------- Telegram ----------
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error("Telegram error:", res.status, err);
  }
  return res.ok;
}

const fs = require("fs");
const path = require("path");
const STATE_FILE = path.join(__dirname, "daily-state.json");
const LOG_FILE = path.join(__dirname, "signal-log.json");

const TF_EXPIRY_H = { "1h": 4, "4h": 12, "1d": 48, "1w": 168 };
const TF_VALID_LABEL = { "1h": "4h", "4h": "12h", "1d": "48h", "1w": "7d" };
const REF_ACCOUNT = 1000;
const REF_RISK_PCT = 0.01;

function formatSignal(d, tf, idx) {
  const emoji = d.action === "BUY" ? "\u{1F7E2}" : "\u{1F534}";
  const rank = idx != null ? `#${idx + 1}  ` : "";

  // Entry zone: ATR-based band around entry
  const zoneHalf = d.atr ? d.atr * 0.3 : d.plan.entry * 0.003;
  const zoneLo = d.plan.entry - zoneHalf;
  const zoneHi = d.plan.entry + zoneHalf;

  // Multi-target TP lines
  const tp1 = d.rr?.tp1, tp2 = d.rr?.tp2, tp3 = d.rr?.tp3;
  const tp1Line = tp1 ? `<b>TP1:</b> <code>${fmt(tp1.price)}</code>  (${tp1.rr.toFixed(1)}R — close 60%)` : "";
  const tp2Line = tp2 ? `<b>TP2:</b> <code>${fmt(tp2.price)}</code>  (${tp2.rr.toFixed(1)}R — close 30%)` : "";
  const tp3Line = tp3 ? `<b>TP3:</b> <code>${fmt(tp3.price)}</code>  (${tp3.rr.toFixed(1)}R — close 10%)` : "";

  // Position sizing for $1,000 account at 1% risk
  const stopDist = Math.abs(d.plan.entry - d.plan.stop);
  const riskUsd = REF_ACCOUNT * REF_RISK_PCT;
  const posSize = stopDist > 0 ? riskUsd / stopDist : 0;
  const posValue = posSize * d.plan.entry;
  const leverage = posValue > REF_ACCOUNT ? Math.ceil(posValue / REF_ACCOUNT) : 1;
  const sizeText = `${posSize.toFixed(posSize >= 1 ? 2 : 6)} ${d.base} ($${posValue.toFixed(0)}) risking $${riskUsd.toFixed(0)}`;
  const levText = leverage > 1 ? `  |  ${leverage}x leverage` : "";

  // Expiry
  const expiryH = TF_EXPIRY_H[tf] || 48;
  const expiresAt = new Date(Date.now() + expiryH * 3600000);
  const expiryStr = expiresAt.toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " UTC";

  const cautionText = d.cautions && d.cautions.length
    ? "\n⚠️ " + d.cautions.join(", ")
    : "\n✅ Clean setup";

  return `${emoji} ${rank}<b>${d.action} ${d.base}</b>  |  ${tf}  |  Grade ${d.grade}

<b>Entry zone:</b> <code>${fmt(zoneLo)}</code> — <code>${fmt(zoneHi)}</code>
<b>Stop:</b>  <code>${fmt(d.plan.stop)}</code>
${tp1Line}
${tp2Line}
${tp3Line}

<b>Size:</b> ${sizeText}${levText}
<b>R:R:</b> ${d.rr ? d.rr.rr.toFixed(1) : "–"}:1  |  <b>Conf:</b> ${d.confluence}/8
⏰ Valid until: ${expiryStr}${cautionText}

<i>Based on $${REF_ACCOUNT} account, ${(REF_RISK_PCT * 100).toFixed(0)}% risk. Not financial advice.</i>`;
}

function signalSnapshot(d) {
  return {
    base: d.base, action: d.action, side: d.side, grade: d.grade,
    score: Math.round(d.score), confluence: d.confluence,
    entry: d.plan?.entry, stop: d.plan?.stop,
    target: d.plan?.srTarget || d.plan?.t1,
    rr: d.rr?.rr, cautions: d.cautions || []
  };
}

function loadDailyState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function saveDailyState(signals) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    ts: Date.now(),
    signals: signals.map(signalSnapshot)
  }));
}

// ---------- signal log: track every signal and its outcome ----------
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch { return { signals: [] }; }
}
function saveLog(log) { fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }

function logSignal(d, tf) {
  const log = loadLog();
  const key = `${d.base}-${tf}-${d.action}`;
  const hasOpen = log.signals.some(s => s.key === key && s.status === "open");
  if (hasOpen) return;
  const zoneHalf = d.atr ? d.atr * 0.3 : d.plan.entry * 0.003;
  const expiryH = TF_EXPIRY_H[tf] || 48;
  log.signals.push({
    key, base: d.base, action: d.action, side: d.side, tf,
    grade: d.grade, confluence: d.confluence, rr: d.rr?.rr,
    entry: d.plan.entry, stop: d.plan.stop,
    entryLo: d.plan.entry - zoneHalf, entryHi: d.plan.entry + zoneHalf,
    tp1: d.rr?.tp1?.price || null,
    tp2: d.rr?.tp2?.price || null,
    tp3: d.rr?.tp3?.price || null,
    target: d.rr?.tp2?.price || d.plan.srTarget || d.plan.t1,
    cautions: d.cautions || [],
    timestamp: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiryH * 3600000).toISOString(),
    status: "open", tp1Hit: false, tp2Hit: false, tp3Hit: false,
    exitPrice: null, exitTime: null, pnlPct: null
  });
  saveLog(log);
}

async function checkOutcomes() {
  const log = loadLog();
  const open = log.signals.filter(s => s.status === "open");
  if (!open.length) return { closed: [], tpNotifications: [] };

  const results = [];
  const tpNotifications = [];
  for (const sig of open) {
    const age = (Date.now() - new Date(sig.timestamp).getTime()) / 3600000;
    const expired = sig.expiresAt && Date.now() >= new Date(sig.expiresAt).getTime();

    const kl = await fetchKlines(sig.base + "USDT", "1h", Math.min(Math.ceil(age) + 1, 500));
    if (!kl || !kl.length) continue;

    const since = new Date(sig.timestamp).getTime();
    const candles = kl.filter(k => k[0] >= since);

    let hit = null;
    for (const k of candles) {
      const high = +k[2], low = +k[3];

      // Check stop first (conservative: assume stop hit before target in same candle)
      if (sig.side === "long" && low <= sig.stop) { hit = { status: "loss", price: sig.stop }; break; }
      if (sig.side === "short" && high >= sig.stop) { hit = { status: "loss", price: sig.stop }; break; }

      // Check TP hits in order
      if (sig.tp1 && !sig.tp1Hit) {
        if ((sig.side === "long" && high >= sig.tp1) || (sig.side === "short" && low <= sig.tp1)) {
          sig.tp1Hit = true;
          sig.stop = sig.entry;
          tpNotifications.push(`\u{1F3AF} <b>TP1 HIT: ${sig.action} ${sig.base}</b> (${sig.tf})\nTP1: <code>${fmt(sig.tp1)}</code> reached — stop moved to breakeven\n<i>60% closed, holding 40% for TP2/TP3</i>`);
        }
      }
      if (sig.tp2 && !sig.tp2Hit) {
        if ((sig.side === "long" && high >= sig.tp2) || (sig.side === "short" && low <= sig.tp2)) {
          sig.tp2Hit = true;
          tpNotifications.push(`\u{1F3AF}\u{1F3AF} <b>TP2 HIT: ${sig.action} ${sig.base}</b> (${sig.tf})\nTP2: <code>${fmt(sig.tp2)}</code> reached\n<i>90% closed, holding 10% for TP3</i>`);
        }
      }
      if (sig.tp3 && !sig.tp3Hit) {
        if ((sig.side === "long" && high >= sig.tp3) || (sig.side === "short" && low <= sig.tp3)) {
          sig.tp3Hit = true;
          hit = { status: "win", price: sig.tp3 };
          break;
        }
      }
    }

    // Expiry: close at current price if time ran out
    if (!hit && expired) {
      const lastPrice = +kl[kl.length - 1][4];
      const pnl = sig.side === "long" ? (lastPrice - sig.entry) / sig.entry : (sig.entry - lastPrice) / sig.entry;
      hit = { status: sig.tp1Hit ? "win" : (pnl > 0 ? "win" : "loss"), price: lastPrice, expired: true };
    }

    if (hit) {
      sig.status = hit.status;
      sig.exitPrice = hit.price;
      sig.exitTime = new Date().toISOString();
      // Weighted P&L across TPs: 60% at TP1 (if hit) + 30% at TP2 (if hit) + rest at exit
      let pnl = 0;
      if (sig.tp1Hit && sig.tp1) {
        const tp1pnl = sig.side === "long" ? (sig.tp1 - sig.entry) / sig.entry : (sig.entry - sig.tp1) / sig.entry;
        pnl += tp1pnl * 0.6;
        if (sig.tp2Hit && sig.tp2) {
          const tp2pnl = sig.side === "long" ? (sig.tp2 - sig.entry) / sig.entry : (sig.entry - sig.tp2) / sig.entry;
          pnl += tp2pnl * 0.3;
          const exitPnl = sig.side === "long" ? (hit.price - sig.entry) / sig.entry : (sig.entry - hit.price) / sig.entry;
          pnl += exitPnl * 0.1;
        } else {
          const exitPnl = sig.side === "long" ? (hit.price - sig.entry) / sig.entry : (sig.entry - hit.price) / sig.entry;
          pnl += exitPnl * 0.4;
        }
      } else {
        pnl = sig.side === "long" ? (hit.price - sig.entry) / sig.entry : (sig.entry - hit.price) / sig.entry;
      }
      sig.pnlPct = pnl * 100;
      sig.expired = hit.expired || false;
      results.push(sig);
    }
  }

  if (results.length || tpNotifications.length) saveLog(log);
  return { closed: results, tpNotifications };
}

function formatOutcome(sig) {
  const isWin = sig.status === "win";
  const emoji = isWin ? "✅" : "❌";
  const label = isWin ? "WIN" : "LOSS";
  const pnl = sig.pnlPct >= 0 ? `+${sig.pnlPct.toFixed(2)}%` : `${sig.pnlPct.toFixed(2)}%`;
  const tpSummary = [
    sig.tp1Hit ? "\u{1F3AF} TP1" : null,
    sig.tp2Hit ? "\u{1F3AF} TP2" : null,
    sig.tp3Hit ? "\u{1F3AF} TP3" : null
  ].filter(Boolean).join("  ");
  const expTag = sig.expired ? " (expired)" : "";
  return `${emoji} <b>${label}: ${sig.action} ${sig.base}</b> (${sig.tf})${expTag}\nEntry: <code>${fmt(sig.entry)}</code> → Exit: <code>${fmt(sig.exitPrice)}</code>\n${tpSummary ? tpSummary + "\n" : ""}P&amp;L: <b>${pnl}</b>`;
}

function buildScorecard() {
  const log = loadLog();
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const closed = log.signals.filter(s => s.status !== "open" && s.exitTime && new Date(s.exitTime).getTime() >= weekAgo);
  const allClosed = log.signals.filter(s => s.status !== "open");
  const openCount = log.signals.filter(s => s.status === "open").length;

  if (allClosed.length === 0) return null;

  const weekWins = closed.filter(s => s.status === "win");
  const weekLosses = closed.filter(s => s.status === "loss");
  const weekWinRate = closed.length ? (weekWins.length / closed.length * 100).toFixed(1) : "0";
  const weekPnl = closed.reduce((sum, s) => sum + (s.pnlPct || 0), 0);
  const avgPnl = closed.length ? (weekPnl / closed.length).toFixed(2) : "0";

  const allWins = allClosed.filter(s => s.status === "win");
  const allWinRate = allClosed.length ? (allWins.length / allClosed.length * 100).toFixed(1) : "0";
  const totalPnl = allClosed.reduce((sum, s) => sum + (s.pnlPct || 0), 0);
  const grossWin = allClosed.filter(s => s.pnlPct > 0).reduce((s, x) => s + x.pnlPct, 0);
  const grossLoss = Math.abs(allClosed.filter(s => s.pnlPct < 0).reduce((s, x) => s + x.pnlPct, 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : grossWin > 0 ? "∞" : "N/A";

  const bestTrade = allClosed.length ? allClosed.reduce((a, b) => (a.pnlPct || 0) > (b.pnlPct || 0) ? a : b) : null;
  const worstTrade = allClosed.length ? allClosed.reduce((a, b) => (a.pnlPct || 0) < (b.pnlPct || 0) ? a : b) : null;

  let streak = 0, streakType = null;
  for (let i = allClosed.length - 1; i >= 0; i--) {
    const s = allClosed[i].status;
    if (streakType === null) { streakType = s; streak = 1; }
    else if (s === streakType) streak++;
    else break;
  }

  return `\u{1F4CA} <b>Weekly Scorecard</b>

<b>─── This Week ───</b>
Signals: ${closed.length}  |  ✅ ${weekWins.length}  |  ❌ ${weekLosses.length}
Win rate: <b>${weekWinRate}%</b>
Week P&amp;L: <b>${weekPnl >= 0 ? "+" : ""}${weekPnl.toFixed(2)}%</b>  (avg ${avgPnl}%/trade)

<b>─── All Time ───</b>
Total: ${allClosed.length} closed  |  ${openCount} open
Win rate: <b>${allWinRate}%</b>
Total P&amp;L: <b>${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}%</b>
Profit factor: <b>${pf}</b>
${bestTrade ? `Best: ${bestTrade.action} ${bestTrade.base} +${(bestTrade.pnlPct || 0).toFixed(2)}%` : ""}
${worstTrade ? `Worst: ${worstTrade.action} ${worstTrade.base} ${(worstTrade.pnlPct || 0).toFixed(2)}%` : ""}
Streak: ${streak} ${streakType === "win" ? "✅" : "❌"} in a row

<i>Verified by bot. Not financial advice.</i>`;
}

// ---------- core scan (shared by both modes) ----------
async function scanTimeframes(timeframes) {
  const all = await getJSON("/api/v3/ticker/24hr");
  const { list: candidates } = buildUniverse(all, CONFIG.minQuoteVolume, CONFIG.poolSize);
  const fundingMap = await fetchBulkFunding();

  console.log(`Scanning ${candidates.length} coins across ${timeframes.join(", ")}...`);

  const allAnalyzed = [];

  for (const tf of timeframes) {
    const htf = HTF_MAP[tf] || tf;
    const btcKl = await fetchKlines("BTCUSDT", tf);
    const btcCs = btcKl ? toCandles(btcKl) : null;
    const market = btcCs ? marketContext(btcCs) : null;

    const fetched = await mapLimit(candidates, 5, async t => ({
      symbol: t.symbol,
      kl: await fetchKlines(t.symbol, tf),
      htfKl: await fetchKlines(t.symbol, htf, CONFIG.htfLimit)
    }));

    const analyzed = [];
    for (const f of fetched) {
      if (!f.kl || f.kl.length < 60) continue;
      const cs = toCandles(f.kl);
      if (cs.length < 55) continue;
      const htfCs = f.htfKl ? toCandles(f.htfKl) : null;
      const base = f.symbol.slice(0, -4);
      const res = analyze(cs, trendDir(htfCs), market, tf, fundingMap[f.symbol] || null);
      res.base = base;
      analyzed.push(res);
    }

    const signaled = analyzed.filter(d => d.side !== "none");
    if (signaled.length) {
      const lsResults = await mapLimit(signaled, 4, async d => ({
        base: d.base, ratio: await fetchLongShortRatio(d.base + "USDT")
      }));
      lsResults.forEach(({ base, ratio }) => {
        const d = analyzed.find(x => x.base === base);
        if (ratio && d) refinePositioning(d, ratio);
      });
    }

    const edge = { long: { gw: 0, gl: 0 }, short: { gw: 0, gl: 0 } };
    analyzed.forEach(d => {
      if (d.side !== "long" && d.side !== "short") return;
      const e = edge[d.side];
      e.gw += d.bt.grossWin || 0; e.gl += d.bt.grossLoss || 0;
    });
    const pf = e => e.gl > 0 ? e.gw / e.gl : (e.gw > 0 ? Infinity : NaN);
    const edgeData = { long: { pf: pf(edge.long) }, short: { pf: pf(edge.short) } };

    for (const d of analyzed) {
      const act = computeAction(d, edgeData);
      d.action = act.action;
      d.skipReason = act.reason;
      d.cautions = act.cautions;
      d.tf = tf;
      allAnalyzed.push(d);
    }
  }

  return allAnalyzed;
}

// ---------- DAILY MODE: morning briefing at 06:00 ----------
async function runDaily() {
  console.log("MODE: DAILY BRIEFING (1d timeframe, top 5)");

  const analyzed = await scanTimeframes(["1d"]);

  // Top 5 = actionable signals sorted by fewest cautions then best R:R
  const actionable = analyzed
    .filter(d => d.action !== "WAIT")
    .sort((a, b) => {
      const ac = (a.cautions || []).length, bc = (b.cautions || []).length;
      if (ac !== bc) return ac - bc;
      return (b.rr ? b.rr.rr : 0) - (a.rr ? a.rr.rr : 0);
    })
    .slice(0, 5);

  if (actionable.length === 0) {
    await sendTelegram(`\u{1F305} <b>Daily Briefing</b> — ${new Date().toISOString().slice(0, 10)}\n\nNo actionable signals on the daily timeframe today.\nAll gates require: grade A/B, R:R ≥ 1.0.\n\n<i>Will notify if strong setups appear during the day.</i>`);
    saveDailyState([]);
    return;
  }

  await sendTelegram(`\u{1F305} <b>Daily Briefing</b> — ${new Date().toISOString().slice(0, 10)}\n\nTop ${actionable.length} signal${actionable.length > 1 ? "s" : ""} on the <b>1D</b> timeframe:`);
  await sleep(500);

  for (let i = 0; i < actionable.length; i++) {
    await sendTelegram(formatSignal(actionable[i], "1d", i));
    await sleep(500);
  }

  await sendTelegram(`\u{1F4CB} <i>Updates to these signals will be sent during the day.\nFull dashboard:</i> https://xtzaferis.github.io/daily-trading/\n\n<i>Not financial advice. DYOR.</i>`);

  // Log signals and execute trades for clean BUY signals
  for (const d of actionable) {
    logSignal(d, "1d");
    if (trader.enabled && d.action === "BUY" && (!d.cautions || d.cautions.length === 0)) {
      const result = await trader.executeSignal({
        base: d.base, action: d.action, tf: "1d",
        entry: d.plan.entry, stop: d.plan.stop,
        tp1: d.rr?.tp1?.price, tp2: d.rr?.tp2?.price, tp3: d.rr?.tp3?.price,
        key: `${d.base}-1d-${d.action}`,
      });
      if (result.executed) {
        await sendTelegram(`💰 <b>TRADE OPENED:</b> ${result.summary}\n<i>${trader.testnet ? "⚠️ TESTNET" : "🔴 LIVE"}</i>`);
      } else {
        console.log(`[TRADE] Skipped ${d.base}: ${result.reason}`);
      }
    }
  }

  saveDailyState(actionable);
  console.log(`Sent ${actionable.length} daily signals, state saved.`);

  // Monday morning: include weekly scorecard
  if (new Date().getUTCDay() === 1) {
    const card = buildScorecard();
    if (card) { await sleep(500); await sendTelegram(card); console.log("Sent weekly scorecard."); }
  }
}

// ---------- HOURLY MODE: clean signals + daily updates ----------
async function runHourly() {
  console.log("MODE: HOURLY (1h/4h clean signals + daily updates)");

  const analyzed = await scanTimeframes(["1h", "4h"]);

  // 1) Send clean strong signals (same strict filter as before)
  let clean = analyzed
    .filter(d => d.action !== "WAIT" && (!d.cautions || d.cautions.length === 0) && d.rr && d.rr.rr >= 1.5)
    .sort((a, b) => (b.rr ? b.rr.rr : 0) - (a.rr ? a.rr.rr : 0));

  // Conflict filter: if same coin has BUY on 1h and SELL on 4h, keep higher TF only
  const TF_RANK = { "5m": 0, "15m": 1, "1h": 2, "4h": 3, "1d": 4, "1w": 5 };
  const byBase = {};
  for (const sig of clean) {
    if (!byBase[sig.base]) byBase[sig.base] = [];
    byBase[sig.base].push(sig);
  }
  const filtered = [];
  for (const [base, sigs] of Object.entries(byBase)) {
    const actions = new Set(sigs.map(s => s.action));
    if (actions.size > 1) {
      // Conflict: keep highest timeframe signal only
      sigs.sort((a, b) => (TF_RANK[b.tf] || 0) - (TF_RANK[a.tf] || 0));
      filtered.push(sigs[0]);
      console.log(`Conflict on ${base}: ${sigs.map(s => s.action + " " + s.tf).join(" vs ")} — kept ${sigs[0].tf}`);
    } else {
      // No conflict: keep highest TF to avoid duplicate
      sigs.sort((a, b) => (TF_RANK[b.tf] || 0) - (TF_RANK[a.tf] || 0));
      filtered.push(sigs[0]);
    }
  }
  clean = filtered.slice(0, 5);

  // Also check against open daily signals for cross-TF conflicts
  const log = loadLog();
  const openDaily = log.signals.filter(s => s.status === "open" && s.tf === "1d");
  clean = clean.filter(sig => {
    const conflict = openDaily.find(d => d.base === sig.base && d.action !== sig.action);
    if (conflict) {
      console.log(`Skipped ${sig.action} ${sig.base} ${sig.tf} — conflicts with open ${conflict.action} on 1d`);
      return false;
    }
    return true;
  });

  for (const sig of clean) {
    await sendTelegram(formatSignal(sig, sig.tf));
    logSignal(sig, sig.tf);
    if (trader.enabled && sig.action === "BUY") {
      const result = await trader.executeSignal({
        base: sig.base, action: sig.action, tf: sig.tf,
        entry: sig.plan.entry, stop: sig.plan.stop,
        tp1: sig.rr?.tp1?.price, tp2: sig.rr?.tp2?.price, tp3: sig.rr?.tp3?.price,
        key: `${sig.base}-${sig.tf}-${sig.action}`,
      });
      if (result.executed) {
        await sendTelegram(`💰 <b>TRADE OPENED:</b> ${result.summary}\n<i>${trader.testnet ? "⚠️ TESTNET" : "🔴 LIVE"}</i>`);
      } else {
        console.log(`[TRADE] Skipped ${sig.base}: ${result.reason}`);
      }
    }
    await sleep(500);
  }
  if (clean.length) console.log(`Sent ${clean.length} clean signal(s)`);

  // Manage live trades (check TP/stop fills on Binance)
  if (trader.enabled) {
    console.log("Checking live trade positions...");
    const tradeNotifs = await trader.managePositions();
    for (const n of tradeNotifs) {
      const emoji = n.type.includes("tp") ? "🎯" : "🛑";
      const label = n.type.replace("_", " ").toUpperCase();
      const pnlStr = n.pos.realizedPnl >= 0 ? `+$${n.pos.realizedPnl.toFixed(2)}` : `-$${Math.abs(n.pos.realizedPnl).toFixed(2)}`;
      await sendTelegram(`${emoji} <b>${label}: ${n.pos.base}</b>\nRealized P&L: <b>${pnlStr}</b>\n<i>${trader.testnet ? "TESTNET" : "LIVE"}</i>`);
      await sleep(500);
    }
    if (tradeNotifs.length) console.log(`${tradeNotifs.length} trade event(s)`);
  }

  // Check outcomes for all open signals
  console.log("Checking open signal outcomes...");
  const { closed, tpNotifications } = await checkOutcomes();
  for (const msg of tpNotifications) {
    await sendTelegram(msg);
    await sleep(500);
  }
  for (const sig of closed) {
    await sendTelegram(formatOutcome(sig));
    await sleep(500);
  }
  if (tpNotifications.length) console.log(`${tpNotifications.length} TP hit(s)`);
  if (closed.length) console.log(`${closed.length} signal(s) closed`);

  // 2) Check for updates to the morning's daily signals
  const state = loadDailyState();
  if (!state || !state.signals || state.signals.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);
  if (state.date !== today) {
    console.log("Daily state is from a previous day, skipping update check.");
    return;
  }

  console.log(`Checking ${state.signals.length} daily signal(s) for updates...`);
  const dailyCheck = await scanTimeframes(["1d"]);
  const updates = [];

  for (const saved of state.signals) {
    const current = dailyCheck.find(d => d.base === saved.base);
    if (!current) continue;

    const act = current.action || "WAIT";
    const nowScore = Math.round(current.score);

    // Signal invalidated: was BUY/SELL, now WAIT
    if (act === "WAIT" && saved.action !== "WAIT") {
      updates.push(`\u{1F6A8} <b>INVALIDATED:</b> <b>${saved.base}</b> was ${saved.action} → now WAIT\n<i>Reason: ${current.skipReason || "gates no longer pass"}</i>`);
      saved.action = "WAIT";
      continue;
    }

    // Direction flipped: BUY -> SELL or vice versa
    if (act !== "WAIT" && act !== saved.action) {
      updates.push(`\u{1F504} <b>FLIPPED:</b> <b>${saved.base}</b> was ${saved.action} → now ${act}\n<i>Score shifted from ${saved.score} to ${nowScore}</i>`);
      saved.action = act;
      saved.score = nowScore;
      continue;
    }

    // Grade changed
    if (current.grade !== saved.grade) {
      const better = current.grade < saved.grade;
      updates.push(`${better ? "⬆️" : "⬇️"} <b>GRADE CHANGE:</b> <b>${saved.base}</b> (${saved.action}) ${saved.grade} → ${current.grade}`);
      saved.grade = current.grade;
    }

    // Score moved significantly (> 15 points)
    if (Math.abs(nowScore - saved.score) > 15 && !updates.find(u => u.includes(saved.base))) {
      const dir = nowScore > saved.score ? "strengthened" : "weakened";
      updates.push(`\u{1F4CA} <b>UPDATE:</b> <b>${saved.base}</b> (${saved.action}) ${dir} — score ${saved.score} → ${nowScore}`);
      saved.score = nowScore;
    }
  }

  if (updates.length) {
    await sendTelegram(`\u{1F514} <b>Daily Signal Updates</b>\n\n` + updates.join("\n\n"));
    saveDailyState(state.signals.filter(s => s.action !== "WAIT").map(s => {
      const cur = dailyCheck.find(d => d.base === s.base);
      return cur ? signalSnapshot(cur) : s;
    }));
    console.log(`Sent ${updates.length} update(s)`);
  } else {
    console.log("No changes to daily signals.");
  }
}

// ---------- export track record data for the public page ----------
function exportTrackRecord() {
  const log = loadLog();
  const allClosed = log.signals.filter(s => s.status !== "open");
  const openSigs = log.signals.filter(s => s.status === "open");
  const wins = allClosed.filter(s => s.status === "win");
  const totalPnl = allClosed.reduce((sum, s) => sum + (s.pnlPct || 0), 0);
  const grossWin = allClosed.filter(s => s.pnlPct > 0).reduce((s, x) => s + x.pnlPct, 0);
  const grossLoss = Math.abs(allClosed.filter(s => s.pnlPct < 0).reduce((s, x) => s + x.pnlPct, 0));

  const data = {
    updated: new Date().toISOString(),
    stats: {
      total: allClosed.length,
      open: openSigs.length,
      wins: wins.length,
      winRate: allClosed.length ? (wins.length / allClosed.length * 100) : 0,
      totalPnl,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0),
      avgPnl: allClosed.length ? totalPnl / allClosed.length : 0
    },
    signals: log.signals.map(s => ({
      date: s.timestamp, base: s.base, action: s.action, tf: s.tf,
      grade: s.grade, confluence: s.confluence,
      entry: s.entry, stop: s.stop,
      tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
      entryLo: s.entryLo, entryHi: s.entryHi,
      status: s.status, exitPrice: s.exitPrice, exitTime: s.exitTime,
      pnlPct: s.pnlPct, tp1Hit: s.tp1Hit, tp2Hit: s.tp2Hit, tp3Hit: s.tp3Hit,
      expired: s.expired, cautions: s.cautions
    }))
  };

  const outPath = path.join(__dirname, "..", "track-record-data.json");
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log("Track record data exported.");
}

// ---------- run ----------
const MODE = process.env.MODE || "auto";
const isDaily = MODE === "daily" || (MODE === "auto" && new Date().getUTCHours() === 6);

(isDaily ? runDaily() : runHourly()).then(() => {
  exportTrackRecord();
  console.log("Done.");
  process.exit(0);
}).catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
