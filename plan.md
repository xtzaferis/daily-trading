# Telegram Signal Bot — Professional Upgrade Plan

## Goal
Make the signal bot reliable and professional enough to charge $2/month.

## Current State
- Bot sends daily briefing (top 5 on 1d) at 07:00 Norway time
- Hourly scans for clean 1h/4h signals
- Tracks outcomes (WIN/LOSS) and sends notifications
- Weekly scorecard on Monday mornings
- Dashboard at https://xtzaferis.github.io/daily-trading/

---

## Upgrades to Implement

### 1. Multi-Target Signals (TP1, TP2, TP3)
**Why:** Subscribers need to scale out of positions. A single target is amateur — pro services give 3 levels so traders can lock in profit along the way.

**What to build:**
- TP1 = nearest S/R level or Fib 1.0 extension (conservative, ~60% of position)
- TP2 = Fib 1.618 extension (moderate, ~30% of position)
- TP3 = Fib 2.618 extension (aggressive, ~10% of position)
- Show all three in the Telegram message
- Move stop to breakeven after TP1 is hit
- Track each TP hit separately in the signal log

### 2. Position Size Calculator
**Why:** Subscribers don't know how much to risk. Without this, they either oversize (blow up) or undersize (signal feels useless).

**What to build:**
- Each signal shows position size for a reference $1,000 account at 1% risk
- Formula: `size = (account * riskPct) / |entry - stop|`
- Show as: "Size: 0.05 BTC ($3,400) risking $10"
- Leverage suggestion if the size exceeds account (e.g., "3x leverage needed")

### 3. Signal Expiry
**Why:** Stale signals mislead late joiners. If someone sees a 12-hour-old signal, they might enter a trade that's already moved.

**What to build:**
- Each signal shows expiry time based on timeframe:
  - 1h signals → valid for 4 hours
  - 4h signals → valid for 12 hours
  - 1d signals → valid for 48 hours
- Show as: "Valid until: Nov 2, 18:00 UTC"
- Auto-send "EXPIRED" notification when time runs out (if not already WIN/LOSS)

### 4. Timeframe Conflict Filter
**Why:** If 1h says BUY and 4h says SELL on the same coin, subscribers get confused and lose trust.

**What to build:**
- Before sending a signal, check if the same coin has an active signal in the opposite direction on another timeframe
- If conflict exists: skip the weaker signal (lower confluence wins)
- If both are strong: send the higher timeframe only (it's more reliable)
- Log conflicts for the scorecard

### 5. Public Track Record Page
**Why:** Nobody pays for signals without seeing proof. A live, verifiable stats page is the #1 conversion tool.

**What to build:**
- New HTML page on GitHub Pages: `/track-record.html`
- Shows all-time stats: win rate, profit factor, total P&L, avg R:R
- Table of every signal: date, coin, action, entry, stop, targets, result, P&L
- Filterable by timeframe, month, WIN/LOSS
- Updates automatically from the signal log (bot pushes a JSON data file)
- Shareable link for marketing

### 6. Entry Zones Instead of Exact Price
**Why:** "BUY at 68,432.50" is misleading — by the time a subscriber sees it, price has moved. An entry zone is more realistic.

**What to build:**
- Entry zone = current price ± 0.3% (tight) or ± ATR*0.3 (volatility-adjusted)
- Show as: "Entry zone: 68,200 – 68,650"
- Signal is valid as long as price is within the zone
- If price has already left the zone by the next hourly check, mark signal as "MISSED"

---

## Implementation Order
1. Multi-target signals (TP1/TP2/TP3) — changes signal format + tracking
2. Entry zones — changes signal format
3. Position size calculator — adds info to signal message
4. Signal expiry — adds expiry logic + notifications
5. Timeframe conflict filter — prevents confusing signals
6. Public track record page — new HTML page, needs signal log data

## Not in Scope (for now)
- Paid tier / paywall integration (do manually via private channel invite)
- Automated Binance trade execution
- User account management
