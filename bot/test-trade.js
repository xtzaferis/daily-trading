// Quick test: open and close a tiny BTC spot position on OKX EEA demo
const OKXTrader = require("./trader");

const trader = new OKXTrader({
  demo: process.env.OKX_LIVE !== "true",
  riskPct: 0.001,
  maxPositions: 5,
});

(async () => {
  if (!trader.enabled) {
    console.log("OKX keys not set — skipping test");
    process.exit(0);
  }

  console.log("=== OKX EEA Spot Demo Trade Test ===");
  console.log("Demo mode:", trader.demo);

  const bal = await trader.getBalance();
  console.log("Balance:", JSON.stringify(bal));

  const price = await trader.getPrice("BTC-USDC");
  console.log("BTC-USDC price:", price);

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
    console.log("\nClosing position...");
    await new Promise(r => setTimeout(r, 2000));
    const closed = await trader.closePosition("BTC", "test-close");
    console.log("Closed:", closed ? "success" : "failed");
    console.log("P&L:", closed?.realizedPnl);
  }

  console.log("\n=== Test Complete ===");
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
