(function () {
  if (window.__POSTURE_AXIOM_OVERLAY__) return;
  window.__POSTURE_AXIOM_OVERLAY__ = true;

  const config = window.POSTURE_EXTENSION_CONFIG;
  const storage = chrome.storage.local;
  const tradeContract = globalThis.PostureTradeContract;
  if (!tradeContract) {
    throw new Error("Missing PostureTradeContract.");
  }

  const Sentry = window.Sentry || null;
  if (Sentry && config?.sentryDsn) {
    Sentry.init({
      dsn: config.sentryDsn,
      environment: "production",
      tracesSampleRate: 0,
    });
  }

  function sentryUser(user) {
    if (!Sentry || !user) return;
    Sentry.setUser({ id: user.id });
  }

  function sentryCrumb(category, message, data) {
    if (!Sentry) return;
    Sentry.addBreadcrumb({ category, message, data, level: "info" });
  }

  function sentryError(error, context) {
    if (!Sentry) return;
    Sentry.captureException(error, { extra: context });
  }
  const OPEN_POSITIONS_KEY = "td_open_positions";
  const EXTENSION_ENABLED_KEY = "td_extension_enabled";
  const FORCE_OVERLAY_KEY = "td_force_overlay";
  const OVERLAY_POSITION_KEY = "td_overlay_position";
  const VIRTUAL_BALANCE_KEY = "td_virtual_balance";
  const BG_PRICE_KEY = "td_bg_price";
  const OVERLAY_DARK_THEME_KEY = "td_overlay_dark_theme";
  const OPEN_TRADE_NOTE_PREFIX = tradeContract.OPEN_TRADE_NOTE_PREFIX;
  const CLOSE_TRADE_NOTE_PREFIX = tradeContract.CLOSE_TRADE_NOTE_PREFIX;
  const MAX_POSITION_EVENTS = 12;
  const FEE_PER_TRADE = 0.01;
  const BUY_PRESETS = [0.1, 0.2, 0.4, 1];
  const SELL_PRESETS = [10, 25, 50, 100];
  const STOP_LOSS_ENABLED_KEY = "td_stop_loss_enabled";
  const TARGET_SELL_ENABLED_KEY = "td_target_sell_enabled";
  const SIMULATION_SETTINGS_KEY = "td_simulation_settings";
  const CLOSE_QUEUE_KEY = "td_close_queue";
  const SIM_DEFAULTS = { slippagePct: null, execDelayMs: null };

  const state = {
    session: null,
    user: null,
    enabled: true,
    liveOpen: false,
    trades: [],
    openPositions: {},
    detected: null,
    authBusy: false,
    tradeBusy: false,
    status: "",
    statusTone: "neutral",
    position: { top: 242, left: 224 },
    forceOverlay: false,
    pairInfo: null,
    tokenMetadata: null,
    dexData: null,
    solPriceUsd: null,
    livePairPriceNative: null,
    virtualBalance: 0,
    settingsOpen: false,
    posNavOpen: false,
    bgPrice: null,
    darkTheme: true,
    automationDrafts: {},
    stopLossEnabled: false,
    simSettings: { ...SIM_DEFAULTS },
    tradeStatus: null,
    caCopiedUntil: 0,
  };

  let pageRefreshTimer = null;
  let lastPageKey = "";
  let dragState = null;
  let liveDataRenderTimer = null;
  let statusDismissTimer = null;
  let historyPatched = false;
  let routeBurstTimers = [];
  const root = document.createElement("div");
  root.className = "td-overlay-root";
  document.documentElement.appendChild(root);

  function handleSocketPayload(data) {
    const room = String(data?.room || "");
    let changed = false;
    if (!room) return;

    if (room === "sol_price") {
      const nextSolPrice = Number(data.content || 0);
      if (Number.isFinite(nextSolPrice) && nextSolPrice > 0) {
        state.solPriceUsd = nextSolPrice;
        changed = true;
      }
    }

    const activePairAddress = state.dexData?.pairAddress || state.pairInfo?.pairAddress || state.detected?.pairAddress;
    const activeTokenAddress = state.detected?.contractAddress;
    const isPriceRoom = room.startsWith("b-") && (
      (activePairAddress && room === `b-${activePairAddress}`) ||
      (activeTokenAddress && room === `b-${activeTokenAddress}`)
    );
    if (isPriceRoom) {
      const nextPairPrice = Number(data.content || 0);
      if (Number.isFinite(nextPairPrice) && nextPairPrice > 0) {
        if (!state._wsRefPrice) state._wsRefPrice = nextPairPrice;
        state.livePairPriceNative = nextPairPrice;
        changed = true;
      }
    }

    if (changed && shouldShowOverlay()) {
      clearTimeout(liveDataRenderTimer);
      liveDataRenderTimer = window.setTimeout(() => {
        patchLiveData();
        void maybeRunAutoExit("socket-update");
      }, 16);
    }
  }

  const VALID_TONES = new Set(["neutral", "good", "bad"]);
  function setStatus(message, tone) {
    clearTimeout(statusDismissTimer);
    state.status = message || "";
    state.statusTone = VALID_TONES.has(tone) ? tone : "neutral";
    if (tone === "good" && message) {
      statusDismissTimer = window.setTimeout(() => {
        state.status = "";
        renderUnlessEditing();
      }, 3000);
    }
  }

  function debugLog(...args) {
    console.log("[Posture]", ...args);
  }

  async function saveFeatureToggles() {
    await storage.set({ [STOP_LOSS_ENABLED_KEY]: state.stopLossEnabled });
  }

  async function saveSimSettings() {
    await storage.set({ [SIMULATION_SETTINGS_KEY]: state.simSettings });
  }

  // Returns a fill-price multiplier simulating Axiom/Solana slippage.
  // side="buy" → entry MC is inflated (you pay more); side="sell" → exit MC is deflated.
  function getSlippageMultiplier(sizeSol, side) {
    const custom = state.simSettings?.slippagePct;
    let pct;
    if (custom != null && custom >= 0) {
      pct = custom / 100;
    } else {
      const base = 0.015;
      const sizeImpact = Math.min(sizeSol * 0.02, 0.03);
      const variance = (Math.random() - 0.5) * 0.01;
      pct = Math.max(0, base + sizeImpact + variance);
    }
    return side === "buy" ? 1 + pct : 1 - pct;
  }

  // Simulates Solana transaction confirmation latency.
  // Auto mode: 400–1200ms base, 15% congestion path up to ~2800ms.
  async function simulateExecDelay() {
    const custom = state.simSettings?.execDelayMs;
    let ms;
    if (custom != null && custom >= 0) {
      ms = custom;
    } else {
      ms = 400 + Math.random() * 800;
      if (Math.random() < 0.15) ms += 1100 + Math.random() * 1300;
    }
    if (ms > 0) await new Promise(r => setTimeout(r, ms));
  }

  function getDashboardBalanceUrl() {
    try {
      const url = new URL(config.dashboardUrl);
      url.searchParams.set("modal", "balance");
      return url.toString();
    } catch {
      return config.dashboardUrl;
    }
  }

  function openDashboardBalanceModal() {
    const url = getDashboardBalanceUrl();
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "td_open_dashboard_balance", url }, () => {
        void chrome.runtime?.lastError;
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openDashboard() {
    const url = config.dashboardUrl;
    if (chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "td_open_dashboard", url }, () => {
        void chrome.runtime?.lastError;
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function request(path, options) {
    return fetch(`${config.supabaseUrl}${path}`, options).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error_description || data.msg || data.message || "Request failed.");
      }
      return data;
    });
  }

  function getAuthHeaders(accessToken, extraHeaders) {
    return {
      "Content-Type": "application/json",
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      ...extraHeaders,
    };
  }

  function formatSignedSol(value) {
    const number = Number(value || 0);
    const sign = number >= 0 ? "+" : "-";
    return `${sign}${Math.abs(number).toFixed(2)} SOL`;
  }

  function formatSignedPct(value) {
    const number = Number(value || 0);
    const sign = number >= 0 ? "+" : "-";
    return `${sign}${Math.abs(number).toFixed(1)}%`;
  }

  function parseAbbrevNumber(text) {
    if (!text) return null;
    const match = String(text).replace(/\s+/g, "").match(/([0-9]+(?:[.,][0-9]+)?)([kmb])?/i);
    if (!match) return null;
    const numeric = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(numeric)) return null;
    const unit = (match[2] || "").toLowerCase();
    const multiplier = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
    return numeric * multiplier;
  }

  function formatUsdValue(usd) {
    if (usd === null || usd === undefined) return "—";
    const abs = Math.abs(usd);
    const sign = usd >= 0 ? "" : "-";
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
    if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
    return `${sign}$${abs.toFixed(3)}`;
  }

  function formatCompactUsd(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number) || number <= 0) return "--";
    if (number >= 1e9) return `$${(number / 1e9).toFixed(2)}B`;
    if (number >= 1e6) return `$${(number / 1e6).toFixed(2)}M`;
    if (number >= 1e3) return `$${(number / 1e3).toFixed(1)}K`;
    return `$${Math.round(number)}`;
  }

  function getVisibleTextCandidates() {
    return Array.from(document.querySelectorAll("body *"))
      .slice(0, 1400)
      .map(el => (el.innerText || "").trim())
      .filter(text => text && text.length < 120);
  }

  function getTextContent(selector) {
    const nodes = Array.from(document.querySelectorAll(selector));
    for (const node of nodes) {
      const text = (node.textContent || "").trim();
      if (text) return text;
    }
    return "";
  }

  function findJsonScripts() {
    return Array.from(document.querySelectorAll("script"))
      .map(node => node.textContent || "")
      .filter(Boolean);
  }

  function findAxiomPairInfoFromNextData() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (!el) return null;
      const text = el.textContent || "";
      // Search for tokenTicker + tokenAddress anywhere in the Next.js page props
      const tickerMatch = text.match(/"tokenTicker"\s*:\s*"([A-Z0-9]{2,16})"/);
      if (!tickerMatch || TOKEN_NAME_BLOCKLIST.has(tickerMatch[1])) return null;
      const addrMatch = text.match(/"tokenAddress"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
      const pairMatch = text.match(/"pairAddress"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
      const fullNameMatch = text.match(/"tokenName"\s*:\s*"([^"]{2,50})"/);
      if (addrMatch) {
        return { tokenTicker: tickerMatch[1], tokenAddress: addrMatch[1], pairAddress: pairMatch?.[1] || "", tokenFullName: fullNameMatch?.[1] || null };
      }
    } catch (_error) {}
    return null;
  }

  function findAxiomPairInfoFromScripts() {
    // Try __NEXT_DATA__ first — most stable across Axiom deploys
    const fromNextData = findAxiomPairInfoFromNextData();
    if (fromNextData) return fromNextData;

    const scripts = findJsonScripts();
    for (const text of scripts) {
      // Original strict pattern (field-order dependent — kept as first attempt)
      const strictMatch = text.match(/\{"tokenImage":.*?"pairAddress":.*?"tokenAddress":.*?"tokenTicker":.*?\}/s);
      if (strictMatch) {
        try {
          const parsed = JSON.parse(strictMatch[0]);
          if (parsed?.tokenAddress && parsed?.tokenTicker) return parsed;
        } catch (_error) {}
      }
      // Flexible: find tokenTicker anywhere, then look for tokenAddress nearby
      const tickerMatches = [...text.matchAll(/"tokenTicker"\s*:\s*"([A-Z0-9]{2,16})"/g)];
      for (const m of tickerMatches) {
        const ticker = m[1];
        if (!isValidTicker(ticker)) continue;
        const snippet = text.slice(Math.max(0, m.index - 600), m.index + 600);
        const addrMatch = snippet.match(/"tokenAddress"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
        if (!addrMatch) continue;
        const pairMatch = snippet.match(/"pairAddress"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/);
        return { tokenTicker: ticker, tokenAddress: addrMatch[1], pairAddress: pairMatch?.[1] || "" };
      }
    }
    return null;
  }

  function findAxiomTokenMetadataFromScripts(tokenTicker) {
    if (!tokenTicker) return null;
    const scripts = findJsonScripts();
    for (const text of scripts) {
      const match = text.match(/\[\{"pairAddress":.*?"priceNative":.*?\}\]/s);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed)) continue;
        const token = parsed.find(item => item?.tokenTicker === tokenTicker);
        if (token?.priceNative && token?.supply) return token;
      } catch (_error) {
        continue;
      }
    }
    return null;
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildPositionId(tokenName, openedAt) {
    return tradeContract.buildPositionId(tokenName, openedAt);
  }

  function getPositionKey(snapshotOrPosition) {
    return snapshotOrPosition?.contractAddress
      || snapshotOrPosition?.pairAddress
      || snapshotOrPosition?.tokenName
      || "unknown";
  }

  function createCaptureMeta(snapshot) {
    return {
      marketCap: Number(snapshot?.marketCap || 0),
      marketCapSource: snapshot?.marketCapSource || "unknown",
      marketCapText: snapshot?.marketCapText || "",
      capturedAt: Number(snapshot?.capturedAt || Date.now()),
      contractAddress: snapshot?.contractAddress || "",
      pairAddress: snapshot?.pairAddress || "",
      pageUrl: snapshot?.pageUrl || location.href,
    };
  }

  function appendPositionEvent(position, event) {
    const next = [...(Array.isArray(position?.events) ? position.events : []), event];
    return next.slice(-MAX_POSITION_EVENTS);
  }

  function createPositionEvent(type, snapshot, extra = {}) {
    const capture = createCaptureMeta(snapshot);
    return {
      id: extra.id || `${type}_${capture.capturedAt}`,
      type,
      at: capture.capturedAt,
      marketCap: capture.marketCap,
      marketCapSource: capture.marketCapSource,
      marketCapText: capture.marketCapText,
      contractAddress: capture.contractAddress,
      pairAddress: capture.pairAddress,
      pageUrl: capture.pageUrl,
      ...extra,
    };
  }

  function resolveSnapshotForClose(current, providedSnapshot = null) {
    const base = providedSnapshot || state.detected || detectPageSnapshot();
    const resolvedMarketCap = Number(base?.marketCap || getEstimatedLiveMarketCapUsd() || 0);
    return {
      tokenName: base?.tokenName || current?.tokenName || "Unknown",
      marketCap: resolvedMarketCap > 0 ? resolvedMarketCap : null,
      marketCapSource: base?.marketCapSource || (resolvedMarketCap > 0 ? "derived-live" : "missing"),
      marketCapText: base?.marketCapText || "",
      contractAddress: base?.contractAddress || current?.contractAddress || "",
      pairAddress: base?.pairAddress || current?.pairAddress || "",
      pageUrl: base?.pageUrl || current?.pageUrl || location.href,
      capturedAt: Number(base?.capturedAt || Date.now()),
      isCoinPage: base?.isCoinPage ?? true,
    };
  }

  function normalizeStopLossPct(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed === 0) return null;
    return -Math.abs(Number(parsed.toFixed(2)));
  }

  function normalizeTargetSellPct(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.abs(Number(parsed.toFixed(2)));
  }

  function normalizeMarketCapValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const cleaned = String(value).trim().replace(/\$/g, "");
    if (!cleaned) return null;
    const parsed = parseAbbrevNumber(cleaned) ?? Number(cleaned.replace(/,/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Number(parsed.toFixed(2));
  }

  function getAutomationDraft(position) {
    if (!position?.positionId) return { stopLoss: "", targetSell: "" };
    const existingDraft = state.automationDrafts[position.positionId];
    if (existingDraft) return existingDraft;
    const stopLossMode = position.stopLossMode || (position.stopLossMarketCap ? "mc" : "pct");
    const targetSellMode = position.targetSellMode || (position.targetSellMarketCap ? "mc" : "pct");
    return {
      stopLossMode,
      targetSellMode,
      stopLoss: stopLossMode === "mc"
        ? (position.stopLossMarketCap ? String(position.stopLossMarketCap) : "")
        : (position.stopLossPct ? String(position.stopLossPct) : ""),
      targetSell: targetSellMode === "mc"
        ? (position.targetSellMarketCap ? String(position.targetSellMarketCap) : "")
        : (position.targetSellPct ? String(position.targetSellPct) : ""),
    };
  }

  function setAutomationDraft(position, nextDraft) {
    if (!position?.positionId) return;
    state.automationDrafts[position.positionId] = {
      ...getAutomationDraft(position),
      ...nextDraft,
    };
  }

  function clearAutomationDraft(position) {
    if (!position?.positionId) return;
    delete state.automationDrafts[position.positionId];
  }

  function isAutomationEditing() {
    const activeElement = document.activeElement;
    return Boolean(
      activeElement &&
      root.contains(activeElement) &&
      activeElement.matches?.("input, textarea, select")
    );
  }

  function renderUnlessEditing() {
    if (isAutomationEditing()) return;
    if (dragState) return;
    render();
  }

  function formatThresholdLabel(position, kind) {
    if (!position) return "—";
    if (kind === "stop") {
      if ((position.stopLossMode || "pct") === "mc") {
        return position.stopLossMarketCap ? `${formatCompactUsd(position.stopLossMarketCap)} MC` : "—";
      }
      return position.stopLossPct ? `-${Math.abs(position.stopLossPct).toFixed(1)}%` : "—";
    }
    if ((position.targetSellMode || "pct") === "mc") {
      return position.targetSellMarketCap ? `${formatCompactUsd(position.targetSellMarketCap)} MC` : "—";
    }
    return position.targetSellPct ? `${position.targetSellPct.toFixed(1)}%` : "—";
  }

  function encodeOpenTradeNote(position) {
    return tradeContract.encodeOpenTradeNote(position, {
      maxPositionEvents: MAX_POSITION_EVENTS,
    });
  }

  function encodeCloseTradeNote(closeMeta) {
    return tradeContract.encodeCloseTradeNote(closeMeta);
  }

  function parseOpenTradeNote(note, fallbackTrade) {
    return tradeContract.parseOpenTradeNote(note, fallbackTrade, {
      maxPositionEvents: MAX_POSITION_EVENTS,
    });
  }

  function upsertCurrentPosition(current, sizeToAdd, snapshot) {
    const addSize = Number(sizeToAdd || 0);
    if (!(addSize > 0)) {
      throw new Error("Buy size must be greater than zero.");
    }

    if (!current) {
      const openedAt = Date.now();
      const entryEvent = createPositionEvent("buy", snapshot, {
        sizeSol: addSize,
        positionSizeSol: addSize,
      });
      return {
        positionId: buildPositionId(snapshot.tokenName, openedAt),
        tokenName: snapshot.tokenName,
        tokenFullName: snapshot.tokenFullName || null,
        entryMarketCap: Number(snapshot.marketCap),
        positionSizeSol: addSize,
        initialSizeSol: addSize,
        totalFeesSol: FEE_PER_TRADE,
        openedAt,
        pageUrl: snapshot.pageUrl,
        marketCapSource: snapshot.marketCapSource || "unknown",
        contractAddress: snapshot.contractAddress || "",
        pairAddress: snapshot.pairAddress || "",
        stopLossPct: null,
        stopLossMode: "pct",
        stopLossMarketCap: null,
        targetSellPct: null,
        targetSellMode: "pct",
        targetSellMarketCap: null,
        entryCapture: createCaptureMeta(snapshot),
        lastCapture: createCaptureMeta(snapshot),
        events: [entryEvent],
        backendTradeId: null,
      };
    }

    const nextPositionSizeSol = Number((Number(current.positionSizeSol || 0) + addSize).toFixed(4));
    const nextInitialSizeSol = Number((Number(current.initialSizeSol || 0) + addSize).toFixed(4));
    // Token-weighted harmonic mean: each SOL buys fewer tokens at a higher MC,
    // so we weight by tokens received (solSpent / MC) not by SOL spent directly.
    const oldTokenBasis = Number(current.positionSizeSol || 0) / Math.max(Number(current.entryMarketCap || 1), 1);
    const newTokenBasis = addSize / Math.max(Number(snapshot.marketCap || 1), 1);
    const weightedEntryMarketCap = nextPositionSizeSol / (oldTokenBasis + newTokenBasis);

    return {
      ...current,
      tokenName: snapshot.tokenName,
      tokenFullName: snapshot.tokenFullName || current.tokenFullName || null,
      entryMarketCap: Number(weightedEntryMarketCap.toFixed(2)),
      positionSizeSol: nextPositionSizeSol,
      initialSizeSol: nextInitialSizeSol,
      totalFeesSol: Number(((current.totalFeesSol || 0) + FEE_PER_TRADE).toFixed(4)),
      pageUrl: snapshot.pageUrl || current.pageUrl || "",
      marketCapSource: snapshot.marketCapSource || current.marketCapSource || "unknown",
      contractAddress: snapshot.contractAddress || current.contractAddress || "",
      pairAddress: snapshot.pairAddress || current.pairAddress || "",
      lastCapture: createCaptureMeta(snapshot),
      events: appendPositionEvent(current, createPositionEvent("buy", snapshot, {
        sizeSol: addSize,
        positionSizeSol: nextPositionSizeSol,
      })),
    };
  }

  // Common Axiom UI labels that match the ticker regex but are not token names
  const TOKEN_NAME_BLOCKLIST = new Set(["CA", "MC", "FDV", "TVL", "APY", "LP", "URL", "USD", "DEX", "AMM", "DAO", "NFT", "ATH"]);

  function isValidTicker(str) {
    return /^[A-Z0-9]{2,16}$/.test(str) && !TOKEN_NAME_BLOCKLIST.has(str);
  }

  function detectTokenFromPage() {
    // 1. Best source: structured data from Axiom's script tags / Next.js page props
    const scriptPairInfo = findAxiomPairInfoFromScripts();
    if (scriptPairInfo?.tokenTicker) return scriptPairInfo.tokenTicker;

    // 2. Axiom-specific DOM selector (may drift with Axiom deploys)
    const axiomToken = getTextContent("span.hidden.lg\\:inline.xl\\:hidden > div.min-w-0.overflow-hidden.truncate.whitespace-nowrap");
    if (axiomToken && isValidTicker(axiomToken)) return axiomToken;

    // 3. Page title — Axiom sets this to "TICKER/SOL | Axiom" or similar
    const titleToken = (document.title || "").match(/^([A-Z0-9]{2,16})[^A-Z0-9]/)?.[1];
    if (titleToken && isValidTicker(titleToken)) return titleToken;

    // 4. URL path bits (works when Axiom uses the ticker in the URL)
    const urlBits = location.pathname.split("/").map(bit => decodeURIComponent(bit)).reverse();
    const fromUrl = urlBits.find(bit => isValidTicker(bit));
    if (fromUrl) return fromUrl;

    // 5. Heading elements — last resort, prone to picking up UI labels
    const headings = Array.from(document.querySelectorAll("h1, h2, h3, [class*='title'], [class*='symbol']"))
      .map(el => (el.textContent || "").trim())
      .filter(Boolean);
    const exact = headings.find(text => isValidTicker(text));
    if (exact) return exact;

    return "Unknown";
  }

  function getContractFallbackName(contractAddress) {
    if (!contractAddress || contractAddress.length < 10) return "Unknown";
    return `${contractAddress.slice(0, 4)}...${contractAddress.slice(-4)}`;
  }

  function detectContractAddressFromPage() {
    const scriptPairInfo = findAxiomPairInfoFromScripts();
    if (scriptPairInfo?.tokenAddress) {
      return {
        contractAddress: scriptPairInfo.tokenAddress,
        pairAddress: scriptPairInfo.pairAddress || "",
      };
    }

    const urlBits = location.pathname.split("/").map(bit => decodeURIComponent(bit)).reverse();
    const fromUrl = urlBits.find(bit => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bit));
    if (fromUrl) {
      return {
        contractAddress: fromUrl,
        pairAddress: "",
      };
    }

    const bodyMatch = (document.body?.innerText || "").match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    return {
      contractAddress: bodyMatch?.[0] || "",
      pairAddress: "",
    };
  }

  function detectVisibleMarketCapFromPage() {
    const axiomMarketCap = getTextContent("span.text-primaryLightBlue.sm\\:text-textPrimary.text-\\[18px\\].font-medium.leading-\\[23px\\].\\[font-variant-numeric\\:tabular-nums\\]");
    const axiomMarketCapNumber = parseAbbrevNumber(axiomMarketCap.replace(/\$/g, ""));
    if (axiomMarketCapNumber) return { value: axiomMarketCapNumber, source: "dom-visible", text: axiomMarketCap };

    const candidates = getVisibleTextCandidates();
    for (const text of candidates) {
      if (!/(market\s*cap|\bmc\b|\bmcap\b)/i.test(text)) continue;
      const number = parseAbbrevNumber(text.replace(/market\s*cap|mcap|\bmc\b/ig, ""));
      if (number) return { value: number, source: "dom-heuristic", text };
    }

    const joined = candidates.join(" | ");
    for (const regex of [
      /market\s*cap[^0-9]{0,12}\$?\s*([0-9][0-9.,]*\s*[kmb]?)/i,
      /\bmc\b[^0-9]{0,12}\$?\s*([0-9][0-9.,]*\s*[kmb]?)/i,
    ]) {
      const match = joined.match(regex);
      if (!match) continue;
      const number = parseAbbrevNumber(match[1]);
      if (number) return { value: number, source: "dom-fallback", text: match[0] };
    }

    return null;
  }

  function detectMarketCapFromPage() {
    const visibleMarketCap = detectVisibleMarketCapFromPage();
    if (visibleMarketCap?.value) {
      return visibleMarketCap;
    }

    const pairInfo = findAxiomPairInfoFromScripts();
    const tokenMetadata = findAxiomTokenMetadataFromScripts(pairInfo?.tokenTicker);
    if (pairInfo && tokenMetadata) {
      state.pairInfo = pairInfo;
      state.tokenMetadata = tokenMetadata;
      const supply = Number(tokenMetadata.supply || pairInfo.supply || 0);
      const priceNative = Number(state.livePairPriceNative || tokenMetadata.priceNative || 0);
      const solPriceUsd = Number(state.solPriceUsd || 0);
      if (supply > 0 && priceNative > 0 && solPriceUsd > 0) {
        return {
          value: supply * priceNative * solPriceUsd,
          source: "derived-live",
          text: "",
        };
      }
    }

    return { value: null, source: "missing", text: "" };
  }

  function isLikelyAxiomCoinPage(snapshot) {
    const path = String(location.pathname || "");
    if (/\/meme\/[^/]+/i.test(path)) return true;
    if (/\/token\/[^/]+/i.test(path)) return true;
    if (/\/pair\/[^/]+/i.test(path)) return true;

    const tokenName = snapshot?.tokenName || "";
    const contractAddress = snapshot?.contractAddress || "";
    const pairAddress = snapshot?.pairAddress || "";
    return Boolean(isValidTicker(tokenName) && (contractAddress || pairAddress));
  }

  function isImmediateCoinRoute(pathname = location.pathname) {
    return /\/(meme|token|pair)\/[^/]+/i.test(String(pathname || ""));
  }

  function detectPageSnapshot() {
    const marketCapCapture = detectMarketCapFromPage();
    const contractCapture = detectContractAddressFromPage();
    const pairInfoForName = findAxiomPairInfoFromScripts();
    const detectedTokenName = detectTokenFromPage();
    const fallbackTokenName = getContractFallbackName(contractCapture.contractAddress || contractCapture.pairAddress || "");
    const snapshot = {
      tokenName: detectedTokenName !== "Unknown" ? detectedTokenName : fallbackTokenName,
      tokenFullName: pairInfoForName?.tokenFullName || null,
      marketCap: marketCapCapture?.value || null,
      marketCapSource: marketCapCapture?.source || "missing",
      marketCapText: marketCapCapture?.text || "",
      contractAddress: contractCapture.contractAddress || "",
      pairAddress: contractCapture.pairAddress || "",
      pageUrl: location.href,
      capturedAt: Date.now(),
    };
    return {
      ...snapshot,
      isCoinPage: isLikelyAxiomCoinPage(snapshot),
    };
  }

  async function saveSession(session) {
    state.session = session;
    await storage.set({ td_session: session });
  }

  async function clearSession() {
    state.session = null;
    state.user = null;
    state.trades = [];
    await storage.remove("td_session");
  }

  async function refreshSession() {
    if (!state.session?.refresh_token) {
      throw new Error("Session expired. Sign in again.");
    }
    const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    });
    await saveSession(refreshed);
    return refreshed;
  }

  async function withSession(requester) {
    try {
      if (!state.session?.access_token) throw new Error("No session found.");
      return await requester(state.session.access_token);
    } catch (error) {
      const message = error?.message || "";
      const shouldRefresh = /jwt|token|expired|invalid/i.test(message);
      if (!shouldRefresh) throw error;
      const refreshed = await refreshSession();
      return requester(refreshed.access_token);
    }
  }

  async function fetchUser(accessToken) {
    return request("/auth/v1/user", {
      method: "GET",
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
      },
    });
  }

  async function signIn(email, password) {
    const data = await request("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.supabaseAnonKey,
      },
      body: JSON.stringify({ email, password }),
    });
    await saveSession(data);
    return data.user || fetchUser(data.access_token);
  }

  async function signOutCurrentUser() {
    try {
      if (state.session?.access_token) {
        await request("/auth/v1/logout", {
          method: "POST",
          headers: {
            apikey: config.supabaseAnonKey,
            Authorization: `Bearer ${state.session.access_token}`,
          },
        });
      }
    } catch (_error) {
      // Ignore logout API failures and still clear local session state.
    }
    await clearSession();
  }

  async function loadTrades() {
    const rows = await withSession(async accessToken => request(
      "/rest/v1/user_paper_trades?select=id,token_name,pnl_sol,pnl_percentage,entry_market_cap,exit_market_cap,notes,trade_timestamp&order=trade_timestamp.desc&limit=20",
      {
        method: "GET",
        headers: getAuthHeaders(accessToken),
      }
    ));
    state.trades = Array.isArray(rows) ? rows : [];
  }

  async function loadOpenPositionsFromBackend() {
    const rows = await withSession(async accessToken => request(
      "/rest/v1/user_paper_trades?select=id,token_name,entry_market_cap,notes,trade_timestamp&order=trade_timestamp.desc&limit=200",
      {
        method: "GET",
        headers: getAuthHeaders(accessToken),
      }
    ));

    const existingPositions = state.openPositions && typeof state.openPositions === "object" ? state.openPositions : {};
    const nextPositions = { ...existingPositions };
    const backendKeys = new Set();
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const parsed = parseOpenTradeNote(row.notes, row);
      if (!parsed) return;
      const positionKey = getPositionKey(parsed);
      if (!positionKey) return;
      backendKeys.add(positionKey);
      const local = nextPositions[positionKey] || {};
      nextPositions[positionKey] = {
        ...local,
        ...parsed,
        backendTradeId: row.id,
        // Keep local positionSizeSol if it's lower — it reflects unsynced partial sells
        positionSizeSol: local.positionSizeSol != null && local.positionSizeSol < (parsed.positionSizeSol ?? Infinity)
          ? local.positionSizeSol
          : (parsed.positionSizeSol ?? local.positionSizeSol),
        storageKey: local.storageKey || positionKey,
      };
    });

    for (const [positionKey, position] of Object.entries(existingPositions)) {
      if (!position?.positionId) continue;
      if (backendKeys.has(positionKey) && position.backendTradeId) continue;
      try {
        const backendTradeId = await persistOpenPosition(position);
        nextPositions[positionKey] = {
          ...position,
          backendTradeId,
        };
      } catch (error) {
        console.error("Failed to backfill live position to backend", position?.tokenName || positionKey, error);
      }
    }

    state.openPositions = nextPositions;
    await saveOpenPositions();
    debugLog("POSITIONS loaded", Object.keys(nextPositions).length, "keys:", Object.keys(nextPositions));
  }

  async function insertTrade(payload) {
    const rows = await withSession(async accessToken => request("/rest/v1/user_paper_trades", {
      method: "POST",
      headers: getAuthHeaders(accessToken, { Prefer: "return=representation" }),
      body: JSON.stringify(payload),
    }));
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  }

  async function updateTrade(tradeId, payload) {
    const rows = await withSession(async accessToken => request(`/rest/v1/user_paper_trades?id=eq.${encodeURIComponent(tradeId)}`, {
      method: "PATCH",
      headers: getAuthHeaders(accessToken, { Prefer: "return=representation" }),
      body: JSON.stringify({
        ...payload,
        updated_at: new Date().toISOString(),
      }),
    }));
    return Array.isArray(rows) ? rows[0] || null : rows || null;
  }

  async function deleteTrade(tradeId) {
    await withSession(async accessToken => request(`/rest/v1/user_paper_trades?id=eq.${encodeURIComponent(tradeId)}`, {
      method: "DELETE",
      headers: getAuthHeaders(accessToken, { Prefer: "return=minimal" }),
    }));
  }

  async function saveOpenPositions() {
    await storage.set({ [OPEN_POSITIONS_KEY]: state.openPositions });
  }

  const MAX_QUEUE_RETRIES = 10;

  async function enqueueClose(item) {
    const { [CLOSE_QUEUE_KEY]: existing = [] } = await storage.get(CLOSE_QUEUE_KEY);
    await storage.set({ [CLOSE_QUEUE_KEY]: [...existing, { ...item, queuedAt: Date.now(), retries: 0 }] });
    debugLog("QUEUE enqueued close", item.closeTradePayload?.token_name);
  }

  async function flushCloseQueue() {
    if (!state.user) return;
    const { [CLOSE_QUEUE_KEY]: queue = [] } = await storage.get(CLOSE_QUEUE_KEY);
    if (!queue.length) return;
    debugLog("QUEUE flushing", queue.length, "item(s)");
    const remaining = [];
    const dead = [];
    for (const item of queue) {
      try {
        await insertTrade({ ...item.closeTradePayload, user_id: state.user.id });
        if (item.openTradeIdToDelete) await deleteTrade(item.openTradeIdToDelete).catch(() => {});
        if (item.updatedOpenPosition) await persistOpenPosition(item.updatedOpenPosition).catch(() => {});
      } catch {
        const retries = (item.retries || 0) + 1;
        if (retries >= MAX_QUEUE_RETRIES) {
          dead.push({ ...item, retries, deadAt: Date.now() });
          debugLog("QUEUE dead-letter", item.closeTradePayload?.token_name, "after", retries, "retries");
        } else {
          remaining.push({ ...item, retries });
        }
      }
    }
    if (dead.length) {
      const { [CLOSE_QUEUE_KEY + "_dead"]: existingDead = [] } = await storage.get(CLOSE_QUEUE_KEY + "_dead");
      await storage.set({ [CLOSE_QUEUE_KEY + "_dead"]: [...existingDead, ...dead] });
    }
    await storage.set({ [CLOSE_QUEUE_KEY]: remaining });
    if (remaining.length < queue.length) await loadTrades();
  }

  async function persistOpenPosition(position) {
    const payload = {
      token_name: position.tokenName,
      pnl_sol: 0,
      pnl_percentage: 0,
      entry_market_cap: Number((position.entryMarketCap || 0).toFixed(2)),
      exit_market_cap: Number((position.lastCapture?.marketCap || position.entryMarketCap || 0).toFixed(2)),
      notes: encodeOpenTradeNote(position),
      trade_timestamp: new Date(position.openedAt || Date.now()).toISOString(),
    };

    if (position.backendTradeId) {
      await updateTrade(position.backendTradeId, payload);
      debugLog("PERSIST update", position.tokenName, "id:", position.backendTradeId);
      return position.backendTradeId;
    }

    const openTrade = await insertTrade({
      user_id: state.user.id,
      ...payload,
    });
    const newId = openTrade?.id || null;
    debugLog("PERSIST insert", position.tokenName, "→ id:", newId);
    return newId;
  }

  async function saveVirtualBalance() {
    await storage.set({ [VIRTUAL_BALANCE_KEY]: state.virtualBalance });
  }

  async function saveThemePreference() {
    await storage.set({ [OVERLAY_DARK_THEME_KEY]: state.darkTheme });
  }

  function syncDashboardStateImmediately() {
    try {
      chrome.runtime.sendMessage({
        type: "td_sync_dashboard_state",
        balance: state.virtualBalance,
        openPositions: state.openPositions,
      }, () => {
        void chrome.runtime?.lastError;
      });
    } catch (_error) {}
  }

  async function saveOverlayUiState() {
    await storage.set({
      [OVERLAY_POSITION_KEY]: state.position,
    });
  }

  function getCurrentPosition() {
    const ca = state.detected?.contractAddress;
    if (ca && state.openPositions[ca]) return state.openPositions[ca];
    const pair = state.detected?.pairAddress;
    if (pair && state.openPositions[pair]) return state.openPositions[pair];
    const token = state.detected?.tokenName;
    return token ? state.openPositions[token] || null : null;
  }

  function getCurrentSolBalance() {
    const current = getCurrentPosition();
    return Number(current?.positionSizeSol || 0);
  }

  async function saveAutomationLevels(position, values, snapshotReason = "settings-update") {
    if (!position || !state.user) return;
    const stopLossMode = values.stopLossMode === "mc" ? "mc" : "pct";
    const targetSellMode = values.targetSellMode === "mc" ? "mc" : "pct";
    const stopLossPct = stopLossMode === "pct" ? normalizeStopLossPct(values.stopLoss) : null;
    const stopLossMarketCap = stopLossMode === "mc" ? normalizeMarketCapValue(values.stopLoss) : null;
    const targetSellPct = targetSellMode === "pct" ? normalizeTargetSellPct(values.targetSell) : null;
    const targetSellMarketCap = targetSellMode === "mc" ? normalizeMarketCapValue(values.targetSell) : null;
    const snapshot = state.detected || detectPageSnapshot();
    const bothCleared = stopLossPct === null
      && stopLossMarketCap === null
      && targetSellPct === null
      && targetSellMarketCap === null;
    const nextPosition = {
      ...position,
      stopLossPct,
      stopLossMode,
      stopLossMarketCap,
      targetSellPct,
      targetSellMode,
      targetSellMarketCap,
      lastCapture: createCaptureMeta(snapshot),
      events: appendPositionEvent(position, createPositionEvent(
        bothCleared ? "automation_cleared" : "automation_updated",
        snapshot,
        {
          stopLossPct,
          stopLossMode,
          stopLossMarketCap,
          targetSellPct,
          targetSellMode,
          targetSellMarketCap,
        }
      )),
    };
    nextPosition.backendTradeId = await persistOpenPosition(nextPosition);
    const nextPosKey = getPositionKey(nextPosition);
    nextPosition.storageKey = nextPosKey;
    state.openPositions[nextPosKey] = nextPosition;
    clearAutomationDraft(position);
    await saveOpenPositions();
    setStatus(bothCleared ? "Auto-sell levels cleared." : "Stop loss / target saved.", "good");
    render();
    await maybeRunAutoExit(snapshotReason);
  }

  function getEstimatedLiveMarketCapUsd() {
    const activePairAddress = state.detected?.pairAddress;
    const dex = (!activePairAddress || state.dexData?.pairAddress === activePairAddress) ? state.dexData : null;

    if (dex && dex.marketCapUsd > 0) {
      const livePriceNative = Number(state.livePairPriceNative || 0);
      if (dex.priceNative > 0 && livePriceNative > 0 && livePriceNative !== dex.priceNative) {
        return dex.marketCapUsd * (livePriceNative / dex.priceNative);
      }
      return dex.marketCapUsd;
    }

    // Scale detected MC by live WS price ratio
    const baseMC = Number(state.detected?.marketCap || 0);
    const refPrice = Number(state._wsRefPrice || 0);
    const livePrice = Number(state.livePairPriceNative || 0);
    if (baseMC > 0 && refPrice > 0 && livePrice > 0) {
      return baseMC * (livePrice / refPrice);
    }
    if (baseMC > 0) return baseMC;

    const bgEntry = activePairAddress && state.bgPrice ? state.bgPrice[activePairAddress] : null;
    const bgMC = Number(bgEntry?.marketCapUsd || 0);
    return bgMC > 0 ? bgMC : null;
  }

  let lastDexFetchPairAddress = null;
  let dexPollTimer = null;

  async function fetchDexScreenerByToken(tokenAddress) {
    if (!tokenAddress) return;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
      if (!res.ok) return;
      const data = await res.json();
      const pairs = data?.pairs;
      if (!Array.isArray(pairs) || pairs.length === 0) return;
      const best = pairs.reduce((a, b) => (Number(b.liquidity?.usd || 0) > Number(a.liquidity?.usd || 0) ? b : a), pairs[0]);
      const pairAddress = best.pairAddress;
      if (!pairAddress) return;
      await fetchDexScreenerPairInfo(pairAddress);
      startDexPoll(pairAddress);
    } catch (_) {}
  }

  async function fetchDexScreenerPairInfo(pairAddress, { silent = false } = {}) {
    if (!pairAddress) return;
    const isNewPair = pairAddress !== lastDexFetchPairAddress;
    if (isNewPair) lastDexFetchPairAddress = pairAddress;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pairAddress}`);
      if (!res.ok) return;
      const data = await res.json();
      const pair = data?.pairs?.[0];
      if (!pair) return;

      const marketCapUsd = Number(pair.marketCap || pair.fdv || 0);
      const priceNative = Number(pair.priceNative || 0);
      const priceUsd = Number(pair.priceUsd || 0);
      const solPriceUsd = priceNative > 0 && priceUsd > 0 ? priceUsd / priceNative : 0;

      state.dexData = {
        pairAddress,
        symbol: pair.baseToken?.symbol || "",
        name: pair.baseToken?.name || "",
        contractAddress: pair.baseToken?.address || "",
        marketCapUsd,
        priceNative,
        priceUsd,
        solPriceUsd,
        liquidity: Number(pair.liquidity?.usd || 0),
        volume24h: Number(pair.volume?.h24 || 0),
        priceChange24h: Number(pair.priceChange?.h24 || 0),
        priceChange1h: Number(pair.priceChange?.h1 || 0),
        priceChange5m: Number(pair.priceChange?.m5 || 0),
        dexUrl: pair.url || "",
        fetchedAt: Date.now(),
      };

      if (marketCapUsd > 0 && priceUsd > 0) {
        state.pairInfo = { ...(state.pairInfo || {}), supply: marketCapUsd / priceUsd, pairAddress };
      }
      if (solPriceUsd > 0) state.solPriceUsd = solPriceUsd;
      // Keep livePairPriceNative in sync with DexScreener's fresh price
      if (priceNative > 0) state.livePairPriceNative = priceNative;

      if (marketCapUsd > 0) {
        const existing = state.bgPrice && typeof state.bgPrice === "object" ? { ...state.bgPrice } : {};
        existing[pairAddress] = { marketCapUsd, priceNative, solPriceUsd, ts: Date.now() };
        state.bgPrice = existing;
        await chrome.storage.local.set({ [BG_PRICE_KEY]: existing });
      }

      if (silent) {
        patchLiveData();
      } else {
        renderUnlessEditing();
      }
      void maybeRunAutoExit("dex-seed");
    } catch (_) {}
  }

  function startDexPoll(pairAddress) {
    clearInterval(dexPollTimer);
    dexPollTimer = setInterval(() => {
      const activePair = state.detected?.pairAddress || state.dexData?.pairAddress;
      if (activePair) void fetchDexScreenerPairInfo(activePair, { silent: true });
    }, 2000);
  }

  function stopDexPoll() {
    clearInterval(dexPollTimer);
    dexPollTimer = null;
  }

  function getCurrentLivePnlPct(position) {
    if (!position || !(position.entryMarketCap > 0)) return null;
    const liveMarketCap = getEstimatedLiveMarketCapUsd() || state.detected?.marketCap || 0;
    if (!(liveMarketCap > 0)) return null;
    return ((liveMarketCap / position.entryMarketCap) - 1) * 100;
  }

  async function maybeRunAutoExit(reason = "live-update") {
    if (state.tradeBusy) return;
    const current = getCurrentPosition();
    if (!current || !state.user) return;
    const livePnlPct = getCurrentLivePnlPct(current);
    const liveMarketCap = getEstimatedLiveMarketCapUsd() || state.detected?.marketCap || null;
    // When triggered by background price poll, build a synthetic snapshot so we
    // don't accidentally close with state.detected from a different token's page.
    const bgEntry = current.pairAddress && state.bgPrice ? state.bgPrice[current.pairAddress] : null;
    const autoExitSnapshot = bgEntry
      ? { ...state.detected, marketCap: bgEntry.marketCapUsd, marketCapSource: "background" }
      : state.detected;

    const stopLossMode = current.stopLossMode || (current.stopLossMarketCap ? "mc" : "pct");
    if (stopLossMode === "mc") {
      const stopLossMarketCap = Number(current.stopLossMarketCap || 0);
      if (liveMarketCap && Number.isFinite(stopLossMarketCap) && stopLossMarketCap > 0 && liveMarketCap <= stopLossMarketCap) {
        await closeTrade(1, { trigger: "stop_loss", reason, snapshot: autoExitSnapshot });
        return;
      }
    } else if (livePnlPct !== null) {
      const rawStopLossPct = current.stopLossPct;
      const stopLossPct = rawStopLossPct === null || rawStopLossPct === undefined || rawStopLossPct === ""
        ? null
        : Number(rawStopLossPct);
      if (Number.isFinite(stopLossPct) && stopLossPct < 0 && livePnlPct <= stopLossPct) {
        await closeTrade(1, { trigger: "stop_loss", reason, snapshot: autoExitSnapshot });
        return;
      }
    }

    const targetSellMode = current.targetSellMode || (current.targetSellMarketCap ? "mc" : "pct");
    if (targetSellMode === "mc") {
      const targetSellMarketCap = Number(current.targetSellMarketCap || 0);
      if (liveMarketCap && Number.isFinite(targetSellMarketCap) && targetSellMarketCap > 0 && liveMarketCap >= targetSellMarketCap) {
        await closeTrade(1, { trigger: "target_sell", reason, snapshot: autoExitSnapshot });
      }
      return;
    }
    if (livePnlPct === null) return;
    const rawTargetSellPct = current.targetSellPct;
    const targetSellPct = rawTargetSellPct === null || rawTargetSellPct === undefined || rawTargetSellPct === ""
      ? null
      : Number(rawTargetSellPct);
    if (Number.isFinite(targetSellPct) && targetSellPct > 0 && livePnlPct >= targetSellPct) {
      await closeTrade(1, { trigger: "target_sell", reason, snapshot: autoExitSnapshot });
    }
  }

  function getDisplayData() {
    const dex = state.dexData?.pairAddress === (state.detected?.pairAddress || state.dexData?.pairAddress)
      ? state.dexData : null;
    const detected = state.detected;
    return {
      tokenName: dex?.symbol || detected?.tokenName || "Unknown",
      tokenFullName: dex?.name || detected?.tokenFullName || null,
      contractAddress: dex?.contractAddress || detected?.contractAddress || "",
      pairAddress: dex?.pairAddress || detected?.pairAddress || "",
      marketCapUsd: getEstimatedLiveMarketCapUsd() || dex?.marketCapUsd || detected?.marketCap || null,
      priceChange5m: dex?.priceChange5m ?? null,
      priceChange1h: dex?.priceChange1h ?? null,
      priceChange24h: dex?.priceChange24h ?? null,
      pageUrl: detected?.pageUrl || "",
    };
  }

  function shouldShowOverlay() {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) return false;
    if (!state.enabled) return false;
    if (state.forceOverlay) return true;
    if (!state.detected?.isCoinPage) return false;
    const dd = getDisplayData();
    if (!dd.tokenName || dd.tokenName === "Unknown") return false;
    return true;
  }

  function isTradeReady(snapshot = state.detected) {
    const dd = getDisplayData();
    return Boolean(
      snapshot?.isCoinPage &&
      dd.tokenName && dd.tokenName !== "Unknown" &&
      (Number(dd.marketCapUsd || 0) > 0 || Number(snapshot?.marketCap || 0) > 0)
    );
  }

  function clampPosition(nextPosition) {
    const maxLeft = Math.max(12, window.innerWidth - 332);
    const maxTop = Math.max(12, window.innerHeight - 300);
    return {
      left: Math.min(Math.max(12, Math.round(nextPosition.left)), maxLeft),
      top: Math.min(Math.max(12, Math.round(nextPosition.top)), maxTop),
    };
  }

  function applyOverlayPosition() {
    const clamped = clampPosition(state.position);
    state.position = clamped;
    root.style.left = `${clamped.left}px`;
    root.style.top = `${clamped.top}px`;
  }

  function startDrag(event) {
    if (event.target.closest("[data-refresh], [data-open-settings], [data-open-balance], [data-dashboard-link], [data-pos-nav], [data-pos-toggle]")) return;
    event.preventDefault();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: state.position.left,
      startTop: state.position.top,
    };
    try { root.setPointerCapture(event.pointerId); } catch (_) {}
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", stopDrag);
  }

  function onDragMove(event) {
    if (!dragState) return;
    event.preventDefault();
    state.position = clampPosition({
      left: dragState.startLeft + (event.clientX - dragState.startX),
      top: dragState.startTop + (event.clientY - dragState.startY),
    });
    applyOverlayPosition();
  }

  async function stopDrag(event) {
    if (!dragState) return;
    dragState = null;
    try { if (event?.pointerId != null) root.releasePointerCapture(event.pointerId); } catch (_) {}
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", stopDrag);
    await saveOverlayUiState();
  }

  function patchLiveData() {
    if (!shouldShowOverlay()) return;
    if (!root.querySelector('[data-live]')) return;

    const mc = getEstimatedLiveMarketCapUsd() || state.dexData?.marketCapUsd || state.detected?.marketCap || null;

    const pnlEl = root.querySelector('[data-live="pnl"]');
    if (!pnlEl) return;
    const currentPosition = getCurrentPosition();
    const sol = state.solPriceUsd;
    let livePnlSol = null, livePnlPct = null;
    const totalFees = currentPosition?.totalFeesSol || 0;
    if (currentPosition && currentPosition.entryMarketCap > 0 && mc > 0) {
      const unrealized = currentPosition.positionSizeSol * (mc / currentPosition.entryMarketCap - 1);
      livePnlSol = unrealized + (currentPosition.realizedPnlSol || 0) - totalFees;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      livePnlPct = initialSol > 0 ? (livePnlSol / initialSol) * 100 : null;
    } else if ((currentPosition?.realizedPnlSol || 0) !== 0 && currentPosition) {
      livePnlSol = (currentPosition.realizedPnlSol || 0) - totalFees;
    }
    const pnlPctStr = livePnlPct !== null ? ` (${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(1)}%)` : "";
    const pnlStr = livePnlSol !== null
      ? (sol ? (livePnlSol >= 0 ? "+" : "") + formatUsdValue(livePnlSol * sol) : (livePnlSol >= 0 ? "+" : "") + `${Math.abs(livePnlSol).toFixed(3)} SOL`) + pnlPctStr
      : "—";
    pnlEl.textContent = pnlStr;
    pnlEl.className = `td-overlay-pos-value${livePnlSol !== null ? (livePnlSol >= 0 ? " is-pos" : " is-neg") : ""}`;
  }

  function render() {
    if (!shouldShowOverlay()) {
      root.style.display = "none";
      root.innerHTML = "";
      return;
    }

    root.className = `td-overlay-root ${state.darkTheme ? "is-dark" : "is-light"}`;
    root.style.display = "block";
    root.dataset.liveOpen = String(state.liveOpen);
    applyOverlayPosition();

    const currentPosition = getCurrentPosition();
    const dd = getDisplayData();
    const solBalanceLabel = `${state.virtualBalance.toFixed(2)} SOL`;
    const tradeReady = isTradeReady();

    let livePnlPct = null;
    let livePnlSol = null;
    const realizedPnl = currentPosition?.realizedPnlSol || 0;
    const totalFees = currentPosition?.totalFeesSol || 0;
    const liveMC = getEstimatedLiveMarketCapUsd() || state.detected?.marketCap;
    if (currentPosition && currentPosition.entryMarketCap > 0 && liveMC > 0) {
      const unrealizedPnl = currentPosition.positionSizeSol * (liveMC / currentPosition.entryMarketCap - 1);
      livePnlSol = unrealizedPnl + realizedPnl - totalFees;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      livePnlPct = initialSol > 0 ? (livePnlSol / initialSol) * 100 : null;
    } else if (realizedPnl !== 0 && currentPosition) {
      livePnlSol = realizedPnl - totalFees;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      livePnlPct = initialSol > 0 ? (livePnlSol / initialSol) * 100 : null;
    }

    let posSummaryHtml = "";
    let automationControlsHtml = "";
    if (currentPosition) {
      const automationDraft = getAutomationDraft(currentPosition);
      const sol = state.solPriceUsd;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      const remainingSol = currentPosition.positionSizeSol;
      const soldSol = Math.max(0, initialSol - remainingSol);

      const fmtSol = v => `${v.toFixed(3)} SOL`;
      const fmtVal = (solAmt, usdPrice, multiplier = 1) => {
        if (sol && usdPrice) return formatUsdValue(solAmt * usdPrice * multiplier);
        return fmtSol(solAmt * multiplier);
      };

      const remainingMultiplier = (liveMC && currentPosition.entryMarketCap > 0)
        ? liveMC / currentPosition.entryMarketCap : 1;

      const investedStr = fmtVal(initialSol, sol, 1);
      const soldStr = soldSol > 0 ? fmtVal(soldSol, sol, 1) : "—";
      const remainingStr = fmtVal(remainingSol, sol, remainingMultiplier);

      const pnlPctStr = livePnlPct !== null ? ` (${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(1)}%)` : "";
      const pnlClass = livePnlSol !== null ? (livePnlSol >= 0 ? "is-pos" : "is-neg") : "";
      const pnlStr = livePnlSol !== null
        ? (sol ? (livePnlSol >= 0 ? "+" : "") + formatUsdValue(livePnlSol * sol) : (livePnlSol >= 0 ? "+" : "") + fmtSol(Math.abs(livePnlSol))) + pnlPctStr
        : "—";

      const stopLabel = state.stopLossEnabled ? formatThresholdLabel(currentPosition, "stop") : null;
      const targetLabel = state.stopLossEnabled ? formatThresholdLabel(currentPosition, "target") : null;
      const showStopTargetRow = state.stopLossEnabled && (stopLabel !== "—" || targetLabel !== "—");
      posSummaryHtml = `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px 0;padding:6px 0;${showStopTargetRow ? "" : "border-bottom:1px solid var(--td-border-subtle);"}margin-bottom:${showStopTargetRow ? "0" : "4px"}">
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">Invested</span>
            <span class="td-overlay-pos-value">${investedStr}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">Sold</span>
            <span class="td-overlay-pos-value">${soldStr}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">Remaining</span>
            <span class="td-overlay-pos-value">${remainingStr}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">PnL</span>
            <span class="td-overlay-pos-value ${pnlClass}" data-live="pnl">${pnlStr}</span>
          </div>
        </div>
        ${showStopTargetRow ? `
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px 0;padding:5px 0;border-bottom:1px solid var(--td-border-subtle);margin-bottom:4px">
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">Stop loss</span>
            <span class="td-overlay-pos-value">${stopLabel}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px">
            <span class="td-overlay-pos-label">Target sell</span>
            <span class="td-overlay-pos-value">${targetLabel}</span>
          </div>
        </div>` : ""}
      `;
      if (state.stopLossEnabled) automationControlsHtml = `
        <div class="td-overlay-automation">
          <div class="td-overlay-automation-row">
            <div class="td-overlay-automation-field">
              <span class="td-overlay-pos-label" style="margin-bottom:3px;display:block">Stop</span>
              <div style="display:flex;align-items:center;gap:4px">
                <input class="td-overlay-input td-overlay-automation-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${automationDraft.stopLossMode === "mc" ? "e.g. 50k" : "e.g. -20"}" value="${esc(automationDraft.stopLoss)}" data-stop-loss-input style="flex:1;min-width:0" />
                <div class="td-overlay-automation-modes" data-stop-loss-modes style="flex-shrink:0">
                  <button class="td-overlay-automation-mode${automationDraft.stopLossMode !== "mc" ? " is-active" : ""}" type="button" data-stop-loss-mode="pct">%</button>
                  <button class="td-overlay-automation-mode${automationDraft.stopLossMode === "mc" ? " is-active" : ""}" type="button" data-stop-loss-mode="mc">MC</button>
                </div>
              </div>
            </div>
            <div class="td-overlay-automation-field">
              <span class="td-overlay-pos-label" style="margin-bottom:3px;display:block">Target</span>
              <div style="display:flex;align-items:center;gap:4px">
                <input class="td-overlay-input td-overlay-automation-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${automationDraft.targetSellMode === "mc" ? "Target MC" : "Target %"}" value="${esc(automationDraft.targetSell)}" data-target-sell-input style="flex:1;min-width:0" />
                <div class="td-overlay-automation-modes" data-target-sell-modes style="flex-shrink:0">
                  <button class="td-overlay-automation-mode${automationDraft.targetSellMode !== "mc" ? " is-active" : ""}" type="button" data-target-sell-mode="pct">%</button>
                  <button class="td-overlay-automation-mode${automationDraft.targetSellMode === "mc" ? " is-active" : ""}" type="button" data-target-sell-mode="mc">MC</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }
    const personIcon = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M12 8.25C9.92894 8.25 8.25 9.92893 8.25 12C8.25 14.0711 9.92894 15.75 12 15.75C14.0711 15.75 15.75 14.0711 15.75 12C15.75 9.92893 14.0711 8.25 12 8.25ZM9.75 12C9.75 10.7574 10.7574 9.75 12 9.75C13.2426 9.75 14.25 10.7574 14.25 12C14.25 13.2426 13.2426 14.25 12 14.25C10.7574 14.25 9.75 13.2426 9.75 12Z" fill="currentColor"/>
        <path fill-rule="evenodd" clip-rule="evenodd" d="M11.9747 1.25C11.5303 1.24999 11.1592 1.24999 10.8546 1.27077C10.5375 1.29241 10.238 1.33905 9.94761 1.45933C9.27379 1.73844 8.73843 2.27379 8.45932 2.94762C8.31402 3.29842 8.27467 3.66812 8.25964 4.06996C8.24756 4.39299 8.08454 4.66251 7.84395 4.80141C7.60337 4.94031 7.28845 4.94673 7.00266 4.79568C6.64714 4.60777 6.30729 4.45699 5.93083 4.40743C5.20773 4.31223 4.47642 4.50819 3.89779 4.95219C3.64843 5.14353 3.45827 5.3796 3.28099 5.6434C3.11068 5.89681 2.92517 6.21815 2.70294 6.60307L2.67769 6.64681C2.45545 7.03172 2.26993 7.35304 2.13562 7.62723C1.99581 7.91267 1.88644 8.19539 1.84541 8.50701C1.75021 9.23012 1.94617 9.96142 2.39016 10.5401C2.62128 10.8412 2.92173 11.0602 3.26217 11.2741C3.53595 11.4461 3.68788 11.7221 3.68786 12C3.68785 12.2778 3.53592 12.5538 3.26217 12.7258C2.92169 12.9397 2.62121 13.1587 2.39007 13.4599C1.94607 14.0385 1.75012 14.7698 1.84531 15.4929C1.88634 15.8045 1.99571 16.0873 2.13552 16.3727C2.26983 16.6469 2.45535 16.9682 2.67758 17.3531L2.70284 17.3969C2.92507 17.7818 3.11058 18.1031 3.28089 18.3565C3.45817 18.6203 3.64833 18.8564 3.89769 19.0477C4.47632 19.4917 5.20763 19.6877 5.93073 19.5925C6.30717 19.5429 6.647 19.3922 7.0025 19.2043C7.28833 19.0532 7.60329 19.0596 7.8439 19.1986C8.08452 19.3375 8.24756 19.607 8.25964 19.9301C8.27467 20.3319 8.31403 20.7016 8.45932 21.0524C8.73843 21.7262 9.27379 22.2616 9.94761 22.5407C10.238 22.661 10.5375 22.7076 10.8546 22.7292C11.1592 22.75 11.5303 22.75 11.9747 22.75H12.0252C12.4697 22.75 12.8407 22.75 13.1454 22.7292C13.4625 22.7076 13.762 22.661 14.0524 22.5407C14.7262 22.2616 15.2616 21.7262 15.5407 21.0524C15.686 20.7016 15.7253 20.3319 15.7403 19.93C15.7524 19.607 15.9154 19.3375 16.156 19.1985C16.3966 19.0596 16.7116 19.0532 16.9974 19.2042C17.3529 19.3921 17.6927 19.5429 18.0692 19.5924C18.7923 19.6876 19.5236 19.4917 20.1022 19.0477C20.3516 18.8563 20.5417 18.6203 20.719 18.3565C20.8893 18.1031 21.0748 17.7818 21.297 17.3969L21.3223 17.3531C21.5445 16.9682 21.7301 16.6468 21.8644 16.3726C22.0042 16.0872 22.1135 15.8045 22.1546 15.4929C22.2498 14.7697 22.0538 14.0384 21.6098 13.4598C21.3787 13.1586 21.0782 12.9397 20.7378 12.7258C20.464 12.5538 20.3121 12.2778 20.3121 11.9999C20.3121 11.7221 20.464 11.4462 20.7377 11.2742C21.0783 11.0603 21.3788 10.8414 21.6099 10.5401C22.0539 9.96149 22.2499 9.23019 22.1547 8.50708C22.1136 8.19546 22.0043 7.91274 21.8645 7.6273C21.7302 7.35313 21.5447 7.03183 21.3224 6.64695L21.2972 6.60318C21.0749 6.21825 20.8894 5.89688 20.7191 5.64347C20.5418 5.37967 20.3517 5.1436 20.1023 4.95225C19.5237 4.50826 18.7924 4.3123 18.0692 4.4075C17.6928 4.45706 17.353 4.60782 16.9975 4.79572C16.7117 4.94679 16.3967 4.94036 16.1561 4.80144C15.9155 4.66253 15.7524 4.39297 15.7403 4.06991C15.7253 3.66808 15.686 3.2984 15.5407 2.94762C15.2616 2.27379 14.7262 1.73844 14.0524 1.45933C13.762 1.33905 13.4625 1.29241 13.1454 1.27077C12.8407 1.24999 12.4697 1.24999 12.0252 1.25H11.9747ZM10.5216 2.84515C10.5988 2.81319 10.716 2.78372 10.9567 2.76729C11.2042 2.75041 11.5238 2.75 12 2.75C12.4762 2.75 12.7958 2.75041 13.0432 2.76729C13.284 2.78372 13.4012 2.81319 13.4783 2.84515C13.7846 2.97202 14.028 3.21536 14.1548 3.52165C14.1949 3.61826 14.228 3.76887 14.2414 4.12597C14.271 4.91835 14.68 5.68129 15.4061 6.10048C16.1321 6.51968 16.9974 6.4924 17.6984 6.12188C18.0143 5.9549 18.1614 5.90832 18.265 5.89467C18.5937 5.8514 18.9261 5.94047 19.1891 6.14228C19.2554 6.19312 19.3395 6.27989 19.4741 6.48016C19.6125 6.68603 19.7726 6.9626 20.0107 7.375C20.2488 7.78741 20.4083 8.06438 20.5174 8.28713C20.6235 8.50382 20.6566 8.62007 20.6675 8.70287C20.7108 9.03155 20.6217 9.36397 20.4199 9.62698C20.3562 9.70995 20.2424 9.81399 19.9397 10.0041C19.2684 10.426 18.8122 11.1616 18.8121 11.9999C18.8121 12.8383 19.2683 13.574 19.9397 13.9959C20.2423 14.186 20.3561 14.29 20.4198 14.373C20.6216 14.636 20.7107 14.9684 20.6674 15.2971C20.6565 15.3799 20.6234 15.4961 20.5173 15.7128C20.4082 15.9355 20.2487 16.2125 20.0106 16.6249C19.7725 17.0373 19.6124 17.3139 19.474 17.5198C19.3394 17.72 19.2553 17.8068 19.189 17.8576C18.926 18.0595 18.5936 18.1485 18.2649 18.1053C18.1613 18.0916 18.0142 18.045 17.6983 17.8781C16.9973 17.5075 16.132 17.4803 15.4059 17.8995C14.68 18.3187 14.271 19.0816 14.2414 19.874C14.228 20.2311 14.1949 20.3817 14.1548 20.4784C14.028 20.7846 13.7846 21.028 13.4783 21.1549C13.4012 21.1868 13.284 21.2163 13.0432 21.2327C12.7958 21.2496 12.4762 21.25 12 21.25C11.5238 21.25 11.2042 21.2496 10.9567 21.2327C10.716 21.2163 10.5988 21.1868 10.5216 21.1549C10.2154 21.028 9.97201 20.7846 9.84514 20.4784C9.80512 20.3817 9.77195 20.2311 9.75859 19.874C9.72896 19.0817 9.31997 18.3187 8.5939 17.8995C7.86784 17.4803 7.00262 17.5076 6.30158 17.8781C5.98565 18.0451 5.83863 18.0917 5.73495 18.1053C5.40626 18.1486 5.07385 18.0595 4.81084 17.8577C4.74458 17.8069 4.66045 17.7201 4.52586 17.5198C4.38751 17.314 4.22736 17.0374 3.98926 16.625C3.75115 16.2126 3.59171 15.9356 3.4826 15.7129C3.37646 15.4962 3.34338 15.3799 3.33248 15.2971C3.28921 14.9684 3.37828 14.636 3.5801 14.373C3.64376 14.2901 3.75761 14.186 4.0602 13.9959C4.73158 13.5741 5.18782 12.8384 5.18786 12.0001C5.18791 11.1616 4.73165 10.4259 4.06021 10.004C3.75769 9.81389 3.64385 9.70987 3.58019 9.62691C3.37838 9.3639 3.28931 9.03149 3.33258 8.7028C3.34348 8.62001 3.37656 8.50375 3.4827 8.28707C3.59181 8.06431 3.75125 7.78734 3.98935 7.37493C4.22746 6.96253 4.3876 6.68596 4.52596 6.48009C4.66055 6.27983 4.74468 6.19305 4.81093 6.14222C5.07395 5.9404 5.40636 5.85133 5.73504 5.8946C5.83873 5.90825 5.98576 5.95483 6.30173 6.12184C7.00273 6.49235 7.86791 6.51962 8.59394 6.10045C9.31998 5.68128 9.72896 4.91837 9.75859 4.12602C9.77195 3.76889 9.80512 3.61827 9.84514 3.52165C9.97201 3.21536 10.2154 2.97202 10.5216 2.84515Z" fill="currentColor"/>
      </svg>
    `;
    const statsIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="12" width="4" height="9" rx="1"/>
        <rect x="10" y="7" width="4" height="14" rx="1"/>
        <rect x="17" y="3" width="4" height="18" rx="1"/>
      </svg>
    `;
    const listIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="4" cy="7" r="1.5" fill="currentColor" stroke="none"/>
        <line x1="8" y1="7" x2="21" y2="7"/>
        <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/>
        <line x1="8" y1="12" x2="21" y2="12"/>
        <circle cx="4" cy="17" r="1.5" fill="currentColor" stroke="none"/>
        <line x1="8" y1="17" x2="21" y2="17"/>
      </svg>
    `;
    const hasOpenPositions = Object.values(state.openPositions || {}).some(p => p?.positionId);

    root.innerHTML = `
      <div class="td-overlay-shell">
          ${state.status && state.statusTone === "bad" ? `<div class="td-overlay-toast td-overlay-toast--bad" data-dismiss-toast>${esc(state.status)}</div>` : ""}
          <div class="td-overlay-head">
            <button type="button" data-dashboard-link class="td-overlay-wordmark">Dashboard</button>
            <button class="td-overlay-balance" type="button" data-open-balance aria-label="Open balance editor" style="display:flex;align-items:center;gap:5px">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.44955 6.75999H12.0395C12.1595 6.75999 12.2695 6.80999 12.3595 6.89999L13.8795 8.45999C14.1595 8.74999 13.9595 9.23999 13.5595 9.23999H3.96955C3.84955 9.23999 3.73955 9.18999 3.64955 9.09999L2.12955 7.53999C1.84955 7.24999 2.04955 6.75999 2.44955 6.75999ZM2.12955 4.68999L3.64955 3.12999C3.72955 3.03999 3.84955 2.98999 3.96955 2.98999H13.5495C13.9495 2.98999 14.1495 3.47999 13.8695 3.76999L12.3595 5.32999C12.2795 5.41999 12.1595 5.46999 12.0395 5.46999H2.44955C2.04955 5.46999 1.84955 4.97999 2.12955 4.68999ZM13.8695 11.3L12.3495 12.86C12.2595 12.95 12.1495 13 12.0295 13H2.44955C2.04955 13 1.84955 12.51 2.12955 12.22L3.64955 10.66C3.72955 10.57 3.84955 10.52 3.96955 10.52H13.5495C13.9495 10.52 14.1495 11.01 13.8695 11.3Z" fill="url(#solG)"/><defs><linearGradient id="solG" x1="1.77756" y1="13.3327" x2="13.9679" y2="1.14234" gradientUnits="userSpaceOnUse"><stop stop-color="#9945FF"/><stop offset="0.24" stop-color="#8752F3"/><stop offset="0.465" stop-color="#5497D5"/><stop offset="0.6" stop-color="#43B4CA"/><stop offset="0.735" stop-color="#28E0B9"/><stop offset="1" stop-color="#19FB9B"/></linearGradient></defs></svg>
              ${solBalanceLabel}
              <span class="td-overlay-balance-tip">Add more SOL</span>
            </button>
            <div class="td-overlay-head-actions">
              <button class="td-overlay-icon-btn td-overlay-icon-btn-pos${state.posNavOpen ? " is-active" : ""}${!state.posNavOpen && hasOpenPositions ? " is-live" : ""}" type="button" data-pos-toggle aria-label="Toggle live trades" style="width:20px;height:20px">${listIcon}</button>
              <button class="td-overlay-icon-btn td-overlay-icon-btn-settings${state.settingsOpen ? " is-active" : ""}" type="button" data-open-settings aria-label="Account settings">${personIcon}</button>
            </div>
          </div>

        <div class="td-overlay-panel">
          ${!state.user ? `
            <div class="td-overlay-auth">
              <input class="td-overlay-input" name="email" type="email" placeholder="Email" />
              <input class="td-overlay-input" name="password" type="password" placeholder="Password" />
              <button class="td-overlay-auth-btn" type="button" data-sign-in>${state.authBusy ? "Signing in..." : "Sign in"}</button>
            </div>
          ` : `
            <div class="td-overlay-section">
              ${(() => {
                if (!state.posNavOpen) return "";
                const seen = new Set();
                const positions = Object.values(state.openPositions || {})
                  .filter(p => { if (!p?.positionId || seen.has(p.positionId)) return false; seen.add(p.positionId); return true; })
                  .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
                if (!positions.length) {
                  return `
                    <div class="td-overlay-label">Positions</div>
                    <div class="td-overlay-empty">No live trades</div>
                  `;
                }
                return `
                  <div class="td-overlay-label">Positions</div>
                  <div class="td-overlay-pos-nav-list">
                    ${positions.map(pos => {
                      const isCurrent = pos.positionId === currentPosition?.positionId;
                      const sol = state.solPriceUsd;
                      const sizeLabel = sol ? "$" + (pos.positionSizeSol * sol).toFixed(0) : pos.positionSizeSol.toFixed(3) + " SOL";
                      const safeHref = pos.pageUrl && /^https?:\/\//i.test(pos.pageUrl) ? esc(pos.pageUrl) : "#";
                      return `<a class="td-overlay-pos-nav-row${isCurrent ? " is-current" : ""}" href="${safeHref}" data-pos-nav title="Go to ${esc(pos.tokenName)}">
                        <span class="td-overlay-pos-nav-name">${esc(pos.tokenName)}${pos.tokenFullName ? `<span class="td-overlay-pos-nav-fullname"> ${esc(pos.tokenFullName)}</span>` : ""}</span>
                        <span class="td-overlay-pos-nav-size">${esc(sizeLabel)}</span>
                      </a>`;
                    }).join("")}
                  </div>
                `;
              })()}
              ${state.settingsOpen ? `
                <div class="td-overlay-label">Settings</div>
                <div style="background:var(--td-card-bg);border:1px solid var(--td-card-border);border-radius:7px;overflow:hidden;margin-bottom:4px">
                  <div style="padding:6px 10px 4px;font-size:10px;color:var(--td-text-faint);text-transform:uppercase;letter-spacing:0.07em;font-weight:600">Features</div>
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--td-border-subtle)">
                    <div style="font-size:12px;font-weight:500;color:var(--td-text)">Stop loss &amp; target</div>
                    <label class="td-toggle">
                      <input type="checkbox" ${state.stopLossEnabled ? "checked" : ""} data-toggle-stop-loss-cb>
                      <span class="td-toggle-track"></span>
                      <span class="td-toggle-thumb"></span>
                    </label>
                  </div>
                  <div style="padding:8px 10px;border-top:1px solid var(--td-border-subtle)">
                    <div style="font-size:10px;color:var(--td-text-faint);text-transform:uppercase;letter-spacing:0.07em;font-weight:600;margin-bottom:6px">Simulation</div>
                    <div style="display:flex;flex-direction:column;gap:5px">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <span style="font-size:11px;color:var(--td-text-dim);white-space:nowrap">Slippage</span>
                        <div style="display:flex;align-items:center;gap:4px">
                          <input class="td-overlay-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" style="width:52px;padding:3px 6px;font-size:11px;text-align:right" placeholder="Auto" value="${state.simSettings.slippagePct != null ? state.simSettings.slippagePct : ""}" data-sim-slippage />
                          <span style="font-size:11px;color:var(--td-text-faint)">%</span>
                        </div>
                      </div>
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                        <span style="font-size:11px;color:var(--td-text-dim);white-space:nowrap">Exec delay</span>
                        <div style="display:flex;align-items:center;gap:4px">
                          <input class="td-overlay-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" style="width:52px;padding:3px 6px;font-size:11px;text-align:right" placeholder="Auto" value="${state.simSettings.execDelayMs != null ? state.simSettings.execDelayMs : ""}" data-sim-delay />
                          <span style="font-size:11px;color:var(--td-text-faint)">ms</span>
                        </div>
                      </div>
                      <button type="button" data-sim-reset style="font:inherit;padding:0;border:none;background:none;font-size:11px;color:var(--td-text-faint);cursor:pointer;text-align:left;margin-top:1px">Reset to defaults</button>
                    </div>
                  </div>
${state.user ? `<div style="padding:7px 10px;border-top:1px solid var(--td-border-subtle)"><button type="button" data-sign-out style="font:inherit;padding:0;border:none;background:none;font-size:12px;color:rgba(248,113,113,0.8);cursor:pointer">Sign out</button></div>` : ""}
                </div>
              ` : ""}
              ${currentPosition ? (() => {
                const fullName = currentPosition.tokenFullName || dd.tokenFullName || "";
                return `${fullName ? `<div class="td-overlay-pos-token-header"><span class="td-overlay-pos-token-fullname">${esc(fullName)}</span></div>` : ""}
                ${posSummaryHtml}`;
              })() : ""}
              ${state.settingsOpen ? `<div style="height:1px;background:var(--td-border-subtle);margin:2px 0 6px"></div>` : ""}
              <div class="td-overlay-label">Buy</div>
              <div class="td-overlay-preset-grid">
                ${BUY_PRESETS.map(value => {
                  const totalRequired = Number((value + FEE_PER_TRADE).toFixed(4));
                  const disabled = !tradeReady || state.virtualBalance < totalRequired || state.tradeBusy;
                  const button = `<button class="td-overlay-preset" type="button" data-buy="${value}" ${disabled ? "disabled" : ""}>${value} SOL</button>`;
                  return disabled && !state.tradeBusy
                    ? `<span class="td-overlay-disabled-hint" data-hint="${!tradeReady ? "Waiting for live coin data" : `Need ${totalRequired.toFixed(2)} SOL including fee`}">${button}</span>`
                    : button;
                }).join("")}
              </div>
              <div class="td-overlay-label" style="margin-top:6px">Sell</div>
              <div class="td-overlay-sell-stack">
                <div class="td-overlay-sell-grid">
                  ${SELL_PRESETS.map(percent => `<button class="td-overlay-pill td-overlay-pill-sell" type="button" data-sell-percent="${percent}" ${currentPosition && !state.tradeBusy ? "" : "disabled"}>${percent}%</button>`).join("")}
                </div>
                <div class="td-overlay-sell-sub" style="justify-content:flex-end">
                  <button class="td-overlay-sell-sub-btn" type="button" data-sell-init ${currentPosition && !state.tradeBusy ? "" : "disabled"}>Sell init.</button>
                </div>
              </div>
              ${automationControlsHtml}
            </div>
          `}
        </div>
      </div>
    `;

    root.querySelector("[data-dismiss-toast]")?.addEventListener("click", () => {
      clearTimeout(statusDismissTimer);
      state.status = "";
      render();
    });

    root.querySelectorAll("[data-copy-ca]").forEach(el => el.addEventListener("click", e => {
      e.stopPropagation();
      const ca = el.dataset.copyCa;
      if (!ca) return;
      navigator.clipboard.writeText(ca).then(() => {
        clearTimeout(state._caCopyTimer);
        state.caCopiedUntil = Date.now() + 1100;
        render();
        state._caCopyTimer = setTimeout(() => render(), 1100);
      }).catch(() => {});
    }));

    root.querySelector("[data-pos-toggle]")?.addEventListener("click", () => {
      state.posNavOpen = !state.posNavOpen;
      if (state.posNavOpen) state.settingsOpen = false;
      render();
    });

    root.querySelectorAll("[data-pos-nav]").forEach(el => el.addEventListener("click", () => {
      state.posNavOpen = false;
      render();
    }));

    root.querySelectorAll("[data-open-balance]").forEach(el => el.addEventListener("click", () => {
      openDashboardBalanceModal();
    }));

    root.querySelectorAll("[data-dashboard-link]").forEach(el => el.addEventListener("click", () => {
      openDashboard();
    }));

    root.querySelectorAll("[data-open-settings]").forEach(el => el.addEventListener("click", e => {
      if (!state.user) return;
      e.stopPropagation();
      state.settingsOpen = !state.settingsOpen;
      if (state.settingsOpen) state.posNavOpen = false;
      render();
    }));

    root.querySelector("[data-sign-out]")?.addEventListener("click", async () => {
      await signOutCurrentUser();
      state.settingsOpen = false;
      setStatus("Signed out.", "neutral");
      render();
    });

    const simSlippageInput = root.querySelector("[data-sim-slippage]");
    const simDelayInput = root.querySelector("[data-sim-delay]");
    const persistSimSettings = async () => {
      const slipRaw = simSlippageInput?.value.trim();
      const delayRaw = simDelayInput?.value.trim();
      const slipParsed = slipRaw === "" ? null : Number(slipRaw);
      const delayParsed = delayRaw === "" ? null : Number(delayRaw);
      state.simSettings = {
        slippagePct: (slipParsed != null && Number.isFinite(slipParsed) && slipParsed >= 0) ? slipParsed : null,
        execDelayMs: (delayParsed != null && Number.isFinite(delayParsed) && delayParsed >= 0) ? delayParsed : null,
      };
      await saveSimSettings();
    };
    simSlippageInput?.addEventListener("change", persistSimSettings);
    simDelayInput?.addEventListener("change", persistSimSettings);
    root.querySelector("[data-sim-reset]")?.addEventListener("click", async () => {
      state.simSettings = { ...SIM_DEFAULTS };
      await saveSimSettings();
      render();
    });

    root.querySelector("[data-toggle-stop-loss-cb]")?.addEventListener("change", async (e) => {
      state.stopLossEnabled = e.target.checked;
      await saveFeatureToggles();
      render();
    });


root.querySelector("[data-refresh]")?.addEventListener("click", () => {
      state.detected = detectPageSnapshot();
      render();
    });

    root.querySelector(".td-overlay-head")?.addEventListener("pointerdown", startDrag);

    root.querySelector("[data-sign-in]")?.addEventListener("click", async () => {
      if (state.authBusy) return;
      const email = root.querySelector('input[name="email"]')?.value.trim();
      const password = root.querySelector('input[name="password"]')?.value || "";
      state.authBusy = true;
      setStatus("", "neutral");
      render();
      try {
        state.user = await signIn(email, password);
        sentryUser(state.user);
        await loadTrades();
        await loadOpenPositionsFromBackend();
        await flushCloseQueue();
      } catch (error) {
        setStatus(error.message || "Sign-in failed.", "bad");
      } finally {
        state.authBusy = false;
        render();
      }
    });

    root.querySelectorAll("[data-buy]").forEach(button => {
      button.addEventListener("click", async () => {
        if (state.tradeBusy) return;
        state.tradeBusy = true;
        state.tradeStatus = "buying";
        render();
        try {
          const size = Number(button.dataset.buy || 0);
          const totalRequired = Number((size + FEE_PER_TRADE).toFixed(4));
          if (state.virtualBalance < totalRequired) {
            throw new Error(`Need ${totalRequired.toFixed(2)} SOL to cover size and fee.`);
          }

          setStatus("Executing...", "neutral");
          await simulateExecDelay();

          // Re-capture MC after delay — price may have moved during execution
          const rawSnapshot = detectPageSnapshot();
          const dex = state.dexData?.pairAddress === (rawSnapshot.pairAddress || state.dexData?.pairAddress) ? state.dexData : null;
          const liveMCForEntry = getEstimatedLiveMarketCapUsd();
          const rawMC = liveMCForEntry || dex?.marketCapUsd || rawSnapshot.marketCap || null;
          const snapshot = {
            ...rawSnapshot,
            tokenName: dex?.symbol || rawSnapshot.tokenName,
            tokenFullName: dex?.name || rawSnapshot.tokenFullName || null,
            contractAddress: dex?.contractAddress || rawSnapshot.contractAddress || "",
            pairAddress: dex?.pairAddress || rawSnapshot.pairAddress || "",
            marketCap: rawMC ? rawMC * getSlippageMultiplier(size, "buy") : null,
            marketCapSource: liveMCForEntry ? "live-mc+slippage" : (rawSnapshot.marketCap ? rawSnapshot.marketCapSource : (dex ? "dex-seed" : rawSnapshot.marketCapSource)),
          };
          state.detected = snapshot;
          sentryCrumb("trade", "BUY attempted", { token: snapshot.tokenName, ca: snapshot.contractAddress, mc: snapshot.marketCap, mcSource: snapshot.marketCapSource, size });
          if (!snapshot.marketCap) {
            throw new Error("Overlay is forced on, but market cap is still not being detected on this page.");
          }
          const positionKey = getPositionKey(snapshot);
          const current = state.openPositions[positionKey] || state.openPositions[snapshot.tokenName] || null;
          const nextPosition = upsertCurrentPosition(current, size, snapshot);
          state.openPositions[positionKey] = {
            ...nextPosition,
            backendTradeId: nextPosition.backendTradeId || null,
            storageKey: positionKey,
          };
          await saveOpenPositions();
          state.virtualBalance = Number(Math.max(0, state.virtualBalance - size - FEE_PER_TRADE).toFixed(4));
          await saveVirtualBalance();
          syncDashboardStateImmediately();

          const backendTradeId = await persistOpenPosition(state.openPositions[positionKey]);
          state.openPositions[positionKey] = {
            ...state.openPositions[positionKey],
            backendTradeId,
            storageKey: positionKey,
          };
          await saveOpenPositions();
          syncDashboardStateImmediately();
          debugLog("BUY", { token: snapshot.tokenName, ca: snapshot.contractAddress, mc: snapshot.marketCap, mcSource: snapshot.marketCapSource, size, backendTradeId });
          setStatus("", "neutral");
        } catch (error) {
          sentryError(error, { action: "buy", token: state.detected?.tokenName, mc: state.detected?.marketCap, mcSource: state.detected?.marketCapSource });
          setStatus(error.message || "Could not open live trade.", "bad");
        } finally {
          state.tradeBusy = false;
          state.tradeStatus = null;
          render();
        }
      });
    });

    root.querySelectorAll("[data-sell-percent]").forEach(button => {
      button.addEventListener("click", async () => {
        await closeTrade(Number(button.dataset.sellPercent || 0) / 100);
      });
    });

    root.querySelector("[data-sell-init]")?.addEventListener("click", async () => {
      const initialSize = Number(currentPosition?.initialSizeSol || currentPosition?.positionSizeSol || 0);
      await closeTradeByAmount(initialSize);
    });

    const stopLossInput = root.querySelector("[data-stop-loss-input]");
    const targetSellInput = root.querySelector("[data-target-sell-input]");
    const persistAutomationFromInputs = async () => {
      const current = getCurrentPosition();
      if (!current || !state.user || state.tradeBusy) return;
      const draft = getAutomationDraft(current);
      const values = {
        stopLossMode: draft.stopLossMode || "pct",
        stopLoss: stopLossInput?.value.trim() || "",
        targetSellMode: draft.targetSellMode || "pct",
        targetSell: targetSellInput?.value.trim() || "",
      };
      setAutomationDraft(current, values);
      await saveAutomationLevels(current, values);
    };
    const bindAutomationInput = (input, field) => {
      if (!input) return;
      input.addEventListener("input", () => {
        const current = getCurrentPosition();
        if (!current) return;
        setAutomationDraft(current, { [field]: input.value });
      });
      input.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void persistAutomationFromInputs();
      });
      input.addEventListener("blur", () => {
        window.setTimeout(() => {
          renderUnlessEditing();
        }, 0);
      });
    };
    bindAutomationInput(stopLossInput, "stopLoss");
    bindAutomationInput(targetSellInput, "targetSell");
    root.querySelectorAll("[data-stop-loss-mode], [data-target-sell-mode]").forEach(button => {
      button.addEventListener("click", () => {
        const current = getCurrentPosition();
        if (!current) return;
        if (button.hasAttribute("data-stop-loss-mode")) {
          const nextMode = button.getAttribute("data-stop-loss-mode") === "mc" ? "mc" : "pct";
          setAutomationDraft(current, {
            stopLossMode: nextMode,
            stopLoss: "",
          });
        } else {
          const nextMode = button.getAttribute("data-target-sell-mode") === "mc" ? "mc" : "pct";
          setAutomationDraft(current, {
            targetSellMode: nextMode,
            targetSell: "",
          });
        }
        render();
      });
    });

  }

  async function closeTrade(fraction, options = {}) {
    if (state.tradeBusy) return;
    const current = getCurrentPosition();
    if (!current || !state.user) return;

    const isManual = !options.trigger || options.trigger === "manual";
    state.tradeBusy = true;
    state.tradeStatus = "selling";
    render();
    sentryCrumb("trade", "SELL attempted", { token: current.tokenName, ca: current.contractAddress, fraction, trigger: options.trigger || "manual" });
    try {
      if (isManual) {
        setStatus("Executing...", "neutral");
        await simulateExecDelay();
      }

      // For manual sells: re-capture MC after delay (price moved during execution).
      // For auto-exit: use provided snapshot (already the trigger-time MC).
      const rawSnapshot = resolveSnapshotForClose(current, isManual ? null : (options.snapshot || null));
      const positionSizeSol = Number(current.positionSizeSol || 0) * fraction;
      const fillMC = rawSnapshot.marketCap
        ? rawSnapshot.marketCap * getSlippageMultiplier(positionSizeSol, "sell")
        : null;
      const snapshot = { ...rawSnapshot, marketCap: fillMC };
      state.detected = snapshot;
      if (!snapshot.marketCap) {
        throw new Error("Live market cap is not available, so the trade could not be closed safely.");
      }
      const pnlPercentage = ((snapshot.marketCap / current.entryMarketCap) - 1) * 100;
      // pnlSol includes exit fee so displayed P&L reflects true cost
      const pnlSol = positionSizeSol * (pnlPercentage / 100) - FEE_PER_TRADE;
      const closeMeta = {
        trigger: options.trigger || "manual",
        reason: options.reason || "manual",
        positionId: current.positionId || null,
        tokenName: current.tokenName,
        fraction: Number(fraction.toFixed(6)),
        sizeSol: Number(positionSizeSol.toFixed(4)),
        pnlSol: Number(pnlSol.toFixed(6)),
        pnlPct: Number(pnlPercentage.toFixed(2)),
        entryMarketCap: Number(current.entryMarketCap.toFixed(2)),
        exitMarketCap: Number(snapshot.marketCap.toFixed(2)),
        capture: createCaptureMeta(snapshot),
        contractAddress: current.contractAddress || "",
        pairAddress: current.pairAddress || "",
      };
      const closeEvent = createPositionEvent("sell", snapshot, {
        sizeSol: Number(positionSizeSol.toFixed(4)),
        positionSizeSol: Number(Math.max(0, current.positionSizeSol - positionSizeSol).toFixed(4)),
        pnlSol: Number(pnlSol.toFixed(6)),
        pnlPct: Number(pnlPercentage.toFixed(2)),
        trigger: options.trigger || "manual",
        reason: options.reason || "manual",
      });
      const closeTradePayload = {
        token_name: current.tokenName,
        pnl_sol: Number(pnlSol.toFixed(6)),
        pnl_percentage: Number(pnlPercentage.toFixed(2)),
        entry_market_cap: Number((current.entryMarketCap || 0).toFixed(2)),
        exit_market_cap: Number((snapshot.marketCap || 0).toFixed(2)),
        notes: encodeCloseTradeNote(closeMeta),
        trade_timestamp: new Date().toISOString(),
      };

      // Update local state first — this always succeeds
      // Use the key the position was actually stored under to avoid CA vs tokenName mismatch
      const posKey = current.storageKey || getPositionKey(current);
      let nextOpenPosition = null;
      if (fraction >= 1) {
        delete state.openPositions[posKey];
        // Also clean up any legacy tokenName alias
        if (current.contractAddress && posKey !== current.tokenName) {
          delete state.openPositions[current.tokenName];
        }
      } else {
        const remainingPositionSizeSol = Number((current.positionSizeSol * (1 - fraction)).toFixed(4));
        nextOpenPosition = {
          ...current,
          positionSizeSol: remainingPositionSizeSol,
          realizedPnlSol: Number(((current.realizedPnlSol || 0) + pnlSol).toFixed(6)),
          totalFeesSol: Number(((current.totalFeesSol || 0) + FEE_PER_TRADE).toFixed(4)),
          lastCapture: createCaptureMeta(snapshot),
          events: appendPositionEvent(current, closeEvent),
        };
        state.openPositions[posKey] = nextOpenPosition;
        // Also clean up any legacy tokenName alias
        if (current.contractAddress && posKey !== current.tokenName) {
          delete state.openPositions[current.tokenName];
        }
      }

      const returnedSol = positionSizeSol + pnlSol;
      state.virtualBalance = Number((state.virtualBalance + Math.max(0, returnedSol)).toFixed(4));
      await saveVirtualBalance();
      await saveOpenPositions();
      syncDashboardStateImmediately();

      // Sync to Supabase — queue on failure so local state is never rolled back
      try {
        await insertTrade({ user_id: state.user.id, ...closeTradePayload });
        if (fraction >= 1 && current.backendTradeId) {
          await deleteTrade(current.backendTradeId);
        } else if (nextOpenPosition) {
          nextOpenPosition.backendTradeId = await persistOpenPosition(nextOpenPosition);
          state.openPositions[posKey] = nextOpenPosition;
          await saveOpenPositions();
          syncDashboardStateImmediately();
        }
        await loadTrades();
      } catch (_syncError) {
        await enqueueClose({
          closeTradePayload,
          openTradeIdToDelete: fraction >= 1 ? (current.backendTradeId || null) : null,
          updatedOpenPosition: nextOpenPosition,
        });
      }
      debugLog("SELL", { token: current.tokenName, ca: current.contractAddress, mc: snapshot.marketCap, mcSource: snapshot.marketCapSource, sizeSol: positionSizeSol, pnlSol, fraction, trigger: options.trigger || "manual", openTradeId: current.backendTradeId });
      setStatus("", "neutral");
    } catch (error) {
      sentryError(error, { action: "sell", token: current.tokenName, ca: current.contractAddress, fraction, trigger: options.trigger || "manual", mc: state.detected?.marketCap, mcSource: state.detected?.marketCapSource });
      setStatus(error.message || "Could not close live trade.", "bad");
    } finally {
      state.tradeBusy = false;
      state.tradeStatus = null;
      render();
    }
  }

  async function closeTradeByAmount(rawAmount) {
    if (state.tradeBusy) return;
    const current = getCurrentPosition();
    if (!current || !state.user) return;

    const amount = Math.max(0, Math.min(Number(rawAmount || 0), Number(current.positionSizeSol || 0)));
    if (!amount) return;

    await closeTrade(amount / Number(current.positionSizeSol || 1));
  }

  async function boot() {
    window.addEventListener("message", event => {
      if (event.source !== window) return;
      if (event.data?.source !== "td-axiom-socket") return;
      handleSocketPayload(event.data.payload);
    });

    if (!document.body) {
      await new Promise(resolve => {
        const ready = () => {
          if (!document.body) return;
          document.removeEventListener("DOMContentLoaded", ready);
          resolve();
        };
        document.addEventListener("DOMContentLoaded", ready);
      });
    }

    const stored = await storage.get(["td_session", OPEN_POSITIONS_KEY, EXTENSION_ENABLED_KEY, FORCE_OVERLAY_KEY, OVERLAY_POSITION_KEY, VIRTUAL_BALANCE_KEY, BG_PRICE_KEY, OVERLAY_DARK_THEME_KEY, STOP_LOSS_ENABLED_KEY, TARGET_SELL_ENABLED_KEY, SIMULATION_SETTINGS_KEY]);
    state.session = stored.td_session || null;
    state.openPositions = stored[OPEN_POSITIONS_KEY] || {};
    state.enabled = stored[EXTENSION_ENABLED_KEY] !== false;
    state.forceOverlay = stored[FORCE_OVERLAY_KEY] === true;
    state.position = clampPosition(stored[OVERLAY_POSITION_KEY] || state.position);
    state.virtualBalance = Number(stored[VIRTUAL_BALANCE_KEY] || 0);
    state.bgPrice = stored[BG_PRICE_KEY] || null;
    state.darkTheme = stored[OVERLAY_DARK_THEME_KEY] !== false;
    state.stopLossEnabled = stored[STOP_LOSS_ENABLED_KEY] === true;
    state.simSettings = stored[SIMULATION_SETTINGS_KEY] || { ...SIM_DEFAULTS };
    state.detected = detectPageSnapshot();

    if (state.session?.access_token) {
      try {
        state.user = await withSession(async accessToken => fetchUser(accessToken));
        sentryUser(state.user);
        await loadTrades();
        await loadOpenPositionsFromBackend();
        await flushCloseQueue();
      } catch (_error) {
        await clearSession();
      }
    }

    render();

    function refreshPageSnapshot() {
      const nextSnapshot = detectPageSnapshot();
      const nextKey = `${location.href}|${nextSnapshot.tokenName}|${nextSnapshot.isCoinPage}`;
      if (nextKey === lastPageKey) return;
      const prevDetected = state.detected;
      lastPageKey = nextKey;
      state.detected = nextSnapshot;
      renderUnlessEditing();
      void maybeRunAutoExit("page-refresh");
      debugLog("PAGE changed", { token: nextSnapshot.tokenName, ca: nextSnapshot.contractAddress, mc: nextSnapshot.marketCap, mcSource: nextSnapshot.marketCapSource });
      // When navigating to a new coin, reload positions from backend so any
      // position created on another device or after an extension restart is resumed.
      const coinChanged = nextSnapshot.isCoinPage && state.user && (
        prevDetected?.contractAddress !== nextSnapshot.contractAddress ||
        prevDetected?.tokenName !== nextSnapshot.tokenName
      );
      if (coinChanged) {
        clearTimeout(state._caCopyTimer);
        state.caCopiedUntil = 0;
        state._wsRefPrice = null;
        stopDexPoll();
        void loadOpenPositionsFromBackend().then(() => renderUnlessEditing()).catch(() => {});
        const pairAddr = nextSnapshot.pairAddress;
        const tokenAddr = nextSnapshot.contractAddress;
        if (pairAddr) {
          void fetchDexScreenerPairInfo(pairAddr).then(() => startDexPoll(pairAddr));
        } else if (tokenAddr) {
          void fetchDexScreenerByToken(tokenAddr);
        }
      } else if (nextSnapshot.pairAddress && nextSnapshot.pairAddress !== lastDexFetchPairAddress) {
        void fetchDexScreenerPairInfo(nextSnapshot.pairAddress).then(() => startDexPoll(nextSnapshot.pairAddress));
      }
    }

    function schedulePageRefresh(delay = 80) {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = window.setTimeout(refreshPageSnapshot, delay);
    }

    function clearRouteRefreshBurst() {
      routeBurstTimers.forEach(timer => window.clearTimeout(timer));
      routeBurstTimers = [];
    }

    function runRouteRefreshBurst() {
      clearRouteRefreshBurst();
      refreshPageSnapshot();
      routeBurstTimers = [45, 120, 260].map(delay => (
        window.setTimeout(refreshPageSnapshot, delay)
      ));
    }

    function hideOverlayImmediatelyForRouteExit() {
      if (isImmediateCoinRoute()) return;
      if (!state.detected?.isCoinPage && root.style.display === "none") return;
      state.detected = {
        tokenName: "Unknown",
        tokenFullName: null,
        marketCap: null,
        marketCapSource: "missing",
        marketCapText: "",
        contractAddress: "",
        pairAddress: "",
        pageUrl: location.href,
        isCoinPage: false,
        capturedAt: Date.now(),
      };
      lastPageKey = "";
      render();
    }

    function getPathnameFromNavigationTarget(target) {
      if (!target) return null;
      try {
        return new URL(String(target), location.href).pathname;
      } catch {
        return null;
      }
    }

    function prehideForNavigationTarget(target) {
      const nextPathname = getPathnameFromNavigationTarget(target);
      if (!nextPathname) return;
      if (isImmediateCoinRoute(nextPathname)) return;
      if (!state.detected?.isCoinPage) return;
      state.detected = {
        tokenName: "Unknown",
        tokenFullName: null,
        marketCap: null,
        marketCapSource: "missing",
        marketCapText: "",
        contractAddress: "",
        pairAddress: "",
        pageUrl: new URL(String(target), location.href).toString(),
        isCoinPage: false,
        capturedAt: Date.now(),
      };
      lastPageKey = "";
      render();
    }

    function patchHistoryNavigation() {
      if (historyPatched) return;
      historyPatched = true;
      const dispatchNavigation = () => window.dispatchEvent(new Event("td:navigation"));
      for (const method of ["pushState", "replaceState"]) {
        const original = window.history[method];
        if (typeof original !== "function") continue;
        window.history[method] = function (...args) {
          prehideForNavigationTarget(args[2]);
          const result = original.apply(this, args);
          dispatchNavigation();
          return result;
        };
      }
    }

    lastPageKey = "";
    refreshPageSnapshot();
    patchHistoryNavigation();

    const observer = new MutationObserver(() => {
      schedulePageRefresh(70);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("pointerup", () => {
      if (!dragState) schedulePageRefresh(24);
    }, true);
    document.addEventListener("click", event => {
      const anchor = event.target?.closest?.("a[href]");
      if (!anchor) return;
      if (anchor.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      prehideForNavigationTarget(anchor.getAttribute("href"));
    }, true);
    const handleRouteSignal = () => {
      hideOverlayImmediatelyForRouteExit();
      runRouteRefreshBurst();
    };
    window.addEventListener("popstate", handleRouteSignal);
    window.addEventListener("hashchange", handleRouteSignal);
    window.addEventListener("td:navigation", handleRouteSignal);
    document.addEventListener("DOMContentLoaded", handleRouteSignal, { once: true });
    window.addEventListener("load", handleRouteSignal, { once: true });
    window.setInterval(refreshPageSnapshot, 450);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      storage.get([VIRTUAL_BALANCE_KEY]).then(stored => {
        const fresh = Number(stored[VIRTUAL_BALANCE_KEY] || 0);
        if (fresh !== state.virtualBalance) {
          state.virtualBalance = fresh;
          renderUnlessEditing();
        }
      }).catch(() => {});
    });

    chrome.storage.onChanged.addListener(changes => {
      if (changes[EXTENSION_ENABLED_KEY]) {
        state.enabled = changes[EXTENSION_ENABLED_KEY].newValue !== false;
        renderUnlessEditing();
      }
      if (changes[FORCE_OVERLAY_KEY]) {
        state.forceOverlay = changes[FORCE_OVERLAY_KEY].newValue === true;
        renderUnlessEditing();
      }
      if (changes[OPEN_POSITIONS_KEY]) {
        state.openPositions = changes[OPEN_POSITIONS_KEY].newValue || {};
        renderUnlessEditing();
      }
      if (changes[BG_PRICE_KEY]) {
        state.bgPrice = changes[BG_PRICE_KEY].newValue || null;
        void maybeRunAutoExit("bg-price-update");
        renderUnlessEditing();
      }
      if (changes[VIRTUAL_BALANCE_KEY]) {
        state.virtualBalance = Number(changes[VIRTUAL_BALANCE_KEY].newValue || 0);
        renderUnlessEditing();
      }
      if (changes[OVERLAY_DARK_THEME_KEY]) {
        state.darkTheme = changes[OVERLAY_DARK_THEME_KEY].newValue !== false;
        renderUnlessEditing();
      }
      if (changes[STOP_LOSS_ENABLED_KEY]) {
        state.stopLossEnabled = changes[STOP_LOSS_ENABLED_KEY].newValue === true;
        renderUnlessEditing();
      }
      if (changes[SIMULATION_SETTINGS_KEY]) {
        state.simSettings = changes[SIMULATION_SETTINGS_KEY].newValue || { ...SIM_DEFAULTS };
        renderUnlessEditing();
      }
      if (changes["td_session"]) {
        const newSession = changes["td_session"].newValue;
        if (newSession?.access_token && !state.user) {
          state.session = newSession;
          withSession(async at => fetchUser(at))
            .then(async user => { state.user = user; await loadTrades(); await loadOpenPositionsFromBackend(); await flushCloseQueue(); })
            .catch(async () => { await clearSession(); })
            .finally(() => render());
        } else if (!newSession && state.user) {
          state.session = null;
          state.user = null;
          state.trades = [];
          render();
        }
      }
    });

    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === "td_check_auto_exit") {
        void maybeRunAutoExit("bg-alarm");
      }
    });
  }

  boot();
})();
