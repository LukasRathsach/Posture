(function () {
  if (window.__POSTURE_AXIOM_OVERLAY__) return;
  window.__POSTURE_AXIOM_OVERLAY__ = true;

  const config = window.POSTURE_EXTENSION_CONFIG;
  const storage = chrome.storage.local;
  const OPEN_POSITIONS_KEY = "td_open_positions";
  const EXTENSION_ENABLED_KEY = "td_extension_enabled";
  const FORCE_OVERLAY_KEY = "td_force_overlay";
  const OVERLAY_POSITION_KEY = "td_overlay_position";
  const OVERLAY_COMPACT_KEY = "td_overlay_compact";
  const VIRTUAL_BALANCE_KEY = "td_virtual_balance";
  const BG_PRICE_KEY = "td_bg_price";
  const OVERLAY_DARK_THEME_KEY = "td_overlay_dark_theme";
  const OPEN_TRADE_NOTE_PREFIX = "__TD_OPEN__";
  const CLOSE_TRADE_NOTE_PREFIX = "__TD_CLOSE__";
  const MAX_POSITION_EVENTS = 12;
  const FEE_PER_TRADE = 0.01;
  const BUY_PRESETS = [0.1, 0.2, 0.4, 1];
  const SELL_PRESETS = [10, 25, 50, 100];

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
    compact: false,
    position: { top: 242, left: 224 },
    forceOverlay: false,
    pairInfo: null,
    tokenMetadata: null,
    solPriceUsd: null,
    livePairPriceNative: null,
    virtualBalance: 0,
    settingsOpen: false,
    posNavOpen: false,
    bgPrice: null,
    darkTheme: true,
  };

  let pageRefreshTimer = null;
  let lastPageKey = "";
  let dragState = null;
  let liveDataRenderTimer = null;
  const root = document.createElement("div");
  root.className = "td-overlay-root";
  document.documentElement.appendChild(root);

  function injectSocketHook() {
    if (document.getElementById("td-axiom-socket-hook")) return;
    const script = document.createElement("script");
    script.id = "td-axiom-socket-hook";
    script.textContent = `
      (() => {
        if (window.__TD_AXIOM_SOCKET_HOOK__) return;
        window.__TD_AXIOM_SOCKET_HOOK__ = true;

        const emit = payload => {
          window.postMessage({ source: "td-axiom-socket", payload }, "*");
        };

        const wireSocket = socket => {
          socket.addEventListener("message", event => {
            try {
              const data = JSON.parse(event.data);
              if (!data || typeof data !== "object") return;
              emit(data);
            } catch (_error) {}
          });
        };

        const NativeWebSocket = window.WebSocket;
        window.WebSocket = function (...args) {
          const socket = new NativeWebSocket(...args);
          wireSocket(socket);
          return socket;
        };
        window.WebSocket.prototype = NativeWebSocket.prototype;
        Object.setPrototypeOf(window.WebSocket, NativeWebSocket);
        window.WebSocket.CONNECTING = NativeWebSocket.CONNECTING;
        window.WebSocket.OPEN = NativeWebSocket.OPEN;
        window.WebSocket.CLOSING = NativeWebSocket.CLOSING;
        window.WebSocket.CLOSED = NativeWebSocket.CLOSED;
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  }

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

    const pairAddress = state.pairInfo?.pairAddress;
    if (pairAddress && room === `b-${pairAddress}`) {
      const nextPairPrice = Number(data.content || 0);
      if (Number.isFinite(nextPairPrice) && nextPairPrice > 0) {
        state.livePairPriceNative = nextPairPrice;
        changed = true;
      }
    }

    if (changed && shouldShowOverlay()) {
      clearTimeout(liveDataRenderTimer);
      liveDataRenderTimer = window.setTimeout(() => {
        render();
        void maybeRunAutoExit("socket-update");
      }, 80);
    }
  }

  function setStatus(message, tone) {
    state.status = message || "";
    state.statusTone = tone || "neutral";
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

  function findAxiomPairInfoFromScripts() {
    const scripts = findJsonScripts();
    for (const text of scripts) {
      const match = text.match(/\{"tokenImage":.*?"pairAddress":.*?"tokenAddress":.*?"tokenTicker":.*?\}/s);
      if (!match) continue;
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed?.tokenAddress && parsed?.tokenTicker) return parsed;
      } catch (_error) {
        continue;
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

  function buildPositionId(tokenName, openedAt) {
    const safeToken = String(tokenName || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    return `${safeToken}_${openedAt}`;
  }

  function getPositionKey(snapshotOrPosition) {
    return snapshotOrPosition?.contractAddress || snapshotOrPosition?.tokenName || "unknown";
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
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return -Math.abs(Number(parsed.toFixed(2)));
  }

  function normalizeTargetSellPct(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.abs(Number(parsed.toFixed(2)));
  }

  function encodeOpenTradeNote(position) {
    return `${OPEN_TRADE_NOTE_PREFIX}${JSON.stringify({
      positionId: position.positionId,
      tokenName: position.tokenName,
      entryMarketCap: Number(position.entryMarketCap || 0),
      positionSizeSol: Number(position.positionSizeSol || 0),
      initialSizeSol: Number(position.initialSizeSol || 0),
      realizedPnlSol: Number(position.realizedPnlSol || 0),
      openedAt: Number(position.openedAt || Date.now()),
      pageUrl: position.pageUrl || "",
      marketCapSource: position.marketCapSource || "unknown",
      contractAddress: position.contractAddress || "",
      pairAddress: position.pairAddress || "",
      stopLossPct: position.stopLossPct ?? null,
      targetSellPct: position.targetSellPct ?? null,
      entryCapture: position.entryCapture || null,
      lastCapture: position.lastCapture || null,
      events: Array.isArray(position.events) ? position.events.slice(-MAX_POSITION_EVENTS) : [],
    })}`;
  }

  function encodeCloseTradeNote(closeMeta) {
    return `${CLOSE_TRADE_NOTE_PREFIX}${JSON.stringify(closeMeta)}`;
  }

  function parseOpenTradeNote(note, fallbackTrade) {
    if (!String(note || "").startsWith(OPEN_TRADE_NOTE_PREFIX)) return null;
    const raw = String(note || "").slice(OPEN_TRADE_NOTE_PREFIX.length);
    const fallbackTimestamp = fallbackTrade?.trade_timestamp
      ? new Date(fallbackTrade.trade_timestamp).getTime()
      : Date.now();

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      const openedAt = Number(parsed.openedAt || fallbackTimestamp);
      const tokenName = parsed.tokenName || fallbackTrade?.token_name || fallbackTrade?.tokenName || "Unknown";
      const positionSizeSol = Number(parsed.positionSizeSol || 0);
      const initialSizeSol = Number(parsed.initialSizeSol || positionSizeSol || 0);
      return {
        positionId: parsed.positionId || buildPositionId(tokenName, openedAt),
        tokenName,
        entryMarketCap: Number(parsed.entryMarketCap || fallbackTrade?.entry_market_cap || fallbackTrade?.entryMarketCap || 0),
        positionSizeSol,
        initialSizeSol,
        realizedPnlSol: Number(parsed.realizedPnlSol || 0),
        openedAt,
        pageUrl: parsed.pageUrl || "",
        marketCapSource: parsed.marketCapSource || "unknown",
        contractAddress: parsed.contractAddress || "",
        pairAddress: parsed.pairAddress || "",
        stopLossPct: parsed.stopLossPct ?? null,
        targetSellPct: parsed.targetSellPct ?? null,
        entryCapture: parsed.entryCapture || null,
        lastCapture: parsed.lastCapture || null,
        events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_POSITION_EVENTS) : [],
      };
    } catch (_error) {
      const legacySize = Number(raw || 0);
      const openedAt = fallbackTimestamp;
      const tokenName = fallbackTrade?.token_name || fallbackTrade?.tokenName || "Unknown";
      return {
        positionId: buildPositionId(tokenName, openedAt),
        tokenName,
        entryMarketCap: Number(fallbackTrade?.entry_market_cap || fallbackTrade?.entryMarketCap || 0),
        positionSizeSol: legacySize,
        initialSizeSol: legacySize,
        openedAt,
        pageUrl: "",
        marketCapSource: "legacy",
        contractAddress: "",
        pairAddress: "",
        stopLossPct: null,
        targetSellPct: null,
        entryCapture: null,
        lastCapture: null,
        events: [],
      };
    }
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
        entryMarketCap: Number(snapshot.marketCap),
        positionSizeSol: addSize,
        initialSizeSol: addSize,
        openedAt,
        pageUrl: snapshot.pageUrl,
        marketCapSource: snapshot.marketCapSource || "unknown",
        contractAddress: snapshot.contractAddress || "",
        pairAddress: snapshot.pairAddress || "",
        stopLossPct: null,
        targetSellPct: null,
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
      entryMarketCap: Number(weightedEntryMarketCap.toFixed(2)),
      positionSizeSol: nextPositionSizeSol,
      initialSizeSol: nextInitialSizeSol,
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

  function detectTokenFromPage() {
    const scriptPairInfo = findAxiomPairInfoFromScripts();
    if (scriptPairInfo?.tokenTicker) return scriptPairInfo.tokenTicker;

    const axiomToken = getTextContent("span.hidden.lg\\:inline.xl\\:hidden > div.min-w-0.overflow-hidden.truncate.whitespace-nowrap");
    if (axiomToken && /^[A-Z0-9]{2,16}$/.test(axiomToken)) return axiomToken;

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, [class*='title'], [class*='symbol']"))
      .map(el => (el.textContent || "").trim())
      .filter(Boolean);
    const exact = headings.find(text => /^[A-Z0-9]{2,12}$/.test(text));
    if (exact) return exact;

    const urlBits = location.pathname.split("/").map(bit => decodeURIComponent(bit)).reverse();
    const fromUrl = urlBits.find(bit => /^[A-Z0-9]{2,12}$/.test(bit));
    if (fromUrl) return fromUrl;

    const fallback = (document.body.innerText || "").match(/\b[A-Z0-9]{2,12}\b/g);
    return fallback?.find(token => token.length >= 2 && token.length <= 12) || "Unknown";
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

  function detectPageSnapshot() {
    const marketCapCapture = detectMarketCapFromPage();
    const contractCapture = detectContractAddressFromPage();
    return {
      tokenName: detectTokenFromPage(),
      marketCap: marketCapCapture?.value || null,
      marketCapSource: marketCapCapture?.source || "missing",
      marketCapText: marketCapCapture?.text || "",
      contractAddress: contractCapture.contractAddress || "",
      pairAddress: contractCapture.pairAddress || "",
      pageUrl: location.href,
      isCoinPage: /^\/meme\/[^/]+/.test(location.pathname),
      capturedAt: Date.now(),
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
      nextPositions[positionKey] = {
        ...(nextPositions[positionKey] || {}),
        ...parsed,
        backendTradeId: row.id,
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

  async function persistOpenPosition(position) {
    const payload = {
      token_name: position.tokenName,
      pnl_sol: 0,
      pnl_percentage: 0,
      entry_market_cap: Number(position.entryMarketCap.toFixed(2)),
      exit_market_cap: Number((position.lastCapture?.marketCap || position.entryMarketCap || 0).toFixed(2)),
      notes: encodeOpenTradeNote(position),
      trade_timestamp: new Date(position.openedAt || Date.now()).toISOString(),
    };

    if (position.backendTradeId) {
      await updateTrade(position.backendTradeId, payload);
      return position.backendTradeId;
    }

    const openTrade = await insertTrade({
      user_id: state.user.id,
      ...payload,
    });
    return openTrade?.id || null;
  }

  async function saveVirtualBalance() {
    await storage.set({ [VIRTUAL_BALANCE_KEY]: state.virtualBalance });
  }

  async function saveThemePreference() {
    await storage.set({ [OVERLAY_DARK_THEME_KEY]: state.darkTheme });
  }

  async function saveOverlayUiState() {
    await storage.set({
      [OVERLAY_POSITION_KEY]: state.position,
      [OVERLAY_COMPACT_KEY]: state.compact,
    });
  }

  function getCurrentPosition() {
    const contractKey = state.detected?.contractAddress;
    if (contractKey && state.openPositions[contractKey]) {
      return state.openPositions[contractKey] || null;
    }
    const token = state.detected?.tokenName;
    return token ? state.openPositions[token] || null : null;
  }

  function getCurrentSolBalance() {
    const current = getCurrentPosition();
    return Number(current?.positionSizeSol || 0);
  }

  function getEstimatedLiveMarketCapUsd() {
    const supply = Number(state.tokenMetadata?.supply || state.pairInfo?.supply || 0);
    const priceNative = Number(state.livePairPriceNative || state.tokenMetadata?.priceNative || 0);
    const solPriceUsd = Number(state.solPriceUsd || state.bgPrice?.solPriceUsd || 0);
    if (supply > 0 && priceNative > 0 && solPriceUsd > 0) {
      return supply * priceNative * solPriceUsd;
    }
    // Fall back to background worker's last known market cap
    const bgMC = Number(state.bgPrice?.marketCapUsd || 0);
    return bgMC > 0 ? bgMC : null;
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
    if (livePnlPct === null) return;

    const rawStopLossPct = current.stopLossPct;
    const stopLossPct = rawStopLossPct === null || rawStopLossPct === undefined || rawStopLossPct === ""
      ? null
      : Number(rawStopLossPct);
    if (Number.isFinite(stopLossPct) && stopLossPct < 0 && livePnlPct <= stopLossPct) {
      await closeTrade(1, { trigger: "stop_loss", reason, snapshot: state.detected });
      return;
    }

    const rawTargetSellPct = current.targetSellPct;
    const targetSellPct = rawTargetSellPct === null || rawTargetSellPct === undefined || rawTargetSellPct === ""
      ? null
      : Number(rawTargetSellPct);
    if (Number.isFinite(targetSellPct) && targetSellPct > 0 && livePnlPct >= targetSellPct) {
      await closeTrade(1, { trigger: "target_sell", reason, snapshot: state.detected });
    }
  }

  function shouldShowOverlay() {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) return false;
    if (!state.enabled) return false;
    if (state.forceOverlay) return true;
    if (!state.detected?.isCoinPage) return false;
    if (!state.detected?.tokenName || state.detected.tokenName === "Unknown") return false;
    if (!state.detected?.marketCap) return false;
    return true;
  }

  function clampPosition(nextPosition) {
    const maxLeft = Math.max(12, window.innerWidth - (state.compact ? 332 : 332));
    const maxTop = Math.max(12, window.innerHeight - (state.compact ? 56 : 300));
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
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      startLeft: state.position.left,
      startTop: state.position.top,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", stopDrag);
  }

  function onDragMove(event) {
    if (!dragState) return;
    state.position = clampPosition({
      left: dragState.startLeft + (event.clientX - dragState.startX),
      top: dragState.startTop + (event.clientY - dragState.startY),
    });
    applyOverlayPosition();
  }

  async function stopDrag() {
    if (!dragState) return;
    dragState = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", stopDrag);
    await saveOverlayUiState();
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
    root.dataset.compact = String(state.compact);
    applyOverlayPosition();

    const currentPosition = getCurrentPosition();
    const solBalanceLabel = `${state.virtualBalance.toFixed(2)} SOL`;

    let livePnlPct = null;
    let livePnlSol = null;
    const realizedPnl = currentPosition?.realizedPnlSol || 0;
    const liveMC = getEstimatedLiveMarketCapUsd() || state.detected?.marketCap;
    if (currentPosition && currentPosition.entryMarketCap > 0 && liveMC > 0) {
      const unrealizedPnl = currentPosition.positionSizeSol * (liveMC / currentPosition.entryMarketCap - 1);
      livePnlSol = unrealizedPnl + realizedPnl;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      livePnlPct = initialSol > 0 ? (livePnlSol / initialSol) * 100 : null;
    } else if (realizedPnl !== 0 && currentPosition) {
      livePnlSol = realizedPnl;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      livePnlPct = initialSol > 0 ? (livePnlSol / initialSol) * 100 : null;
    }

    let posSummaryHtml = "";
    let automationControlsHtml = "";
    if (currentPosition) {
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

      posSummaryHtml = `
        <div class="td-overlay-pos-summary">
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Invested</span>
            <span class="td-overlay-pos-value">${investedStr}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Sold</span>
            <span class="td-overlay-pos-value">${soldStr}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Remaining</span>
            <span class="td-overlay-pos-value">${remainingStr}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">PnL</span>
            <span class="td-overlay-pos-value ${pnlClass}">${pnlStr}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Stop</span>
            <span class="td-overlay-pos-value">${currentPosition.stopLossPct ? `${Math.abs(currentPosition.stopLossPct).toFixed(1)}%` : "—"}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Target</span>
            <span class="td-overlay-pos-value">${currentPosition.targetSellPct ? `${currentPosition.targetSellPct.toFixed(1)}%` : "—"}</span>
          </div>
        </div>
      `;
      automationControlsHtml = `
        <div class="td-overlay-automation">
          <div class="td-overlay-automation-row">
            <input class="td-overlay-input td-overlay-automation-input" type="number" min="0" step="0.1" placeholder="Stop %" value="${currentPosition.stopLossPct ? Math.abs(currentPosition.stopLossPct) : ""}" data-stop-loss-input />
            <input class="td-overlay-input td-overlay-automation-input" type="number" min="0" step="0.1" placeholder="Target %" value="${currentPosition.targetSellPct || ""}" data-target-sell-input />
          </div>
          <div class="td-overlay-automation-actions">
            <button class="td-overlay-sell-sub-btn" type="button" data-save-automation>Save levels</button>
            <button class="td-overlay-sell-sub-btn" type="button" data-clear-automation>Clear</button>
          </div>
        </div>
      `;
    }
    const personIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="7" r="4"/>
        <path d="M4 21v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2"/>
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
          <div class="td-overlay-head">
            <div style="display:flex;align-items:center;gap:4px">
              <button class="td-overlay-icon-btn td-overlay-icon-btn-pos${state.posNavOpen ? " is-active" : ""}" type="button" data-pos-toggle aria-label="Toggle live trades">${listIcon}</button>
              <a class="td-overlay-icon-btn" href="${config.dashboardUrl}" target="_blank" rel="noopener noreferrer" data-dashboard-link aria-label="Open dashboard">${statsIcon}</a>
            </div>
            <button class="td-overlay-balance" type="button" data-open-balance style="display:flex;align-items:center;gap:5px">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.44955 6.75999H12.0395C12.1595 6.75999 12.2695 6.80999 12.3595 6.89999L13.8795 8.45999C14.1595 8.74999 13.9595 9.23999 13.5595 9.23999H3.96955C3.84955 9.23999 3.73955 9.18999 3.64955 9.09999L2.12955 7.53999C1.84955 7.24999 2.04955 6.75999 2.44955 6.75999ZM2.12955 4.68999L3.64955 3.12999C3.72955 3.03999 3.84955 2.98999 3.96955 2.98999H13.5495C13.9495 2.98999 14.1495 3.47999 13.8695 3.76999L12.3595 5.32999C12.2795 5.41999 12.1595 5.46999 12.0395 5.46999H2.44955C2.04955 5.46999 1.84955 4.97999 2.12955 4.68999ZM13.8695 11.3L12.3495 12.86C12.2595 12.95 12.1495 13 12.0295 13H2.44955C2.04955 13 1.84955 12.51 2.12955 12.22L3.64955 10.66C3.72955 10.57 3.84955 10.52 3.96955 10.52H13.5495C13.9495 10.52 14.1495 11.01 13.8695 11.3Z" fill="url(#solG)"/><defs><linearGradient id="solG" x1="1.77756" y1="13.3327" x2="13.9679" y2="1.14234" gradientUnits="userSpaceOnUse"><stop stop-color="#9945FF"/><stop offset="0.24" stop-color="#8752F3"/><stop offset="0.465" stop-color="#5497D5"/><stop offset="0.6" stop-color="#43B4CA"/><stop offset="0.735" stop-color="#28E0B9"/><stop offset="1" stop-color="#19FB9B"/></linearGradient></defs></svg>
              ${solBalanceLabel}
              <span class="td-overlay-balance-tip">Add more SOL</span>
            </button>
            <div class="td-overlay-head-actions">
              <button class="td-overlay-icon-btn td-overlay-icon-btn-settings" type="button" data-open-settings aria-label="Account settings">${personIcon}</button>
            </div>
          </div>

          ${state.settingsOpen ? `
            <div class="td-overlay-settings-panel">
              ${state.user ? `<button class="td-overlay-settings-signout" type="button" data-sign-out>Sign out</button>` : ""}
            </div>
          ` : ""}

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
                      return `<a class="td-overlay-pos-nav-row${isCurrent ? " is-current" : ""}" href="${pos.pageUrl || "#"}" data-pos-nav title="Go to ${pos.tokenName}">
                        <span class="td-overlay-pos-nav-name">${pos.tokenName}</span>
                        <span class="td-overlay-pos-nav-size">${sizeLabel}</span>
                      </a>`;
                    }).join("")}
                  </div>
                `;
              })()}
              <div class="td-overlay-label">Buy</div>
              <div class="td-overlay-preset-grid">
                ${BUY_PRESETS.map(value => {
                  const totalRequired = Number((value + FEE_PER_TRADE).toFixed(4));
                  const disabled = state.virtualBalance < totalRequired;
                  const button = `<button class="td-overlay-preset" type="button" data-buy="${value}" ${disabled ? "disabled" : ""}>${value} SOL</button>`;
                  return disabled
                    ? `<span class="td-overlay-disabled-hint" data-hint="Need ${totalRequired.toFixed(2)} SOL including fee">${button}</span>`
                    : button;
                }).join("")}
              </div>

              <div class="td-overlay-label">Sell</div>
              ${posSummaryHtml}
              ${automationControlsHtml}
              <div class="td-overlay-sell-stack">
                <div class="td-overlay-sell-grid">
                  ${SELL_PRESETS.map(percent => `<button class="td-overlay-pill td-overlay-pill-sell" type="button" data-sell-percent="${percent}" ${currentPosition ? "" : "disabled"}>${percent}%</button>`).join("")}
                </div>
                <div class="td-overlay-sell-sub" style="justify-content:flex-end">
                  <button class="td-overlay-sell-sub-btn" type="button" data-sell-init ${currentPosition ? "" : "disabled"}>Sell init.</button>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>
    `;

    root.querySelector("[data-pos-toggle]")?.addEventListener("click", () => {
      state.posNavOpen = !state.posNavOpen;
      render();
    });

    root.querySelectorAll("[data-open-balance]").forEach(el => el.addEventListener("click", () => {
      openDashboardBalanceModal();
    }));

    root.querySelectorAll("[data-open-settings]").forEach(el => el.addEventListener("click", () => {
      if (!state.user) return;
      state.settingsOpen = !state.settingsOpen;
      render();
    }));

    root.querySelector("[data-sign-out]")?.addEventListener("click", async () => {
      await signOutCurrentUser();
      state.settingsOpen = false;
      setStatus("Signed out.", "neutral");
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
        await loadTrades();
        await loadOpenPositionsFromBackend();
        setStatus("Connected. Sync is active.", "good");
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
        try {
          const size = Number(button.dataset.buy || 0);
          const totalRequired = Number((size + FEE_PER_TRADE).toFixed(4));
          if (state.virtualBalance < totalRequired) {
            throw new Error(`Need ${totalRequired.toFixed(2)} SOL to cover size and fee.`);
          }
          const snapshot = detectPageSnapshot();
          state.detected = snapshot;
          if (!snapshot.marketCap) {
            throw new Error("Overlay is forced on, but market cap is still not being detected on this page.");
          }
          const positionKey = getPositionKey(snapshot);
          const current = state.openPositions[positionKey] || state.openPositions[snapshot.tokenName] || null;
          const nextPosition = upsertCurrentPosition(current, size, snapshot);
          state.openPositions[positionKey] = {
            ...nextPosition,
            backendTradeId: nextPosition.backendTradeId || null,
          };
          await saveOpenPositions();
          state.virtualBalance = Number(Math.max(0, state.virtualBalance - size).toFixed(4));
          await saveVirtualBalance();

          const backendTradeId = await persistOpenPosition(state.openPositions[positionKey]);
          state.openPositions[positionKey] = {
            ...state.openPositions[positionKey],
            backendTradeId,
          };
          await saveOpenPositions();
          setStatus(`Position synced: ${state.openPositions[positionKey].positionSizeSol.toFixed(2)} SOL`, "good");
        } catch (error) {
          setStatus(error.message || "Could not open live trade.", "bad");
        } finally {
          state.tradeBusy = false;
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

    root.querySelector("[data-save-automation]")?.addEventListener("click", async () => {
      const current = getCurrentPosition();
      if (!current || !state.user) return;
      const stopLossPct = normalizeStopLossPct(root.querySelector("[data-stop-loss-input]")?.value || "");
      const targetSellPct = normalizeTargetSellPct(root.querySelector("[data-target-sell-input]")?.value || "");
      const snapshot = state.detected || detectPageSnapshot();
      const nextPosition = {
        ...current,
        stopLossPct,
        targetSellPct,
        lastCapture: createCaptureMeta(snapshot),
        events: appendPositionEvent(current, createPositionEvent("automation_updated", snapshot, {
          stopLossPct,
          targetSellPct,
        })),
      };
      nextPosition.backendTradeId = await persistOpenPosition(nextPosition);
      state.openPositions[getPositionKey(nextPosition)] = nextPosition;
      await saveOpenPositions();
      setStatus("Stop loss / target saved.", "good");
      render();
      await maybeRunAutoExit("settings-update");
    });

    root.querySelector("[data-clear-automation]")?.addEventListener("click", async () => {
      const current = getCurrentPosition();
      if (!current || !state.user) return;
      const snapshot = state.detected || detectPageSnapshot();
      const nextPosition = {
        ...current,
        stopLossPct: null,
        targetSellPct: null,
        lastCapture: createCaptureMeta(snapshot),
        events: appendPositionEvent(current, createPositionEvent("automation_cleared", snapshot, {})),
      };
      nextPosition.backendTradeId = await persistOpenPosition(nextPosition);
      state.openPositions[getPositionKey(nextPosition)] = nextPosition;
      await saveOpenPositions();
      setStatus("Auto-sell levels cleared.", "good");
      render();
    });

  }

  async function closeTrade(fraction, options = {}) {
    if (state.tradeBusy) return;
    const current = getCurrentPosition();
    if (!current || !state.user) return;

    state.tradeBusy = true;
    try {
      const snapshot = resolveSnapshotForClose(current, options.snapshot || null);
      state.detected = snapshot;
      if (!snapshot.marketCap) {
        throw new Error("Live market cap is not available, so the trade could not be closed safely.");
      }
      const positionSizeSol = Number(current.positionSizeSol || 0) * fraction;
      const pnlPercentage = ((snapshot.marketCap / current.entryMarketCap) - 1) * 100;
      const pnlSol = positionSizeSol * (pnlPercentage / 100);
      const closeMeta = {
        trigger: options.trigger || "manual",
        reason: options.reason || "manual",
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
      await insertTrade({
        user_id: state.user.id,
        token_name: current.tokenName,
        pnl_sol: Number(pnlSol.toFixed(6)),
        pnl_percentage: Number(pnlPercentage.toFixed(2)),
        entry_market_cap: Number(current.entryMarketCap.toFixed(2)),
        exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
        notes: encodeCloseTradeNote(closeMeta),
        trade_timestamp: new Date().toISOString(),
      });

      if (fraction >= 1) {
        if (current.backendTradeId) {
          await deleteTrade(current.backendTradeId);
        }
        delete state.openPositions[getPositionKey(current)];
        if (current.contractAddress && state.openPositions[current.tokenName]) {
          delete state.openPositions[current.tokenName];
        }
      } else {
        const remainingPositionSizeSol = Number((current.positionSizeSol * (1 - fraction)).toFixed(4));
        const nextOpenPosition = {
          ...current,
          positionSizeSol: remainingPositionSizeSol,
          realizedPnlSol: Number(((current.realizedPnlSol || 0) + pnlSol).toFixed(6)),
          lastCapture: createCaptureMeta(snapshot),
          events: appendPositionEvent(current, closeEvent),
        };
        nextOpenPosition.backendTradeId = await persistOpenPosition(nextOpenPosition);
        state.openPositions[getPositionKey(nextOpenPosition)] = nextOpenPosition;
        if (current.contractAddress && state.openPositions[current.tokenName]) {
          delete state.openPositions[current.tokenName];
        }
      }

      const returnedSol = positionSizeSol + pnlSol;
      state.virtualBalance = Number((state.virtualBalance + returnedSol).toFixed(4));
      await saveVirtualBalance();
      await saveOpenPositions();
      await loadTrades();
      setStatus(options.trigger === "stop_loss" ? "Stop loss hit. Trade closed." : options.trigger === "target_sell" ? "Target hit. Trade closed." : "Trade sync completed.", "good");
    } catch (error) {
      setStatus(error.message || "Could not close live trade.", "bad");
    } finally {
      state.tradeBusy = false;
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
    injectSocketHook();
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

    const stored = await storage.get(["td_session", OPEN_POSITIONS_KEY, EXTENSION_ENABLED_KEY, FORCE_OVERLAY_KEY, OVERLAY_POSITION_KEY, OVERLAY_COMPACT_KEY, VIRTUAL_BALANCE_KEY, BG_PRICE_KEY, OVERLAY_DARK_THEME_KEY]);
    state.session = stored.td_session || null;
    state.openPositions = stored[OPEN_POSITIONS_KEY] || {};
    state.enabled = stored[EXTENSION_ENABLED_KEY] !== false;
    state.forceOverlay = stored[FORCE_OVERLAY_KEY] === true;
    state.compact = Boolean(stored[OVERLAY_COMPACT_KEY]);
    state.position = clampPosition(stored[OVERLAY_POSITION_KEY] || state.position);
    state.virtualBalance = Number(stored[VIRTUAL_BALANCE_KEY] || 0);
    state.bgPrice = stored[BG_PRICE_KEY] || null;
    state.darkTheme = stored[OVERLAY_DARK_THEME_KEY] !== false;
    state.detected = detectPageSnapshot();

    if (state.session?.access_token) {
      try {
        state.user = await withSession(async accessToken => fetchUser(accessToken));
        await loadTrades();
        await loadOpenPositionsFromBackend();
        setStatus("Sync is active.", "good");
      } catch (_error) {
        await clearSession();
      }
    }

    render();

    function refreshPageSnapshot() {
      const nextSnapshot = detectPageSnapshot();
      const nextKey = `${location.href}|${nextSnapshot.tokenName}|${nextSnapshot.marketCap || ""}|${nextSnapshot.isCoinPage}`;
      if (nextKey === lastPageKey) return;
      lastPageKey = nextKey;
      state.detected = nextSnapshot;
      render();
      void maybeRunAutoExit("page-refresh");
    }

    lastPageKey = "";
    refreshPageSnapshot();

    const observer = new MutationObserver(() => {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = window.setTimeout(() => {
        refreshPageSnapshot();
      }, 140);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener("pointerup", () => {
      clearTimeout(pageRefreshTimer);
      pageRefreshTimer = window.setTimeout(refreshPageSnapshot, 60);
    }, true);
    window.addEventListener("popstate", refreshPageSnapshot);
    window.setInterval(refreshPageSnapshot, 700);

    chrome.storage.onChanged.addListener(changes => {
      if (changes[EXTENSION_ENABLED_KEY]) {
        state.enabled = changes[EXTENSION_ENABLED_KEY].newValue !== false;
        render();
      }
      if (changes[FORCE_OVERLAY_KEY]) {
        state.forceOverlay = changes[FORCE_OVERLAY_KEY].newValue === true;
        render();
      }
      if (changes[OPEN_POSITIONS_KEY]) {
        state.openPositions = changes[OPEN_POSITIONS_KEY].newValue || {};
        render();
      }
      if (changes[BG_PRICE_KEY]) {
        state.bgPrice = changes[BG_PRICE_KEY].newValue || null;
        render();
      }
      if (changes[VIRTUAL_BALANCE_KEY]) {
        state.virtualBalance = Number(changes[VIRTUAL_BALANCE_KEY].newValue || 0);
        render();
      }
      if (changes[OVERLAY_DARK_THEME_KEY]) {
        state.darkTheme = changes[OVERLAY_DARK_THEME_KEY].newValue !== false;
        render();
      }
      if (changes["td_session"]) {
        const newSession = changes["td_session"].newValue;
        if (newSession?.access_token && !state.user) {
          state.session = newSession;
          withSession(async at => fetchUser(at))
            .then(async user => { state.user = user; await loadTrades(); await loadOpenPositionsFromBackend(); })
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
  }

  boot();
})();
