import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import nodemailer from "nodemailer";
import axios from "axios";
import { sma } from "technicalindicators";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN || '8175210664:AAEs4eFLN0JmymnaIjsftVHk2Y6bZBQ3X-Y';
const EMAIL_FROM = process.env.EMAIL_FROM;       // e.g., your email address
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD; // e.g., your email app password
const FRONTEND_URL = "https://tgbotx-miniapp-production.up.railway.app";

const app = express();
app.use(cors());
app.use(express.json());

// Health-check route
app.get("/", (req, res) => {
  res.send("Trading Signals Backend is running!");
});

// ------------------ Trading Signal Endpoint ------------------
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

// ------------------ Email Verification Endpoints ------------------

// Set up nodemailer transporter (using Gmail as an example)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: EMAIL_FROM,
    pass: EMAIL_PASSWORD
  }
});

// In-memory store for verification tokens (use a database in production)
const tokens = {};

// Endpoint to send verification email
app.post("/api/auth/send-verification", async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ success: false, message: "Email is required." });
  }

  // Generate a verification token
  const token = crypto.randomBytes(16).toString("hex");
  // Save the token with expiration (e.g., 15 minutes)
  tokens[token] = { email, expires: Date.now() + 15 * 60 * 1000 };

  // Create a verification URL (adjust path if necessary)
  const verificationUrl = `${FRONTEND_URL}/verify.html?token=${token}`;

  // Send verification email using nodemailer
  const mailOptions = {
    from: EMAIL_FROM,
    to: email,
    subject: "Your TGBotX Verification Email",
    html: `<p>Click <a href="${verificationUrl}">here</a> to verify your email and log in.</p>`
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending email:", error);
      return res.status(500).json({ success: false, message: "Failed to send verification email." });
    }
    console.log("Verification email sent:", info.response);
    res.json({ success: true, message: "Verification email sent." });
  });
});

// Endpoint to verify the token
app.get("/api/auth/verify", (req, res) => {
  const { token } = req.query;
  if (!token || !tokens[token]) {
    return res.status(400).send("Invalid or expired token.");
  }

  const record = tokens[token];
  if (Date.now() > record.expires) {
    delete tokens[token];
    return res.status(400).send("Token expired. Please request a new verification email.");
  }

  // Token is valid; remove the token and proceed with login (session creation, etc.)
  delete tokens[token];
  res.send("Email verified! You can now close this window and return to the mini-app.");
});

// ------------------ Helper Functions for Trading Signals ------------------
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
