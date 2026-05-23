(function (global) {
  const OPEN_TRADE_NOTE_PREFIX = "__TD_OPEN__";
  const CLOSE_TRADE_NOTE_PREFIX = "__TD_CLOSE__";
  const DEFAULT_MAX_POSITION_EVENTS = 12;

  function buildPositionId(tokenName, openedAt) {
    return `${String(tokenName || "unknown").trim() || "unknown"}_${Number(openedAt || Date.now())}`;
  }

  function normalizeOpenTradePosition(position, options = {}) {
    const maxPositionEvents = options.maxPositionEvents || DEFAULT_MAX_POSITION_EVENTS;
    return {
      positionId: position.positionId,
      tokenName: position.tokenName,
      tokenFullName: position.tokenFullName || null,
      entryMarketCap: Number(position.entryMarketCap || 0),
      positionSizeSol: Number(position.positionSizeSol || 0),
      initialSizeSol: Number(position.initialSizeSol || 0),
      realizedPnlSol: Number(position.realizedPnlSol || 0),
      totalFeesSol: Number(position.totalFeesSol || 0),
      openedAt: Number(position.openedAt || Date.now()),
      pageUrl: position.pageUrl || "",
      marketCapSource: position.marketCapSource || "unknown",
      contractAddress: position.contractAddress || "",
      pairAddress: position.pairAddress || "",
      stopLossPct: position.stopLossPct ?? null,
      stopLossMode: position.stopLossMode || "pct",
      stopLossMarketCap: position.stopLossMarketCap ?? null,
      targetSellPct: position.targetSellPct ?? null,
      targetSellMode: position.targetSellMode || "pct",
      targetSellMarketCap: position.targetSellMarketCap ?? null,
      entryCapture: position.entryCapture || null,
      lastCapture: position.lastCapture || null,
      events: Array.isArray(position.events) ? position.events.slice(-maxPositionEvents) : [],
    };
  }

  function encodeOpenTradeNote(position, options = {}) {
    return `${OPEN_TRADE_NOTE_PREFIX}${JSON.stringify(normalizeOpenTradePosition(position, options))}`;
  }

  function encodeCloseTradeNote(closeMeta) {
    return `${CLOSE_TRADE_NOTE_PREFIX}${JSON.stringify(closeMeta)}`;
  }

  function parseCloseTradeNote(note) {
    if (!String(note || "").startsWith(CLOSE_TRADE_NOTE_PREFIX)) return null;
    try {
      const parsed = JSON.parse(String(note).slice(CLOSE_TRADE_NOTE_PREFIX.length));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function parseOpenTradeNote(note, fallbackTrade, options = {}) {
    if (!String(note || "").startsWith(OPEN_TRADE_NOTE_PREFIX)) return null;

    const maxPositionEvents = options.maxPositionEvents || DEFAULT_MAX_POSITION_EVENTS;
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
        tokenFullName: parsed.tokenFullName || fallbackTrade?.token_full_name || fallbackTrade?.tokenFullName || null,
        entryMarketCap: Number(parsed.entryMarketCap || fallbackTrade?.entry_market_cap || fallbackTrade?.entryMarketCap || 0),
        positionSizeSol,
        initialSizeSol,
        realizedPnlSol: Number(parsed.realizedPnlSol || 0),
        totalFeesSol: Number(parsed.totalFeesSol || 0),
        openedAt,
        pageUrl: parsed.pageUrl || "",
        marketCapSource: parsed.marketCapSource || "unknown",
        contractAddress: parsed.contractAddress || "",
        pairAddress: parsed.pairAddress || "",
        stopLossPct: parsed.stopLossPct ?? null,
        stopLossMode: parsed.stopLossMode || (parsed.stopLossMarketCap ? "mc" : "pct"),
        stopLossMarketCap: parsed.stopLossMarketCap ?? null,
        targetSellPct: parsed.targetSellPct ?? null,
        targetSellMode: parsed.targetSellMode || (parsed.targetSellMarketCap ? "mc" : "pct"),
        targetSellMarketCap: parsed.targetSellMarketCap ?? null,
        entryCapture: parsed.entryCapture || null,
        lastCapture: parsed.lastCapture || null,
        events: Array.isArray(parsed.events) ? parsed.events.slice(-maxPositionEvents) : [],
      };
    } catch {
      const legacySize = Number(raw || 0);
      const openedAt = fallbackTimestamp;
      const tokenName = fallbackTrade?.token_name || fallbackTrade?.tokenName || "Unknown";
      return {
        positionId: buildPositionId(tokenName, openedAt),
        tokenName,
        tokenFullName: fallbackTrade?.token_full_name || fallbackTrade?.tokenFullName || null,
        entryMarketCap: Number(fallbackTrade?.entry_market_cap || fallbackTrade?.entryMarketCap || 0),
        positionSizeSol: legacySize,
        initialSizeSol: legacySize,
        realizedPnlSol: 0,
        openedAt,
        pageUrl: "",
        marketCapSource: "legacy",
        contractAddress: "",
        pairAddress: "",
        stopLossPct: null,
        stopLossMode: "pct",
        stopLossMarketCap: null,
        targetSellPct: null,
        targetSellMode: "pct",
        targetSellMarketCap: null,
        entryCapture: null,
        lastCapture: null,
        events: [],
      };
    }
  }

  global.PostureTradeContract = {
    OPEN_TRADE_NOTE_PREFIX,
    CLOSE_TRADE_NOTE_PREFIX,
    DEFAULT_MAX_POSITION_EVENTS,
    buildPositionId,
    normalizeOpenTradePosition,
    encodeOpenTradeNote,
    encodeCloseTradeNote,
    parseCloseTradeNote,
    parseOpenTradeNote,
  };
})(globalThis);
