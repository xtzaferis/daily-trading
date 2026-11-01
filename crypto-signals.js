// ======================================================================
// Crypto Signals — scanner + technical scoring engine (v2)
// Scans a dynamic universe of liquid Binance USDT pairs every refresh,
// scores each one with closed-candle technical rules, ranks the top
// opportunities, and overlays a confidence grade (A/B/C) based on how
// many independent dimensions confirm the signal.
// Not financial advice.
// ======================================================================

// ---------- configuration ----------
const CONFIG = {
  poolSize: 40,
  minQuoteVolume: 5_000_000,
  candlesLimit: 500,
  htfLimit: 150,
  topN: 10
};

const DEFAULT_TF = "1d";
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

// VWAP — Volume Weighted Average Price. Resets at UTC midnight for intraday timeframes.
// THE institutional reference: price above VWAP = buyers in control, below = sellers.
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
    cumTP += tp * cs[i].v;
    cumVol += cs[i].v;
    out[i] = cumVol > 0 ? cumTP / cumVol : tp;
  }
  return out;
}

// Fractal pivot S/R — find swing highs/lows and cluster nearby levels.
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
    if (m) { m.strength++; m.price = (m.price + l.price) / 2; }
    else merged.push({ ...l });
  }
  return merged.sort((a, b) => b.strength - a.strength);
}

// Market structure: HH/HL = uptrend, LH/LL = downtrend.
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
// Score in [-100,100]. Positive = bullish. Returns score + confluence count + confidence grade.
function scoreAt(I, i) {
  if ([I.e50[i], I.m.sig[i], I.a[i], I.vm[i], I.r[i], I.bb.up[i]].some(isNaN))
    return { score: 0, why: ["Not enough data"], confluence: 0, grade: "C" };
  let s = 0; const why = [];
  const add = (n, t) => { s += n; why.push((n >= 0 ? "+" : "") + Math.round(n) + "  " + t); };
  const c = I.c[i];

  const adxVal = I.adx[i];
  const trendDamp = isNaN(adxVal) ? 1 : adxVal < 18 ? 0.5 : adxVal > 25 ? 1.15 : 1;
  const trendNote = isNaN(adxVal) ? "" : adxVal < 18 ? ` [ADX ${adxVal.toFixed(0)}: choppy, discounted]` : adxVal > 25 ? ` [ADX ${adxVal.toFixed(0)}: trending, amplified]` : "";

  // --- Trend dimension ---
  const trendBull = I.e20[i] > I.e50[i];
  add((trendBull ? 20 : -20) * trendDamp, (trendBull ? "EMA20 above EMA50 (uptrend)" : "EMA20 below EMA50 (downtrend)") + trendNote);
  add((c > I.e50[i] ? 10 : -10) * trendDamp, c > I.e50[i] ? "Price above EMA50" : "Price below EMA50");
  if (!isNaN(I.e200[i])) add(c > I.e200[i] ? 8 : -8, c > I.e200[i] ? "Above EMA200 (long-term uptrend)" : "Below EMA200 (long-term downtrend)");

  // --- Momentum dimension ---
  const r = I.r[i];
  if (r < 30) add(15, "RSI " + r.toFixed(0) + " oversold (bounce potential)");
  else if (r > 70) add(-15, "RSI " + r.toFixed(0) + " overbought (pullback risk)");
  else add((r - 50) / 50 * 10, "RSI " + r.toFixed(0) + " momentum");
  const h = I.m.hist[i], hp = I.m.hist[i - 1];
  add((h > 0 ? 15 : -15) * trendDamp, h > 0 ? "MACD histogram positive" : "MACD histogram negative");
  if (!isNaN(hp)) {
    add(h > hp ? 5 : -5, h > hp ? "MACD momentum rising" : "MACD momentum falling");
    if (hp <= 0 && h > 0) add(10, "Fresh MACD bullish cross");
    if (hp >= 0 && h < 0) add(-10, "Fresh MACD bearish cross");
  }

  // --- Volatility dimension ---
  const pb = (c - I.bb.lo[i]) / ((I.bb.up[i] - I.bb.lo[i]) || 1e-9);
  if (pb < 0.05) add(10, "Price at lower Bollinger band");
  else if (pb > 0.95) add(-10, "Price at upper Bollinger band");

  // --- Volume dimension ---
  const vr = I.cs[i].v / I.vm[i];
  if (vr > 1.5) { const up = I.cs[i].c >= I.cs[i].o; add(up ? 10 : -10, "Volume " + vr.toFixed(1) + "x avg on " + (up ? "green" : "red") + " candle"); }

  // --- Orthogonal confirmers (validated to lift backtested PF) ---
  if (!isNaN(I.diPlus[i]) && !isNaN(I.diMinus[i]))
    add(I.diPlus[i] > I.diMinus[i] ? 6 : -6, I.diPlus[i] > I.diMinus[i] ? "DI+ above DI- (buyers in control)" : "DI- above DI+ (sellers in control)");
  const sk = I.sr.k[i];
  if (!isNaN(sk)) {
    if (sk < 0.2) add(6, "StochRSI " + sk.toFixed(2) + " oversold (early bounce)");
    else if (sk > 0.8) add(-6, "StochRSI " + sk.toFixed(2) + " overbought (early pullback)");
  }
  if (!isNaN(I.obvE[i]))
    add(I.obv[i] > I.obvE[i] ? 6 : -6, I.obv[i] > I.obvE[i] ? "OBV rising (accumulation)" : "OBV falling (distribution)");

  if (!isNaN(I.bbw[i]) && i >= 50) {
    const w = I.bbw.slice(i - 49, i + 1).filter(x => !isNaN(x));
    if (w.length > 20) {
      const q = [...w].sort((a, b) => a - b)[Math.floor(w.length * 0.25)];
      if (I.bbw[i] <= q) {
        if (pb > 0.85) add(8, "Breakout from Bollinger squeeze (volatility expanding up)");
        else if (pb < 0.15) add(-8, "Breakdown from Bollinger squeeze (volatility expanding down)");
      }
    }
  }

  // --- VWAP dimension (most meaningful on intraday timeframes) ---
  if (!isNaN(I.vwap[i])) {
    const aboveVwap = c > I.vwap[i];
    add(aboveVwap ? 6 : -6, aboveVwap ? "Price above VWAP (institutional buyers)" : "Price below VWAP (institutional sellers)");
    const vwapDist = Math.abs(c - I.vwap[i]) / c;
    if (vwapDist < 0.003) add(0, "Near VWAP — potential reaction zone");
  }

  // --- Market structure dimension ---
  const ms = I.ms;
  if (ms.score >= 2) add(5, "Structure: higher highs + higher lows (uptrend intact)");
  else if (ms.score <= -2) add(-5, "Structure: lower highs + lower lows (downtrend intact)");
  else if (ms.score !== 0) add(ms.score > 0 ? 2 : -2, "Structure: mixed (ranging)");

  // --- Divergence (leading signal) ---
  const div = divergence(I.c, I.r, i);
  if (div.bearish) add(-12, "Bearish RSI divergence — new high not confirmed by momentum");
  if (div.bullish) add(12, "Bullish RSI divergence — new low not confirmed by momentum");

  // --- EMA9 pullback entry (momentum trigger) ---
  if (!isNaN(I.e9[i])) {
    const nearE9 = Math.abs(c - I.e9[i]) / c < 0.004;
    if (nearE9 && trendBull && r > 40 && r < 65) add(4, "Price at EMA9 pullback in uptrend (clean entry)");
    else if (nearE9 && !trendBull && r > 35 && r < 60) add(-4, "Price at EMA9 pullback in downtrend (clean short entry)");
  }

  s = Math.max(-100, Math.min(100, s));

  // --- Confluence counter: how many independent dimensions agree with the signal direction ---
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

const label = s => s >= 45 ? "SB" : s >= 20 ? "B" : s <= -45 ? "SS" : s <= -20 ? "S" : "N";
const labelText = { SB: "Strong Buy", B: "Buy", N: "Neutral", S: "Sell", SS: "Strong Sell" };
const gradeText = { A: "High", B: "Medium", C: "Low" };

// R:R calculation using S/R levels
function calcRR(price, stop, levels, side) {
  if (side === "long") {
    const risk = price - stop;
    if (risk <= 0) return { rr: NaN, target: null };
    const targets = levels.filter(l => l.type === "R" && l.price > price * 1.003).sort((a, b) => a.price - b.price);
    if (!targets.length) return { rr: NaN, target: null };
    return { rr: (targets[0].price - price) / risk, target: targets[0].price };
  } else {
    const risk = stop - price;
    if (risk <= 0) return { rr: NaN, target: null };
    const targets = levels.filter(l => l.type === "S" && l.price < price * 0.997).sort((a, b) => b.price - a.price);
    if (!targets.length) return { rr: NaN, target: null };
    return { rr: (price - targets[0].price) / risk, target: targets[0].price };
  }
}

// Backtest with trailing stop: after reaching 1R profit, move stop to breakeven.
function backtest(I, side = "long", enter = 25, fee = 0.001) {
  const n = I.c.length; let pos = null, trades = [], eq = 1;
  const sc = Array(n).fill(0); for (let i = 50; i < n; i++) sc[i] = scoreAt(I, i).score;
  for (let i = 51; i < n; i++) {
    if (pos) {
      const k = I.cs[i];
      // Trailing stop: after 1R reached, move stop to breakeven + fee
      if (!pos.trailed) {
        if (side === "long" && k.h >= pos.entry + pos.risk) {
          pos.stop = pos.entry * (1 + fee * 2);
          pos.trailed = true;
        } else if (side === "short" && k.l <= pos.entry - pos.risk) {
          pos.stop = pos.entry * (1 - fee * 2);
          pos.trailed = true;
        }
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
      const risk = 1.5 * I.a[i];
      pos = { entry: I.c[i], stop: I.c[i] - risk, risk, trailed: false };
    } else if (side === "short" && sc[i] <= -enter && sc[i - 1] > -enter) {
      const risk = 1.5 * I.a[i];
      pos = { entry: I.c[i], stop: I.c[i] + risk, risk, trailed: false };
    }
  }
  const wins = trades.filter(x => x > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0), grossLoss = -trades.filter(x => x <= 0).reduce((a, b) => a + b, 0);
  const bh = side === "long" ? I.c[n - 1] / I.c[50] - 1 : I.c[50] / I.c[n - 1] - 1;
  return {
    trades: trades.length,
    win: trades.length ? wins.length / trades.length : NaN,
    ret: eq - 1, bh,
    exp: trades.length ? trades.reduce((a, b) => a + b, 0) / trades.length : NaN,
    pf: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : NaN),
    grossWin, grossLoss
  };
}

function analyze(cs, htfTrend = 0, market = null, tf = "1d", funding = null) {
  const I = indicators(cs, tf), i = cs.length - 1, base = scoreAt(I, i), a = I.a[i], c = I.c[i];
  let score = base.score, why = [...base.why], counterTrend = false, aligned = false;
  let squeezeRisk = null;

  if (htfTrend !== 0 && score !== 0) {
    aligned = (score > 0 && htfTrend > 0) || (score < 0 && htfTrend < 0);
    if (aligned) { score += score > 0 ? 8 : -8; why.push("✓ Aligned with higher-timeframe trend"); }
    else { score *= 0.5; counterTrend = true; why.push("⚠ Against the higher-timeframe trend — conviction halved"); }
  }

  if (market && i >= 20) {
    const rs = (I.c[i] / I.c[i - 20] - 1) - market.ret20;
    const rsPoints = Math.max(-15, Math.min(15, rs * 100));
    if (Math.abs(rsPoints) >= 2) {
      score += rsPoints;
      why.push(`${rsPoints >= 0 ? "+" : ""}${Math.round(rsPoints)}  ${rsPoints >= 0 ? "Outperforming" : "Underperforming"} BTC by ${Math.abs(rs * 100).toFixed(1)}pp over 20 periods`);
    }
  }

  let marketAligned = null;
  if (market && market.trend !== 0 && score !== 0) {
    marketAligned = (score > 0 && market.trend > 0) || (score < 0 && market.trend < 0);
    if (marketAligned) { score *= 1.1; }
    else { score *= 0.7; why.push(`⚠ Against the overall market trend (BTC is ${market.trend > 0 ? "bullish" : "bearish"}) — discounted`); }
  }

  // --- Positioning overlay: funding rate as a crowding/squeeze proxy ---
  // Positive funding = longs pay shorts = crowded long → risky to go long, helps shorts.
  // Negative funding = shorts pay longs = crowded short → risky to go short (squeeze up risk).
  // This is the free-API version of what a liquidation heatmap shows.
  let positioningAligned = null;
  if (funding && score !== 0) {
    const fr = funding.funding;
    const extreme = Math.abs(fr) > 0.0002;
    const veryExtreme = Math.abs(fr) > 0.0006;
    const dir = score > 0 ? 1 : -1;

    if (extreme) {
      if (fr > 0 && dir > 0) {
        // Long signal + crowded longs = squeeze DOWN risk for your long
        const penalty = veryExtreme ? 0.6 : 0.8;
        score *= penalty;
        squeezeRisk = "long";
        positioningAligned = false;
        why.push(`⚠ Funding +${(fr * 100).toFixed(3)}% — crowded longs, squeeze-down risk (score ×${penalty})`);
      } else if (fr > 0 && dir < 0) {
        // Short signal + crowded longs = positioning HELPS your short
        score *= veryExtreme ? 1.15 : 1.08;
        positioningAligned = true;
        why.push(`✓ Funding +${(fr * 100).toFixed(3)}% — crowded longs fuel a move down`);
      } else if (fr < 0 && dir < 0) {
        // Short signal + crowded shorts = squeeze UP risk for your short
        const penalty = veryExtreme ? 0.6 : 0.8;
        score *= penalty;
        squeezeRisk = "short";
        positioningAligned = false;
        why.push(`⚠ Funding ${(fr * 100).toFixed(3)}% — crowded shorts, squeeze-up risk (score ×${penalty})`);
      } else if (fr < 0 && dir > 0) {
        // Long signal + crowded shorts = positioning HELPS your long
        score *= veryExtreme ? 1.15 : 1.08;
        positioningAligned = true;
        why.push(`✓ Funding ${(fr * 100).toFixed(3)}% — crowded shorts fuel a squeeze up`);
      }
    }
  }

  score = Math.max(-100, Math.min(100, score));

  // Confluence: 8 dimensions now (7 technical + 1 positioning)
  let confluence = base.confluence;
  if (aligned) confluence = Math.min(8, confluence + 1);
  if (positioningAligned === true) confluence = Math.min(8, confluence + 1);
  else if (positioningAligned === false) confluence = Math.max(0, confluence - 1);

  const lab = label(score);
  const side = score >= 20 ? "long" : score <= -20 ? "short" : "none";
  const stopDist = 1.5 * a;
  const plan = side === "long" ? { side: "LONG", entry: c, stop: c - stopDist, t1: c + stopDist, t2: c + 3 * a }
    : side === "short" ? { side: "SHORT", entry: c, stop: c + stopDist, t1: c - stopDist, t2: c - 3 * a }
    : null;

  // R:R: check multiple S/R levels, pick the one with best R:R >= 1.5 if available
  let rr = null;
  if (plan) {
    rr = calcRR(c, plan.stop, I.levels, side);
    if (rr.target) plan.srTarget = rr.target;
    // If nearest S/R gives poor R:R, try the next ones
    if (isNaN(rr.rr) || rr.rr < 1.5) {
      const farLevels = I.levels.filter(l => {
        if (side === "long") return l.type === "R" && l.price > (rr.target || c) * 1.003;
        return l.type === "S" && l.price < (rr.target || c) * 0.997;
      }).sort((a, b) => side === "long" ? a.price - b.price : b.price - a.price);
      if (farLevels.length) {
        const alt = calcRR(c, plan.stop, [farLevels[0]], side);
        if (!isNaN(alt.rr) && alt.rr > (rr.rr || 0)) { rr = alt; plan.srTarget = alt.target; }
      }
    }
    // Final fallback: use ATR target for R:R if S/R gives nothing useful
    if (isNaN(rr.rr) || rr.rr < 0.5) {
      const atrRR = stopDist > 0 ? stopDist / stopDist : 1;
      rr = { rr: atrRR, target: plan.t1 };
      plan.srTarget = plan.t1;
    }
  }

  const grade = confluence >= 6 ? "A" : confluence >= 4 ? "B" : "C";
  const bt = backtest(I, side === "short" ? "short" : "long");
  return {
    I, score, why, lab, side, plan, rsi: I.r[i], trend: I.e20[i] > I.e50[i] ? 1 : -1,
    adx: base.adx, counterTrend, htfAligned: aligned, marketAligned, atr: a, cs,
    bt, confluence, grade, rr, levels: I.levels, vwap: I.vwap[i], ms: I.ms,
    squeezeRisk, positioningAligned, funding
  };
}

// ---------- Binance data ----------
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
const FUTURES_BASES = ["https://fapi.binance.com"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getFrom(bases, path, retries = 2) {
  let err;
  for (const b of bases) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await fetch(b + path);
        if (r.ok) return await r.json();
        if ((r.status === 429 || r.status === 418) && attempt < retries) { await sleep(400 * (attempt + 1)); continue; }
        err = new Error(r.status); break;
      } catch (e) { err = e; if (attempt < retries) await sleep(300 * (attempt + 1)); }
    }
  }
  throw err;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return results;
}
const getJSON = path => getFrom(BASES, path);
const futuresJSON = path => getFrom(FUTURES_BASES, path);
async function fetchKlines(sym, tf, limit = CONFIG.candlesLimit) {
  try { return await getJSON(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`); }
  catch (e) { return null; }
}

async function fetchSentiment(symbol) {
  try {
    const [oi, prem, ls] = await Promise.all([
      futuresJSON(`/fapi/v1/openInterest?symbol=${symbol}`),
      futuresJSON(`/fapi/v1/premiumIndex?symbol=${symbol}`),
      futuresJSON(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`)
    ]);
    const row = Array.isArray(ls) ? ls[0] : null;
    return {
      oi: +oi.openInterest,
      markPrice: +prem.markPrice,
      funding: +prem.lastFundingRate,
      longPct: row ? +row.longAccount * 100 : null,
      shortPct: row ? +row.shortAccount * 100 : null
    };
  } catch (e) { return null; }
}

// Bulk fetch ALL funding rates in one call — no per-coin overhead.
// Returns a Map of symbol → { funding, markPrice }.
async function fetchBulkFunding() {
  try {
    const data = await futuresJSON("/fapi/v1/premiumIndex");
    const map = {};
    for (const p of data) map[p.symbol] = { funding: +p.lastFundingRate, markPrice: +p.markPrice };
    return map;
  } catch (e) { return {}; }
}

// Per-symbol long/short account ratio — no bulk endpoint, so only fetched for top coins.
async function fetchLongShortRatio(symbol) {
  try {
    const data = await futuresJSON(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`);
    const row = Array.isArray(data) && data[0];
    return row ? { longPct: +row.longAccount * 100, shortPct: +row.shortAccount * 100 } : null;
  } catch (e) { return null; }
}

// Refine positioning using L/S account ratio as a second check on funding.
// Funding rate alone can't detect when BOTH sides are heavily leveraged.
function refinePositioning(result, lsRatio) {
  if (!lsRatio || result.side === "none") return;
  result.lsRatio = lsRatio;

  const { longPct, shortPct } = lsRatio;
  const dir = result.side === "long" ? 1 : -1;

  const crowdedLongs = longPct > 56;
  const crowdedShorts = shortPct > 56;
  const balanced = !crowdedLongs && !crowdedShorts;

  if (result.positioningAligned === true && balanced) {
    result.positioningAligned = null;
    result.confluence = Math.max(0, result.confluence - 1);
    result.squeezeRisk = result.side;
    result.score = Math.max(-100, Math.min(100, result.score * 0.82));
    result.why.push(`⚠ L/S ${longPct.toFixed(0)}%L / ${shortPct.toFixed(0)}%S — both sides positioned, squeeze risk`);
  } else if (result.positioningAligned === true) {
    if ((dir < 0 && crowdedShorts) || (dir > 0 && crowdedLongs)) {
      result.positioningAligned = false;
      result.confluence = Math.max(0, result.confluence - 2);
      result.squeezeRisk = result.side;
      result.score = Math.max(-100, Math.min(100, result.score * 0.65));
      result.why.push(`⚠ ${dir > 0 ? longPct.toFixed(0) + "% long" : shortPct.toFixed(0) + "% short"} accounts — L/S contradicts funding, high squeeze risk`);
    }
  }

  if (result.positioningAligned === null && !balanced) {
    if ((dir > 0 && crowdedLongs) || (dir < 0 && crowdedShorts)) {
      result.positioningAligned = false;
      result.confluence = Math.max(0, result.confluence - 1);
      result.squeezeRisk = result.side;
      result.score = Math.max(-100, Math.min(100, result.score * 0.8));
      result.why.push(`⚠ ${dir > 0 ? longPct.toFixed(0) + "% long" : shortPct.toFixed(0) + "% short"} accounts — crowded on your side`);
    } else if ((dir > 0 && crowdedShorts) || (dir < 0 && crowdedLongs)) {
      result.positioningAligned = true;
      result.confluence = Math.min(8, result.confluence + 1);
      result.score = Math.max(-100, Math.min(100, result.score * 1.05));
      result.why.push(`✓ L/S ${longPct.toFixed(0)}%L / ${shortPct.toFixed(0)}%S — opposing side crowded`);
    }
  }

  if (result.squeezeRisk) {
    result.grade = result.confluence >= 4 ? "B" : "C";
  } else {
    result.grade = result.confluence >= 6 ? "A" : result.confluence >= 4 ? "B" : "C";
  }
}

// Compute a final BUY/SELL/WAIT action from all criteria.
// Only returns BUY or SELL when EVERY gate passes.
function computeAction(d, edgeData) {
  if (d.side === "none") return { action: "WAIT", reason: "No signal" };
  if (d.grade === "C") return { action: "WAIT", reason: "Low confidence" };
  if (!d.rr || isNaN(d.rr.rr) || d.rr.rr < 1.5) return { action: "WAIT", reason: "R:R < 1.5" };
  if (d.counterTrend) return { action: "WAIT", reason: "Counter-trend" };
  if (d.squeezeRisk) return { action: "WAIT", reason: "Squeeze risk" };
  const coinPf = d.bt && d.bt.pf;
  if (coinPf !== undefined && isFinite(coinPf) && coinPf < 1.0) return { action: "WAIT", reason: "Backtest losing" };
  if (edgeData) {
    const pf = edgeData[d.side === "long" ? "long" : "short"];
    if (pf && pf.pf < 1.0) return { action: "WAIT", reason: "PF < 1.0" };
  }
  if (d.marketAligned === false) return { action: "WAIT", reason: "Against market" };
  return { action: d.side === "long" ? "BUY" : "SELL", reason: null };
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

function buildUniverse(all, mode, minVol, poolSize) {
  const eligible = filterUniverse(all, minVol);
  const cat = {};
  if (mode !== "curated") {
    const list = eligible.slice(0, poolSize);
    list.forEach(t => cat[t.symbol] = "major");
    return { list, cat };
  }
  const list = [], seen = new Set();
  const add = (t, c) => { if (t && !seen.has(t.symbol)) { seen.add(t.symbol); list.push(t); cat[t.symbol] = c; } };
  eligible.slice(0, 20).forEach(t => add(t, "major"));
  eligible.filter(t => MEME_BASES.has(t.symbol.slice(0, -4))).slice(0, 10).forEach(t => add(t, "meme"));
  eligible.slice().sort((a, b) => +b.priceChangePercent - +a.priceChangePercent)
    .slice(0, 5).forEach(t => add(t, "trend"));
  return { list, cat };
}

const fmt = p => p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toFixed(6);
const fmtUsd = n => n >= 1e9 ? "$" + (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + n.toFixed(0);
const parsePinned = str => (str || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const state = { data: {}, tick: {}, top: [], sel: null, prev: {}, feed: [], scanned: 0, lastUpdate: null, sentiment: {}, market: null, lookup: null, lookupActive: false, edge: null, cat: {} };
const activeDetailBase = () => state.lookupActive ? state.lookup?.base : state.sel;

function renderSentimentHtml(base, d) {
  if (!d) return `<div class="mute">No perpetual futures market for ${base} on Binance, or data unavailable right now.</div>`;
  const fundingPct = (d.funding * 100).toFixed(4), annual = (d.funding * 3 * 365 * 100).toFixed(1);
  const oiUsd = d.oi * d.markPrice, hasRatio = d.longPct != null;
  const skew = d.funding > 0.0003 ? "Longs are paying shorts — crowded long, vulnerable to a squeeze lower."
    : d.funding < -0.0003 ? "Shorts are paying longs — crowded short, vulnerable to a squeeze higher."
    : "Funding neutral — no strong one-sided crowding.";
  return `<div class="kv">
      <span>Open interest</span><span>${fmtUsd(oiUsd)}</span>
      <span>Funding rate (8h)</span><span class="${d.funding >= 0 ? "up" : "down"}">${fundingPct}% <span class="mute">(~${annual}%/yr)</span></span>
      ${hasRatio ? `<span>Long accounts</span><span class="up">${d.longPct.toFixed(1)}%</span><span>Short accounts</span><span class="down">${d.shortPct.toFixed(1)}%</span>` : ""}
    </div>
    ${hasRatio ? `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:4px 0"><div style="width:${d.longPct}%;background:var(--up)"></div><div style="width:${d.shortPct}%;background:var(--down)"></div></div>` : ""}
    <div class="mute" style="font-size:12px">${skew}</div>`;
}

async function runCoinLookup(base, tf) {
  const sym = base + "USDT";
  const htf = HTF_MAP[tf] || tf;
  const [kl, htfKl, btcKl, fundingMap, lsRatio] = await Promise.all([
    fetchKlines(sym, tf),
    fetchKlines(sym, htf, CONFIG.htfLimit),
    fetchKlines("BTCUSDT", tf),
    fetchBulkFunding(),
    fetchLongShortRatio(sym)
  ]);
  if (!kl || kl.length < 60) return { error: `"${sym}" not found on Binance, or not enough ${tf} history yet.` };
  const toCandles = raw => raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1);
  const cs = toCandles(kl);
  if (cs.length < 55) return { error: `Not enough ${tf} history for ${sym} yet.` };
  const htfCs = htfKl ? toCandles(htfKl) : null;
  const btcCs = btcKl ? toCandles(btcKl) : null;
  const res = analyze(cs, trendDir(htfCs), marketContext(btcCs), tf, fundingMap[sym] || null);
  refinePositioning(res, lsRatio);
  const act = computeAction(res, state.edge);
  res.action = act.action;
  res.skipReason = act.reason;
  return { ...res, base, tf };
}

async function loadSentiment(base) {
  const cached = state.sentiment[base];
  if (cached && Date.now() - cached.ts < 25000) { const el = $("sentiment"); if (el) el.innerHTML = cached.html; return; }
  const data = await fetchSentiment(base + "USDT");
  if (activeDetailBase() !== base) return;
  const html = renderSentimentHtml(base, data);
  state.sentiment[base] = { html, ts: Date.now() };
  const el = $("sentiment"); if (el) el.innerHTML = html;
}
const $ = id => document.getElementById(id);

// ---------- scan & rank ----------
async function load() {
  $("status").textContent = "Scanning market…";
  $("refresh").disabled = true;
  try {
    const tf = $("tf").value;
    const all = await getJSON("/api/v3/ticker/24hr");
    const minVol = +$("minVol").value || CONFIG.minQuoteVolume;
    const poolSize = Math.max(1, +$("poolSize").value || CONFIG.poolSize);
    const mode = $("universe") ? $("universe").value : "volume";
    const { list: candidates, cat } = buildUniverse(all, mode, minVol, poolSize);
    state.cat = cat;

    let pinnedNotFound = null;
    parsePinned($("pinned").value).forEach(base => {
      const sym = base + "USDT";
      if (!candidates.some(c => c.symbol === sym)) {
        const t = all.find(x => x.symbol === sym);
        if (t) { candidates.push(t); cat[sym] = cat[sym] || "watch"; }
        else pinnedNotFound = base;
      }
    });
    state.scanned = candidates.length;

    const htf = HTF_MAP[tf] || tf;
    const btcP = fetchKlines("BTCUSDT", tf);
    const fundingP = fetchBulkFunding();
    const fetched = await mapLimit(candidates, 6, async t => ({
      kl: await fetchKlines(t.symbol, tf),
      htf: await fetchKlines(t.symbol, htf, CONFIG.htfLimit)
    }));
    const klResults = fetched.map(f => f.kl), htfResults = fetched.map(f => f.htf);
    const [btcKl, fundingMap] = await Promise.all([btcP, fundingP]);
    const btcCs = btcKl ? btcKl.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1) : null;
    if (btcCs) state.market = marketContext(btcCs);

    const analyzed = [];
    candidates.forEach((t, idx) => {
      const kl = klResults[idx];
      if (!kl || kl.length < 60) return;
      const cs = kl.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1);
      if (cs.length < 55) return;
      const htfKl = htfResults[idx];
      const htfCs = htfKl ? htfKl.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1) : null;
      const base = t.symbol.slice(0, -4);
      const res = analyze(cs, trendDir(htfCs), state.market, tf, fundingMap[t.symbol] || null);
      const old = state.prev[base];
      if (old && old !== res.lab) {
        state.feed.unshift({ t: new Date(), s: base, from: old, to: res.lab });
        state.feed = state.feed.slice(0, 30);
        notify(base, old, res.lab);
      }
      state.prev[base] = res.lab;
      state.tick[base] = t;
      state.data[base] = { ...res, base };
      analyzed.push(state.data[base]);
    });

    if (analyzed.length < Math.min(3, candidates.length) && state.top.length) {
      $("status").textContent = "Showing last good scan · network throttled, retrying in 60s";
      $("refresh").disabled = false;
      render();
      scheduleCloseRefresh();
      return;
    }

    // Second pass: fetch L/S account ratio for coins with signals to refine positioning
    const signaled = analyzed.filter(d => d.side !== "none");
    if (signaled.length) {
      const lsResults = await mapLimit(signaled, 4, async d => ({
        base: d.base, ratio: await fetchLongShortRatio(d.base + "USDT")
      }));
      lsResults.forEach(({ base, ratio }) => {
        if (ratio && state.data[base]) refinePositioning(state.data[base], ratio);
      });
    }

    const edge = { long: { gw: 0, gl: 0, n: 0 }, short: { gw: 0, gl: 0, n: 0 } };
    analyzed.forEach(d => {
      if (d.side !== "long" && d.side !== "short") return;
      const e = edge[d.side];
      e.gw += d.bt.grossWin || 0; e.gl += d.bt.grossLoss || 0; e.n++;
    });
    const pf = e => e.gl > 0 ? e.gw / e.gl : (e.gw > 0 ? Infinity : NaN);
    state.edge = { long: { pf: pf(edge.long), n: edge.long.n }, short: { pf: pf(edge.short), n: edge.short.n } };

    analyzed.forEach(d => {
      const a = computeAction(d, state.edge);
      d.action = a.action;
      d.skipReason = a.reason;
    });

    const dir = $("dir").value;
    const ranked = analyzed
      .filter(d => dir === "both" ? true : d.side === dir)
      .sort((a, b) => {
        const aAct = a.action !== "WAIT" ? 0 : 1;
        const bAct = b.action !== "WAIT" ? 0 : 1;
        if (aAct !== bAct) return aAct - bAct;
        const gOrder = { A: 0, B: 1, C: 2 };
        const gDiff = (gOrder[a.grade] || 2) - (gOrder[b.grade] || 2);
        if (gDiff !== 0) return gDiff;
        return Math.abs(b.score) - Math.abs(a.score) || ((b.bt.win || 0) - (a.bt.win || 0));
      });

    const topN = Math.max(1, +$("topN").value || CONFIG.topN);
    state.top = ranked.slice(0, topN);

    if (!state.lookupActive && !state.data[state.sel]) state.sel = state.top[0]?.base || null;

    state.lastUpdate = new Date();
    $("status").textContent = "Updated " + state.lastUpdate.toLocaleTimeString() + " · scanned " + state.scanned + " pairs"
      + (pinnedNotFound ? ` · "${pinnedNotFound}USDT" not found on Binance` : "");
  } catch (e) {
    $("status").textContent = "Data error: " + e.message + " (Binance may be blocked on your network)";
  }
  $("refresh").disabled = false;
  render();
  scheduleCloseRefresh();
}

let closeTimer = null;
function msToNextClose(tf) { const span = TF_MS[tf] || TF_MS[DEFAULT_TF]; return span - (Date.now() % span); }
function scheduleCloseRefresh() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(load, msToNextClose($("tf").value) + 1500);
}
function updateCountdown() {
  const tf = $("tf").value, totalSec = Math.max(0, Math.floor(msToNextClose(tf) / 1000));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const t = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  $("countdown").textContent = `Next ${tf} candle closes in ${t}`;
}

function notify(s, from, to) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  if (to === "SB" || to === "SS" || from === "SB" || from === "SS")
    new Notification(s + ": " + labelText[to], { body: "Was " + labelText[from] + " · " + $("tf").value });
}

// ---------- rendering ----------
function spark(cs) {
  const v = cs.slice(-48).map(x => x.c), mn = Math.min(...v), mx = Math.max(...v);
  const pts = v.map((y, i) => (i / (v.length - 1) * 80).toFixed(1) + "," + (22 - (y - mn) / ((mx - mn) || 1) * 20).toFixed(1)).join(" ");
  const col = v[v.length - 1] >= v[0] ? "#2ea36a" : "#e5534b";
  return `<svg width="80" height="24"><polyline fill="none" stroke="${col}" stroke-width="1.5" points="${pts}"/></svg>`;
}

function render() {
  renderRegime();
  renderStats();
  const acct = +$("acct").value || 0, riskPct = (+$("risk").value || 0) / 100;
  const rows = state.top.map((d, idx) => {
    const t = state.tick[d.base];
    const c = state.cat[d.base + "USDT"];
    const catChip = c && c !== "major" ? `<span class="cat cat-${c}">${c === "trend" ? "trending" : c}</span>` : "";

    const isBuy = d.action === "BUY", isSell = d.action === "SELL";
    const actionHtml = isBuy ? '<span class="action-badge action-buy">BUY</span>'
      : isSell ? '<span class="action-badge action-sell">SELL</span>'
      : `<span class="action-badge action-wait">WAIT</span><span class="skip-reason">${d.skipReason || ""}</span>`;

    let entryHtml = "–", stopHtml = "–", targetHtml = "–", riskHtml = "–";
    if (d.plan && (isBuy || isSell)) {
      entryHtml = fmt(d.plan.entry);
      stopHtml = `<span class="down">${fmt(d.plan.stop)}</span>`;
      const tgt = d.plan.srTarget || d.plan.t1;
      targetHtml = `<span class="up">${fmt(tgt)}</span>`;
      const dist = Math.abs(d.plan.entry - d.plan.stop);
      const riskUsd = acct * riskPct;
      riskHtml = `${riskUsd.toFixed(0)}$`;
    }

    return `<tr data-s="${d.base}" class="${d.base === state.sel ? "sel" : ""}${isBuy || isSell ? " actionable" : ""}">
      <td data-label="Asset"><span class="rank">${idx + 1}</span> <b>${d.base}</b>${catChip}</td>
      <td data-label="Price">${fmt(+t.lastPrice)}</td>
      <td data-label="Action">${actionHtml}</td>
      <td data-label="Entry">${entryHtml}</td>
      <td data-label="Stop">${stopHtml}</td>
      <td data-label="Target">${targetHtml}</td>
      <td data-label="Risk">${riskHtml}</td>
    </tr>`;
  }).join("");
  $("rows").innerHTML = rows || `<tr><td colspan="7" class="mute">No pairs matched your filters. Lower min volume, widen the universe, or switch direction to "Both".</td></tr>`;
  document.querySelectorAll("#rows tr[data-s]").forEach(tr => tr.onclick = () => selectSymbol(tr.dataset.s, $("tf").value));
  renderDetail();
  renderFeed();
}

function renderRegime() {
  const el = $("regime"); if (!el) return;
  const m = state.market;
  if (!m) { el.className = "regime"; el.innerHTML = '<span class="mute">Market regime: BTC data unavailable.</span>'; return; }
  const chop = m.adx != null && m.adx < 18;
  const cls = chop ? "chop" : m.trend > 0 ? "bull" : "bear";
  const lbl = chop ? "Choppy / range-bound" : m.trend > 0 ? "Risk-on (BTC uptrend)" : "Risk-off (BTC downtrend)";
  const advice = chop ? "Low-conviction — expect whipsaws, size down or skip C-grade setups."
    : m.trend > 0 ? "Longs get conviction boost, shorts discounted — don't fight the tape."
    : "Shorts get conviction boost, longs discounted — don't fight the tape.";
  el.className = "regime " + cls;
  el.innerHTML = `<b>Market regime: ${lbl}</b>${m.adx != null ? ` · BTC ADX ${m.adx.toFixed(0)}` : ""} · BTC 20d return ${m.ret20 >= 0 ? "+" : ""}${(m.ret20 * 100).toFixed(1)}% <span class="mute">— ${advice}</span>`;
}

function renderStats() {
  const longs = state.top.filter(d => d.side === "long").length;
  const shorts = state.top.filter(d => d.side === "short").length;
  const actionable = state.top.filter(d => d.action === "BUY" || d.action === "SELL");
  const actionCount = actionable.length;
  const best = actionable[0] || state.top[0];
  const e = state.edge;
  const edgeTag = sd => {
    const s = e && e[sd];
    if (!s || !s.n || isNaN(s.pf)) return '<span class="mute" style="font-size:11px">no signals</span>';
    const pf = s.pf, cls = pf >= 1.5 ? "up" : pf >= 1 ? "" : "down";
    const word = pf >= 1.5 ? "strong edge" : pf >= 1 ? "thin edge" : "no edge — skip";
    return `<span class="${cls}" style="font-size:11px">PF ${isFinite(pf) ? pf.toFixed(2) : "∞"} · ${word}</span>`;
  };
  const tf = $("tf").value;
  const dir = $("dir") ? $("dir").value : "both";
  const weakLong = e && dir !== "short" && e.long.n && e.long.pf < 1;
  const weakShort = e && dir !== "long" && e.short.n && e.short.pf < 1;
  let note = "";
  if (weakLong || weakShort) {
    const which = weakLong && weakShort ? "Both long and short" : weakLong ? "Long" : "Short";
    note = `<div style="grid-column:1/-1" class="warn">⚠ ${which} signals on the ${tf} timeframe are currently backtesting below profitable (PF &lt; 1.0). Strongest edge: 4h (long) and 1d (short) — treat ${tf} signals with extra caution.</div>`;
  }
  $("stats").innerHTML = `
    <div class="stat"><span class="mute">Pairs scanned</span><b>${state.scanned || 0}</b></div>
    <div class="stat"><span class="mute">Long setups · ${tf}</span><b class="up">${longs}</b>${edgeTag("long")}</div>
    <div class="stat"><span class="mute">Short setups · ${tf}</span><b class="down">${shorts}</b>${edgeTag("short")}</div>
    <div class="stat"><span class="mute">Actionable trades</span><b class="${actionCount ? "up" : "mute"}">${actionCount}</b><span class="mute" style="font-size:11px">${actionCount ? "all gates passed — ready to trade" : "no trades pass all gates right now"}</span></div>
    <div class="stat"><span class="mute">Best opportunity</span><b>${best ? best.base + " " + best.action : "–"}</b>${best ? `<span class="grade grade-${best.grade.toLowerCase()}" style="font-size:12px">${best.grade}-grade · ${best.confluence}/8</span>` : ""}</div>
    ${note}`;
}

function renderFeed() {
  if (!state.feed.length) { $("feed").innerHTML = '<span class="mute">Nothing yet. Changes appear here while the page stays open.</span>'; return; }
  $("feed").innerHTML = state.feed.map(f => `<div><span class="mute">${f.t.toLocaleTimeString()}</span> <b>${f.s}</b> <span class="badge ${f.from}">${labelText[f.from]}</span> → <span class="badge ${f.to}">${labelText[f.to]}</span></div>`).join("");
}

const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d", "1w"];

async function selectSymbol(base, tf) {
  if (tf === $("tf").value && state.data[base]) {
    state.sel = base;
    state.lookupActive = false;
    render();
    return;
  }
  $("detail").innerHTML = `<h2>${base}/USDT · ${tf}</h2><div class="mute">Loading…</div>`;
  const result = await runCoinLookup(base, tf);
  if (result.error) { $("detail").innerHTML = `<h2>Detail</h2><div class="mute">${result.error}</div>`; return; }
  state.lookup = result;
  state.lookupActive = true;
  renderDetail();
}

function renderDetail() {
  const s = activeDetailBase(), d = state.lookupActive ? state.lookup : state.data[s];
  if (!d) { $("detail").innerHTML = '<h2>Detail</h2><div class="mute">No opportunity selected. Adjust filters, look up a coin, or wait for the next scan.</div>'; return; }
  const acct = +$("acct").value || 0, risk = (+$("risk").value || 0) / 100;

  // Action banner — clear BUY/SELL or WAIT with reason
  const isBuy = d.action === "BUY", isSell = d.action === "SELL";
  const actionBanner = isBuy
    ? `<div class="action-banner action-banner-buy"><span class="action-badge action-buy" style="font-size:18px;padding:8px 22px">BUY</span> <b>All gates passed.</b> ${d.confluence}/8 confirmers · R:R ${d.rr ? d.rr.rr.toFixed(1) : "–"}:1${d.lsRatio ? ` · L/S ${d.lsRatio.longPct.toFixed(0)}/${d.lsRatio.shortPct.toFixed(0)}` : ""}</div>`
    : isSell
    ? `<div class="action-banner action-banner-sell"><span class="action-badge action-sell" style="font-size:18px;padding:8px 22px">SELL</span> <b>All gates passed.</b> ${d.confluence}/8 confirmers · R:R ${d.rr ? d.rr.rr.toFixed(1) : "–"}:1${d.lsRatio ? ` · L/S ${d.lsRatio.longPct.toFixed(0)}/${d.lsRatio.shortPct.toFixed(0)}` : ""}</div>`
    : `<div class="action-banner action-banner-wait"><span class="action-badge action-wait" style="font-size:16px;padding:6px 16px">WAIT</span> <b>${d.skipReason || "No signal"}</b><br><span class="mute" style="font-size:12px">${d.side !== "none" ? `Signal: ${d.side.toUpperCase()} · ${d.grade}-grade · ${d.confluence}/8 · R:R ${d.rr && !isNaN(d.rr.rr) ? d.rr.rr.toFixed(1) + ":1" : "–"} — doesn't pass all gates` : "Score between −20 and +20. No directional signal."}</span></div>`;
  const confHtml = actionBanner;

  let planHtml = '<div class="mute" style="margin-top:8px">No trade: score is between −20 and +20. Waiting is a position.</div>';
  if (d.plan) {
    const p = d.plan, dist = Math.abs(p.entry - p.stop), riskUsd = acct * risk, qty = riskUsd / dist;
    const rrText = d.rr && !isNaN(d.rr.rr) ? d.rr.rr.toFixed(1) + ":1" : "–";
    const rrClass = d.rr && d.rr.rr >= 2 ? "up" : d.rr && d.rr.rr >= 1.5 ? "" : "down";
    const rrAdvice = d.rr && d.rr.rr >= 2 ? "Good R:R — trade has edge." : d.rr && d.rr.rr >= 1.5 ? "Acceptable R:R." : "Poor R:R — consider skipping.";
    const tip = `Trailing stop: after 1R reached, move stop to breakeven. ${p.side === "SHORT" ? "Funding fees apply on perpetuals." : ""}`;
    planHtml = `<div class="kv"><span>Setup</span><span><b class="${p.side === "LONG" ? "up" : "down"}">${p.side}</b></span>
      <span>Entry (last close)</span><span>${fmt(p.entry)}</span>
      <span>Stop (1.5×ATR)</span><span class="down">${fmt(p.stop)} (${(dist / p.entry * 100).toFixed(2)}%)</span>
      <span>Target 1 (1R)</span><span class="up">${fmt(p.t1)}</span>
      <span>Target 2 (2R)</span><span class="up">${fmt(p.t2)}</span>
      ${p.srTarget ? `<span>S/R target</span><span class="up">${fmt(p.srTarget)}</span>` : ""}
      <span>Risk:Reward</span><span class="${rrClass}">${rrText} <span class="mute" style="font-size:11px">${rrAdvice}</span></span>
      <span>Risk amount</span><span>${riskUsd.toFixed(0)} USDT</span>
      <span>Position size</span><span>${qty.toPrecision(4)} ${s} (~${(qty * p.entry).toFixed(0)} USDT)</span></div>
      <div class="mute" style="font-size:12px">${tip}</div>`;
  }
  const b = d.bt;
  const tfLabel = state.lookupActive ? state.lookup.tf : $("tf").value;
  const tfOptions = TIMEFRAMES.map(t => `<option value="${t}"${t === tfLabel ? " selected" : ""}>${t}</option>`).join("");

  // S/R levels display
  const price = d.I.c[d.I.c.length - 1];
  const nearRes = d.levels.filter(l => l.type === "R" && l.price > price).sort((a, b) => a.price - b.price).slice(0, 3);
  const nearSup = d.levels.filter(l => l.type === "S" && l.price < price).sort((a, b) => b.price - a.price).slice(0, 3);
  const srHtml = (nearRes.length || nearSup.length)
    ? `<div class="kv">${nearRes.map(l => `<span class="down">Resistance</span><span>${fmt(l.price)} <span class="mute">(${l.strength} touches)</span></span>`).join("")}${nearSup.map(l => `<span class="up">Support</span><span>${fmt(l.price)} <span class="mute">(${l.strength} touches)</span></span>`).join("")}</div>`
    : '<div class="mute">No clear S/R levels detected in this range.</div>';

  $("detail").innerHTML = `<h2>${s}/USDT <select id="detailTf" title="View at a different timeframe">${tfOptions}</select></h2>
    ${confHtml}
    <canvas id="ch"></canvas>
    ${planHtml}
    <h2 style="margin-top:14px">Key levels</h2>${srHtml}
    <h2 style="margin-top:14px">Why this score</h2><ul>${d.why.map(w => `<li>${w}</li>`).join("")}</ul>
    <h2 style="margin-top:14px">Backtest (${d.side === "short" ? "short" : "long"}-side, trailing stop)</h2>
    <div class="kv"><span>Trades</span><span>${b.trades}</span><span>Win rate</span><span>${b.trades ? (b.win * 100).toFixed(0) + "%" : "–"}</span>
    <span title="Avg % gained/lost per trade">Expectancy / trade</span><span class="${b.exp >= 0 ? "up" : "down"}">${b.trades ? (b.exp * 100).toFixed(2) + "%" : "–"}</span>
    <span title="Gross wins ÷ gross losses. Above 1.0 = profitable; pros want 1.5+">Profit factor</span><span class="${b.pf >= 1 ? "up" : "down"}">${b.trades ? (isFinite(b.pf) ? b.pf.toFixed(2) : "∞") : "–"}</span>
    <span>Strategy return</span><span class="${b.ret >= 0 ? "up" : "down"}">${(b.ret * 100).toFixed(1)}%</span>
    <span>Buy &amp; hold</span><span class="${b.bh >= 0 ? "up" : "down"}">${(b.bh * 100).toFixed(1)}%</span></div>
    <h2 style="margin-top:14px">Futures positioning <span class="mute hint">· squeeze/liquidation proxy</span></h2>
    <div id="sentiment" class="mute">Loading…</div>
    <div class="warn">Not financial advice. Backtest uses trailing stops but ignores HTF/BTC overlays and slippage/funding. Signals with C-grade confidence or poor R:R should generally be skipped.</div>`;
  $("detailTf").onchange = () => selectSymbol(s, $("detailTf").value);
  drawChart(d);
  loadSentiment(s);
}

function drawChart(d) {
  const cv = $("ch"), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.scale(dpr, dpr);
  const N = 90, off = d.cs.length - N, cs = d.cs.slice(-N);
  const all = cs.flatMap(k => [k.h, k.l]); let mx = Math.max(...all), mn = Math.min(...all);
  if (d.plan) { mx = Math.max(mx, d.plan.t2, d.plan.stop); mn = Math.min(mn, d.plan.t2, d.plan.stop); }
  const e200vals = cs.map((_, i) => d.I.e200[off + i]).filter(v => !isNaN(v));
  if (e200vals.length) {
    const range = mx - mn, e200min = Math.min(...e200vals), e200max = Math.max(...e200vals);
    if (e200max <= mx + range * 1.5 && e200min >= mn - range * 1.5) { mx = Math.max(mx, e200max); mn = Math.min(mn, e200min); }
  }

  const chartH = H * 0.78, volH = H * 0.18, volTop = chartH + H * 0.04;
  const y = v => 8 + (mx - v) / (mx - mn) * (chartH - 16), bw = W / N;

  // Volume bars
  const vols = cs.map(k => k.v);
  const maxVol = Math.max(...vols) || 1;
  cs.forEach((k, i) => {
    const x = i * bw, up = k.c >= k.o;
    const barH = (k.v / maxVol) * volH;
    g.fillStyle = up ? "rgba(46,163,106,0.25)" : "rgba(229,83,75,0.25)";
    g.fillRect(x + 1, volTop + volH - barH, bw - 2, barH);
  });

  // S/R levels
  const price = d.I.c[d.I.c.length - 1];
  const srNear = d.levels.filter(l => {
    const dist = Math.abs(l.price - price) / price;
    return dist < 0.08 && l.price >= mn && l.price <= mx;
  }).slice(0, 6);
  srNear.forEach(l => {
    const yv = y(l.price);
    g.strokeStyle = l.type === "R" ? "rgba(240,97,109,0.35)" : "rgba(38,194,129,0.35)";
    g.lineWidth = 1; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(0, yv); g.lineTo(W, yv); g.stroke(); g.setLineDash([]);
    g.fillStyle = l.type === "R" ? "rgba(240,97,109,0.5)" : "rgba(38,194,129,0.5)";
    g.font = "9px Inter, sans-serif";
    g.fillText((l.type === "R" ? "R" : "S") + " " + fmt(l.price), 3, yv - 3);
  });

  // VWAP line
  const vwapArr = d.I.vwap;
  if (vwapArr) {
    g.strokeStyle = "rgba(255,170,0,0.6)"; g.lineWidth = 1.2; g.setLineDash([5, 3]);
    g.beginPath(); let started = false;
    cs.forEach((_, i) => {
      const v = vwapArr[off + i]; if (isNaN(v)) return;
      const yv = y(v);
      if (yv >= 0 && yv <= chartH) { started ? g.lineTo(i * bw + bw / 2, yv) : g.moveTo(i * bw + bw / 2, yv); started = true; }
    });
    g.stroke(); g.setLineDash([]);
  }

  // Candlesticks
  cs.forEach((k, i) => {
    const x = i * bw + bw / 2, up = k.c >= k.o;
    g.strokeStyle = g.fillStyle = up ? "#2ea36a" : "#e5534b";
    g.beginPath(); g.moveTo(x, y(k.h)); g.lineTo(x, y(k.l)); g.stroke();
    g.fillRect(x - bw * 0.35, Math.min(y(k.o), y(k.c)), bw * 0.7, Math.max(1, Math.abs(y(k.o) - y(k.c))));
  });

  // EMA lines
  [[d.I.e9, "rgba(76,141,255,0.45)"], [d.I.e20, "#4c8dff"], [d.I.e50, "#d4a72c"], [d.I.e200, "#a371f7"]].forEach(([arr, col]) => {
    g.strokeStyle = col; g.lineWidth = arr === d.I.e9 ? 0.9 : 1.3; g.beginPath();
    cs.forEach((_, i) => { const v = arr[off + i]; if (isNaN(v)) return; const x = i * bw + bw / 2; const yv = y(v); if (yv >= 0 && yv <= chartH) { i ? g.lineTo(x, yv) : g.moveTo(x, yv); } });
    g.stroke();
  });

  // Trade plan levels
  if (d.plan) {
    [[d.plan.stop, "#e5534b"], [d.plan.t1, "#2ea36a"], [d.plan.t2, "#2ea36a"]].forEach(([v, col]) => {
      g.strokeStyle = col; g.setLineDash([4, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W, y(v)); g.stroke(); g.setLineDash([]);
    });
  }

  // Chart legend
  g.font = "10px Inter, sans-serif"; g.fillStyle = "rgba(255,255,255,0.45)";
  const legends = [["EMA9", "rgba(76,141,255,0.45)"], ["EMA20", "#4c8dff"], ["EMA50", "#d4a72c"], ["EMA200", "#a371f7"], ["VWAP", "rgba(255,170,0,0.6)"]];
  let lx = 5;
  legends.forEach(([name, col]) => {
    g.fillStyle = col; g.fillRect(lx, chartH + 2, 12, 2);
    g.fillStyle = "rgba(255,255,255,0.5)"; g.fillText(name, lx + 15, chartH + 6);
    lx += g.measureText(name).width + 25;
  });
}

// ---------- wiring ----------
function init() {
  ["tf", "universe", "poolSize", "minVol", "dir", "pinned", "topN"].forEach(id => $(id).onchange = load);
  $("refresh").onclick = load;
  $("acct").oninput = renderDetail;
  $("risk").oninput = renderDetail;
  $("alerts").onclick = async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    $("alerts").textContent = p === "granted" ? "Alerts on" : "Alerts blocked";
  };
  $("advToggle").onclick = () => {
    const open = document.querySelector(".toolbar").classList.toggle("adv-open");
    $("advToggle").setAttribute("aria-expanded", open);
    $("advToggle").textContent = open ? "Less ▲" : "More ▾";
  };
  const runLookup = async () => {
    const base = $("lookup").value.trim().toUpperCase().replace(/USDT$/, "").replace(/[^A-Z0-9]/g, "");
    if (!base) return;
    $("lookupBtn").disabled = true; $("lookupBtn").textContent = "Checking…";
    await selectSymbol(base, $("tf").value);
    $("lookupBtn").disabled = false; $("lookupBtn").textContent = "Check trend";
    $("lookup").value = "";
  };
  $("lookupBtn").onclick = runLookup;
  $("lookup").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); runLookup(); } });
  addEventListener("resize", renderDetail);
  updateCountdown();
  setInterval(updateCountdown, 1000);
  load();
  setInterval(load, 60000);
}
init();
