import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { sma } from "technicalindicators";
import crypto from "crypto";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8175210664:AAEs4eFLN0JmymnaIjsftVHk2Y6bZBQ3X-Y';

const app = express();
app.use(cors());
app.use(express.json());

// Health-check route
app.get("/", (req, res) => {
  res.send("Trading Signals Backend is running!");
});

// ----- Trading Signal Endpoint (existing code) -----

app.post("/api/trading-signal", async (req, res) => {
  try {
    const { pair } = req.body;
    if (!pair) {
      return res.status(400).json({ error: "Missing 'pair' in request body." });
    }
    const upperPair = pair.toUpperCase();

    // Fetch current prices concurrently:
    const [coingeckoPrice, geminiPrice] = await Promise.all([
      getCoinGeckoPrice(upperPair),
      getGeminiPrice(upperPair)
    ]);

    if (!coingeckoPrice && !geminiPrice) {
      return res.status(500).json({ error: "Failed to fetch current market prices." });
    }

    let priceForCalculation;
    if (coingeckoPrice && geminiPrice) {
      priceForCalculation = (coingeckoPrice + geminiPrice) / 2;
    } else if (coingeckoPrice) {
      priceForCalculation = coingeckoPrice;
    } else {
      priceForCalculation = geminiPrice;
    }
    console.log("Price used for calculation:", priceForCalculation);

    const historicalPrices = await getHistoricalPrices(upperPair, 1);
    let currentSMA = null;
    if (historicalPrices && historicalPrices.length >= 14) {
      const smaValues = sma({ period: 14, values: historicalPrices });
      currentSMA = smaValues[smaValues.length - 1] || priceForCalculation;
    }

    let diffPercent = "N/A";
    if (coingeckoPrice && geminiPrice) {
      diffPercent = Math.abs((coingeckoPrice - geminiPrice) / geminiPrice) * 100;
    }

    let signal;
    if (currentSMA !== null) {
      if (priceForCalculation > currentSMA) {
        signal = {
          entry: (priceForCalculation * 1.005).toFixed(2),
          stopLoss: (priceForCalculation * 0.98).toFixed(2),
          takeProfit: (priceForCalculation * 1.03).toFixed(2),
          rationale: "Bullish momentum: average price is above the 14-period SMA."
        };
      } else {
        signal = {
          entry: (priceForCalculation * 0.995).toFixed(2),
          stopLoss: (priceForCalculation * 1.02).toFixed(2),
          takeProfit: (priceForCalculation * 0.97).toFixed(2),
          rationale: "Bearish momentum: average price is below the 14-period SMA."
        };
      }
    } else {
      signal = {
        entry: (priceForCalculation * 1.005).toFixed(2),
        stopLoss: (priceForCalculation * 0.98).toFixed(2),
        takeProfit: (priceForCalculation * 1.03).toFixed(2),
        rationale: "Using available average price; historical SMA data is insufficient."
      };
    }

    res.json({
      success: true,
      pair: upperPair,
      coingeckoPrice,
      geminiPrice,
      averagePrice: priceForCalculation.toFixed(2),
      currentSMA: currentSMA !== null ? currentSMA.toFixed(2) : "N/A",
      diffPercent: diffPercent !== "N/A" ? diffPercent.toFixed(2) : "N/A",
      signal,
      utcTime: new Date().toUTCString()
    });
  } catch (error) {
    console.error("Error generating trading signal:", error.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ----- New Endpoint for Telegram Login Verification -----
// This endpoint expects a JSON body containing { tgData: "<query-string>" }
app.post("/api/auth/telegram", async (req, res) => {
  try {
    const { tgData } = req.body;
    if (!tgData) {
      return res.status(400).json({ success: false, message: "No Telegram data provided." });
    }
    
    // Parse tgData (a query-string) into an object
    const params = new URLSearchParams(tgData);
    const dataObj = {};
    for (const [key, value] of params.entries()) {
      dataObj[key] = value;
    }
    
    if (!dataObj.hash) {
      return res.status(400).json({ success: false, message: "No hash parameter found." });
    }
    
    const providedHash = dataObj.hash;
    delete dataObj.hash;
    
    // Create data_check_string: sort keys alphabetically and join as "key=value" with newline separators
    const sortedKeys = Object.keys(dataObj).sort();
    const dataCheckString = sortedKeys.map(key => `${key}=${dataObj[key]}`).join("\n");
    
    // Compute the secret key as the SHA-256 hash of your BOT_TOKEN
    const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
    
    // Compute HMAC-SHA256 of the dataCheckString using the secretKey
    const computedHash = crypto.createHmac("sha256", secretKey)
                               .update(dataCheckString)
                               .digest("hex");
    
    // Compare computed hash with the provided hash
    if (computedHash !== providedHash) {
      return res.status(400).json({ success: false, message: "Data verification failed." });
    }
    
    // Optionally, check that the auth_date is recent (e.g., within 24 hours)
    const authDate = parseInt(dataObj.auth_date, 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return res.status(400).json({ success: false, message: "Authentication data is outdated." });
    }
    
    // Data is verified. Here you can store user data or process the login as needed.
    console.log("Verified Telegram user data:", dataObj);
    res.json({ success: true, message: "User authenticated successfully.", user: dataObj });
    
  } catch (err) {
    console.error("Error processing Telegram login:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// Helper functions used in trading signal endpoint:
async function getCoinGeckoPrice(pair) {
  try {
    const coinGeckoMapping = {
      "BTCUSDT": "bitcoin",
      "TRXUSDT": "tron",
      "XRPUSDT": "ripple",
      "TONUSDT": "toncoin",
      "SUIUSDT": "sui"
    };
    const mapping = coinGeckoMapping[pair.toUpperCase()];
    if (!mapping) {
      console.error("No CoinGecko mapping for pair", pair);
      return null;
    }
    const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
      params: {
        ids: mapping,
        vs_currencies: "usdt"
      }
    });
    if (response.data && response.data[mapping] && response.data[mapping].usdt) {
      const price = parseFloat(response.data[mapping].usdt);
      console.log(`CoinGecko price for ${pair} (${mapping}):`, price);
      return price;
    } else {
      console.error("Invalid response from CoinGecko for", pair);
      return null;
    }
  } catch (error) {
    console.error("Error fetching price from CoinGecko for", pair, ":", error.response ? error.response.data : error.message);
    return null;
  }
}

async function getGeminiPrice(pair) {
  try {
    let geminiPair = pair.toUpperCase();
    if (geminiPair.endsWith("USDT")) {
      geminiPair = geminiPair.replace("USDT", "USD");
    }
    const url = `https://api.gemini.com/v1/pubticker/${geminiPair.toLowerCase()}`;
    const response = await axios.get(url);
    const price = parseFloat(response.data.last);
    console.log(`Gemini price for ${pair}:`, price);
    return price;
  } catch (error) {
    console.error("Error fetching Gemini price for", pair, ":", error.response ? error.response.data : error.message);
    return null;
  }
}

async function getHistoricalPrices(pair, days = 1) {
  try {
    if (pair.toUpperCase() === "BTCUSDT") {
      const response = await axios.get("https://api.coingecko.com/api/v3/coins/bitcoin/market_chart", {
        params: {
          vs_currency: "usdt",
          days: days,
          interval: "hourly"
        }
      });
      const prices = response.data.prices.map(item => parseFloat(item[1]));
      console.log("Historical prices (last 5):", prices.slice(-5));
      return prices;
    }
    return null;
  } catch (error) {
    console.error("Error fetching historical prices from CoinGecko for", pair, ":", error.response ? error.response.data : error.message);
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
