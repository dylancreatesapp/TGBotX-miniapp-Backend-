import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { sma } from "technicalindicators"; // Ensure you've installed technicalindicators via npm
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health-check route
app.get("/", (req, res) => {
  res.send("Trading Signals Backend is running!");
});

// Helper: Fetch current price from CoinGecko for BTCUSDT (mapping to Bitcoin)
async function getCoinGeckoPrice(pair) {
  try {
    if (pair.toUpperCase() === "BTCUSDT") {
      const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
        params: {
          ids: "bitcoin",
          vs_currencies: "usdt"
        }
      });
      return parseFloat(response.data.bitcoin.usdt);
    }
    // For additional pairs, you can extend this mapping
    return null;
  } catch (error) {
    console.error("Error fetching price from CoinGecko:", error.message);
    return null;
  }
}

// Helper: Fetch current price from Gemini for a given pair (converts BTCUSDT to BTCUSD)
async function getGeminiPrice(pair) {
  try {
    let geminiPair = pair.toUpperCase();
    if (geminiPair.endsWith("USDT")) {
      geminiPair = geminiPair.replace("USDT", "USD");
    }
    const url = `https://api.gemini.com/v1/pubticker/${geminiPair.toLowerCase()}`;
    const response = await axios.get(url);
    return parseFloat(response.data.last);
  } catch (error) {
    console.error("Error fetching Gemini price:", error.message);
    return null;
  }
}

// Helper: Fetch historical closing prices from CoinGecko for technical analysis (SMA)
// This function fetches hourly price data for the past 1 day for BTCUSDT.
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
      // response.data.prices is an array: [timestamp, price]
      const prices = response.data.prices.map(item => parseFloat(item[1]));
      return prices;
    }
    return null;
  } catch (error) {
    console.error("Error fetching historical prices from CoinGecko:", error.message);
    return null;
  }
}

// Trading Signal Endpoint
// Expects a JSON body: { "pair": "BTCUSDT" }
app.post("/api/trading-signal", async (req, res) => {
  try {
    const { pair } = req.body;
    if (!pair) {
      return res.status(400).json({ error: "Missing 'pair' in request body." });
    }
    const upperPair = pair.toUpperCase();

    // Fetch current prices concurrently:
    // - Use CoinGecko for current price (since Binance gives 451 error)
    // - Use Gemini for a secondary data point
    const [coingeckoPrice, geminiPrice] = await Promise.all([
      getCoinGeckoPrice(upperPair),
      getGeminiPrice(upperPair)
    ]);

    if (!coingeckoPrice || !geminiPrice) {
      return res.status(500).json({ error: "Failed to fetch current market prices." });
    }

    // Compute the average price
    const averagePrice = (coingeckoPrice + geminiPrice) / 2;

    // Fetch historical prices for SMA calculation
    const historicalPrices = await getHistoricalPrices(upperPair, 1); // 1 day of hourly data
    let currentSMA = null;
    if (historicalPrices && historicalPrices.length >= 14) {
      const smaValues = sma({ period: 14, values: historicalPrices });
      currentSMA = smaValues[smaValues.length - 1] || averagePrice;
    }

    // Calculate percentage difference between CoinGecko and Gemini prices
    const diffPercent = Math.abs((coingeckoPrice - geminiPrice) / geminiPrice) * 100;

    // Generate trading signal using SMA if available; otherwise, use average price defaults
    let signal;
    if (currentSMA !== null) {
      if (averagePrice > currentSMA) {
        signal = {
          entry: (averagePrice * 1.005).toFixed(2),
          stopLoss: (averagePrice * 0.98).toFixed(2),
          takeProfit: (averagePrice * 1.03).toFixed(2),
          rationale: "Bullish momentum: average price is above the 14-period SMA."
        };
      } else {
        signal = {
          entry: (averagePrice * 0.995).toFixed(2),
          stopLoss: (averagePrice * 1.02).toFixed(2),
          takeProfit: (averagePrice * 0.97).toFixed(2),
          rationale: "Bearish momentum: average price is below the 14-period SMA."
        };
      }
    } else {
      // Fallback if historical data is insufficient
      signal = {
        entry: (averagePrice * 1.005).toFixed(2),
        stopLoss: (averagePrice * 0.98).toFixed(2),
        takeProfit: (averagePrice * 1.03).toFixed(2),
        rationale: "Using average price as SMA data is unavailable."
      };
    }

    res.json({
      success: true,
      pair: upperPair,
      coingeckoPrice,
      geminiPrice,
      averagePrice: averagePrice.toFixed(2),
      currentSMA: currentSMA !== null ? currentSMA.toFixed(2) : "N/A",
      diffPercent: diffPercent.toFixed(2),
      signal,
      utcTime: new Date().toUTCString()
    });
  } catch (error) {
    console.error("Error generating trading signal:", error.message);
    res.status(500).json({ error: "Internal server error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
