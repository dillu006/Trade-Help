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


## Google Translation
Add `GOOGLE_TRANSLATE_API_KEY` to GitHub/Vercel Environment Variables. Enable Cloud Translation API in Google Cloud. The app endpoint is `/api/translate?text=...&target=te`.

## What changed in this update
- **Prices no longer go blank.** `/api/market` now tries Upstox first, then falls back to Yahoo Finance (no key needed) for NSE stocks/indices and global stocks, then finally a disk cache (`data/cache.json`) of the last real values seen. If Upstox's daily token expires and nothing refreshes, the app keeps showing the last known prices instead of dashes/₹0.00.
- **Foreign stock search works now.** `/api/search` fuzzy-matches typos (e.g. "Nividia") against the global stock/index list, not just NSE.
- **Real charts.** 1D/1W/1M/1Y buttons now call a new `/api/history` endpoint (Yahoo Finance candles) and draw the real series. No fabricated/straight-line data — if a feed is briefly down, the last real chart for that symbol+range is served from cache; if there's truly nothing yet, it says so honestly instead of faking a line.
- **Portfolio tab actually exists now.** It was missing from the HTML entirely, so tapping "Portfolio" just showed whatever Home content was underneath it. There's now a real Portfolio screen: add holdings (symbol/qty/avg price, stored on your device), live P&L, and a real value-over-time chart built from each holding's actual historical prices — not a fake trending line.
- **Selected-stock header** now shows the price range (day low–high) instead of repeating the company name twice.
- **News tab (new).** Live market-moving headlines (war, floods/disasters, crashes, gold, dollar/rupee) via Google News, with a language picker and a "read headlines aloud" button that translates via `/api/translate` before speaking — plus an optional auto-read toggle that announces new crisis-tagged headlines.
- Bottom nav (Home/Watchlist/Portfolio/News/Orders/Profile) now properly shows only one section at a time instead of stacking sections on top of each other.

Note: Upstox tokens still expire daily — that's on Upstox's side, not fixable in code. The Yahoo fallback means the app stays usable even on days you haven't refreshed the token.
