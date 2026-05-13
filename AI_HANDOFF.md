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

As of 2026-05-12 (latest):

- `npm run build` passes
- project is a git repo (branch: `main`)
- Supabase-backed sync is in use for paper trades
- open positions are tracked both locally in extension storage and canonically in Supabase
- session auto-sync between extension and dashboard is live via `extension/dashboard-bridge.js`

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

### 0. P/L accounting — must match Axiom

**Entry price on multiple buys: token-weighted harmonic mean, not arithmetic mean.**

When the user buys the same token multiple times, buying at a higher MC gets you fewer tokens per SOL. The correct weighted average entry is:

```js
const oldTokenBasis = current.positionSizeSol / current.entryMarketCap;
const newTokenBasis  = addSize / snapshot.marketCap;
const weightedEntryMC = nextPositionSizeSol / (oldTokenBasis + newTokenBasis);
```

The old arithmetic formula `(oldMC × oldSize + newMC × newSize) / totalSize` is **wrong** — it understates gains when adding to a winner.

**Live P/L = realized + unrealized.**

Each partial sell accumulates `realizedPnlSol` on the open position object (persisted in the `__TD_OPEN__` note JSON). The displayed P/L is:

```js
livePnlSol = (remainingSize × (currentMC / entryMC - 1)) + realizedPnlSol;
livePnlPct = livePnlSol / initialSizeSol × 100;
```

This prevents the confusing case where partial sells at profit + a small remaining-position dip shows as an overall loss.

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

Current note payload now also carries richer audit / automation state when present:

- `entryCapture`
- `lastCapture`
- `events`
- `stopLossPct`
- `targetSellPct`

Realized close rows may now also use a structured `__TD_CLOSE__{...}` note payload for close audit metadata.

### 3. Dashboard sync compatibility

`src/api.js` understands both:

- new structured `__TD_OPEN__{...json...}` notes
- old legacy `__TD_OPEN__0.1000` note format

That backward compatibility is deliberate and should be preserved unless a cleanup migration is done.

## Current overlay behavior

- header is a 3-column grid: `[positions toggle + stats icon] [SOL icon + balance centered] [person icon]`
- positions toggle (list icon / live trades icon) sits left of the stats icon at all times; shows/hides the positions nav panel; turns green when active
- stats icon (bar chart) is an `<a>` that opens the dashboard URL in a new tab
- person icon opens a minimal menu with only `Sign out` when authenticated
- open positions can store stop loss / target sell percentages in the open-note payload
- stop loss / target sell are checked against live P/L % and auto-close the paper trade when hit
- auto-close now resolves against the already-known live capture / live MC path instead of forcing a second brittle DOM scrape at trigger time when possible
- position audit state is appended to the open-note payload via capture metadata and a capped event timeline
- **compact mode has been removed entirely** — do not re-add it
- **drag-dot indicator removed** — dragging still works via the header bar
- sell section shows quick actions: `10%`, `25%`, `50%`, `100%`; "Sell init." is far right on its own row
- section labels (Buy / Sell / Positions) are 11px, weight 500, uppercase
- SOL icon (Solana gradient logo) is shown inline with the balance number
- hovering the SOL balance shows the tooltip: `"need more SOL? add here"`
- no "Set balance to start trading" prompts anywhere in the main flow

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

## Dashboard trade list — grouping behaviour

Trades in the session modal are **grouped by instrument (token name)** before display. Multiple partial sells on the same token appear as a single row showing combined net P/L.

- `__TD_OPEN__` placeholder records are filtered out of the display (they appear in `tradeList` for fee counting but are not shown as completed trades)
- A group with multiple closes shows a `"N CLOSES"` label
- The `%` shown is a weighted average across all closes
- The delete button on a grouped row deletes all individual trade records in the group
- The underlying `tradeList` data is unchanged — fee/stat calculations still see individual records

Relevant: `displayTradeGroups` computed value in `src/App.jsx`, defined near line 765.

## Dashboard UI conventions

- **Inline styles everywhere** — this project does not use a CSS framework. Add styles inline in JSX. Only add to `src/index.css` for things that genuinely cannot be done inline (pseudo-elements, animations, scrollbar).
- **Blue accent borders are paused** — removed at user request. Do not re-add unless asked.
- **Do not push to GitHub** without the user explicitly asking.

## Dashboard settings panel

A settings panel is accessible via the sliders icon in the header (right of sign out). It provides:

1. **Theme** — 4 color presets (amber, teal, violet, rose). Each preset changes both the accent color AND the full background/surface palette (`bg`, `surface1`–`3`, `border`, etc.). Selection is persisted to `localStorage` under `posture_accent_key`.
2. **Virtual balance** — SOL balance for paper trading purposes. Stored in `localStorage` under `posture_virtual_balance`. The "Reset balance" button also fires `window.postMessage({ source: "posture-page", type: "reset_balance" }, "*")`, which `extension/dashboard-bridge.js` picks up and clears `td_virtual_balance` from `chrome.storage.local`.

### Theme implementation

`ACCENT_PRESETS` is defined at the top of `App.jsx` (before any useState hooks). Each preset includes `base`, `dim`, and a `dark` object with full color overrides. The active theme is computed as:

```js
const tk = dark
  ? { ...THEME.dark, ...activeAccentPreset.dark, modalBg: ..., modalSurf: ... }
  : THEME.light;
```

A `useEffect` also updates `document.body.style.background` when the key changes. Light mode always uses `THEME.light` (unchanged).

## Dashboard header layout

Desktop: `[SOL icon + P/L] | [user icon + name + streak] [currency toggle] || [settings icon] [sign out]`
- SOL+P/L is the leftmost item; sign out is the rightmost
- The right section is `grid-template-columns: minmax(0, 1fr) auto`

Mobile: `[SOL+P/L + user icon + name + streak] ... [currency toggle] [settings icon] [sign out]`

## Mission goals ("Next focus" rail)

All 3 goals are always shown, including completed ones (no `filter(!done)` anymore). Completed goals render with green text, a green checkmark, and a full green bar.

## Session sync (extension ↔ dashboard)

`extension/dashboard-bridge.js` runs as a content script on the dashboard URL at `document_start`. It:
1. Reads `td_session` from `chrome.storage.local`
2. Writes it to `localStorage` under the Supabase key before Supabase initialises
3. Also sends a `posture-bridge` postMessage as a fallback
4. Mirrors `td_virtual_balance` into dashboard `localStorage` and sends a `posture-bridge` balance message
5. Mirrors `td_open_positions` into dashboard `localStorage` and sends a `posture-bridge` open-position message
4. Listens for `posture-page` messages:
   - `type: "session_update"` — writes/clears `td_session` in chrome.storage
   - `type: "balance_update"` — writes `td_virtual_balance` in chrome.storage
   - `type: "reset_balance"` — removes `td_virtual_balance` from chrome.storage (so extension overlay resets to 0)

`src/App.jsx` listens for the bridge postMessages and:
- calls `supabase.auth.setSession()` if needed
- accepts injected balance updates from the extension
- accepts injected extension open positions for reconciliation UI
- posts balance changes back through `posture-page`

On auth state change, the dashboard postMessages back so the extension auto-logs in.

## Dashboard live-position trust surface

The right rail `Live positions` section now does more than list token + size:

- shows a reconciliation health summary between backend open rows and extension local open positions
- shows capture source / capture time for each open position
- shows stop loss / target sell values when configured
- shows a capped activity timeline sourced from the open-note `events` array

If you change the open-note payload shape, update both:

- `extension/overlay.js`
- `src/api.js`

If you change realized trade audit metadata, also update:

- `extension/overlay.js` (`__TD_CLOSE__`)
- `src/api.js`
- `src/utils.js`

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
