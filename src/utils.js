export const FEE_PER_TRADE = 0.01;
export const RULES = { minEntryMC: 10000, maxLossPct: -30, maxTradesPerHour: 5 };

export const accent    = "#F59E0B";
export const accentDim = "#D97706";
export const green     = "#22C55E";
export const red       = "#EF4444";
export const serif     = "'Inter', 'Geist Sans', system-ui, sans-serif";
export const sans      = "'Inter', 'Geist Sans', system-ui, sans-serif";

export const fmtSol   = v => { const n = parseFloat(v); return (n >= 0 ? "+" : "") + n.toFixed(2) + " SOL"; };
export const fmtPct   = v => { const n = parseFloat(v); return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; };
export const fmtColor = v => parseFloat(v) >= 0 ? green : red;

export const netPnl   = s => s.tradeList?.length > 0
  ? s.tradeList.reduce((a, t) => a + parseFloat(t.pnl) - FEE_PER_TRADE, 0)
  : parseFloat(s.grossPnl || 0) - parseFloat(s.fees || 0);

export const tradeNet = t => parseFloat(t.pnl) - FEE_PER_TRADE;

export const emptyTrade = () => ({
  instrument: "", entryMC: "", exitMC: "", pnlPct: "", pnl: "", notes: "", timestamp: Date.now()
});

export function checkTrade(t) {
  const v = [];
  if (t.entryMC > 0 && t.entryMC < RULES.minEntryMC)
    v.push({ rule: "Entry MC", detail: `$${t.entryMC.toLocaleString()} below 10K` });
  if (t.pnlPct < RULES.maxLossPct)
    v.push({ rule: "Stop loss", detail: `${t.pnlPct.toFixed(1)}% exceeded -30%` });
  return v;
}

export function checkSessionHourly(tl) {
  const hours = {};
  tl.forEach(t => {
    const h = Math.floor(t.timestamp / 3600000);
    if (!hours[h]) hours[h] = [];
    hours[h].push(t);
  });
  return Object.entries(hours)
    .filter(([, ts]) => ts.length > RULES.maxTradesPerHour)
    .map(([h, ts]) => ({
      rule: "Trades/hour",
      detail: `${ts.length} trades at ${new Date(+h * 3600000).toISOString().slice(11,16)} UTC (max 5)`
    }));
}

export function sessionViolations(s) {
  return [
    ...(s.tradeList || []).flatMap(t => checkTrade(t).map(v => ({ ...v, token: t.instrument }))),
    ...checkSessionHourly(s.tradeList || [])
  ];
}

export function mergeImportedTrades(trades, setSessions, good = "", bad = "") {
  if (!Array.isArray(trades) || !trades.length) return false;

  const byDate = {};
  trades.forEach(t => {
    const timestamp = t.timestamp || Date.now();
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push({ ...t, timestamp });
  });

  const newSessions = Object.entries(byDate).map(([date, dayTrades]) => ({
    date,
    instrument: "SOL Memecoins",
    grossPnl: parseFloat(dayTrades.reduce((sum, trade) => sum + trade.pnlSol, 0).toFixed(6)),
    fees: parseFloat((dayTrades.length * FEE_PER_TRADE).toFixed(4)),
    notes: "",
    good,
    bad,
    tradeList: dayTrades.map((trade, i) => ({
      id: trade.id || (date + "_" + i),
      instrument: trade.tokenName || "?",
      positionId: trade.positionId || null,
      pnl: parseFloat((trade.pnlSol || 0).toFixed(6)),
      pnlPct: parseFloat((trade.pnlPercentage || 0).toFixed(2)),
      entryMC: trade.entryMarketCap || 0,
      exitMC: trade.exitMarketCap || 0,
      closeMeta: trade.closeMeta || null,
      notes: trade.notes || "",
      timestamp: trade.timestamp,
    }))
  }));

  setSessions(prev => {
    const merged = [...prev];
    newSessions.forEach(ns => {
      const idx = merged.findIndex(s => s.date === ns.date);
      if (idx >= 0) {
        if ((ns.tradeList?.length || 0) >= (merged[idx].tradeList?.length || 0)) merged[idx] = ns;
      } else {
        merged.push(ns);
      }
    });
    return merged.sort((a, b) => a.date.localeCompare(b.date));
  });

  return newSessions.length;
}

export function importRawTrades(rawJson, setSessions, good = "", bad = "") {
  try {
    const arr = JSON.parse(rawJson);
    return mergeImportedTrades(arr, setSessions, good, bad);
  } catch {
    return false;
  }
}

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9æøå\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeFromNotes(notes, themes, fallback) {
  const counts = themes.map(theme => ({
    label: theme.label,
    count: notes.reduce((sum, note) => {
      const hit = theme.keywords.some(keyword => note.includes(keyword));
      return sum + (hit ? 1 : 0);
    }, 0),
  })).sort((a, b) => b.count - a.count);

  if (counts[0] && counts[0].count > 0) return counts[0].label;

  const latest = notes.find(Boolean);
  if (!latest) return fallback;

  const plain = latest.split(/[.!?]/)[0].trim();
  if (!plain) return fallback;
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

export function summarizeReflectionTrends(sessions) {
  const goodNotes = sessions.map(s => normalizeText(s.good)).filter(Boolean);
  const badNotes = sessions.map(s => normalizeText(s.bad)).filter(Boolean);

  const goodThemes = [
    { label: "You manage your stops and risk levels well", keywords: ["stop loss", "stops", "risiko", "disciplin"] },
    { label: "You are good at waiting for the right entries", keywords: ["tålmod", "taalmod", "vente", "entry", "entries", "setup"] },
    { label: "You follow the plan and stay composed", keywords: ["plan", "rolig", "disciplineret", "konsekvent"] },
    { label: "You take profits sensibly when trades work", keywords: ["profit", "trim", "sikre", "exit", "solgte"] },
  ];

  const badThemes = [
    { label: "You still chase entries a bit too early", keywords: ["for tidligt", "for hurtigt", "fomo", "jagede", "chase"] },
    { label: "You can tighten your exit execution further", keywords: ["exit", "solgte for tidligt", "holdt for længe", "trim"] },
    { label: "You lose edge when you deviate from the plan", keywords: ["plan", "disciplin", "afveg", "brød regel", "regel"] },
    { label: "You can improve your setup selection", keywords: ["setup", "dårligt setup", "tvivlsom", "kedelig entry"] },
  ];

  return {
    good: summarizeFromNotes(goodNotes, goodThemes, "No clear strengths logged yet"),
    bad: summarizeFromNotes(badNotes, badThemes, "No clear improvement pattern logged yet"),
  };
}

export const THEME = {
  dark: {
    bg: "#0F172A", surface1: "#1E293B", surface2: "#162033", surface3: "#0F1929",
    border: "#334155", borderSub: "#1E293B",
    text: "#F8FAFC", textMid: "#94A3B8", textDim: "#64748B",
    modalBg: "#0F172A", modalSurf: "#1E293B",
    inp: { bg: "#1E293B", border: "#334155", color: "#F8FAFC" },
    calWin:    { bg: "#0C2518", border: "#14532D" },
    calBigWin: { bg: "#1C1408", border: "#78350F", text: "#FBBF24" },
    calLoss:   { bg: "#1A0F10", border: "#7F1D1D" },
  },
  light: {
    bg: "#f7f7f5", surface1: "#ffffff", surface2: "#f2f3f1", surface3: "#eceeeb",
    border: "#dedfdc", borderSub: "#e8e9e6",
    text: "#1f2328", textMid: "#636a73", textDim: "#969ca3",
    modalBg: "#ffffff", modalSurf: "#f4f5f3",
    inp: { bg: "#ffffff", border: "#d9dbd7", color: "#1f2328" },
    calWin:  { bg: "#e8f6f0", border: "#9fd9c4" },
    calBigWin: { bg: "#f1ead8", border: "#cfbe88", text: "#99772b" },
    calLoss: { bg: "#f8eaea", border: "#e2adad" },
  },
};
