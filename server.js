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

let instrumentCache = new Map();
let liveQuotes = new Map();
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

function normalQuote(meta,row={}) {
  const ltp=Number(row.last_price ?? row.ltp ?? 0);
  const cp=Number(row.prev_close_price ?? row.cp ?? row.close_price ?? 0);
  const change=cp?ltp-cp:0;
  return {...meta,ltp,cp,change,percent:cp?(change/cp)*100:0,
    open:Number(row.ohlc?.open ?? row.open_price ?? 0),
    high:Number(row.ohlc?.high ?? row.high_price ?? 0),
    low:Number(row.ohlc?.low ?? row.low_price ?? 0),
    volume:Number(row.volume ?? row.ohlc?.volume ?? 0),
    yearHigh:Number(row.year_high ?? 0),yearLow:Number(row.year_low ?? 0),
    updatedAt:Date.now()};
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
    const keys=meta.map(x=>x.key);
    const all=[...INDICES,...meta];
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
            ltt:ltpc.ltt||null, ltq:Number(ltpc.ltq||0), updatedAt:Date.now()};
          liveQuotes.set(key,q);
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
    if(!streamer) await startStream(stocks);
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
      ltp:Number(item.last_price||item.ltp||0),
      message:`${transaction_type} ${quantity} ${symbol} ${order_type}`
    });
  }catch(e){ res.status(500).json({error:e.message||"Order preview failed"}); }
});

app.listen(PORT,()=>console.log(`TradeVoice Final: http://localhost:${PORT}`));
