# AI Handoff

Living project handoff for future AI collaborators. Update this file whenever architecture, trade-flow behavior, or debugging conclusions materially change.

## Purpose

This project has two connected parts:

1. A React/Vite trading dashboard in `src/`
2. A Chrome extension overlay in `extension/` that sits on Axiom pages and records paper trades into Supabase

The most important product requirement is:

- the buy-to-sell paper trade lifecycle must be trustworthy
- entry/exit market cap values should reflect what the user actually saw on Axiom at the moment of action
- dashboard sync must stay aligned with the overlay’s captured values

## Current state

As of 2026-05-11:

- `npm run build` passes
- project is **not** a git repo in the current workspace
- Supabase-backed sync is in use for paper trades
- open positions are tracked both locally in extension storage and canonically in Supabase

## Key files

- `extension/overlay.js`
  - main overlay UI
  - Axiom page detection
  - market cap capture logic
  - buy/sell paper trade sync
- `extension/overlay.css`
  - overlay layout and compact mode styling
- `extension/manifest.json`
  - content script registration
- `src/api.js`
  - Supabase client and trade/session loading
- `src/App.jsx`
  - dashboard UI and polling
- `src/utils.js`
  - imported trade merging and dashboard helpers

## Important trade-flow decisions

### 1. Market cap capture strategy

The overlay now uses:

- **primary source:** visible Axiom market cap text from the page DOM
- **fallback source:** derived estimate from script/websocket data

This is intentional. The user cares more about storing the number Axiom visibly showed at buy/sell time than about reconstructing a theoretically cleaner value from hidden feeds.

Relevant logic:

- `detectVisibleMarketCapFromPage()`
- `detectMarketCapFromPage()`
- `detectPageSnapshot()`

in `extension/overlay.js`

### 2. Canonical open-position model

Earlier versions treated the backend “open trade” row as something that became a closed trade row on sell, then spawned a new open row for the remainder. That was fragile.

Current model:

- while a position is open, it has one canonical Supabase row with notes starting with `__TD_OPEN__`
- that note stores structured JSON, not just a bare numeric size
- partial sells create a separate realized trade row and update the canonical open row
- full sells create a realized trade row and delete the canonical open row

This makes repeated buys and partial sells much easier to reason about.

Relevant helpers in `extension/overlay.js`:

- `encodeOpenTradeNote(position)`
- `parseOpenTradeNote(note, fallbackTrade)`
- `upsertCurrentPosition(current, sizeToAdd, snapshot)`
- `loadOpenPositionsFromBackend()`
- `deleteTrade(tradeId)`

### 3. Dashboard sync compatibility

`src/api.js` understands both:

- new structured `__TD_OPEN__{...json...}` notes
- old legacy `__TD_OPEN__0.1000` note format

That backward compatibility is deliberate and should be preserved unless a cleanup migration is done.

## Current overlay behavior

- top-left force-overlay badge removed
- live trades footer removed
- header shows:
  - current SOL position size
  - market cap
- compact mode keeps full width and only reduces height
- sell section shows quick actions only:
  - `10%`
  - `25%`
  - `50%`
  - `100%`
  - `Sell init`

## Axiom data detection notes

### Token detection

Best current DOM selector:

- `span.hidden.lg\:inline.xl\:hidden > div.min-w-0.overflow-hidden.truncate.whitespace-nowrap`

### Visible market cap selector

Primary selector currently used:

- `span.text-primaryLightBlue.sm\:text-textPrimary.text-\[18px\].font-medium.leading-\[23px\].\[font-variant-numeric\:tabular-nums\]`

If this selector breaks, the overlay falls back to heuristic DOM scanning and then derived data.

### Derived data inputs

The extension also collects:

- Axiom script-tag data:
  - pair info
  - token metadata
- websocket data:
  - `sol_price`
  - `b-${pairAddress}`

These support fallback MC estimation, but they are not the preferred source for persisted entry/exit MC values anymore.

The temporary header market-cap display was removed again after validation. Keep the DOM-first capture logic, but do not assume the MC must stay visible in the overlay UI.

## Reverse-engineering conclusions

We spent time trying to inspect MockApe’s exact buy flow through DevTools.

What we learned:

- no clear page `fetch`/XHR request was triggered on click
- no useful site websocket payload appeared on click
- service worker activity did not clearly light up on trade click
- page inspection produced signs of extension-internal messaging, but not a clean reusable implementation path

Conclusion:

- do not assume MockApe internals are worth chasing further unless a new clear lead appears
- prefer building our own robust DOM-first capture flow

## Known risks / things to watch

1. **Axiom selector drift**
   - if the visible token or market cap selector changes, capture quality will degrade

2. **Stale DOM at action time**
   - if Axiom visually lags during rapid movement, the overlay may capture stale MC
   - if this becomes noticeable, add a short “capture refresh” step immediately before buy/sell persistence

3. **Legacy open rows**
   - older Supabase open-position notes may still exist in numeric-only format
   - parser currently handles them

4. **One open position per token assumption**
   - overlay state now prefers `contractAddress` as the open-position key and falls back to `tokenName`
   - this was added because token-name-only matching had started to feel brittle

## Recommended next improvements

### High priority

- add explicit debug logging toggle for overlay trade capture:
  - token
  - market cap
  - market cap source
  - position size
  - backend row ids

- consider storing token address / pair address in open-position note payload

- verify repeated flow manually:
  1. buy `0.1`
  2. buy `0.2`
  3. sell `50%`
  4. sell `100%`
  5. confirm overlay and dashboard match

### Medium priority

- show capture source in a hidden debug mode, not normal UI
- build a small reconciliation check between local open positions and Supabase open rows

## How to update this file

Whenever you make a meaningful change, add or revise:

- what changed
- why it changed
- what assumptions now exist
- what another AI should avoid re-breaking

If you change trade persistence, Axiom selectors, or dashboard sync, update this file in the same task.
