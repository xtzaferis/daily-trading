// Test: open and close a tiny long (spot) and short (X-Perp) position
const OKXTrader = require("./trader");

const mode = process.argv[2] || "check"; // check | long | short | both

const trader = new OKXTrader({
  demo: process.env.OKX_LIVE !== "true",
  riskPct: 0.001,
  maxPositions: 5,
  leverage: 5,
});

async function testConnection() {
  console.log("=== OKX Connection Test ===");
  console.log("Mode:", trader.demo ? "DEMO" : "LIVE");

  const bal = await trader.getBalance();
  console.log("Balance:", JSON.stringify(bal));

  const spotPrice = await trader.getPrice("BTC-USDC");
  console.log("BTC-USDC spot price:", spotPrice);

  const xperp = await trader.getXPerpInstrument("BTC");
  if (xperp) {
    const xperpPrice = await trader.getPrice(xperp.instId);
    console.log(`X-Perp: ${xperp.instId} | price: ${xperpPrice} | ctVal: ${xperp.ctVal} | minSz: ${xperp.minSz}`);
  } else {
    console.log("X-Perp: NOT AVAILABLE for BTC");
  }

  if (bal.available <= 0) {
    console.log("\nWARNING: No available balance");
    return false;
  }
  console.log(`\nOK: $${bal.available.toFixed(2)} ${bal.ccy} available`);
  return true;
}

async function testLong() {
  console.log("\n=== Testing LONG (spot BUY) ===");
  const price = await trader.getPrice("BTC-USDC");

  const result = await trader.executeSignal({
    base: "BTC", action: "BUY", tf: "1h",
    entry: price, stop: price * 0.98,
    tp1: price * 1.02, tp2: price * 1.04, tp3: price * 1.06,
    key: "BTC-1h-BUY-test",
  });
  console.log("Result:", JSON.stringify(result, null, 2));

  if (result.executed) {
    console.log("Closing long...");
    await new Promise(r => setTimeout(r, 2000));
    const closed = await trader.closePosition("BTC", "test-close");
    console.log("Closed:", closed ? "OK" : "FAILED");
    console.log("P&L: $" + (closed?.realizedPnl?.toFixed(4) || "?"));
  }
}

async function testShort() {
  console.log("\n=== Testing SHORT (X-Perp SELL) ===");
  const xperp = await trader.getXPerpInstrument("BTC");
  if (!xperp) { console.log("SKIP: No X-Perp for BTC"); return; }

  const price = await trader.getPrice(xperp.instId);

  const result = await trader.executeSignal({
    base: "BTC", action: "SELL", tf: "1h",
    entry: price, stop: price * 1.02,
    tp1: price * 0.98, tp2: price * 0.96, tp3: price * 0.94,
    key: "BTC-1h-SELL-test",
  });
  console.log("Result:", JSON.stringify(result, null, 2));

  if (result.executed) {
    console.log("Closing short...");
    await new Promise(r => setTimeout(r, 2000));
    const closed = await trader.closePosition("BTC", "test-close");
    console.log("Closed:", closed ? "OK" : "FAILED");
    console.log("P&L: $" + (closed?.realizedPnl?.toFixed(4) || "?"));
  }
}

(async () => {
  if (!trader.enabled) { console.log("OKX keys not set — skipping"); process.exit(0); }

  const ok = await testConnection();
  if (!ok) process.exit(1);

  if (mode === "long" || mode === "both") await testLong();
  if (mode === "short" || mode === "both") await testShort();
  if (mode === "check") console.log("\nPass 'long', 'short' or 'both' to test trades.");

  console.log("\n=== Test Complete ===");
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
