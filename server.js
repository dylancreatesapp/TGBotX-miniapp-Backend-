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

// Mapping for CoinGecko IDs by trading pair
const coinGeckoMapping = {
  "BTCUSDT": "bitcoin",
  "TRXUSDT": "tron",
  "XRPUSDT": "ripple",
  "TONUSDT": "toncoin",  // Verify the correct CoinGecko ID for TON; often it's "toncoin"
  "SUIUSDT": "sui"       // Verify if CoinGecko supports SUI; if not, this will return null
};

// Helper: Fetch current price from CoinGecko for supported tokens
async function getCoinGeckoPrice(pair) {
  try {
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

// Helper: Fetch current price from Gemini for a given pair (converts BTCUSDT to BTCUSD)
async function getGeminiPrice(pair) {
  try {
    let geminiPair = pair.toUpperCase();
    // Gemini uses "BTCUSD" for Bitcoin; adjust similarly for others if necessary.
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

// Helper: Fetch historical closing prices from CoinGecko for technical analysis (SMA)
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
    // For simplicity, for other tokens we won't calculate SMA; return null.
    return null;
  } catch (error) {
    console.error("Error fetching historical prices from CoinGecko for", pair, ":", error.response ? error.response.data : error.message);
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
    const [coingeckoPrice, geminiPrice] = await Promise.all([
      getCoinGeckoPrice(upperPair),
      getGeminiPrice(upperPair)
    ]);

    // If both sources fail, return an error.
    if (!coingeckoPrice && !geminiPrice) {
      return res.status(500).json({ error: "Failed to fetch current market prices." });
    }

    // Use available price(s)
    let priceForCalculation;
    if (coingeckoPrice && geminiPrice) {
      priceForCalculation = (coingeckoPrice + geminiPrice) / 2;
    } else if (coingeckoPrice) {
      priceForCalculation = coingeckoPrice;
    } else {
      priceForCalculation = geminiPrice;
    }
    console.log("Price used for calculation:", priceForCalculation);

    // Fetch historical prices for SMA if possible (only implemented for BTCUSDT)
    const historicalPrices = await getHistoricalPrices(upperPair, 1);
    let currentSMA = null;
    if (historicalPrices && historicalPrices.length >= 14) {
      const smaValues = sma({ period: 14, values: historicalPrices });
      currentSMA = smaValues[smaValues.length - 1] || priceForCalculation;
    }

    // Calculate percentage difference if both prices are available
    let diffPercent = "N/A";
    if (coingeckoPrice && geminiPrice) {
      diffPercent = Math.abs((coingeckoPrice - geminiPrice) / geminiPrice) * 100;
    }

    // Generate trading signal
    let signal;
    if (currentSMA !== null) {
      if (priceForCalculation > currentSMA) {
        // Bullish scenario
        signal = {
          entry: (priceForCalculation * 1.005).toFixed(2),
          stopLoss: (priceForCalculation * 0.98).toFixed(2),
          takeProfit: (priceForCalculation * 1.03).toFixed(2),
          rationale: "Bullish momentum: average price is above the 14-period SMA."
        };
      } else {
        // Bearish scenario
        signal = {
          entry: (priceForCalculation * 0.995).toFixed(2),
          stopLoss: (priceForCalculation * 1.02).toFixed(2),
          takeProfit: (priceForCalculation * 0.97).toFixed(2),
          rationale: "Bearish momentum: average price is below the 14-period SMA."
        };
      }
    } else {
      // If SMA data is not available, fallback to default signal calculation
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
