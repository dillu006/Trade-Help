# TradeVoice Live — Upstox

A ready-to-run live market-data dashboard.

## What's included
- `server.js` — Express backend (Upstox Market Quote V3 + Instrument Search)
- `public/index.html` — the dashboard frontend, with a Telugu voice toggle
- `package.json` — dependencies

What is already done:
- Express backend
- Upstox Analytics Token authentication via environment variable
- Upstox Market Quote V3
- Automatic instrument lookup using Upstox Instrument Search
- NIFTY 50 / BANK NIFTY / INDIA VIX lookup
- NSE stocks: Reliance, TCS, Infosys, HDFC Bank, ICICI Bank, SBI, Tata Motors, Bharti Airtel
- Live refresh every 10 seconds
- Telugu browser voice toggle
- No order placement

## Run locally

Put your private Upstox Analytics Token into a `.env` file (never commit this file):

```
UPSTOX_ACCESS_TOKEN=YOUR_TOKEN
```

Then:

```
npm install
npm start
```

Open: http://localhost:3000

## Deploy on Render (no computer needed)

1. Push these files to a GitHub repo (keep `public/index.html` inside the `public` folder — the server serves it from there).
2. On [Render](https://render.com), create a **New Web Service** from that repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add an environment variable: `UPSTOX_ACCESS_TOKEN` = your token
6. Deploy — Render gives you a live `https://yourapp.onrender.com` link.

## Important

Never upload/share your Analytics Token, client secret, PAN/Aadhaar, or KYC documents.

The app uses Upstox's current Full Market Quotes V3 endpoint. Upstox documents up to 500 instruments per request and recommends unique `instrument_key` values. Instrument Search can resolve a small set of symbols without manually maintaining instrument keys.
