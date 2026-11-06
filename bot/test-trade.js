// Quick test: open and close a tiny BTC position on OKX demo
const OKXTrader = require("./trader");

const trader = new OKXTrader({
  demo: process.env.OKX_LIVE !== "true",
  leverage: 5,
  riskPct: 0.001,
  maxPositions: 5,
});

(async () => {
  if (!trader.enabled) {
    console.log("OKX keys not set — skipping test");
    process.exit(0);
  }

  console.log("=== OKX Demo Trade Test ===");
  console.log("Demo mode:", trader.demo);

  // 1. Check balance
  const bal = await trader.getBalance();
  console.log("Balance:", bal);

  // 2. Resolve BTC instrument
  const inst = await trader.resolveInstId("BTC");
  if (!inst) { console.error("No BTC X-Perp found!"); process.exit(1); }
  console.log("Instrument:", inst.instId, "| ctVal:", inst.ctVal, "| lotSz:", inst.lotSz);

  // 3. Get price
  const price = await trader.getPrice(inst.instId);
  console.log("BTC price:", price);

  // 4. Execute a test BUY signal
  const result = await trader.executeSignal({
    base: "BTC",
    action: "BUY",
    tf: "1h",
    entry: price,
    stop: price * 0.98,
    tp1: price * 1.02,
    tp2: price * 1.04,
    tp3: price * 1.06,
    key: "BTC-1h-BUY-test",
  });

  console.log("\nTrade result:", JSON.stringify(result, null, 2));

  if (result.executed) {
    console.log("\n✓ Trade opened successfully! Closing it now...");
    await new Promise(r => setTimeout(r, 2000));
    const closed = await trader.closePosition("BTC", "test-close");
    console.log("Closed:", closed ? "success" : "failed");
    console.log("P&L:", closed?.realizedPnl);
  }

  console.log("\n=== Test Complete ===");
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
