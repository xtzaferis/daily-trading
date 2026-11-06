// Quick test: open and close a tiny BTC position on OKX demo
const crypto = require("crypto");
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
  console.log("API Key (first 6):", trader.apiKey.slice(0, 6) + "...");
  console.log("API Key length:", trader.apiKey.length);
  console.log("Secret length:", trader.apiSecret.length);
  console.log("Passphrase length:", trader.passphrase.length);

  // Raw debug request
  console.log("\n--- Debug: raw API call ---");
  const timestamp = new Date().toISOString();
  const method = "GET";
  const endpoint = "/api/v5/account/balance";
  const msg = timestamp + method + endpoint;
  const sign = crypto.createHmac("sha256", trader.apiSecret).update(msg).digest("base64");

  const headers = {
    "OK-ACCESS-KEY": trader.apiKey,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": trader.passphrase,
    "Content-Type": "application/json",
    "x-simulated-trading": "1",
  };
  console.log("Request URL: https://www.okx.com" + endpoint);
  console.log("Timestamp:", timestamp);

  const res = await fetch("https://www.okx.com" + endpoint, { method, headers });
  const data = await res.json();
  console.log("Response status:", res.status);
  console.log("Response:", JSON.stringify(data));

  if (data.code !== "0") {
    // Try without demo header
    console.log("\n--- Retry without demo header ---");
    delete headers["x-simulated-trading"];
    const timestamp2 = new Date().toISOString();
    const sign2 = crypto.createHmac("sha256", trader.apiSecret).update(timestamp2 + method + endpoint).digest("base64");
    headers["OK-ACCESS-SIGN"] = sign2;
    headers["OK-ACCESS-TIMESTAMP"] = timestamp2;
    const res2 = await fetch("https://www.okx.com" + endpoint, { method, headers });
    const data2 = await res2.json();
    console.log("Response without demo header:", JSON.stringify(data2));

    // Try aws.okx.com
    console.log("\n--- Retry with aws.okx.com ---");
    headers["x-simulated-trading"] = "1";
    const timestamp3 = new Date().toISOString();
    const sign3 = crypto.createHmac("sha256", trader.apiSecret).update(timestamp3 + method + endpoint).digest("base64");
    headers["OK-ACCESS-SIGN"] = sign3;
    headers["OK-ACCESS-TIMESTAMP"] = timestamp3;
    const res3 = await fetch("https://aws.okx.com" + endpoint, { method, headers });
    const data3 = await res3.json();
    console.log("Response from aws.okx.com:", JSON.stringify(data3));

    process.exit(1);
  }

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
