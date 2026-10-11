// ======================================================================
// Crypto Signals — scanner + technical scoring engine
// Scans a dynamic universe of liquid Binance USDT pairs every refresh,
// scores each one with the same closed-candle technical rule set, and
// ranks the top opportunities for both LONG and SHORT setups.
// Not financial advice.
// ======================================================================

// ---------- configuration ----------
const CONFIG = {
  poolSize: 40,            // how many of the most-liquid pairs to scan
  minQuoteVolume: 5_000_000, // minimum 24h quote volume (USDT) to be eligible
  candlesLimit: 500,
  htfLimit: 150,           // candles fetched for the higher-timeframe trend filter
  topN: 10
};

// Higher timeframe used to confirm/veto each signal's timeframe, so a bounce on a
// small timeframe that fights the bigger trend gets discounted instead of shown as clean.
const HTF_MAP = { "5m": "15m", "15m": "1h", "1h": "4h", "4h": "1d", "1d": "1w" };

// Candle span in ms, used to show when the current signal will next actually change.
const TF_MS = { "5m": 5 * 60000, "15m": 15 * 60000, "1h": 3600000, "4h": 4 * 3600000, "1d": 86400000 };

// Exclude stablecoin pairs and leveraged tokens — they don't trend like normal assets.
const STABLE_BASES = new Set([
  "USDC","FDUSD","TUSD","DAI","USDP","BUSD","EUR","GBP","TRY","BRL","AUD",
  "GYEN","USTC","UST","USDD","USDJ","PAX","EURI","XUSD","USD1","USDE",
  "PYUSD","USDS","FRAX","GUSD","LUSD","USDX","EURC","AEUR"
]);
const LEVERAGED_RE = /(UP|DOWN|BULL|BEAR)USDT$/;

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

// Wilder's ADX — measures trend STRENGTH (not direction). Low ADX = choppy/range-bound,
// where EMA/MACD trend-following signals whipsaw and should be trusted less.
function adx(cs, p = 14) {
  const n = cs.length, out = Array(n).fill(NaN);
  if (n <= p + 1) return out;
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
  const dx = trS.map((v, i) => isNaN(v) ? NaN : 100 * Math.abs(pdmS[i] - mdmS[i]) / (v || 1e-9));
  const firstValid = dx.findIndex(x => !isNaN(x));
  if (firstValid >= 0 && dx.length >= firstValid + p) {
    let s = 0; for (let i = firstValid; i < firstValid + p; i++) s += dx[i];
    let a = s / p; out[firstValid + p] = a; // +1 to realign: tr/dm arrays are shifted by one candle
    for (let i = firstValid + p; i < dx.length; i++) { a = (a * (p - 1) + dx[i]) / p; out[i + 1] = a; }
  }
  return out;
}

// Simplified RSI divergence: compares the current bar to the most extreme bar in the
// lookback window. A new price high on weaker RSI (or new low on stronger RSI) often
// precedes a reversal — this is one of the few genuinely leading signals available here.
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

function indicators(cs) {
  const c = cs.map(x => x.c), v = cs.map(x => x.v);
  return { cs, c, e20: ema(c, 20), e50: ema(c, 50), r: rsi(c), m: macd(c), bb: boll(c), a: atr(cs), vm: sma(v, 20), adx: adx(cs) };
}

// EMA20-vs-EMA50 trend direction on a (usually higher) timeframe's candles: 1 bullish, -1 bearish, 0 unknown.
function trendDir(cs) {
  if (!cs || cs.length < 55) return 0;
  const c = cs.map(x => x.c), e20 = ema(c, 20), e50 = ema(c, 50), i = c.length - 1;
  if (isNaN(e20[i]) || isNaN(e50[i])) return 0;
  return e20[i] > e50[i] ? 1 : -1;
}

// ---------- scoring ----------
// Score in [-100,100]. Positive = bullish. Every component is explained in `why`.
function scoreAt(I, i) {
  if ([I.e50[i], I.m.sig[i], I.a[i], I.vm[i], I.r[i], I.bb.up[i]].some(isNaN)) return { score: 0, why: ["Not enough data"] };
  let s = 0; const why = [];
  const add = (n, t) => { s += n; why.push((n >= 0 ? "+" : "") + Math.round(n) + "  " + t); };
  const c = I.c[i];

  // In a choppy/range-bound market (low ADX), trend-following EMA/MACD signals whipsaw
  // far more often — discount them. In a strongly trending market (high ADX), trust them more.
  const adxVal = I.adx[i];
  const trendDamp = isNaN(adxVal) ? 1 : adxVal < 18 ? 0.5 : adxVal > 25 ? 1.15 : 1;
  const trendNote = isNaN(adxVal) ? "" : adxVal < 18 ? ` [ADX ${adxVal.toFixed(0)}: range-bound, discounted]` : adxVal > 25 ? ` [ADX ${adxVal.toFixed(0)}: trending, amplified]` : "";

  add((I.e20[i] > I.e50[i] ? 20 : -20) * trendDamp, (I.e20[i] > I.e50[i] ? "EMA20 above EMA50 (uptrend)" : "EMA20 below EMA50 (downtrend)") + trendNote);
  add((c > I.e50[i] ? 10 : -10) * trendDamp, c > I.e50[i] ? "Price above EMA50" : "Price below EMA50");
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
  const pb = (c - I.bb.lo[i]) / ((I.bb.up[i] - I.bb.lo[i]) || 1e-9);
  if (pb < 0.05) add(10, "Price at lower Bollinger band");
  else if (pb > 0.95) add(-10, "Price at upper Bollinger band");
  const vr = I.cs[i].v / I.vm[i];
  if (vr > 1.5) { const up = I.cs[i].c >= I.cs[i].o; add(up ? 10 : -10, "Volume " + vr.toFixed(1) + "x avg on " + (up ? "green" : "red") + " candle"); }

  // Divergence: price making a new extreme that momentum doesn't confirm often front-runs a reversal.
  const div = divergence(I.c, I.r, i);
  if (div.bearish) add(-12, "Bearish RSI divergence — new price high not confirmed by momentum");
  if (div.bullish) add(12, "Bullish RSI divergence — new price low not confirmed by momentum");

  return { score: Math.max(-100, Math.min(100, s)), why, adx: adxVal };
}

const label = s => s >= 45 ? "SB" : s >= 20 ? "B" : s <= -45 ? "SS" : s <= -20 ? "S" : "N";
const labelText = { SB: "Strong Buy", B: "Buy", N: "Neutral", S: "Sell", SS: "Strong Sell" };

// Backtest of the same rule set, for the side actually signaled.
// Long: enter when score crosses up through +enter, stop 1.5*ATR below entry, exit when score <= 0.
// Short: enter when score crosses down through -enter, stop 1.5*ATR above entry, exit when score >= 0.
// Fees 0.1%/side. Closed candles only.
function backtest(I, side = "long", enter = 25, fee = 0.001) {
  const n = I.c.length; let pos = null, trades = [], eq = 1;
  const sc = Array(n).fill(0); for (let i = 50; i < n; i++) sc[i] = scoreAt(I, i).score;
  for (let i = 51; i < n; i++) {
    if (pos) {
      const k = I.cs[i]; let exit = null;
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
      pos = { entry: I.c[i], stop: I.c[i] - 1.5 * I.a[i] };
    } else if (side === "short" && sc[i] <= -enter && sc[i - 1] > -enter) {
      pos = { entry: I.c[i], stop: I.c[i] + 1.5 * I.a[i] };
    }
  }
  const wins = trades.filter(x => x > 0).length;
  const bh = side === "long" ? I.c[n - 1] / I.c[50] - 1 : I.c[50] / I.c[n - 1] - 1;
  return { trades: trades.length, win: trades.length ? wins / trades.length : NaN, ret: eq - 1, bh };
}

function analyze(cs, htfTrend = 0) { // cs = closed candles; htfTrend = higher-timeframe trend direction (1/-1/0)
  const I = indicators(cs), i = cs.length - 1, base = scoreAt(I, i), a = I.a[i], c = I.c[i];
  let score = base.score, why = [...base.why], counterTrend = false, aligned = false;

  if (htfTrend !== 0 && score !== 0) {
    aligned = (score > 0 && htfTrend > 0) || (score < 0 && htfTrend < 0);
    if (aligned) { score += score > 0 ? 8 : -8; why.push("✓ Aligned with higher-timeframe trend"); }
    else { score *= 0.5; counterTrend = true; why.push("⚠ Against the higher-timeframe trend — conviction halved, likely a counter-trend bounce"); }
  }
  score = Math.max(-100, Math.min(100, score));

  const lab = label(score);
  const side = score >= 20 ? "long" : score <= -20 ? "short" : "none";
  const plan = side === "long" ? { side: "LONG", entry: c, stop: c - 1.5 * a, t1: c + 1.5 * a, t2: c + 3 * a }
    : side === "short" ? { side: "SHORT", entry: c, stop: c + 1.5 * a, t1: c - 1.5 * a, t2: c - 3 * a }
    : null;
  const bt = backtest(I, side === "short" ? "short" : "long");
  return { I, score, why, lab, side, plan, rsi: I.r[i], trend: I.e20[i] > I.e50[i] ? 1 : -1, adx: base.adx, counterTrend, htfAligned: aligned, atr: a, cs, bt };
}

// ---------- Binance data ----------
const BASES = ["https://data-api.binance.vision", "https://api.binance.com"];
const FUTURES_BASES = ["https://fapi.binance.com"];
async function getFrom(bases, path) {
  let err;
  for (const b of bases) {
    try { const r = await fetch(b + path); if (r.ok) return await r.json(); err = new Error(r.status); }
    catch (e) { err = e; }
  }
  throw err;
}
const getJSON = path => getFrom(BASES, path);
const futuresJSON = path => getFrom(FUTURES_BASES, path);
async function fetchKlines(sym, tf, limit = CONFIG.candlesLimit) {
  try { return await getJSON(`/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`); }
  catch (e) { return null; }
}

// Binance doesn't publish a market-wide liquidation map publicly (that endpoint was locked
// down to authenticated, own-account-only access years ago). Open interest + funding rate +
// long/short account ratio from the free perpetual-futures API is the closest honest proxy:
// it shows how crowded and squeeze-prone current positioning is, even without exact price levels.
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

const fmt = p => p >= 1000 ? p.toLocaleString(undefined, { maximumFractionDigits: 1 }) : p >= 1 ? p.toFixed(3) : p.toFixed(6);
const fmtUsd = n => n >= 1e9 ? "$" + (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? "$" + (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? "$" + (n / 1e3).toFixed(1) + "K" : "$" + n.toFixed(0);
const parsePinned = str => (str || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

const state = { data: {}, tick: {}, top: [], sel: null, pendingSelect: null, prev: {}, feed: [], scanned: 0, lastUpdate: null, sentiment: {} };

function renderSentimentHtml(base, d) {
  if (!d) return `<div class="mute">No perpetual futures market for ${base} on Binance, or data unavailable right now.</div>`;
  const fundingPct = (d.funding * 100).toFixed(4), annual = (d.funding * 3 * 365 * 100).toFixed(1);
  const oiUsd = d.oi * d.markPrice, hasRatio = d.longPct != null;
  const skew = d.funding > 0.0003 ? "Longs are paying shorts to stay in — crowded long, vulnerable to a squeeze lower."
    : d.funding < -0.0003 ? "Shorts are paying longs to stay in — crowded short, vulnerable to a squeeze higher."
    : "Funding is roughly neutral — no strong one-sided crowding.";
  return `<div class="kv">
      <span>Open interest</span><span>${fmtUsd(oiUsd)}</span>
      <span>Funding rate (8h)</span><span class="${d.funding >= 0 ? "up" : "down"}">${fundingPct}% <span class="mute">(~${annual}%/yr annualized)</span></span>
      ${hasRatio ? `<span>Long accounts</span><span class="up">${d.longPct.toFixed(1)}%</span><span>Short accounts</span><span class="down">${d.shortPct.toFixed(1)}%</span>` : ""}
    </div>
    ${hasRatio ? `<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:4px 0"><div style="width:${d.longPct}%;background:var(--up)"></div><div style="width:${d.shortPct}%;background:var(--down)"></div></div>` : ""}
    <div class="mute" style="font-size:12px">${skew} Sentiment proxy only, not an exact liquidation price map — Binance doesn't publish market-wide liquidation levels publicly.</div>`;
}

async function loadSentiment(base) {
  const cached = state.sentiment[base];
  if (cached && Date.now() - cached.ts < 25000) { const el = $("sentiment"); if (el) el.innerHTML = cached.html; return; }
  const data = await fetchSentiment(base + "USDT");
  if (state.sel !== base) return; // selection changed while the request was in flight
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
    const filtered = filterUniverse(all, minVol);
    const candidates = filtered.slice(0, poolSize);

    // Always include pinned/looked-up symbols even if they fall outside the volume/pool cutoff.
    let lookupNotFound = null;
    parsePinned($("pinned").value).forEach(base => {
      const sym = base + "USDT";
      if (!candidates.some(c => c.symbol === sym)) {
        const t = all.find(x => x.symbol === sym);
        if (t) candidates.push(t);
        else if (base === state.pendingSelect) lookupNotFound = base;
      }
    });
    state.scanned = candidates.length;

    const htf = HTF_MAP[tf] || tf;
    const [klResults, htfResults] = await Promise.all([
      Promise.all(candidates.map(t => fetchKlines(t.symbol, tf))),
      Promise.all(candidates.map(t => fetchKlines(t.symbol, htf, CONFIG.htfLimit)))
    ]);
    const analyzed = [];
    candidates.forEach((t, idx) => {
      const kl = klResults[idx];
      if (!kl || kl.length < 60) return;
      const cs = kl.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1); // drop forming candle
      if (cs.length < 55) return;
      const htfKl = htfResults[idx];
      const htfCs = htfKl ? htfKl.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })).slice(0, -1) : null;
      const base = t.symbol.slice(0, -4);
      const res = analyze(cs, trendDir(htfCs));
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

    const dir = $("dir").value; // both|long|short
    const ranked = analyzed
      .filter(d => dir === "both" ? true : d.side === dir)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || ((b.bt.win || 0) - (a.bt.win || 0)));

    const topN = Math.max(1, +$("topN").value || CONFIG.topN);
    state.top = ranked.slice(0, topN);

    if (state.pendingSelect) {
      if (state.data[state.pendingSelect]) state.sel = state.pendingSelect;
      state.pendingSelect = null;
    }
    // Keep the current selection sticky as long as it's still in the scanned pool (e.g. a
    // looked-up or pinned coin that isn't a top-ranked opportunity) — only fall back to
    // the #1 opportunity if the selection no longer exists at all.
    if (!state.data[state.sel]) state.sel = state.top[0]?.base || null;

    state.lastUpdate = new Date();
    $("status").textContent = "Updated " + state.lastUpdate.toLocaleTimeString() + " · scanned " + state.scanned + " pairs"
      + (lookupNotFound ? ` · "${lookupNotFound}USDT" not found on Binance` : "");
  } catch (e) {
    $("status").textContent = "Data error: " + e.message + " (Binance may be blocked on your network)";
  }
  $("refresh").disabled = false;
  render();
  scheduleCloseRefresh();
}

// Scores only change when a candle actually closes, so instead of waiting on the next
// 60s poll, schedule one extra refresh right at the current timeframe's next candle close.
let closeTimer = null;
function msToNextClose(tf) { const span = TF_MS[tf] || 3600000; return span - (Date.now() % span); }
function scheduleCloseRefresh() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(load, msToNextClose($("tf").value) + 1500); // small buffer for Binance to publish the closed candle
}
function updateCountdown() {
  const tf = $("tf").value, totalSec = Math.max(0, Math.floor(msToNextClose(tf) / 1000));
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  const t = h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  $("countdown").textContent = `Next ${tf} candle closes in ${t} — signals update then`;
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
  renderStats();
  const rows = state.top.map((d, idx) => {
    const t = state.tick[d.base], ch = +t.priceChangePercent, w = Math.min(50, Math.abs(d.score) / 2);
    const bar = `<span class="bar"><i style="${d.score >= 0 ? `left:50%;width:${w}%;background:var(--up)` : `right:50%;width:${w}%;background:var(--down)`}"></i></span>`;
    const bt = d.bt.trades ? `${(d.bt.win * 100).toFixed(0)}% / ${d.bt.trades}` : "–";
    const sideTag = d.side === "long" ? '<b class="up">LONG</b>' : d.side === "short" ? '<b class="down">SHORT</b>' : '<span class="mute">WAIT</span>';
    const flag = d.counterTrend ? '<span class="mute" title="Against the higher-timeframe trend — treat as a lower-conviction bounce, not a clean signal">⚠</span>'
      : d.htfAligned ? '<span class="up" title="Aligned with the higher-timeframe trend">✓</span>' : "";
    return `<tr data-s="${d.base}" class="${d.base === state.sel ? "sel" : ""}">
      <td class="mute">${idx + 1}</td>
      <td><b>${d.base}</b></td>
      <td>${fmt(+t.lastPrice)}</td>
      <td class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${ch.toFixed(2)}%</td>
      <td>${spark(d.cs)}</td>
      <td class="${d.rsi > 70 ? "down" : d.rsi < 30 ? "up" : ""}">${d.rsi.toFixed(0)}</td>
      <td>${bar}${d.score.toFixed(0)}</td>
      <td><span class="badge ${d.lab}">${labelText[d.lab]}</span> ${flag}</td>
      <td>${sideTag}</td>
      <td class="mute">${bt}</td>
    </tr>`;
  }).join("");
  $("rows").innerHTML = rows || `<tr><td colspan="10" class="mute">No pairs matched your filters. Lower min volume, widen the universe, or switch direction to "Both".</td></tr>`;
  document.querySelectorAll("#rows tr[data-s]").forEach(tr => tr.onclick = () => { state.sel = tr.dataset.s; render(); });
  renderDetail();
  renderFeed();
}

function renderStats() {
  const longs = state.top.filter(d => d.side === "long").length;
  const shorts = state.top.filter(d => d.side === "short").length;
  const best = state.top[0];
  $("stats").innerHTML = `
    <div class="stat"><span class="mute">Pairs scanned</span><b>${state.scanned || 0}</b></div>
    <div class="stat"><span class="mute">Long setups</span><b class="up">${longs}</b></div>
    <div class="stat"><span class="mute">Short setups</span><b class="down">${shorts}</b></div>
    <div class="stat"><span class="mute">Best opportunity</span><b>${best ? best.base + " (" + best.score.toFixed(0) + ")" : "–"}</b></div>`;
}

function renderFeed() {
  if (!state.feed.length) { $("feed").innerHTML = '<span class="mute">Nothing yet. Changes appear here while the page stays open.</span>'; return; }
  $("feed").innerHTML = state.feed.map(f => `<div><span class="mute">${f.t.toLocaleTimeString()}</span> <b>${f.s}</b> <span class="badge ${f.from}">${labelText[f.from]}</span> → <span class="badge ${f.to}">${labelText[f.to]}</span></div>`).join("");
}

function renderDetail() {
  const s = state.sel, d = state.data[s];
  if (!d) { $("detail").innerHTML = '<h2>Detail</h2><div class="mute">No opportunity selected. Adjust filters or wait for the next scan.</div>'; return; }
  const acct = +$("acct").value || 0, risk = (+$("risk").value || 0) / 100;
  let planHtml = '<div class="mute" style="margin-top:8px">No trade: score is between −20 and +20. Waiting is a position.</div>';
  if (d.plan) {
    const p = d.plan, dist = Math.abs(p.entry - p.stop), riskUsd = acct * risk, qty = riskUsd / dist;
    const tip = p.side === "LONG" ? "Suggestion: take half at T1, move stop to entry, let the rest run to T2."
      : "Suggestion (short): take half at T1, move stop to entry, let the rest run to T2. Borrowing/funding fees apply on perpetuals.";
    planHtml = `<div class="kv"><span>Setup</span><span><b class="${p.side === "LONG" ? "up" : "down"}">${p.side}</b></span>
      <span>Entry (last close)</span><span>${fmt(p.entry)}</span>
      <span>Stop (1.5×ATR)</span><span class="down">${fmt(p.stop)} (${(dist / p.entry * 100).toFixed(2)}%)</span>
      <span>Target 1 (1R)</span><span class="up">${fmt(p.t1)}</span>
      <span>Target 2 (2R)</span><span class="up">${fmt(p.t2)}</span>
      <span>Risk amount</span><span>${riskUsd.toFixed(0)} USDT</span>
      <span>Position size</span><span>${qty.toPrecision(4)} ${s} (~${(qty * p.entry).toFixed(0)} USDT)</span></div>
      <div class="mute" style="font-size:12px">${tip}</div>`;
  }
  const b = d.bt;
  $("detail").innerHTML = `<h2>${s}/USDT · ${$("tf").value}</h2><canvas id="ch"></canvas>
    ${planHtml}<h2 style="margin-top:14px">Why this score</h2><ul>${d.why.map(w => `<li>${w}</li>`).join("")}</ul>
    <h2 style="margin-top:14px">Backtest (${d.side === "short" ? "short" : "long"}-side, same rules)</h2>
    <div class="kv"><span>Trades</span><span>${b.trades}</span><span>Win rate</span><span>${b.trades ? (b.win * 100).toFixed(0) + "%" : "–"}</span>
    <span>Strategy return</span><span class="${b.ret >= 0 ? "up" : "down"}">${(b.ret * 100).toFixed(1)}%</span>
    <span>Buy &amp; hold, same period</span><span class="${b.bh >= 0 ? "up" : "down"}">${(b.bh * 100).toFixed(1)}%</span></div>
    <h2 style="margin-top:14px">Futures positioning <span class="mute hint">· squeeze/liquidation-risk proxy</span></h2>
    <div id="sentiment" class="mute">Loading…</div>
    <div class="warn">Not financial advice. Backtest ignores the higher-timeframe filter above (it's single-timeframe only) and slippage/funding, and runs on a small sample — if it doesn't beat buy &amp; hold here, treat the signal with suspicion.</div>`;
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
  const y = v => 8 + (mx - v) / (mx - mn) * (H - 16), bw = W / N;
  cs.forEach((k, i) => {
    const x = i * bw + bw / 2, up = k.c >= k.o;
    g.strokeStyle = g.fillStyle = up ? "#2ea36a" : "#e5534b";
    g.beginPath(); g.moveTo(x, y(k.h)); g.lineTo(x, y(k.l)); g.stroke();
    g.fillRect(x - bw * 0.35, Math.min(y(k.o), y(k.c)), bw * 0.7, Math.max(1, Math.abs(y(k.o) - y(k.c))));
  });
  [[d.I.e20, "#4c8dff"], [d.I.e50, "#d4a72c"]].forEach(([arr, col]) => {
    g.strokeStyle = col; g.lineWidth = 1.3; g.beginPath();
    cs.forEach((_, i) => { const v = arr[off + i]; if (isNaN(v)) return; const x = i * bw + bw / 2; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
    g.stroke();
  });
  if (d.plan) {
    [[d.plan.stop, "#e5534b"], [d.plan.t1, "#2ea36a"], [d.plan.t2, "#2ea36a"]].forEach(([v, col]) => {
      g.strokeStyle = col; g.setLineDash([4, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, y(v)); g.lineTo(W, y(v)); g.stroke(); g.setLineDash([]);
    });
  }
}

// ---------- wiring ----------
function init() {
  ["tf", "poolSize", "minVol", "dir", "pinned", "topN"].forEach(id => $(id).onchange = load);
  $("refresh").onclick = load;
  $("acct").oninput = renderDetail;
  $("risk").oninput = renderDetail;
  $("alerts").onclick = async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    $("alerts").textContent = p === "granted" ? "Alerts on" : "Alerts blocked";
  };
  const runLookup = () => {
    const base = $("lookup").value.trim().toUpperCase().replace(/USDT$/, "").replace(/[^A-Z0-9]/g, "");
    if (!base) return;
    const pinned = parsePinned($("pinned").value);
    if (!pinned.includes(base)) { pinned.push(base); $("pinned").value = pinned.join(","); }
    state.pendingSelect = base;
    $("lookup").value = "";
    load();
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
