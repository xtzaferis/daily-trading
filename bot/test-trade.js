// Connection test: verify OKX API key works (no orders placed)
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

  console.log("=== OKX Connection Test ===");
  console.log("Mode:", trader.demo ? "DEMO" : "LIVE");

  const bal = await trader.getBalance();
  console.log("Balance:", JSON.stringify(bal));

  const price = await trader.getPrice("BTC-USDC");
  console.log("BTC-USDC price:", price);

  if (bal.available <= 0) {
    console.log("WARNING: No available balance — transfer USDC to Trading account");
  } else {
    console.log(`OK: $${bal.available.toFixed(2)} ${bal.ccy} available for trading`);
  }

  console.log("\n=== Connection OK ===");
})().catch(e => { console.error("Test failed:", e); process.exit(1); });
