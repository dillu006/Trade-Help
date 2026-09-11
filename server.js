import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const WATCHLIST = [
  { symbol: "RELIANCE", label: "Reliance", segment: "EQ", exchange: "NSE" },
  { symbol: "TCS", label: "TCS", segment: "EQ", exchange: "NSE" },
  { symbol: "INFY", label: "Infosys", segment: "EQ", exchange: "NSE" },
  { symbol: "HDFCBANK", label: "HDFC Bank", segment: "EQ", exchange: "NSE" },
  { symbol: "ICICIBANK", label: "ICICI Bank", segment: "EQ", exchange: "NSE" },
  { symbol: "SBIN", label: "SBI", segment: "EQ", exchange: "NSE" },
  { symbol: "TATAMOTORS", label: "Tata Motors", segment: "EQ", exchange: "NSE" },
  { symbol: "BHARTIARTL", label: "Bharti Airtel", segment: "EQ", exchange: "NSE" }
];

const INDEXES = [
  { symbol: "Nifty 50", label: "NIFTY 50", segment: "INDEX", exchange: "NSE" },
  { symbol: "Nifty Bank", label: "BANK NIFTY", segment: "INDEX", exchange: "NSE" },
  { symbol: "India VIX", label: "INDIA VIX", segment: "INDEX", exchange: "NSE" }
];

let instrumentCache = new Map();
let instrumentCacheAt = 0;

async function searchInstrument(query, segment, exchange) {
  const url = "https://api.upstox.com/v2/instruments/search";
  const params = { query, segment, exchange, page_number: 1, page_size: 10 };
  const res = await axios.get(url, {
    params,
    headers: { Accept: "application/json", Authorization: `Bearer ${TOKEN}` },
    timeout: 10000
  });
  const data = res.data?.data || [];
  return data.find(x => x.instrument_type === "EQ" || x.instrument_type === "INDEX") || data[0];
}

async function resolveInstruments() {
  if (!TOKEN) return;
  if (Date.now() - instrumentCacheAt < 6 * 60 * 60 * 1000 && instrumentCache.size) return;

  const all = [...WATCHLIST, ...INDEXES];
  const entries = await Promise.all(all.map(async item => {
    try {
      const found = await searchInstrument(item.symbol, item.segment === "INDEX" ? "INDEX" : "EQ", "NSE");
      return [item.label, found?.instrument_key || null];
    } catch {
      return [item.label, null];
    }
  }));

  instrumentCache = new Map(entries);
  instrumentCacheAt = Date.now();
}

function quoteToItem(label, quote) {
  const ohlc = quote?.ohlc || {};
  const last = Number(quote?.last_price ?? 0);
  const prev = Number(quote?.prev_close_price ?? ohlc.close ?? 0);
  const change = Number(quote?.net_change ?? (last - prev));
  const pct = prev ? (change / prev) * 100 : 0;
  return {
    label,
    price: last,
    change,
    percent: pct,
    open: Number(ohlc.open ?? 0),
    high: Number(ohlc.high ?? 0),
    low: Number(ohlc.low ?? 0),
    volume: Number(ohlc.volume ?? quote?.volume ?? 0),
    yearHigh: Number(quote?.year_high ?? 0),
    yearLow: Number(quote?.year_low ?? 0),
    timestamp: quote?.last_trade_time || null
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(TOKEN),
    message: TOKEN ? "Upstox token configured" : "Add UPSTOX_ACCESS_TOKEN to .env"
  });
});

app.get("/api/market", async (_req, res) => {
  if (!TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "UPSTOX_ACCESS_TOKEN is not configured on the server."
    });
  }

  try {
    await resolveInstruments();

    const pairs = [...instrumentCache.entries()].filter(([, key]) => key);
    const keys = pairs.map(([, key]) => key);
    if (!keys.length) throw new Error("No instruments could be resolved.");

    const response = await axios.get("https://api.upstox.com/v3/market-quote/quotes", {
      params: { instrument_key: keys.join(",") },
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`
      },
      timeout: 10000
    });

    const raw = response.data?.data || {};
    const byKey = new Map(Object.entries(raw));

    function findQuote(key) {
      const colonForm = key.replace("|", ":");
      if (byKey.has(colonForm)) return byKey.get(colonForm);
      const suffix = key.split("|")[1];
      const match = Object.entries(raw).find(([k]) => k.endsWith(suffix));
      return match ? match[1] : null;
    }

    const stocks = pairs
      .filter(([label]) => WATCHLIST.some(x => x.label === label))
      .map(([label, key]) => {
        const quote = findQuote(key);
        return quote ? quoteToItem(label, quote) : null;
      }).filter(Boolean);

    const indexes = pairs
      .filter(([label]) => INDEXES.some(x => x.label === label))
      .map(([label, key]) => {
        const quote = findQuote(key);
        return quote ? quoteToItem(label, quote) : null;
      }).filter(Boolean);

    res.json({
      ok: true,
      source: "Upstox Market Quote V3",
      updatedAt: new Date().toISOString(),
      stocks,
      indexes
    });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    res.status(status).json({ ok: false, error: "Upstox market-data request failed", detail });
  }
});

// Express 5 requires named wildcards — bare "*" throws at startup.
app.get("/*splat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`TradeVoice running on http://localhost:${PORT}`);
});
