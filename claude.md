# Trading Dashboard — Project Context

## Hvad er dette?
Et personligt SOL memecoin trading dashboard bygget med React + Vite.
Tracket P/L, regel-overholdelse og historik for paper trades lavet via MockApe/Axiom.

## Stack
- **React 18** med hooks (useState, useEffect, useRef)
- **Vite 5** som build tool
- **Ingen CSS framework** — al styling er inline React styles
- **localStorage** til data persistering (key: `trading_v9`)
- **Canvas API** til equity kurve chart (ingen chart library)
- **Google Fonts**: Fraunces (serif display) + DM Sans (body)

## Projekt struktur
```
src/
  App.jsx       — Hoved-komponent, al UI og state
  utils.js      — Shared logic: regler, formattering, theme, import
  data.js       — REAL_DATA: hardcoded historiske sessioner
  main.jsx      — React entry point
  index.css     — Minimal global CSS (scrollbar, input reset)
index.html      — HTML entry med Google Fonts
vite.config.js  — Vite config (port 3000 dev, 4173 preview)
package.json
```

## Data model
### Session
```js
{
  date: "2026-05-09",          // ISO date string
  instrument: "SOL Memecoins",
  grossPnl: 0.57175,           // Sum af alle trade pnl (uden fees)
  fees: 0.08,                  // Antal trades × 0.01 SOL
  notes: "...",
  tradeList: [Trade]
}
```

### Trade
```js
{
  id: 1,
  instrument: "LANI",
  pnl: 0.50767,          // Gross P/L i SOL
  pnlPct: 126.92,        // Procent gain/loss
  entryMC: 14400,        // Entry market cap i USD
  exitMC: 34300,         // Exit market cap i USD
  notes: "+127%",
  timestamp: 1778264737161
}
```

## Regler der trackes
1. **Entry MC > $10.000** — ingen trades under 10K market cap
2. **Stop loss ≤ −30%** — exit senest ved −30%
3. **Max 5 trades per time** — ingen overtrade

## Fees
Fast 0.01 SOL per trade (≈ 5% af standard 0.2 SOL position).
Net P/L = gross P/L − (antal trades × 0.01)

## Theme system
Fuld dark/light mode via `THEME` objekt i `utils.js`.
Detekterer system preference via `window.matchMedia`.
Accent farve: `#c9a96e` (varm kobber/guld).
Grøn: `#3ec98a` | Rød: `#e8604c`

## Import flow
Brugeren kører dette i MockApe's service worker console:
```js
chrome.storage.local.get(['trades'], (d) => console.log(JSON.stringify(d.trades)))
```
Og paster output i "⬆ Import" tab'en.
`importRawTrades()` i utils.js parser Axiom/MockApe JSON format og merger ind i eksisterende sessioner.

## Render deployment
- **Build command**: `npm run build`
- **Start command**: `npm run preview`
- **Port**: 4173 (preview) eller sæt `PORT` env variable
- Output: `dist/` folder

## Tilføj ny session
Tilføj til `REAL_DATA` array i `src/data.js` — OBS: localStorage overskriver
default data efter første load. Bump `STORAGE_KEY` i App.jsx hvis du vil resette til ny data.

## Vigtige detaljer
- `netPnl(session)` bruger tradeList hvis den findes, ellers grossPnl − fees
- `sessionViolations(session)` returnerer array af { rule, detail, token? }
- Calendar viser grøn/rød baseret på net P/L per dag
- Modal slides op fra bunden (iOS-style sheet)
- Data gemmes automatisk i localStorage ved enhver state-ændring
