"use strict";

const OPEN_POSITIONS_KEY = "td_open_positions";
const BG_PRICE_KEY = "td_bg_price";

async function getActivePairAddress() {
  const stored = await chrome.storage.local.get([OPEN_POSITIONS_KEY]);
  const positions = stored[OPEN_POSITIONS_KEY] || {};
  for (const pos of Object.values(positions)) {
    if (pos.pairAddress) return pos.pairAddress;
  }
  return null;
}

async function pollPrice() {
  const pairAddress = await getActivePairAddress();
  if (!pairAddress) {
    await chrome.storage.local.remove(BG_PRICE_KEY);
    return;
  }

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`);
    if (!res.ok) return;
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (!pair) return;

    const marketCapUsd = Number(pair.marketCap || pair.fdv || 0);
    const priceNative = Number(pair.priceNative || 0);
    const solPriceUsd = priceNative > 0 && Number(pair.priceUsd || 0) > 0
      ? Number(pair.priceUsd) / priceNative : 0;

    if (marketCapUsd > 0) {
      await chrome.storage.local.set({
        [BG_PRICE_KEY]: {
          pairAddress,
          marketCapUsd,
          priceNative,
          solPriceUsd,
          ts: Date.now(),
        }
      });
    }
  } catch (_) {
    // network error — keep last known value
  }
}

// Poll every 30 seconds via alarms (reliable in MV3 service workers)
chrome.alarms.create("price_poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "price_poll") pollPrice();
});

// Poll immediately on worker startup
pollPrice();
