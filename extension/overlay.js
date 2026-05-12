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
  const OPEN_TRADE_NOTE_PREFIX = "__TD_OPEN__";
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
      }, 80);
    }
  }

  function setStatus(message, tone) {
    state.status = message || "";
    state.statusTone = tone || "neutral";
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

  function encodeOpenTradeNote(position) {
    return `${OPEN_TRADE_NOTE_PREFIX}${JSON.stringify({
      positionId: position.positionId,
      tokenName: position.tokenName,
      entryMarketCap: Number(position.entryMarketCap || 0),
      positionSizeSol: Number(position.positionSizeSol || 0),
      initialSizeSol: Number(position.initialSizeSol || 0),
      openedAt: Number(position.openedAt || Date.now()),
      pageUrl: position.pageUrl || "",
      marketCapSource: position.marketCapSource || "unknown",
      contractAddress: position.contractAddress || "",
      pairAddress: position.pairAddress || "",
    })}`;
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
        openedAt,
        pageUrl: parsed.pageUrl || "",
        marketCapSource: parsed.marketCapSource || "unknown",
        contractAddress: parsed.contractAddress || "",
        pairAddress: parsed.pairAddress || "",
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
        backendTradeId: null,
      };
    }

    const nextPositionSizeSol = Number((Number(current.positionSizeSol || 0) + addSize).toFixed(4));
    const nextInitialSizeSol = Number((Number(current.initialSizeSol || 0) + addSize).toFixed(4));
    const weightedEntryMarketCap = (
      (Number(current.entryMarketCap || 0) * Number(current.positionSizeSol || 0)) +
      (Number(snapshot.marketCap || 0) * addSize)
    ) / Math.max(nextPositionSizeSol, 1e-9);

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
    if (axiomMarketCapNumber) return { value: axiomMarketCapNumber, source: "dom-visible" };

    const candidates = getVisibleTextCandidates();
    for (const text of candidates) {
      if (!/(market\s*cap|\bmc\b|\bmcap\b)/i.test(text)) continue;
      const number = parseAbbrevNumber(text.replace(/market\s*cap|mcap|\bmc\b/ig, ""));
      if (number) return { value: number, source: "dom-heuristic" };
    }

    const joined = candidates.join(" | ");
    for (const regex of [
      /market\s*cap[^0-9]{0,12}\$?\s*([0-9][0-9.,]*\s*[kmb]?)/i,
      /\bmc\b[^0-9]{0,12}\$?\s*([0-9][0-9.,]*\s*[kmb]?)/i,
    ]) {
      const match = joined.match(regex);
      if (!match) continue;
      const number = parseAbbrevNumber(match[1]);
      if (number) return { value: number, source: "dom-fallback" };
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
        };
      }
    }

    return { value: null, source: "missing" };
  }

  function detectPageSnapshot() {
    const marketCapCapture = detectMarketCapFromPage();
    const contractCapture = detectContractAddressFromPage();
    return {
      tokenName: detectTokenFromPage(),
      marketCap: marketCapCapture?.value || null,
      marketCapSource: marketCapCapture?.source || "missing",
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

    const nextPositions = {};
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const parsed = parseOpenTradeNote(row.notes, row);
      if (!parsed) return;
      const positionKey = getPositionKey(parsed);
      if (nextPositions[positionKey]) return;
      nextPositions[positionKey] = {
        ...parsed,
        backendTradeId: row.id,
      };
    });

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
    const solPriceUsd = Number(state.solPriceUsd || 0);
    if (!(supply > 0) || !(priceNative > 0) || !(solPriceUsd > 0)) return null;
    return supply * priceNative * solPriceUsd;
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
    if (event.target.closest("[data-refresh], [data-compact-toggle]")) return;
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

    root.style.display = "block";
    root.dataset.liveOpen = String(state.liveOpen);
    root.dataset.compact = String(state.compact);
    applyOverlayPosition();

    const currentPosition = getCurrentPosition();
    const solBalanceLabel = `${getCurrentSolBalance().toFixed(2)} SOL`;

    let livePnlPct = null;
    let livePnlSol = null;
    const liveMC = getEstimatedLiveMarketCapUsd() || state.detected?.marketCap;
    if (currentPosition && currentPosition.entryMarketCap > 0 && liveMC > 0) {
      livePnlPct = (liveMC / currentPosition.entryMarketCap - 1) * 100;
      livePnlSol = currentPosition.positionSizeSol * (livePnlPct / 100);
    }

    let posSummaryHtml = "";
    if (currentPosition) {
      const sol = state.solPriceUsd;
      const initialSol = currentPosition.initialSizeSol || currentPosition.positionSizeSol;
      const remainingSol = currentPosition.positionSizeSol;
      const soldSol = Math.max(0, initialSol - remainingSol);

      const investedUsd = sol ? initialSol * sol : null;
      const soldUsd = sol ? soldSol * sol : null;
      const remainingUsd = (sol && liveMC && currentPosition.entryMarketCap > 0)
        ? remainingSol * (liveMC / currentPosition.entryMarketCap) * sol
        : (sol ? remainingSol * sol : null);
      const pnlUsd = (livePnlSol !== null && sol) ? livePnlSol * sol : null;

      const pnlSign = pnlUsd !== null ? (pnlUsd >= 0 ? "+" : "") : "";
      const pnlPctStr = livePnlPct !== null ? ` (${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(1)}%)` : "";
      const pnlClass = livePnlSol !== null ? (livePnlSol >= 0 ? "is-pos" : "is-neg") : "";

      posSummaryHtml = `
        <div class="td-overlay-pos-summary">
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Invested</span>
            <span class="td-overlay-pos-value">${formatUsdValue(investedUsd)}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Sold</span>
            <span class="td-overlay-pos-value">${soldSol > 0 ? formatUsdValue(soldUsd) : "—"}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">Remaining</span>
            <span class="td-overlay-pos-value">${formatUsdValue(remainingUsd)}</span>
          </div>
          <div class="td-overlay-pos-item">
            <span class="td-overlay-pos-label">PnL</span>
            <span class="td-overlay-pos-value ${pnlClass}">${pnlUsd !== null ? pnlSign + formatUsdValue(pnlUsd) + pnlPctStr : "—"}</span>
          </div>
        </div>
      `;
    }
    const settingsIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/>
        <path d="M13.7654 2.15224C13.3978 2 12.9319 2 12 2C11.0681 2 10.6022 2 10.2346 2.15224C9.74457 2.35523 9.35522 2.74458 9.15223 3.23463C9.05957 3.45834 9.0233 3.7185 9.00911 4.09799C8.98826 4.65568 8.70226 5.17189 8.21894 5.45093C7.73564 5.72996 7.14559 5.71954 6.65219 5.45876C6.31645 5.2813 6.07301 5.18262 5.83294 5.15102C5.30704 5.08178 4.77518 5.22429 4.35436 5.5472C4.03874 5.78938 3.80577 6.1929 3.33983 6.99993C2.87389 7.80697 2.64092 8.21048 2.58899 8.60491C2.51976 9.1308 2.66227 9.66266 2.98518 10.0835C3.13256 10.2756 3.3397 10.437 3.66119 10.639C4.1338 10.936 4.43789 11.4419 4.43786 12C4.43783 12.5581 4.13375 13.0639 3.66118 13.3608C3.33965 13.5629 3.13248 13.7244 2.98508 13.9165C2.66217 14.3373 2.51966 14.8691 2.5889 15.395C2.64082 15.7894 2.87379 16.193 3.33973 17C3.80568 17.807 4.03865 18.2106 4.35426 18.4527C4.77508 18.7756 5.30694 18.9181 5.83284 18.8489C6.07289 18.8173 6.31632 18.7186 6.65204 18.5412C7.14547 18.2804 7.73556 18.27 8.2189 18.549C8.70224 18.8281 8.98826 19.3443 9.00911 19.9021C9.02331 20.2815 9.05957 20.5417 9.15223 20.7654C9.35522 21.2554 9.74457 21.6448 10.2346 21.8478C10.6022 22 11.0681 22 12 22C12.9319 22 13.3978 22 13.7654 21.8478C14.2554 21.6448 14.6448 21.2554 14.8477 20.7654C14.9404 20.5417 14.9767 20.2815 14.9909 19.902C15.0117 19.3443 15.2977 18.8281 15.781 18.549C16.2643 18.2699 16.8544 18.2804 17.3479 18.5412C17.6836 18.7186 17.927 18.8172 18.167 18.8488C18.6929 18.9181 19.2248 18.7756 19.6456 18.4527C19.9612 18.2105 20.1942 17.807 20.6601 16.9999C21.1261 16.1929 21.3591 15.7894 21.411 15.395C21.4802 14.8691 21.3377 14.3372 21.0148 13.9164C20.8674 13.7243 20.6602 13.5628 20.3387 13.3608C19.8662 13.0639 19.5621 12.558 19.5621 11.9999C19.5621 11.4418 19.8662 10.9361 20.3387 10.6392C20.6603 10.4371 20.8675 10.2757 21.0149 10.0835C21.3378 9.66273 21.4803 9.13087 21.4111 8.60497C21.3592 8.21055 21.1262 7.80703 20.6602 7C20.1943 6.19297 19.9613 5.78945 19.6457 5.54727C19.2249 5.22436 18.693 5.08185 18.1671 5.15109C17.9271 5.18269 17.6837 5.28136 17.3479 5.4588C16.8545 5.71959 16.2644 5.73002 15.7811 5.45096C15.2977 5.17191 15.0117 4.65566 14.9909 4.09794C14.9767 3.71848 14.9404 3.45833 14.8477 3.23463C14.6448 2.74458 14.2554 2.35523 13.7654 2.15224Z" stroke="currentColor" stroke-width="1.5" fill="none"/>
      </svg>
    `;
    const caretIcon = `
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M4.25 10.25 8 6.5l3.75 3.75" />
      </svg>
    `;

    root.innerHTML = `
      <div class="td-overlay-shell">
          <div class="td-overlay-head">
            <div class="td-overlay-head-summary">
              <div class="td-overlay-balance">${solBalanceLabel}</div>
              ${livePnlPct !== null ? `<div class="td-overlay-live-pnl ${livePnlPct >= 0 ? "is-positive" : "is-negative"}">${formatSignedPct(livePnlPct)} · ${formatSignedSol(livePnlSol)}</div>` : ""}
            </div>
            <div class="td-overlay-head-actions">
              <button class="td-overlay-icon-btn td-overlay-icon-btn-settings" type="button" data-refresh>${settingsIcon}</button>
              <button class="td-overlay-icon-btn ${state.compact ? "is-compact" : ""}" type="button" data-compact-toggle>${caretIcon}</button>
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
              <div class="td-overlay-contract">
                <div class="td-overlay-label">Buy</div>
                <div class="td-overlay-token-name">${state.detected.tokenName}</div>
              </div>
              <div class="td-overlay-preset-grid">
                ${BUY_PRESETS.map(value => `<button class="td-overlay-preset" type="button" data-buy="${value}">${value} SOL</button>`).join("")}
              </div>

              <div class="td-overlay-label">Sell</div>
              ${posSummaryHtml}
              <div class="td-overlay-sell-stack">
                <div class="td-overlay-sell-grid">
                  ${SELL_PRESETS.map(percent => `<button class="td-overlay-pill td-overlay-pill-sell" type="button" data-sell-percent="${percent}" ${currentPosition ? "" : "disabled"}>${percent}%</button>`).join("")}
                </div>
                <div class="td-overlay-sell-sub">
                  <button class="td-overlay-sell-sub-btn" type="button" data-sell-init ${currentPosition ? "" : "disabled"}>Sell init.</button>
                </div>
              </div>
            </div>
          `}
        </div>
      </div>
    `;

    root.querySelector("[data-refresh]")?.addEventListener("click", () => {
      state.detected = detectPageSnapshot();
      render();
    });

    root.querySelector("[data-compact-toggle]")?.addEventListener("click", async () => {
      state.compact = !state.compact;
      await saveOverlayUiState();
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
          const snapshot = detectPageSnapshot();
          state.detected = snapshot;
          if (!snapshot.marketCap) {
            throw new Error("Overlay is forced on, but market cap is still not being detected on this page.");
          }
          const positionKey = getPositionKey(snapshot);
          const current = state.openPositions[positionKey] || state.openPositions[snapshot.tokenName] || null;
          const nextPosition = upsertCurrentPosition(current, size, snapshot);
          let backendTradeId = current?.backendTradeId || null;

          if (backendTradeId) {
            await updateTrade(backendTradeId, {
              token_name: nextPosition.tokenName,
              pnl_sol: 0,
              pnl_percentage: 0,
              entry_market_cap: Number(nextPosition.entryMarketCap.toFixed(2)),
              exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
              notes: encodeOpenTradeNote(nextPosition),
              trade_timestamp: new Date(nextPosition.openedAt).toISOString(),
            });
          } else {
            const backendTrade = await insertTrade({
              user_id: state.user.id,
              token_name: nextPosition.tokenName,
              pnl_sol: 0,
              pnl_percentage: 0,
              entry_market_cap: Number(nextPosition.entryMarketCap.toFixed(2)),
              exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
              notes: encodeOpenTradeNote(nextPosition),
              trade_timestamp: new Date(nextPosition.openedAt).toISOString(),
            });
            backendTradeId = backendTrade?.id || null;
          }

          state.openPositions[positionKey] = {
            ...nextPosition,
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

  }

  async function closeTrade(fraction) {
    if (state.tradeBusy) return;
    const current = getCurrentPosition();
    if (!current || !state.user) return;

    state.tradeBusy = true;
    try {
      const snapshot = detectPageSnapshot();
      state.detected = snapshot;
      if (!snapshot.marketCap) {
        throw new Error("Overlay is forced on, but market cap is still not being detected on this page.");
      }
      const positionSizeSol = Number(current.positionSizeSol || 0) * fraction;
      const pnlPercentage = ((snapshot.marketCap / current.entryMarketCap) - 1) * 100;
      const pnlSol = positionSizeSol * (pnlPercentage / 100);
      await insertTrade({
        user_id: state.user.id,
        token_name: current.tokenName,
        pnl_sol: Number(pnlSol.toFixed(6)),
        pnl_percentage: Number(pnlPercentage.toFixed(2)),
        entry_market_cap: Number(current.entryMarketCap.toFixed(2)),
        exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
        notes: "",
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
        };
        if (current.backendTradeId) {
          await updateTrade(current.backendTradeId, {
            token_name: current.tokenName,
            pnl_sol: 0,
            pnl_percentage: 0,
            entry_market_cap: Number(current.entryMarketCap.toFixed(2)),
            exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
            notes: encodeOpenTradeNote(nextOpenPosition),
            trade_timestamp: new Date(current.openedAt || Date.now()).toISOString(),
          });
        } else {
          const openTrade = await insertTrade({
            user_id: state.user.id,
            token_name: current.tokenName,
            pnl_sol: 0,
            pnl_percentage: 0,
            entry_market_cap: Number(current.entryMarketCap.toFixed(2)),
            exit_market_cap: Number(snapshot.marketCap.toFixed(2)),
            notes: encodeOpenTradeNote(nextOpenPosition),
            trade_timestamp: new Date(current.openedAt || Date.now()).toISOString(),
          });
          nextOpenPosition.backendTradeId = openTrade?.id || null;
        }
        state.openPositions[getPositionKey(nextOpenPosition)] = nextOpenPosition;
        if (current.contractAddress && state.openPositions[current.tokenName]) {
          delete state.openPositions[current.tokenName];
        }
      }

      await saveOpenPositions();
      await loadTrades();
      setStatus("Trade sync completed.", "good");
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

    const stored = await storage.get(["td_session", OPEN_POSITIONS_KEY, EXTENSION_ENABLED_KEY, FORCE_OVERLAY_KEY, OVERLAY_POSITION_KEY, OVERLAY_COMPACT_KEY]);
    state.session = stored.td_session || null;
    state.openPositions = stored[OPEN_POSITIONS_KEY] || {};
    state.enabled = stored[EXTENSION_ENABLED_KEY] !== false;
    state.forceOverlay = stored[FORCE_OVERLAY_KEY] === true;
    state.compact = Boolean(stored[OVERLAY_COMPACT_KEY]);
    state.position = clampPosition(stored[OVERLAY_POSITION_KEY] || state.position);
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
    });
  }

  boot();
})();
