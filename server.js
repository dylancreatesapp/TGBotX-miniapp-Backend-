import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { sma } from "technicalindicators";  // Import SMA function
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Health-check route
app.get("/", (req, res) => {
  res.send("Trading Signals Backend is running!");
});

// Helper: Fetch current price from Binance for a given pair (e.g., "BTCUSDT")
async function getCoinGeckoPrice(pair) {
  try {
    // For BTCUSDT, we'll assume pair is BTCUSDT and map it to CoinGecko's id "bitcoin" and currency "usdt".
    // You can extend this mapping for other coins if needed.
    if (pair.toUpperCase() === "BTCUSDT") {
      const response = await axios.get("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usdt");
      return parseFloat(response.data.bitcoin.usdt);
    }
    // For other pairs, implement similar mapping or fallback.
    return null;
  } catch (error) {
    console.error("Error fetching price from CoinGecko:", error.message);
    return null;
  }
}


// Helper: Fetch current price from Gemini for a given pair
async function getGeminiPrice(pair) {
  try {
    let geminiPair = pair;
    // Gemini uses "BTCUSD" instead of "BTCUSDT"
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

// Helper: Fetch historical closing prices from Binance (for technical indicator)
async function getHistoricalPrices(pair, interval = '1h', limit = 24) {
  try {
    const response = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`);
    // Each kline: [openTime, open, high, low, close, volume, ...]
    const closes = response.data.map(kline => parseFloat(kline[4]));
    return closes;
  } catch (error) {
    console.error("Error fetching historical prices:", error.message);
    return null;
  }
}

// Trading Signal Endpoint
// Expects a JSON body: { "pair": "BTCUSD" }
app.post("/api/trading-signal", async (req, res) => {
  try {
    const { pair } = req.body;
    if (!pair) {
      return res.status(400).json({ error: "Missing 'pair' in request body." });
    }
    const upperPair = pair.toUpperCase();

    // Fetch current prices concurrently
    const [binancePrice, geminiPrice] = await Promise.all([
      getBinancePrice(upperPair),
      getGeminiPrice(upperPair)
    ]);

    if (!binancePrice || !geminiPrice) {
      return res.status(500).json({ error: "Failed to fetch current market prices." });
    }

    // Compute the average price
    const averagePrice = (binancePrice + geminiPrice) / 2;

    // Fetch historical close prices from Binance for technical analysis
    const historicalPrices = await getHistoricalPrices(upperPair, '1h', 24);
    if (!historicalPrices) {
      return res.status(500).json({ error: "Failed to fetch historical prices." });
    }
    // Calculate SMA with period 14. Note: The SMA array will have (limit - period + 1) values.
    const smaValues = sma({ period: 14, values: historicalPrices });
    const currentSMA = smaValues[smaValues.length - 1] || averagePrice;

    // Generate trading signal based on comparison with SMA
    let signal;
    if (averagePrice > currentSMA) {
      // Bullish: current price above SMA
      signal = {
        entry: (averagePrice * 1.005).toFixed(2),   // ~0.5% above average
        stopLoss: (averagePrice * 0.98).toFixed(2),   // ~2% below average
        takeProfit: (averagePrice * 1.03).toFixed(2), // ~3% above average
        rationale: "The average price is above the 14-period SMA, indicating bullish momentum."
      };
    } else {
      // Bearish: current price below SMA
      signal = {
        entry: (averagePrice * 0.995).toFixed(2),    // ~0.5% below average
        stopLoss: (averagePrice * 1.02).toFixed(2),    // ~2% above average
        takeProfit: (averagePrice * 0.97).toFixed(2),  // ~3% below average
        rationale: "The average price is below the 14-period SMA, indicating bearish momentum."
      };
    }

    // Calculate the percentage difference between Binance and Gemini prices
    const diffPercent = Math.abs((binancePrice - geminiPrice) / geminiPrice) * 100;

    res.json({
      success: true,
      pair: upperPair,
      binancePrice,
      geminiPrice,
      averagePrice: averagePrice.toFixed(2),
      currentSMA: currentSMA.toFixed(2),
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
