"use strict";

const OPEN_POSITIONS_KEY = "td_open_positions";
const BG_PRICE_KEY = "td_bg_price";
const PROD_DASHBOARD_URL = "https://trading-dashboard-v8ns.onrender.com";
const LOCAL_DASHBOARD_URLS = [
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];

async function isReachableDashboard(url, timeoutMs = 900) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function getReachableLocalDashboardUrl() {
  for (const url of LOCAL_DASHBOARD_URLS) {
    if (await isReachableDashboard(url)) return url;
  }
  return null;
}

function getDashboardOrigins() {
  return [...LOCAL_DASHBOARD_URLS, PROD_DASHBOARD_URL]
    .map(url => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function openDashboardUrl(rawTargetUrl) {
  const targetUrl = String(rawTargetUrl);
  const target = new URL(targetUrl);
  const dashboardOrigins = getDashboardOrigins();
  const localOrigins = new Set(LOCAL_DASHBOARD_URLS.map(url => new URL(url).origin));
  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter(tab => {
    if (!tab.url) return false;
    try {
      return dashboardOrigins.includes(new URL(tab.url).origin);
    } catch {
      return false;
    }
  });

  const preferredExistingLocal = matchingTabs.find(tab => {
    try {
      return localOrigins.has(new URL(tab.url).origin);
    } catch {
      return false;
    }
  }) || null;
  const preferredExisting = preferredExistingLocal || matchingTabs[0] || null;

  let finalUrl = targetUrl;
  const reachableLocalDashboardUrl = preferredExistingLocal?.url || await getReachableLocalDashboardUrl();
  if (reachableLocalDashboardUrl) {
    try {
      const localOrigin = new URL(reachableLocalDashboardUrl).origin;
      const rewritten = new URL(targetUrl);
      rewritten.protocol = new URL(localOrigin).protocol;
      rewritten.host = new URL(localOrigin).host;
      finalUrl = rewritten.toString();
    } catch {
      finalUrl = targetUrl;
    }
  } else if (preferredExisting?.url) {
    try {
      const existingOrigin = new URL(preferredExisting.url).origin;
      const rewritten = new URL(targetUrl);
      rewritten.protocol = new URL(existingOrigin).protocol;
      rewritten.host = new URL(existingOrigin).host;
      finalUrl = rewritten.toString();
    } catch {
      finalUrl = targetUrl;
    }
  }

  if (preferredExistingLocal?.id) {
    await chrome.tabs.update(preferredExistingLocal.id, { url: finalUrl, active: true });
    if (preferredExistingLocal.windowId) await chrome.windows.update(preferredExistingLocal.windowId, { focused: true });
    return;
  }

  if (preferredExisting?.id && !reachableLocalDashboardUrl) {
    await chrome.tabs.update(preferredExisting.id, { url: finalUrl, active: true });
    if (preferredExisting.windowId) await chrome.windows.update(preferredExisting.windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url: finalUrl, active: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "td_sync_dashboard_state") {
    (async () => {
      try {
        const dashboardOrigins = getDashboardOrigins();
        const tabs = await chrome.tabs.query({});
        const dashboardTabs = tabs.filter(tab => {
          if (!tab.url || !tab.id) return false;
          try {
            return dashboardOrigins.includes(new URL(tab.url).origin);
          } catch {
            return false;
          }
        });

        await Promise.all(dashboardTabs.map(tab => (
          chrome.tabs.sendMessage(tab.id, {
            type: "td_sync_dashboard_state",
            balance: message.balance ?? null,
            openPositions: message.openPositions ?? {},
          }).catch(() => {})
        )));
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || "Failed to sync dashboard state." });
      }
    })();
    return true;
  }

  if (!message?.url) return;
  if (message.type !== "td_open_dashboard_balance" && message.type !== "td_open_dashboard") return;

  (async () => {
    try {
      await openDashboardUrl(message.url);
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || "Failed to open dashboard." });
    }
  })();

  return true;
});

// Returns Set of distinct pairAddresses across all open positions
async function getActivePairAddresses() {
  const stored = await chrome.storage.local.get([OPEN_POSITIONS_KEY]);
  const positions = stored[OPEN_POSITIONS_KEY] || {};
  const addrs = new Set();
  for (const pos of Object.values(positions)) {
    if (pos?.pairAddress) addrs.add(pos.pairAddress);
  }
  return addrs;
}

// Only check positions whose pairAddress matches the fetched price
async function notifyAutoExitIfNeeded(marketCapUsd, pairAddress) {
  if (!(marketCapUsd > 0)) return;
  const { [OPEN_POSITIONS_KEY]: positions = {} } = await chrome.storage.local.get(OPEN_POSITIONS_KEY);
  let triggered = false;
  for (const pos of Object.values(positions)) {
    if (!pos?.positionId || !(pos.entryMarketCap > 0)) continue;
    if (pos.pairAddress !== pairAddress) continue;
    const pnlPct = ((marketCapUsd / pos.entryMarketCap) - 1) * 100;

    const stopMode = pos.stopLossMode || "pct";
    if (stopMode === "mc" && pos.stopLossMarketCap > 0 && marketCapUsd <= pos.stopLossMarketCap) { triggered = true; break; }
    if (stopMode !== "mc" && pos.stopLossPct !== null && pos.stopLossPct < 0 && pnlPct <= pos.stopLossPct) { triggered = true; break; }

    const targetMode = pos.targetSellMode || "pct";
    if (targetMode === "mc" && pos.targetSellMarketCap > 0 && marketCapUsd >= pos.targetSellMarketCap) { triggered = true; break; }
    if (targetMode !== "mc" && pos.targetSellPct > 0 && pnlPct >= pos.targetSellPct) { triggered = true; break; }
  }
  if (!triggered) return;
  const tabs = await chrome.tabs.query({ url: ["https://axiom.trade/*", "https://*.axiom.trade/*"] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "td_check_auto_exit" }).catch(() => {});
  }
}

// BG_PRICE_KEY now stores a map: { [pairAddress]: { marketCapUsd, priceNative, solPriceUsd, ts } }
async function pollPrice() {
  const pairAddresses = await getActivePairAddresses();
  if (!pairAddresses.size) {
    await chrome.storage.local.remove(BG_PRICE_KEY);
    return;
  }

  const { [BG_PRICE_KEY]: existing = {} } = await chrome.storage.local.get(BG_PRICE_KEY);
  const priceMap = typeof existing === "object" && existing !== null && !Array.isArray(existing) ? { ...existing } : {};

  for (const pairAddress of pairAddresses) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pair = data?.pairs?.[0];
      if (!pair) continue;

      const marketCapUsd = Number(pair.marketCap || pair.fdv || 0);
      const priceNative = Number(pair.priceNative || 0);
      const solPriceUsd = priceNative > 0 && Number(pair.priceUsd || 0) > 0
        ? Number(pair.priceUsd) / priceNative : 0;

      if (marketCapUsd > 0) {
        priceMap[pairAddress] = { marketCapUsd, priceNative, solPriceUsd, ts: Date.now() };
        await notifyAutoExitIfNeeded(marketCapUsd, pairAddress);
      }
    } catch (_) {
      // network error — keep last known value for this pair
    }
  }

  await chrome.storage.local.set({ [BG_PRICE_KEY]: priceMap });
}

// Poll every 30 seconds via alarms (reliable in MV3 service workers)
chrome.alarms.create("price_poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "price_poll") pollPrice();
});

// Poll immediately on worker startup
pollPrice();
