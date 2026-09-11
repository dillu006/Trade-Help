import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

// Surface any crash with a clear, labeled message instead of a bare exit code 1.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err?.stack || err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err?.stack || err);
  process.exit(1);
});

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

// label -> original trading symbol (needed to match Upstox's response keys,
// which use the trading symbol, not the ISIN embedded in the instrument_key)
const LABEL_TO_SYMBOL = new Map([...WATCHLIST, ...INDEXES].map(x => [x.label, x.symbol]));

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
      if (item.segment === "INDEX") {
        const found = await searchInstrument(item.symbol, "INDEX", "NSE");
        return [item.label, found?.instrument_key || null];
      }
      const found = await searchInstrument(item.symbol, "EQ", "NSE");
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

// Find the matching quote for a label out of Upstox's response object.
// Upstox v3 quote keys look like "NSE_EQ:RELIANCE" or "NSE_INDEX:Nifty 50" —
// i.e. EXCHANGE_SEGMENT:TRADING_SYMBOL. We match on that trading symbol
// instead of the ISIN that lives inside the instrument_key.
function findQuote(raw, byKey, label, instrumentKey) {
  const directLookup = instrumentKey.replace("|", ":");
  if (byKey.has(directLookup)) return byKey.get(directLookup);

  const symbol = LABEL_TO_SYMBOL.get(label);
  if (symbol) {
    const bySymbol = Object.entries(raw).find(([k]) => k.endsWith(":" + symbol));
    if (bySymbol) return bySymbol[1];
  }

  // last-resort: match by label text appearing in the key (handles index
  // names like "Nifty 50" that Upstox echoes verbatim)
  const byLabelText = Object.entries(raw).find(([k]) =>
    k.toLowerCase().includes(label.toLowerCase())
  );
  return byLabelText?.[1] || null;
}

app.get("/api/health", async (_req, res) => {
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

    const stocks = pairs
      .filter(([label]) => WATCHLIST.some(x => x.label === label))
      .map(([label, key]) => {
        const quote = findQuote(raw, byKey, label, key);
        return quote ? quoteToItem(label, quote) : null;
      }).filter(Boolean);

    const indexes = pairs
      .filter(([label]) => INDEXES.some(x => x.label === label))
      .map(([label, key]) => {
        const quote = findQuote(raw, byKey, label, key);
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

app.get("/*splat", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`[OK] TradeVoice running on port ${PORT}`);
  console.log(`[OK] Upstox token configured: ${Boolean(TOKEN)}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[FATAL] Port ${PORT} is already in use.`);
  } else {
    console.error("[FATAL] Server failed to start:", err?.stack || err);
  }
  process.exit(1);
});
