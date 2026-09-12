import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import UpstoxClient from "upstox-js-sdk";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json());
app.use(express.static("public"));
app.get("/", (_req,res)=>res.sendFile("index.html", {root: "public"}));

// ---------------------------------------------------------------------------
// Disk-backed cache. Upstox access tokens expire daily and the Yahoo feed can
// hiccup too, so instead of ever showing a blank/zero screen, TradeVoice keeps
// the last real values it saw and reloads them on process restart. This is
// what makes "no update today" behave like "still shows yesterday's numbers"
// instead of going blank.
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return {
      quotes: new Map(raw.quotes || []),
      global: new Map(raw.global || []),
      globalStocks: new Map(raw.globalStocks || []),
      history: new Map(raw.history || [])
    };
  } catch { return { quotes: new Map(), global: new Map(), globalStocks: new Map(), history: new Map() }; }
}
const cacheStore = loadCache();
let lastGoodQuote = cacheStore.quotes;         // key -> last quote with a real (non-zero) ltp
let lastGoodGlobal = cacheStore.global;        // symbol -> last global index quote
let lastGoodGlobalStocks = cacheStore.globalStocks; // symbol -> last global stock quote
let lastGoodHistory = cacheStore.history;      // "symbol:range" -> candle array

let saveTimer = null;
function persistCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        quotes: [...lastGoodQuote.entries()],
        global: [...lastGoodGlobal.entries()],
        globalStocks: [...lastGoodGlobalStocks.entries()],
        history: [...lastGoodHistory.entries()]
      }));
    } catch (e) { console.error("cache save failed:", e.message); }
  }, 400);
}

const STOCKS = [
  ["RELIANCE","Reliance Industries","R"],["TCS","Tata Consultancy Services","T"],
  ["INFY","Infosys","I"],["HDFCBANK","HDFC Bank","H"],["ICICIBANK","ICICI Bank","I"],
  ["SBIN","State Bank of India","S"],["TATAMOTORS","Tata Motors","T"],["BHARTIARTL","Bharti Airtel","B"]
].map(([symbol,name,icon])=>({symbol,name,icon}));

const INDICES = [
  {symbol:"NIFTY 50",name:"Nifty 50",key:"NSE_INDEX|Nifty 50",icon:"N",yahoo:"^NSEI"},
  {symbol:"NIFTY BANK",name:"Nifty Bank",key:"NSE_INDEX|Nifty Bank",icon:"B",yahoo:"^NSEBANK"},
  {symbol:"INDIA VIX",name:"India VIX",key:"NSE_INDEX|India VIX",icon:"V",yahoo:"^INDIAVIX"}
];

// Global indices/stocks for context (Dow, Nasdaq, Apple, etc). Informational
// only — reflects markets that already moved, never a crash predictor.
const GLOBAL_INDICES = [
  {symbol:"^DJI",name:"Dow Jones (US)",icon:"D"},
  {symbol:"^IXIC",name:"Nasdaq (US)",icon:"N"},
  {symbol:"^N225",name:"Nikkei 225 (Japan)",icon:"J"},
  {symbol:"^HSI",name:"Hang Seng (Hong Kong)",icon:"H"}
];
const GLOBAL_STOCKS = [
  {symbol:"AAPL",name:"Apple (US)",icon:"A"},
  {symbol:"MSFT",name:"Microsoft (US)",icon:"M"},
  {symbol:"NVDA",name:"NVIDIA (US)",icon:"N"},
  {symbol:"TSLA",name:"Tesla (US)",icon:"T"},
  {symbol:"AMZN",name:"Amazon (US)",icon:"A"},
  {symbol:"GOOGL",name:"Alphabet (US)",icon:"G"},
  {symbol:"META",name:"Meta (US)",icon:"M"}
];

let instrumentCache = new Map();
let liveQuotes = new Map();
let sseClients = new Set();
let streamer = null;

function headers() {
  if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is not configured");
  return {Authorization:`Bearer ${TOKEN}`,Accept:"application/json"};
}

// ---- fuzzy match helper (small dataset, so plain Levenshtein is fine) -----
function editDistance(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const dp = Array.from({length:a.length+1},(_, i)=>[i,...Array(b.length).fill(0)]);
  for (let j=0;j<=b.length;j++) dp[0][j]=j;
  for (let i=1;i<=a.length;i++) for (let j=1;j<=b.length;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j-1],dp[i-1][j],dp[i][j-1]);
  return dp[a.length][b.length];
}
function fuzzyMatchGlobal(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const pool = [...GLOBAL_STOCKS.map(s=>({...s,type:"stock"})), ...GLOBAL_INDICES.map(s=>({...s,type:"index"}))];
  return pool
    .map(item=>{
      const name = item.name.toLowerCase(), sym = item.symbol.toLowerCase();
      let score = 99;
      if (sym.includes(q) || name.includes(q)) score = 0;
      else {
        const words = name.replace(/[()]/g,"").split(/\s+/).concat([sym]);
        score = Math.min(...words.map(w=>editDistance(w.slice(0,Math.max(q.length,3)), q)));
      }
      return {item, score};
    })
    .filter(x=>x.score<=2)
    .sort((a,b)=>a.score-b.score)
    .map(x=>x.item);
}

async function resolveStock(s) {
  if (instrumentCache.has(s.symbol)) return {...s,...instrumentCache.get(s.symbol)};
  try {
    const r = await axios.get("https://api.upstox.com/v2/instruments/search",{
      headers:headers(), params:{query:s.symbol,exchanges:"NSE",segments:"EQ",records:10}
    });
    const rows=r.data?.data||[];
    const hit=rows.find(x=>String(x.trading_symbol||"").toUpperCase()===s.symbol) || rows[0];
    if(!hit?.instrument_key) throw new Error(`Instrument not found: ${s.symbol}`);
    instrumentCache.set(s.symbol,{key:hit.instrument_key,isin:hit.isin||hit.ISIN||null});
    return {...s,key:hit.instrument_key,isin:hit.isin||hit.ISIN||null};
  } catch {
    // Upstox unreachable/token dead — still return a usable key so Yahoo fallback works.
    return {...s,key:`NSE_EQ|${s.symbol}`,isin:null};
  }
}
async function stockMeta() { return Promise.all(STOCKS.map(resolveStock)); }

function withFallback(key, quote) {
  if (quote.ltp > 0) { lastGoodQuote.set(key, quote); persistCache(); return {...quote, stale:false}; }
  const cached = lastGoodQuote.get(key);
  if (cached) return {...cached, updatedAt:quote.updatedAt, stale:true};
  return {...quote, stale:true};
}

function normalQuote(meta,row={}) {
  const ltp=Number(row.last_price ?? row.ltp ?? 0);
  const cp=Number(row.prev_close_price ?? row.cp ?? row.close_price ?? 0);
  const change=cp?ltp-cp:0;
  const quote={...meta,ltp,cp,change,percent:cp?(change/cp)*100:0,
    open:Number(row.ohlc?.open ?? row.open_price ?? 0),
    high:Number(row.ohlc?.high ?? row.high_price ?? 0),
    low:Number(row.ohlc?.low ?? row.low_price ?? 0),
    volume:Number(row.volume ?? row.ohlc?.volume ?? 0),
    yearHigh:Number(row.year_high ?? 0),yearLow:Number(row.year_low ?? 0),
    updatedAt:Date.now()};
  return quote;
}

async function fetchUpstoxSnapshot(meta) {
  const keys=meta.map(x=>x.key).join(",");
  const r=await axios.get("https://api.upstox.com/v3/market-quote/quotes",{
    headers:headers(),params:{instrument_key:keys}
  });
  const rows=r.data?.data||{};
  return meta.map(m=>normalQuote(m,rows[m.key]||{}));
}

// Yahoo Finance quote endpoint needs no API key and works even when the
// Upstox token has expired, so it is used as an automatic fallback for NSE
// symbols (".NS") as well as the existing global stocks/indices.
async function fetchYahooQuotes(yahooSymbols) {
  if (!yahooSymbols.length) return new Map();
  const r = await axios.get("https://query1.finance.yahoo.com/v7/finance/quote",{
    params:{symbols:yahooSymbols.join(",")}, headers:{"User-Agent":"Mozilla/5.0"}, timeout:8000
  });
  const rows = r.data?.quoteResponse?.result || [];
  const out = new Map();
  for (const row of rows) {
    out.set(row.symbol, {
      ltp:Number(row.regularMarketPrice ?? 0),
      cp:Number(row.regularMarketPreviousClose ?? 0),
      change:Number(row.regularMarketChange ?? 0),
      percent:Number(row.regularMarketChangePercent ?? 0),
      open:Number(row.regularMarketOpen ?? 0),
      high:Number(row.regularMarketDayHigh ?? 0),
      low:Number(row.regularMarketDayLow ?? 0),
      volume:Number(row.regularMarketVolume ?? 0),
      yearHigh:Number(row.fiftyTwoWeekHigh ?? 0),
      yearLow:Number(row.fiftyTwoWeekLow ?? 0),
      currency:row.currency||"USD",
      marketState:row.marketState||null
    });
  }
  return out;
}

// Merge Upstox + Yahoo + disk cache, in that priority, for a real price.
async function getStockQuotes(stocks) {
  const meta = [...INDICES, ...stocks];
  let upstoxByKey = new Map();
  try {
    const snap = await fetchUpstoxSnapshot(meta);
    snap.forEach(q=>upstoxByKey.set(q.key,q));
  } catch (e) { /* Upstox unreachable — fall through to Yahoo/disk cache */ }

  const yahooSymbolFor = m => m.yahoo || `${m.symbol}.NS`;
  let yahooByKey = new Map();
  try {
    const yq = await fetchYahooQuotes(meta.map(yahooSymbolFor));
    meta.forEach(m=>{ const y = yq.get(yahooSymbolFor(m)); if (y) yahooByKey.set(m.key, y); });
  } catch { /* Yahoo unreachable too — disk cache will carry it */ }

  return meta.map(m=>{
    const up = upstoxByKey.get(m.key);
    const ya = yahooByKey.get(m.key);
    let base = null, source = "cache";
    if (up && up.ltp > 0) { base = up; source = "upstox"; }
    else if (ya && ya.ltp > 0) { base = {...m, ...ya}; source = "yahoo"; }
    const quote = base || {...m, ltp:0, cp:0, change:0, percent:0, open:0, high:0, low:0, volume:0, yearHigh:0, yearLow:0, updatedAt:Date.now()};
    quote.updatedAt = Date.now();
    const withFb = withFallback(m.key, quote);
    return {...withFb, source: withFb.stale ? "cache" : source};
  });
}

async function broadcast(obj) {
  const text=`data: ${JSON.stringify(obj)}\n\n`;
  for(const res of sseClients){try{res.write(text)}catch{ sseClients.delete(res); }}
}

async function startStream(meta) {
  if(!TOKEN || streamer) return;
  try {
    const api=UpstoxClient.ApiClient.instance;
    api.authentications.OAUTH2.accessToken=TOKEN;
    const all=[...INDICES,...meta];
    const keys=all.map(x=>x.key);
    streamer=new UpstoxClient.MarketDataStreamerV3(keys,"full");
    streamer.on("open",()=>console.log("Upstox V3 stream connected"));
    streamer.on("message",(data)=>{
      try{
        let msg=data;
        if(Buffer.isBuffer(data)){
          const text=data.toString("utf8");
          try{msg=JSON.parse(text)}catch{return;}
        } else if(typeof data==="string"){try{msg=JSON.parse(data)}catch{return;}}
        const feeds=msg?.feeds||{};
        for(const [key,feed] of Object.entries(feeds)){
          const ff=feed?.fullFeed?.marketFF || feed?.fullFeed || feed?.marketFF || feed;
          const ltpc=ff?.ltpc || feed?.ltpc;
          if(!ltpc || ltpc.ltp==null) continue;
          const old=liveQuotes.get(key)||{};
          const cp=Number(ltpc.cp ?? old.cp ?? 0), ltp=Number(ltpc.ltp);
          const q={...old, key, ltp, cp, change:cp?ltp-cp:0, percent:cp?((ltp-cp)/cp)*100:0,
            ltt:ltpc.ltt||null, ltq:Number(ltpc.ltq||0), updatedAt:Date.now(), stale:false};
          liveQuotes.set(key,q);
          if(ltp>0){ lastGoodQuote.set(key,q); persistCache(); }
          broadcast({type:"tick",...q});
        }
      }catch(e){console.error("tick decode:",e.message)}
    });
    streamer.on("error",e=>console.error("Upstox stream:",e?.message||e));
    streamer.autoReconnect(true,5,20);
    streamer.connect();
    console.log(`Streaming ${all.length} instruments`);
  } catch(e) { console.error("Streamer start failed:",e.message); streamer=null; }
}

// Google Cloud Translation: set GOOGLE_TRANSLATE_API_KEY in repo/Vercel env.
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
async function translateText(text, target) {
  if (target === "en") return text;
  if (!GOOGLE_TRANSLATE_API_KEY) return text;
  try {
    const r = await axios.post('https://translation.googleapis.com/language/translate/v2', null, {params:{q:text,target,format:'text',key:GOOGLE_TRANSLATE_API_KEY},timeout:10000});
    return r.data?.data?.translations?.[0]?.translatedText || text;
  } catch { return text; }
}
app.get('/api/translate', async (req,res)=>{
  try {
    const text = String(req.query.text || '').trim();
    const target = String(req.query.target || 'te').trim().toLowerCase();
    const allowed = new Set(['en','te','hi','ta','kn','ml','bn','mr','gu','pa','ur']);
    if (!text) return res.status(400).json({ok:false,error:'text is required'});
    if (!allowed.has(target)) return res.status(400).json({ok:false,error:'unsupported language'});
    if (target === 'en') return res.json({ok:true,translatedText:text,target});
    if (!GOOGLE_TRANSLATE_API_KEY) return res.status(503).json({ok:false,error:'GOOGLE_TRANSLATE_API_KEY not configured'});
    const translatedText = await translateText(text, target);
    res.json({ok:true,translatedText,target});
  } catch (e) {
    res.status(502).json({ok:false,error:'Translation service unavailable'});
  }
});

app.get("/api/health",(_req,res)=>res.json({ok:true,upstoxConfigured:Boolean(TOKEN),stream:!!streamer,time:new Date().toISOString()}));

app.get("/api/market",async(_req,res)=>{
  try{
    const stocks=await stockMeta();
    const snap=await getStockQuotes(stocks);
    snap.forEach(q=>liveQuotes.set(q.key,q));
    if(!streamer) startStream(stocks).catch(()=>{}); // startStream adds INDICES internally
    const degraded = snap.every(q=>q.source==="cache") && snap.length>0;
    res.json({ok:true,degraded,
      indices:snap.filter(q=>INDICES.some(i=>i.key===q.key)),
      stocks:snap.filter(q=>stocks.some(s=>s.key===q.key))});
  }catch(e){
    // Total failure (shouldn't really happen now) — still serve whatever is on disk
    // rather than an error screen, so the app looks like "yesterday" instead of blank.
    const stocks=STOCKS;
    const fallback = m => lastGoodQuote.get(m.key) || {...m, ltp:0, change:0, percent:0, stale:true};
    res.json({ok:true,degraded:true,
      indices:INDICES.map(fallback),
      stocks:stocks.map(s=>fallback({...s,key:`NSE_EQ|${s.symbol}`}))});
  }
});

app.get("/api/search",async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    if(!q)return res.json({ok:true,data:[]});
    let nse=[];
    try{
      const r=await axios.get("https://api.upstox.com/v2/instruments/search",{
        headers:headers(), params:{query:q.slice(0,60),exchanges:"NSE,BSE",segments:"EQ",records:20}
      });
      nse=(r.data?.data||[]).map(x=>({key:x.instrument_key,symbol:x.trading_symbol,name:x.name||x.short_name||x.trading_symbol,exchange:x.exchange,market:"IN"}));
    }catch{ /* Upstox unreachable — global fuzzy match below still works */ }
    const globalHits = fuzzyMatchGlobal(q).map(g=>({
      key:`GLOBAL|${g.symbol}`, symbol:g.symbol, name:g.name, exchange:g.type==="index"?"INDEX":"GLOBAL",
      market:"GLOBAL", cached: g.type==="stock" ? (lastGoodGlobalStocks.get(g.symbol)||null) : (lastGoodGlobal.get(g.symbol)||null)
    }));
    res.json({ok:true,data:[...nse,...globalHits]});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get("/api/stream",(_req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({type:"connected",time:new Date().toISOString()})}\n\n`);
  const hb=setInterval(()=>{try{res.write(": heartbeat\n\n")}catch{}},15000);
  res.on("close",()=>{clearInterval(hb);sseClients.delete(res)});
});

app.get("/api/global",async(_req,res)=>{
  try{
    const symbols=GLOBAL_INDICES.map(x=>x.symbol).join(",");
    const r=await axios.get("https://query1.finance.yahoo.com/v7/finance/quote",{
      params:{symbols}, headers:{"User-Agent":"Mozilla/5.0"}, timeout:8000
    });
    const rows=r.data?.quoteResponse?.result||[];
    const data=GLOBAL_INDICES.map(g=>{
      const row=rows.find(x=>x.symbol===g.symbol)||{};
      const ltp=Number(row.regularMarketPrice ?? 0);
      let out={...g,ltp,change:Number(row.regularMarketChange ?? 0),
        percent:Number(row.regularMarketChangePercent ?? 0),
        marketState:row.marketState||null,updatedAt:Date.now()};
      if(out.ltp>0){ lastGoodGlobal.set(g.symbol,out); out.stale=false; persistCache(); }
      else { const cached=lastGoodGlobal.get(g.symbol); out=cached?{...cached,updatedAt:Date.now(),stale:true}:{...out,stale:true}; }
      return out;
    });
    res.json({ok:true,data,note:"Informational only — reflects markets that already moved. Not a prediction."});
  }catch(e){
    const data=GLOBAL_INDICES.map(g=>lastGoodGlobal.get(g.symbol)||{...g,ltp:0,change:0,percent:0,stale:true});
    res.json({ok:true,data,degraded:true,note:"Global feed temporarily unavailable; showing last known values."});
  }
});

app.get("/api/global-stocks",async(_req,res)=>{
  try{
    const symbols=GLOBAL_STOCKS.map(x=>x.symbol).join(",");
    const r=await axios.get("https://query1.finance.yahoo.com/v7/finance/quote",{
      params:{symbols},headers:{"User-Agent":"Mozilla/5.0"},timeout:8000
    });
    const rows=r.data?.quoteResponse?.result||[];
    const data=GLOBAL_STOCKS.map(g=>{
      const row=rows.find(x=>x.symbol===g.symbol)||{};
      const out={...g,ltp:Number(row.regularMarketPrice||0),
        change:Number(row.regularMarketChange||0),
        percent:Number(row.regularMarketChangePercent||0),
        currency:row.currency||"USD",marketState:row.marketState||null,updatedAt:Date.now()};
      if(out.ltp>0){lastGoodGlobalStocks.set(g.symbol,out);persistCache();return {...out,stale:false};}
      return lastGoodGlobalStocks.get(g.symbol)||{...out,stale:true};
    });
    res.json({ok:true,data});
  }catch(e){
    res.json({ok:true,data:GLOBAL_STOCKS.map(g=>lastGoodGlobalStocks.get(g.symbol)||{...g,ltp:0,stale:true}),degraded:true});
  }
});

// ---------------------------------------------------------------------------
// Real price history for the chart's 1D/1W/1M/1Y ranges, via Yahoo Finance
// (no key required, works for both NSE ".NS" symbols and global tickers).
// If the feed is unreachable, the last successfully fetched series for that
// symbol+range is served from disk instead of ever inventing fake candles.
// ---------------------------------------------------------------------------
const RANGE_PARAMS = {
  "1D":{range:"1d",interval:"5m"},
  "1W":{range:"5d",interval:"15m"},
  "1M":{range:"1mo",interval:"1d"},
  "1Y":{range:"1y",interval:"1wk"}
};
app.get("/api/history", async (req,res)=>{
  const symbol=String(req.query.symbol||"").trim().toUpperCase();
  const isGlobal=String(req.query.global||"")==="1";
  const range=String(req.query.range||"1D").toUpperCase();
  if(!symbol || !RANGE_PARAMS[range]) return res.status(400).json({ok:false,error:"symbol and a valid range (1D/1W/1M/1Y) are required"});
  const yahooSymbol = isGlobal ? symbol : (INDICES.find(i=>i.symbol===symbol)?.yahoo || `${symbol}.NS`);
  const cacheKey = `${yahooSymbol}:${range}`;
  try{
    const {range:r,interval}=RANGE_PARAMS[range];
    const resp=await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`,{
      params:{range:r,interval}, headers:{"User-Agent":"Mozilla/5.0"}, timeout:8000
    });
    const result=resp.data?.chart?.result?.[0];
    const timestamps=result?.timestamp||[];
    const closes=result?.indicators?.quote?.[0]?.close||[];
    const points=timestamps.map((t,i)=>({t:t*1000,c:closes[i]})).filter(p=>Number.isFinite(p.c));
    if(!points.length) throw new Error("empty series");
    lastGoodHistory.set(cacheKey, points); persistCache();
    res.json({ok:true,symbol,range,points,stale:false});
  }catch(e){
    const cached=lastGoodHistory.get(cacheKey);
    if(cached) return res.json({ok:true,symbol,range,points:cached,stale:true,note:"Live history feed unavailable; showing last known chart."});
    res.json({ok:false,symbol,range,points:[],error:"No historical data available yet for this symbol/range."});
  }
});

app.get("/api/fundamentals", async (req,res)=>{
  try{
    const symbol=String(req.query.symbol||"").trim().toUpperCase();
    if(!symbol) return res.status(400).json({ok:false,error:"symbol is required"});
    const metaList=await stockMeta();
    let meta=metaList.find(x=>x.symbol===symbol);
    if(!meta){
      const r=await axios.get("https://api.upstox.com/v2/instruments/search",{
        headers:headers(),params:{query:symbol,exchanges:"NSE,BSE",segments:"EQ",records:20}
      });
      const rows=r.data?.data||[];
      const hit=rows.find(x=>String(x.trading_symbol||"").toUpperCase()===symbol)||rows[0];
      if(!hit?.instrument_key) return res.status(404).json({ok:false,error:"Instrument not found"});
      meta={symbol,name:hit.name||hit.short_name||symbol,key:hit.instrument_key,isin:hit.isin||hit.ISIN||null};
    }
    if(!meta.isin) return res.status(404).json({ok:false,error:"ISIN unavailable for this instrument"});
    const base=`https://api.upstox.com/v2/fundamentals/${encodeURIComponent(meta.isin)}`;
    const [rr,ir,pr]=await Promise.all([
      axios.get(`${base}/key-ratios`,{headers:headers()}),
      axios.get(`${base}/income-statement`,{headers:headers(),params:{type:"consolidated",time_period:"yearly",fs:"true"}}),
      axios.get(`${base}/profile`,{headers:headers()}).catch(()=>({data:{data:null}}))
    ]);
    const ratios={};
    for(const x of (rr.data?.data||[])) ratios[String(x.name).toUpperCase()]={company:x.company_value,sector:x.sector_value};
    const income=ir.data?.data?.income_statement||[];
    const eps=income.find(x=>String(x.category).toLowerCase()==="eps")?.history||[];
    let peg=null, epsGrowth=null;
    const h=eps.filter(x=>Number.isFinite(Number(x.value))).sort((a,b)=>String(b.period).localeCompare(String(a.period)));
    if(h.length>=2){
      const latest=Number(h[0].value), prev=Number(h[1].value);
      if(prev>0&&latest>0){
        epsGrowth=((latest-prev)/prev)*100;
        const pe=parseFloat(ratios["P/E"]?.company);
        if(Number.isFinite(pe)&&epsGrowth>0) peg=pe/epsGrowth;
      }
    }
    res.json({ok:true,symbol,name:meta.name,isin:meta.isin,
      ratios:{
        pe:ratios["P/E"]||null,pb:ratios["P/B"]||null,roce:ratios["ROCE"]||null,
        roe:ratios["ROE"]||null,roa:ratios["ROA"]||null,evEbitda:ratios["EV/EBITDA"]||null,
        roc:null,peg:peg===null?null:{company:peg.toFixed(2),sector:null},
        epsGrowth:epsGrowth===null?null:`${epsGrowth.toFixed(2)}%`
      },
      profile:pr.data?.data||null,
      note:{roc:"Separate ROC is not supplied by the Upstox key-ratios endpoint.",
            peg:peg===null?"PEG not calculated because reliable positive EPS growth was unavailable.":"PEG derived from P/E divided by latest year-over-year EPS growth."}
    });
  }catch(e){res.status(500).json({ok:false,error:e.response?.data?.errors?.[0]?.message||e.message||"Fundamentals failed"})}
});

app.post("/api/order/preview", express.json(), async (req,res)=>{
  try{
    const {symbol, transaction_type, quantity, order_type="MARKET", price=0, product="D"}=req.body||{};
    if(!symbol || !["BUY","SELL"].includes(transaction_type) || !Number.isInteger(Number(quantity)) || Number(quantity)<=0)
      return res.status(400).json({error:"Invalid order command"});
    const metaList=await stockMeta();
    const meta=metaList.find(x=>x.symbol===String(symbol).toUpperCase());
    if(!meta) return res.status(404).json({error:"Stock quote not available"});
    const snap=await getStockQuotes([meta]);
    const item=snap.find(x=>x.symbol===meta.symbol)||snap[0];
    res.json({
      ok:true, preview:true, symbol, transaction_type, quantity:Number(quantity),
      order_type, price:Number(price)||0, product,
      ltp:Number(item.ltp||0),
      message:`${transaction_type} ${quantity} ${symbol} ${order_type}`
    });
  }catch(e){ res.status(500).json({error:e.message||"Order preview failed"}); }
});

// ---------------------------------------------------------------------------
// Live market-moving news (war, floods, crash, gold/dollar moves, etc.) via
// Google News RSS — no API key needed. Headlines are translated on request
// through /api/translate so the voice panel can read them out in the
// person's selected language.
// ---------------------------------------------------------------------------
const NEWS_QUERIES = [
  "stock market crash", "sensex nifty today", "war news today",
  "gold price today", "dollar rupee today", "flood disaster news"
];
const CRISIS_KEYWORDS = [
  {re:/\bwar\b|military strike|missile|attack/i, tag:"war"},
  {re:/flood|cyclone|earthquake|disaster/i, tag:"disaster"},
  {re:/crash|plunge|tumbl|sell-?off|sinks?/i, tag:"crash"},
  {re:/gold price|gold rate/i, tag:"gold"},
  {re:/dollar|rupee|forex/i, tag:"currency"}
];
let newsCache = { items: [], updatedAt: 0 };

function stripCdata(s=""){ return s.replace(/^<!\[CDATA\[/,"").replace(/\]\]>$/,""); }
function parseRss(xml) {
  const items = [];
  const blocks = xml.split("<item>").slice(1);
  for (const block of blocks) {
    const get = tag => { const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)); return m ? stripCdata(m[1]).trim() : ""; };
    const title = get("title");
    const link = get("link");
    const pubDate = get("pubDate");
    const source = get("source");
    if (title) items.push({ title, link, pubDate, source });
  }
  return items;
}
function classify(title) {
  for (const k of CRISIS_KEYWORDS) if (k.re.test(title)) return k.tag;
  return "market";
}
async function fetchNewsOnce() {
  const seen = new Set();
  const all = [];
  for (const q of NEWS_QUERIES) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
      const r = await axios.get(url, { headers:{"User-Agent":"Mozilla/5.0"}, timeout:8000 });
      for (const item of parseRss(r.data).slice(0,6)) {
        const key = item.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        all.push({ ...item, tag: classify(item.title) });
      }
    } catch { /* skip this query, keep others */ }
  }
  all.sort((a,b)=> new Date(b.pubDate||0) - new Date(a.pubDate||0));
  return all.slice(0,20);
}
app.get("/api/news", async (_req,res)=>{
  try{
    if (Date.now() - newsCache.updatedAt > 90*1000) {
      const items = await fetchNewsOnce();
      if (items.length) newsCache = { items, updatedAt: Date.now() };
    }
    res.json({ ok:true, items:newsCache.items, updatedAt:newsCache.updatedAt,
      note:"Headlines from Google News. Informational only — not financial advice." });
  }catch(e){
    res.json({ ok:true, items:newsCache.items, updatedAt:newsCache.updatedAt, degraded:true });
  }
});
// A short translated + condensed line, ready for the browser's speechSynthesis.
app.get("/api/news/speak", async (req,res)=>{
  try{
    const target = String(req.query.lang||"en").trim().toLowerCase();
    const allowed = new Set(['en','te','hi','ta','kn','ml','bn','mr','gu','pa','ur']);
    const lang = allowed.has(target) ? target : 'en';
    if (Date.now() - newsCache.updatedAt > 90*1000) {
      const items = await fetchNewsOnce();
      if (items.length) newsCache = { items, updatedAt: Date.now() };
    }
    const top = newsCache.items.slice(0,3).map(x=>x.title);
    if (!top.length) return res.json({ ok:true, text:"" });
    const joined = top.join(". ");
    const translated = await translateText(joined, lang);
    res.json({ ok:true, text: translated, headlines: newsCache.items.slice(0,3) });
  }catch(e){ res.json({ ok:false, text:"" }); }
});

app.listen(PORT,()=>console.log(`TradeVoice: http://localhost:${PORT}`));
