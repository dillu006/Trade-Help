import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import UpstoxClient from "upstox-js-sdk";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN;

app.use(express.json());
app.use(express.static("public"));
app.get("/", (_req,res)=>res.sendFile("index.html", {root: "public"}));

// Google Cloud Translation: set GOOGLE_TRANSLATE_API_KEY in repo/Vercel env.
const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
app.get('/api/translate', async (req,res)=>{
  try {
    const text = String(req.query.text || '').trim();
    const target = String(req.query.target || 'te').trim().toLowerCase();
    const allowed = new Set(['en','te','hi','ta','kn','ml','bn','mr','gu','pa','ur']);
    if (!text) return res.status(400).json({ok:false,error:'text is required'});
    if (!allowed.has(target)) return res.status(400).json({ok:false,error:'unsupported language'});
    if (target === 'en') return res.json({ok:true,translatedText:text,target});
    if (!GOOGLE_TRANSLATE_API_KEY) return res.status(503).json({ok:false,error:'GOOGLE_TRANSLATE_API_KEY not configured'});
    const r = await axios.post('https://translation.googleapis.com/language/translate/v2', null, {params:{q:text,target,format:'text',key:GOOGLE_TRANSLATE_API_KEY},timeout:10000});
    const translatedText = r.data?.data?.translations?.[0]?.translatedText || text;
    res.json({ok:true,translatedText,target});
  } catch (e) {
    res.status(502).json({ok:false,error:'Translation service unavailable'});
  }
});


const STOCKS = [
  ["RELIANCE","Reliance Industries","R"],["TCS","Tata Consultancy Services","T"],
  ["INFY","Infosys","I"],["HDFCBANK","HDFC Bank","H"],["ICICIBANK","ICICI Bank","I"],
  ["SBIN","State Bank of India","S"],["TATAMOTORS","Tata Motors","T"],["BHARTIARTL","Bharti Airtel","B"]
].map(([symbol,name,icon])=>({symbol,name,icon}));
const INDICES = [
  {symbol:"NIFTY 50",name:"Nifty 50",key:"NSE_INDEX|Nifty 50",icon:"N"},
  {symbol:"NIFTY BANK",name:"Nifty Bank",key:"NSE_INDEX|Nifty Bank",icon:"B"},
  {symbol:"INDIA VIX",name:"India VIX",key:"NSE_INDEX|India VIX",icon:"V"}
];
// Global indices that commonly move Indian markets on the next session
// (overnight US action, Asia open, etc). Yahoo Finance's public quote
// endpoint needs no API key. This is informational only — it is NOT a
// crash predictor. No system can reliably predict a market crash from
// news; this just shows what already happened elsewhere for context.
const GLOBAL_INDICES = [
  {symbol:"^DJI",name:"Dow Jones (US)",icon:"D"},
  {symbol:"^IXIC",name:"Nasdaq (US)",icon:"N"},
  {symbol:"^N225",name:"Nikkei 225 (Japan)",icon:"J"},
  {symbol:"^HSI",name:"Hang Seng (Hong Kong)",icon:"H"}
];
let lastGoodGlobal = new Map();
const GLOBAL_STOCKS = [
  {symbol:"AAPL",name:"Apple (US)",icon:"A"},
  {symbol:"MSFT",name:"Microsoft (US)",icon:"M"},
  {symbol:"NVDA",name:"NVIDIA (US)",icon:"N"},
  {symbol:"TSLA",name:"Tesla (US)",icon:"T"},
  {symbol:"AMZN",name:"Amazon (US)",icon:"A"},
  {symbol:"GOOGL",name:"Alphabet (US)",icon:"G"},
  {symbol:"META",name:"Meta (US)",icon:"M"}
];
let lastGoodGlobalStocks = new Map();

let instrumentCache = new Map();
let liveQuotes = new Map();
let lastGoodQuote = new Map(); // key -> last quote that had a real (non-zero) ltp
let sseClients = new Set();
let streamer = null;

function headers() {
  if (!TOKEN) throw new Error("UPSTOX_ACCESS_TOKEN is not configured");
  return {Authorization:`Bearer ${TOKEN}`,Accept:"application/json"};
}

async function resolveStock(s) {
  if (instrumentCache.has(s.symbol)) return {...s,...instrumentCache.get(s.symbol)};
  const r = await axios.get("https://api.upstox.com/v2/instruments/search",{
    headers:headers(), params:{query:s.symbol,exchanges:"NSE",segments:"EQ",records:10}
  });
  const rows=r.data?.data||[];
  const hit=rows.find(x=>String(x.trading_symbol||"").toUpperCase()===s.symbol) || rows[0];
  if(!hit?.instrument_key) throw new Error(`Instrument not found: ${s.symbol}`);
  instrumentCache.set(s.symbol,{key:hit.instrument_key,isin:hit.isin||hit.ISIN||null});
  return {...s,key:hit.instrument_key,isin:hit.isin||hit.ISIN||null};
}

async function stockMeta() {
  return Promise.all(STOCKS.map(resolveStock));
}

// If a fresh quote has a real price, remember it. If a fresh quote comes back
// empty/zero (e.g. market closed, feed hiccup), fall back to the last known
// good price instead of showing ₹0.00, and mark it as "stale" so the UI can
// label it (e.g. "as of last close") if desired.
function withFallback(key, quote) {
  if (quote.ltp > 0) { lastGoodQuote.set(key, quote); return {...quote, stale:false}; }
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
  return withFallback(meta.key, quote);
}

async function fetchSnapshot(meta) {
  const keys=meta.map(x=>x.key).join(",");
  const r=await axios.get("https://api.upstox.com/v3/market-quote/quotes",{
    headers:headers(),params:{instrument_key:keys}
  });
  const rows=r.data?.data||{};
  return meta.map(m=>normalQuote(m,rows[m.key]||{}));
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
          if(ltp>0) lastGoodQuote.set(key,q);
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

app.get("/api/health",(_req,res)=>res.json({ok:true,upstoxConfigured:Boolean(TOKEN),stream:!!streamer,time:new Date().toISOString()}));

app.get("/api/market",async(_req,res)=>{
  try{
    const stocks=await stockMeta();
    const all=[...INDICES,...stocks];
    const snap=await fetchSnapshot(all);
    snap.forEach(q=>liveQuotes.set(q.key,q));
    if(!streamer) await startStream(stocks); // startStream adds INDICES internally
    res.json({ok:true,indices:snap.filter(q=>INDICES.some(i=>i.key===q.key)),stocks:snap.filter(q=>stocks.some(s=>s.key===q.key))});
  }catch(e){res.status(500).json({ok:false,error:e.message})}
});

app.get("/api/search",async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    if(!q)return res.json({ok:true,data:[]});
    const r=await axios.get("https://api.upstox.com/v2/instruments/search",{
      headers:headers(),params:{query:q.slice(0,60),exchanges:"NSE,BSE",segments:"EQ",records:20}
    });
    res.json({ok:true,data:(r.data?.data||[]).map(x=>({key:x.instrument_key,symbol:x.trading_symbol,name:x.name||x.short_name||x.trading_symbol,exchange:x.exchange}))});
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

// Global indices for context (Dow, Nasdaq, Nikkei, Hang Seng). This is
// informational only, meant to show what has already happened overnight
// in other markets — it is NOT a crash predictor. No feed can reliably
// tell you in advance that a crash is coming; treat this as context, not
// a signal to act on.
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
      if(out.ltp>0){ lastGoodGlobal.set(g.symbol,out); out.stale=false; }
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
      if(out.ltp>0){lastGoodGlobalStocks.set(g.symbol,out);return {...out,stale:false};}
      return lastGoodGlobalStocks.get(g.symbol)||{...out,stale:true};
    });
    res.json({ok:true,data});
  }catch(e){
    res.json({ok:true,data:GLOBAL_STOCKS.map(g=>lastGoodGlobalStocks.get(g.symbol)||{...g,ltp:0,stale:true}),degraded:true});
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
    const snap=await fetchSnapshot([meta]);
    const item=snap[0];
    res.json({
      ok:true, preview:true, symbol, transaction_type, quantity:Number(quantity),
      order_type, price:Number(price)||0, product,
      ltp:Number(item.ltp||item.last_price||0),
      message:`${transaction_type} ${quantity} ${symbol} ${order_type}`
    });
  }catch(e){ res.status(500).json({error:e.message||"Order preview failed"}); }
});

app.listen(PORT,()=>console.log(`TradeVoice Final: http://localhost:${PORT}`));
