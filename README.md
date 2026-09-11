# TradeVoice Web App — Best Clean Build

Web-app-only Indian market dashboard using a server-side Upstox integration.

## Included
- Clean broker-style responsive dashboard
- Stocks + indices
- Company search
- Selected stock chart with live tick history
- Live LTP, change, %, OHLC, volume and available 52-week fields
- Date, year, hour, minute and second visible
- Long press stock actions
- Watchlist UI
- Price alert UI
- 1-second voice mode
- English / Hindi / Telugu voice language selector
- Voice announcement contains stock, price, date/year and exact seconds
- IPO / Mutual Funds / Gold navigation areas
- Fundamentals placeholders for PE / ROCE / ROC / P/B / PEG; no fabricated values
- Upstox access token remains server-side

## Run
1. Copy `.env.example` to `.env`
2. Set `UPSTOX_ACCESS_TOKEN`
3. `npm install`
4. `npm start`
5. Open `http://localhost:3000`

## Accuracy
Market prices come from the configured Upstox API/feed and depend on account permissions and market availability.
Browser speech voices depend on the voices installed by the device/browser. The app selects the requested `en-IN`, `hi-IN`, or `te-IN` voice when available and falls back to a matching language voice.
Fundamental ratios must come from a verified fundamentals provider before being displayed.
No order placement is included.
