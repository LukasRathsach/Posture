# Trading Dashboard — Developer Handoff

_LLM-optimized. Feed this file at the start of any new session. Update whenever architecture, trade-flow behavior, or data model changes._

Last updated: 2026-05-14 (security + reliability hardening pass)

---

## What this project is

**Posture** is a paper trading tool for Solana meme coins on [Axiom](https://axiom.trade). It teaches trading discipline by letting users trade with a virtual SOL balance on the real Axiom interface — same charts, same price action, no real money at risk. Trades are logged with the exact market cap the user saw on screen at action time, then reviewed through a calendar-style dashboard.

### Core product loop
1. User sets a virtual SOL balance in the extension
2. Navigates to any token on Axiom — the overlay appears automatically
3. Buys and sells using the overlay panel (no real on-chain execution)
4. Entry/exit market caps are captured from the Axiom page DOM at action time
5. Trades persist to Supabase; the dashboard shows a full session history

### Non-negotiable priorities (in order)
1. **Buy/sell must always work and record correctly.** A failed or wrong trade record makes the tool worthless.
2. **Market cap values must reflect what the user saw.** DOM-first capture exists for this — it's intentional, not a hack.
3. **Data must never be lost.** Open positions survive page reloads, offline periods, and extension restarts.

---

## Hard rules — read before touching any code

These are explicit constraints. Do not deviate from them without the user asking.

**Never do:**
- Push to GitHub unless the user explicitly asks
- Add blue accent borders or border glows — removed by user request, do not re-add
- Re-add compact mode — permanently removed, do not re-add
- Re-add the drag-dot indicator — removed, dragging still works via header bar
- Add hover or press states that move controls or shift their position — buttons, pills, toggles, and links must keep a fixed footprint; tooltips and other floating helper UI may animate independently
- Use a CSS framework or utility classes — inline styles everywhere in JSX
- Add comments that describe what code does — only comment non-obvious WHY
- Make the extension settings panel inline (pushing content down) — it must be a floating popup

**Always do:**
- Inline styles in `App.jsx` JSX — only use `src/index.css` for pseudo-elements, animations, scrollbar
- Update this file when you change trade persistence, Axiom selectors, or the sync protocol
- Update `extension/trade-contract.js` first if you change the `__TD_OPEN__` / `__TD_CLOSE__` note payload, then verify both `extension/overlay.js` and `src/api.js`
- Update local state before Supabase in any sell/close operation — local state must always be correct

---

## System architecture

Two connected parts:

```
Axiom page (Chrome tab)
  └── extension/overlay.js        Content script — overlay UI + trade logic
  └── extension/background.js     Service worker — price polling every 30s via chrome.alarms

Dashboard page (React/Vite)
  └── extension/dashboard-bridge.js  Content script — bridges chrome.storage ↔ localStorage + postMessage

Supabase (Postgres + Auth)
  └── user_sessions               JSON blob of all sessions per user
  └── user_paper_trades           One row per trade event (open, partial close, full close)
```

The extension and dashboard communicate through `chrome.storage.local` (synced by the bridge) and `window.postMessage`. There is no custom server — Supabase is the only backend.

---

## Codebase map

```
extension/
  overlay.js            Most important file. All overlay UI + trade logic + Axiom detection
  overlay.css           Overlay styles (no framework)
  background.js         MV3 service worker — DexScreener price polling, tab routing
  dashboard-bridge.js   Content script on dashboard — storage ↔ localStorage bridge
  manifest.json         MV3 manifest
  config.js             Dashboard origin constants (prod + localhost)

src/
  App.jsx               Entire dashboard UI — intentionally a single large component
  api.js                Supabase client + all data access; parses note formats
  utils.js              P/L math, trade merge, shared constants
  index.css             Global CSS — minimal, only what can't be done inline
```

---

## Key functions reference

Knowing these saves significant navigation time.

### `extension/overlay.js`
| Function | What it does |
|---|---|
| `detectPageSnapshot()` | Builds current token/MC snapshot from page; calls all detection layers |
| `detectVisibleMarketCapFromPage()` | Primary MC source — scrapes Axiom's displayed MC text |
| `findAxiomPairInfoFromNextData()` | Reads token ticker, full name, CA, pair address from `__NEXT_DATA__` |
| `upsertCurrentPosition(current, sizeToAdd, snapshot)` | Creates or spreads into an open position using harmonic mean entry |
| `closeTrade(fraction, options)` | Handles all sell logic — updates local state first, then Supabase |
| `enqueueClose(item)` | Queues a failed Supabase close to `td_close_queue` in chrome.storage |
| `flushCloseQueue()` | Attempts to flush queued closes; called on reconnect |
| `maybeRunAutoExit(trigger)` | Checks stop loss / target sell and fires closeTrade if hit |
| `encodeOpenTradeNote(position)` | Serializes position to `__TD_OPEN__{...json...}` string |
| `loadOpenPositionsFromBackend()` | Loads all `__TD_OPEN__` rows from Supabase on init |
| `saveOpenPositions(positions)` | Writes positions to `chrome.storage.local.td_open_positions` |
| `render()` | Full overlay re-render — called after any state change |

### `src/api.js`
| Function | What it does |
|---|---|
| `loadOpenPaperTrades(userId)` | Loads all `__TD_OPEN__` rows and parses them |
| `loadClosedPaperTrades(userId)` | Loads all non-open trade rows |
| `saveSessions(userId, sessions)` | Upserts full sessions blob to Supabase |
| `deletePaperTradesByIds(ids)` | Batch delete by row id |

### Shared trade contract

`extension/trade-contract.js` is now the single source of truth for:
- `__TD_OPEN__` / `__TD_CLOSE__` prefixes
- open-trade note encoding
- open/close note parsing
- legacy bare-number fallback parsing

If you change the note payload, update this file first and then verify both the
extension and dashboard still consume it correctly.

### `src/App.jsx`
| Location | What it does |
|---|---|
| `ACCENT_PRESETS` (top of file) | 5 theme presets with full dark color overrides |
| `displayTradeGroups` (~line 765) | Groups trades by token for session modal display |
| `posture-bridge` postMessage listener | Handles balance/session/open-positions from extension bridge |

---

## Data model

### Supabase tables

**`user_sessions`**
```
user_id   uuid
sessions  jsonb    -- full array of session objects, one blob per user
```

**`user_paper_trades`**
```
id                uuid
user_id           uuid
token_name        text
pnl_sol           numeric
pnl_percentage    numeric
entry_market_cap  numeric
exit_market_cap   numeric
notes             text         -- structured payload, see below
trade_timestamp   timestamptz
```

### The `notes` field — most important data structure

**Open position:** `notes = "__TD_OPEN__" + JSON.stringify({...})`

Full payload shape:
```js
{
  positionId:          string,   // unique id for this position
  tokenName:           string,   // ticker, e.g. "FLT"
  tokenFullName:       string,   // human name, e.g. "Flute" — from Axiom __NEXT_DATA__
  contractAddress:     string,   // Solana mint address — PRIMARY KEY for position matching
  pairAddress:         string,   // DexScreener pair address — used for price polling
  positionSizeSol:     number,   // current remaining size in SOL
  initialSizeSol:      number,   // size at first open (P/L % denominator)
  entryMarketCap:      number,   // harmonic-mean-weighted entry MC (NOT arithmetic)
  realizedPnlSol:      number,   // accumulates with each partial sell
  openedAt:            number,   // unix ms timestamp
  pageUrl:             string,
  marketCapSource:     string,   // "visible-dom" | "next-data" | "websocket" | etc.
  stopLossPct:         number|null,
  stopLossMode:        "pct"|"mc",
  stopLossMarketCap:   number|null,
  targetSellPct:       number|null,
  targetSellMode:      "pct"|"mc",
  targetSellMarketCap: number|null,
  entryCapture:        object|null,
  lastCapture:         object|null,
  events:              array,    // capped audit timeline
}
```

**Closed trade:** `notes = "__TD_CLOSE__" + JSON.stringify({...})` — close audit metadata (timestamp, trigger, MC at close, etc.)

**Legacy open row:** `notes = "__TD_OPEN__0.1000"` — bare number format from older versions. `parseOpenTradeNote()` handles this. Do not remove that branch without a migration.

### `chrome.storage.local` keys

| Key | Writer | Contents |
|---|---|---|
| `td_session` | overlay.js | Supabase auth session JSON |
| `td_virtual_balance` | both, via bridge | Virtual SOL balance (number) |
| `td_open_positions` | overlay.js | `{ [positionId]: positionObject }` |
| `td_bg_price` | background.js | `{ [pairAddress]: { marketCapUsd, priceNative, solPriceUsd, ts } }` — map over ALL open positions' pair addresses |
| `td_close_queue` | overlay.js | Array of `{ closeTradePayload, openTradeIdToDelete, updatedOpenPosition, queuedAt, retries }` — dead-letters after 10 retries into `td_close_queue_dead` |

---

## Trade lifecycle

### Buy
1. `detectPageSnapshot()` — captures token, CA, pair address, MC from page
2. `upsertCurrentPosition()` — creates or adds to position using harmonic mean entry MC
3. Supabase: upsert `__TD_OPEN__` row with encoded position JSON
4. Decrement `td_virtual_balance` in chrome.storage
5. Update `state.openPositions`; call `render()`

### Sell (partial or full)
1. Compute: sold SOL value, P/L, new remaining size, updated `realizedPnlSol`
2. **Update local state immediately (unconditional)** — balance restored, position shrunk or removed
3. Attempt Supabase sync:
   - Create `__TD_CLOSE__` trade row
   - Partial sell: update `__TD_OPEN__` row with new size + `realizedPnlSol`
   - Full sell: delete `__TD_OPEN__` row
4. If Supabase fails: call `enqueueClose()` — payload queued to `td_close_queue`
5. Queue flushes on next: session restore, sign-in, or `chrome.storage.onChanged` for session key

**Rule: local state is always correct. The backend eventually catches up.**

### Auto-exit (stop loss / target sell)
Two independent triggers, both call `maybeRunAutoExit()`:

1. `chrome.storage.onChanged` watching `td_bg_price` — fires even when the Axiom tab is backgrounded
2. `chrome.tabs.sendMessage({ type: "td_check_auto_exit" })` sent from `background.js` after each price poll — covers cases where the storage event doesn't fire

`background.js` checks thresholds before sending the message, so content scripts aren't woken unnecessarily.

---

## P/L accounting

### Entry MC on re-buys: harmonic mean (not arithmetic)

```js
const oldTokenBasis  = current.positionSizeSol / current.entryMarketCap;
const newTokenBasis  = addSize / snapshot.marketCap;
const weightedEntryMC = nextPositionSizeSol / (oldTokenBasis + newTokenBasis);
```

Arithmetic mean (`(oldMC × oldSize + newMC × newSize) / totalSize`) is **wrong** — it understates how many tokens you own when adding to a winner. The harmonic mean correctly reflects that higher MC = fewer tokens per SOL.

### Live P/L formula

```js
livePnlSol = (positionSizeSol × (currentMC / entryMC - 1)) + realizedPnlSol;
livePnlPct = livePnlSol / initialSizeSol × 100;
```

`realizedPnlSol` accumulates on the open position object with each partial sell. Without this, taking profit on a partial position and then seeing a dip would show as an overall loss even if you're up.

---

## Market cap capture strategy

Priority order (first successful source wins):

1. **Visible DOM** — Axiom's displayed MC number scraped by `detectVisibleMarketCapFromPage()`. Primary source. Preferred because it's what the user saw.
2. **`__NEXT_DATA__`** — Next.js server-injected data in a script tag, read by `findAxiomPairInfoFromNextData()`. Also captures `tokenFullName` and `contractAddress`.
3. **WebSocket data** — Axiom pushes live prices; the extension intercepts `sol_price` and `b-${pairAddress}` messages.
4. **Derived estimate** — SOL price × supply. Last resort.

**Axiom's DOM changes without notice.** If MC or token detection breaks, check the CSS selectors in `detectVisibleMarketCapFromPage()` and `findAxiomPairInfoFromNextData()` first.

Current key selectors:
- MC: `span.text-primaryLightBlue.sm\:text-textPrimary.text-\[18px\].font-medium...`
- Token: `span.hidden.lg\:inline.xl\:hidden > div.min-w-0.overflow-hidden.truncate.whitespace-nowrap`

`tokenFullName` is best-effort. If Axiom doesn't expose it in `__NEXT_DATA__`, the field stays `null` and UI degrades gracefully to ticker-only.

---

## Extension ↔ Dashboard sync

`extension/dashboard-bridge.js` is a content script running at `document_start` on dashboard pages. It bridges `chrome.storage.local` to the dashboard's `window` environment.

### On load, bridge:
1. Reads `td_session` → writes to `localStorage` (Supabase key) before React mounts
2. Reads `td_virtual_balance` → sends `posture-bridge` balance postMessage
3. Reads `td_open_positions` → sends `posture-bridge` open-positions postMessage

### Message protocol

**Dashboard → Bridge** (`source: "posture-page"`):
- `session_update` — auth changed; write session to chrome.storage
- `request_balance` — re-broadcast current balance
- `balance_update` — user changed balance; write to chrome.storage
- `reset_balance` — set balance to 0 in chrome.storage
- `open_positions_update` — dashboard deleted a trade; update chrome.storage

**Bridge → Dashboard** (`source: "posture-bridge"`):
- `balance` — confirmed value from chrome.storage
- `open_positions` — current open positions

The dashboard requests balance on load and on tab focus. `td_virtual_balance` is the single source of truth — never trust only `localStorage`.

---

## Dashboard architecture

`src/App.jsx` is a single large component — intentional, do not split unless the user asks.

**Session storage:** loaded from Supabase on mount; `localStorage` used as a cache for instant initial render. Writes go to both.

**Open positions:** injected from extension via `posture-bridge` postMessage; held in a separate `useState`. Not derived from session trade history.

**Trade grouping in session modal:** trades are grouped by `tokenName` before display. Multiple partial sells on the same token show as one row. `__TD_OPEN__` placeholder rows are filtered from display (counted for fees but not shown as completed trades). Relevant: `displayTradeGroups` computed value around line 765.

**Theme system:** `ACCENT_PRESETS` at top of `App.jsx` — 5 presets (`axiom`, `amber`, `teal`, `violet`, `rose`). Each has `base`, `dim`, and a full `dark` color override. Active preset persisted to `localStorage` under `posture_accent_key`. Light mode always uses `THEME.light` — accent presets only affect dark mode.

**Dashboard settings panel:** gear icon in header; contains theme, sign out (`signOutUser()`), and delete account (`deleteCurrentUser()` — calls `sb.rpc("delete_user")` then `sb.auth.signOut()`, gated behind `window.confirm`).

---

## Extension overlay UI

**Header:** 3-column grid
```
[positions-toggle  stats-icon]  [SOL-logo  balance]  [gear-icon]
```

- **Gear icon:** opens a floating popup (position: absolute) — not inline. Clicking outside closes it. Contains: theme toggle, virtual balance link, advanced trading toggle, sign out. Do not make this inline again.
- **Gear icon CSS gotcha:** base `.td-overlay-icon-btn svg` applies `fill: none; stroke: currentColor`. The gear uses a fill-based SVG. Override on `.td-overlay-icon-btn-settings svg`: `fill: currentColor; stroke: none; stroke-width: 0`.
- **Position summary** (Invested / Sold / Remaining / P/L): always visible when a position is open. Not gated.
- **Stop loss / target sell inputs:** only shown when `state.advancedTrading === true`.
- **Balance tooltip** ("Add more SOL"): appears **above** the balance, not below. `bottom: calc(100% + 7px)`.

---

## Known fragile areas

| Area | Risk | Where to look |
|---|---|---|
| Axiom DOM selectors | Axiom deploys without notice; MC/token capture silently degrades | `detectVisibleMarketCapFromPage()`, `findAxiomPairInfoFromNextData()` |
| Stale DOM at action time | Rapid price movement → captured MC lags visual | Add pre-buy/sell capture refresh if reported |
| Legacy open rows | Older notes in bare `__TD_OPEN__0.1000` format still exist | `parseOpenTradeNote()` in `api.js` — do not remove legacy branch |
| Position storage key stability | Positions are stored under `storageKey` (stamped at buy time). Always use `current.storageKey \|\| getPositionKey(current)` to delete — never recompute the key at close time. | `closeTrade()`, `state.openPositions` |
| `td_bg_price` format | Now a map `{ [pairAddress]: {...} }` not a flat object. `state.bgPrice[pairAddress]` to get a specific entry. | `background.js`, `getEstimatedLiveMarketCapUsd()` |
| MV3 service worker suspension | Chrome suspends background workers; `setInterval` would die | Price polling uses `chrome.alarms` — do not change to setInterval |

---

## Local development

Extension bridge injects on:
- `https://trading-dashboard-v8ns.onrender.com/*`
- `http://localhost/*` and `http://127.0.0.1/*`

When a localhost dashboard tab is already open, the extension prefers it over production — intentional for local testing without deploying.

1. `npm run dev` — dashboard at `localhost:5173`
2. Load `extension/` as an unpacked extension in Chrome
3. Navigate to any Axiom token page

`npm run build` must pass before any commit.

---

## Roadmap

### Up next
- **Dashboard polish + attention to detail** — loading treatments, tighter modal/button states, clearer empty/error/success surfaces, and cleaner async feedback without changing the core product shape.
- **Closer Axiom simulation** — move this up immediately after the polish pass: richer live-trade context, clearer simulation audit trail, and stronger parity between dashboard and extension state presentation.
- **Extension ↔ dashboard sync edge cases** — reload, new tab, extension restart. The happy path works; edge cases are untested.

### Medium-term
- Replace DOM-scraping for MC with a real data feed (DexScreener WebSocket or Birdeye API) — more reliable, less fragile to Axiom DOM changes.
- Use `pairAddress` as the canonical position key — more stable than `contractAddress` across token redeployments.

### Long-term
- Deeper Axiom simulation fidelity: slippage, priority fees, realistic fill modeling once the closer dashboard/extension simulation loop feels solid.
