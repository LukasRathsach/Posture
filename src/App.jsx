import { useState, useEffect, useRef } from "react";
import {
  FEE_PER_TRADE, accent, accentDim, green, red, sans,
  fmtPct, fmtColor, netPnl, tradeNet, emptyTrade,
  checkTrade, sessionViolations, mergeImportedTrades, THEME
} from "./utils";
import {
  getCurrentUser,
  deletePaperTradesByIds,
  hasSupabaseConfig,
  loadClosedPaperTrades,
  loadOpenPaperTrades,
  loadSessions,
  onAuthStateChange,
  saveSessions,
  sendPasswordResetEmail,
  signInWithEmail,
  signOutUser,
  signUpWithEmail,
  updateUserPassword,
  validateInviteCode,
  claimInvite,
  generateInvite,
  listInvites,
} from "./api";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const MISSION_TARGETS = {
  trades: 150,
  profitableWeeks: 3,
  ruleCompliance: 0.85,
};
const LOCAL_STORAGE_KEY = "trading-dashboard-sessions";

function loadLocalSessions() {
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function App() {
  // ── Theme ──────────────────────────────────────────────────────────────────
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = e => setDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const tk = dark ? THEME.dark : THEME.light;

  // ── Responsive ─────────────────────────────────────────────────────────────
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const h = () => setIsDesktop(window.innerWidth >= 900);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);

  // ── SOL/USD price ──────────────────────────────────────────────────────────
  const [solPrice, setSolPrice] = useState(null);
  useEffect(() => {
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")
      .then(r => r.json())
      .then(d => setSolPrice(d?.solana?.usd ?? null))
      .catch(() => {});
  }, []);

  // Session/detail format follows the active calendar unit
  const fmtUsd = sol => {
    const n = parseFloat(sol);
    const sign = n >= 0 ? "+" : "-";
    if (calendarUnit === "sol" || solPrice === null) {
      return sign + Math.abs(n).toFixed(2) + " SOL";
    }
    const usd = n * solPrice;
    const abs = Math.abs(usd);
    if (abs >= 10000) return sign + (abs / 1000).toFixed(1) + "K USD";
    if (abs >= 100) return sign + Math.round(abs) + " USD";
    return sign + abs.toFixed(0) + " USD";
  };

  // Compact USD only for calendar cells
  const fmtCompact = sol => {
    const n = parseFloat(sol);
    if (solPrice === null) return (n >= 0 ? "+" : "") + n.toFixed(2) + " SOL";
    const usd = n * solPrice;
    const abs = Math.abs(usd);
    const sign = usd >= 0 ? "+" : "-";
    if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + "K USD";
    return sign + Math.round(abs) + " USD";
  };

  const fmtHeaderPnl = sol => {
    const n = parseFloat(sol);
    const sign = n >= 0 ? "+" : "-";
    if (calendarUnit === "sol" || solPrice === null) {
      return sign + Math.abs(n).toFixed(2) + " SOL";
    }
    const usd = n * solPrice;
    const abs = Math.abs(usd);
    return abs >= 1000 ? sign + (abs / 1000).toFixed(1) + "K USD" : sign + Math.round(abs) + " USD";
  };

  const fmtCalendarValue = (sol, compact = false) => {
    const n = parseFloat(sol || 0);
    const sign = n >= 0 ? "+" : "-";
    if (calendarUnit === "sol" || solPrice === null) {
      return sign + Math.abs(n).toFixed(2) + " SOL";
    }
    const usd = n * solPrice;
    const abs = Math.abs(usd);
    if (compact && abs >= 1000) return sign + (abs / 1000).toFixed(1) + "K USD";
    return sign + Math.round(abs) + " USD";
  };

  const mixHex = (from, to, amount) => {
    const t = Math.max(0, Math.min(1, amount));
    const a = from.replace("#", "");
    const b = to.replace("#", "");
    const ar = parseInt(a.slice(0, 2), 16);
    const ag = parseInt(a.slice(2, 4), 16);
    const ab = parseInt(a.slice(4, 6), 16);
    const br = parseInt(b.slice(0, 2), 16);
    const bg = parseInt(b.slice(2, 4), 16);
    const bb = parseInt(b.slice(4, 6), 16);
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `rgb(${rr}, ${rg}, ${rb})`;
  };

  const getPositiveCalendarTone = usdValue => {
    const progress = Math.max(0, Math.min(1, Math.abs(usdValue || 0) / 500));
    if (dark) {
      return {
        bg: mixHex("#0d1313", "#17382d", progress),
        border: mixHex("#182028", "#275244", progress),
        text: mixHex("#8ccfb9", "#42e3ad", progress),
      };
    }
    return {
      bg: mixHex("#edf3ef", "#d9f5e9", progress),
      border: mixHex("#d7e6dd", "#9fd9c4", progress),
      text: mixHex("#287a61", "#149d78", progress),
    };
  };

  const getNegativeCalendarTone = usdValue => {
    const progress = Math.max(0, Math.min(1, Math.abs(usdValue || 0) / 500));
    if (dark) {
      return {
        bg: mixHex("#161112", "#3a171a", progress),
        border: mixHex("#251b1d", "#5b262c", progress),
        text: mixHex("#c89198", "#ff7d8b", progress),
      };
    }
    return {
      bg: mixHex("#f4eeee", "#f8dfe2", progress),
      border: mixHex("#e5d3d6", "#e2adad", progress),
      text: mixHex("#8e4d57", "#c94a59", progress),
    };
  };

  // ── Data ───────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState([]);
  const [openTrades, setOpenTrades] = useState([]);
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() };
  });
  const [modal, setModal] = useState(null);
  const [addTradeOpen, setAddTradeOpen] = useState(false);
  const [tradeForm, setTradeForm] = useState(emptyTrade());
  const [calendarUnit, setCalendarUnit] = useState("usd");
  const [calendarHover, setCalendarHover] = useState(null);
  const [highlightHover, setHighlightHover] = useState(null);
  const [syncStatus, setSyncStatus] = useState("loading");
  const [authUser, setAuthUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [authMode, setAuthMode] = useState("sign-in");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authForm, setAuthForm] = useState({ fullName: "", email: "", password: "", confirmPassword: "", inviteCode: "" });
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteList, setInviteList] = useState([]);
  const [inviteListLoading, setInviteListLoading] = useState(false);
  const [inviteGenBusy, setInviteGenBusy] = useState(false);
  const [inviteCopied, setInviteCopied] = useState("");
  const initialized = useRef(false);
  const saveTimer = useRef(null);
  const lastSyncedTradeKey = useRef("");
  const isLocalMode = !hasSupabaseConfig;
  const isAdmin = authUser?.email === "lrl@dsfwine.dk";
  const now = new Date();
  const isCurrentMonth = currentMonth.y === now.getFullYear() && currentMonth.m === now.getMonth();

  // ── Parse invite code from URL ────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("invite");
    if (code) {
      setAuthForm(prev => ({ ...prev, inviteCode: code.toUpperCase() }));
      setAuthMode("sign-up");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // ── Auth / Supabase sync ──────────────────────────────────────────────────
  useEffect(() => {
    if (isLocalMode) {
      setSessions(loadLocalSessions());
      setAuthReady(true);
      setSyncStatus("local");
      initialized.current = true;
      return;
    }

    let alive = true;
    getCurrentUser()
      .then(user => {
        if (!alive) return;
        setAuthUser(user);
        setAuthReady(true);
      })
      .catch(() => {
        if (!alive) return;
        setAuthReady(true);
        setSyncStatus("error");
      });

    const { data } = onAuthStateChange((_event, session) => {
      if (!alive) return;
      if (_event === "PASSWORD_RECOVERY") {
        setAuthMode("reset-password");
        setAuthNotice("Set a new password for your account.");
      }
      setAuthUser(session?.user ?? null);
      setAuthError("");
      initialized.current = false;
      if (!session?.user) {
        setSessions([]);
        setModal(null);
        setSyncStatus("loading");
      }
    });

    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [isLocalMode]);

  useEffect(() => {
    if (isLocalMode || !authReady) return;
    if (!authUser) {
      initialized.current = false;
      setSessions([]);
      setSyncStatus("loading");
      return;
    }

    setSyncStatus("loading");
    loadSessions(authUser.id)
      .then(remote => {
        setSessions(remote);
        initialized.current = true;
        setSyncStatus("ok");
      })
      .catch(() => {
        initialized.current = true;
        setSyncStatus("error");
      });
  }, [authReady, authUser, isLocalMode]);

  useEffect(() => {
    if (!initialized.current) return;
    if (isLocalMode) {
      try {
        window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(sessions));
        setSyncStatus("local");
      } catch {
        setSyncStatus("error");
      }
      return;
    }
    if (!authUser) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      setSyncStatus("saving");
      saveSessions(authUser.id, sessions)
        .then(() => setSyncStatus("ok"))
        .catch(() => setSyncStatus("error"));
    }, 1200);
  }, [authUser, isLocalMode, sessions]);

  useEffect(() => {
    if (isLocalMode || !authUser) return;

    let cancelled = false;
    const syncExtensionTrades = async () => {
      try {
        const [closedTrades, openPositions] = await Promise.all([
          loadClosedPaperTrades(authUser.id),
          loadOpenPaperTrades(authUser.id),
        ]);
        if (cancelled) return;
        setOpenTrades(openPositions);
        if (closedTrades.length) {
          const key = closedTrades.map(t => t.id).sort().join(",");
          if (key !== lastSyncedTradeKey.current) {
            lastSyncedTradeKey.current = key;
            mergeImportedTrades(closedTrades, setSessions);
          }
        }
      } catch (_error) {
        if (!cancelled) setSyncStatus("error");
      }
    };

    syncExtensionTrades();
    const interval = window.setInterval(syncExtensionTrades, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [authUser, isLocalMode]);

  useEffect(() => {
    if (!modal) return;
    const u = sessions.find(s => s.date === modal.date);
    if (u) setModal(u);
  }, [sessions]);

  useEffect(() => {
    const h = e => {
      if (e.key === "Escape") {
        if (modal) closeModal();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [modal]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const allTrades = sessions.flatMap(s => s.tradeList || []);
  const allTimeNet = sessions.reduce((a, s) => a + netPnl(s), 0);

  const weekKey = dateStr => {
    const d = new Date(dateStr + "T12:00:00");
    const day = d.getDay() || 7;
    d.setDate(d.getDate() + 4 - day);
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
  };

  const missionStats = (() => {
    const cleanTrades = allTrades.filter(t => checkTrade(t).length === 0).length;
    const ruleCompliance = allTrades.length ? cleanTrades / allTrades.length : 0;
    const weeks = Object.values(sessions.reduce((acc, s) => {
      const key = weekKey(s.date);
      if (!acc[key]) acc[key] = { key, lastDate: s.date, pnl: 0, trades: 0 };
      acc[key].pnl += netPnl(s);
      acc[key].trades += s.tradeList?.length || 0;
      if (s.date > acc[key].lastDate) acc[key].lastDate = s.date;
      return acc;
    }, {})).filter(w => w.trades > 0).sort((a, b) => a.key.localeCompare(b.key));

    let profitableWeekStreak = 0;
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (weeks[i].pnl > 0) profitableWeekStreak++;
      else break;
    }

    const tradeScore = Math.min(1, allTrades.length / MISSION_TARGETS.trades);
    const weekScore = Math.min(1, profitableWeekStreak / MISSION_TARGETS.profitableWeeks);
    const ruleScore = Math.min(1, ruleCompliance / MISSION_TARGETS.ruleCompliance);
    const score = Math.round((tradeScore * 0.40 + weekScore * 0.40 + ruleScore * 0.20) * 100);
    const ready = allTrades.length >= MISSION_TARGETS.trades
      && profitableWeekStreak >= MISSION_TARGETS.profitableWeeks
      && ruleCompliance >= MISSION_TARGETS.ruleCompliance;

    return {
      score,
      ready,
      ruleCompliance,
      profitableWeekStreak,
      weeksTracked: weeks.length,
      items: [
        {
          label: "Sample size",
          value: `${allTrades.length}/${MISSION_TARGETS.trades} trades`,
          progress: tradeScore,
          done: allTrades.length >= MISSION_TARGETS.trades,
        },
        {
          label: "Consistency",
          value: `${profitableWeekStreak}/${MISSION_TARGETS.profitableWeeks} profitable weeks`,
          progress: weekScore,
          done: profitableWeekStreak >= MISSION_TARGETS.profitableWeeks,
        },
        {
          label: "Rules",
          value: `${Math.round(ruleCompliance * 100)}%`,
          progress: ruleScore,
          done: ruleCompliance >= MISSION_TARGETS.ruleCompliance,
        },
      ],
    };
  })();

  // ── Calendar helpers ───────────────────────────────────────────────────────
  const { y, m } = currentMonth;
  const firstDay = new Date(y, m, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const calendarRows = Math.ceil((offset + daysInMonth) / 7);
  const calendarTrailing = calendarRows * 7 - (offset + daysInMonth);
  const monthLabel = new Date(y, m, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const monthLabelShort = new Date(y, m, 1).toLocaleString("en-US", { month: "long" });
  const sessionsByDate = {};
  sessions.forEach(s => { sessionsByDate[s.date] = s; });

  const monthStr = `${y}-${String(m + 1).padStart(2, "0")}`;
  const monthSessions = sessions.filter(s => s.date.startsWith(monthStr));
  const monthWins = monthSessions.filter(s => netPnl(s) > 0);
  const monthLosses = monthSessions.filter(s => netPnl(s) <= 0);
  const monthTotal = monthSessions.reduce((a, s) => a + netPnl(s), 0);
  const monthWinTotal = monthWins.reduce((a, s) => a + netPnl(s), 0);
  const monthLossTotal = monthLosses.reduce((a, s) => a + netPnl(s), 0);
  const winRatio = monthSessions.length ? monthWins.length / monthSessions.length : 0;
  const monthTrades = monthSessions.flatMap(s => s.tradeList || []);
  const cleanTradeCount = allTrades.filter(t => checkTrade(t).length === 0).length;
  const cleanTradeRate = allTrades.length ? Math.round(cleanTradeCount / allTrades.length * 100) : 0;

  const allSorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
  let curStreak = 0, curStreakPos = true;
  if (allSorted.length) {
    curStreakPos = netPnl(allSorted[allSorted.length - 1]) > 0;
    for (let i = allSorted.length - 1; i >= 0; i--) {
      const p = netPnl(allSorted[i]);
      if ((p > 0) === curStreakPos) curStreak++;
      else break;
    }
  }
  const monthSorted = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  let tradingStreak = 0;
  if (monthSorted.length) {
    tradingStreak = 1;
    for (let i = monthSorted.length - 1; i > 0; i--) {
      const current = new Date(monthSorted[i].date + "T12:00:00");
      const previous = new Date(monthSorted[i - 1].date + "T12:00:00");
      const diffDays = Math.round((current - previous) / 86400000);
      if (diffDays === 1) tradingStreak++;
      else break;
    }
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    setAuthNotice("");
    try {
      if (authMode === "forgot-password") {
        const redirectTo = window.location.origin;
        await sendPasswordResetEmail(authForm.email.trim(), redirectTo);
        setAuthNotice("Password reset email sent. Open the link in your email to choose a new password.");
        setAuthMode("sign-in");
      } else if (authMode === "reset-password") {
        if (authForm.password !== authForm.confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        await updateUserPassword(authForm.password);
        setAuthNotice("Password updated. You can now continue in the app.");
      } else if (authMode === "sign-up") {
        const code = authForm.inviteCode.trim().toUpperCase();
        const valid = await validateInviteCode(code);
        if (!valid) throw new Error("Invalid or already used invite code.");
        const data = await signUpWithEmail({
          email: authForm.email.trim(),
          password: authForm.password,
          fullName: authForm.fullName.trim(),
        });
        if (data.session) {
          await claimInvite(code).catch(() => {});
          setAuthNotice("Account created and signed in.");
        } else {
          setAuthNotice("Account created. Check your email to confirm, then sign in.");
          setAuthMode("sign-in");
        }
      } else {
        await signInWithEmail({
          email: authForm.email.trim(),
          password: authForm.password,
        });
      }
    } catch (err) {
      setAuthError(err?.message || "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    if (isLocalMode) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      await signOutUser();
    } catch (err) {
      setAuthError(err?.message || "Could not sign out.");
    } finally {
      setAuthBusy(false);
    }
  }

  function closeModal() { setModal(null); setAddTradeOpen(false); setTradeForm(emptyTrade()); }

  const isBackendId = id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id ?? ""));

  async function deleteSession() {
    if (!modal) return;
    const session = sessions.find(s => s.date === modal.date);
    if (!isLocalMode && authUser && session) {
      const backendIds = (session.tradeList || []).map(t => t.id).filter(isBackendId);
      if (backendIds.length) {
        try { await deletePaperTradesByIds(backendIds); } catch { /* non-fatal */ }
        lastSyncedTradeKey.current = "";
      }
    }
    setSessions(prev => prev.filter(s => s.date !== modal.date));
    closeModal();
  }

  function addTradeToSession() {
    if (!tradeForm.pnl) return alert("P/L (SOL) is required.");
    const tr = {
      id: Date.now(),
      instrument: tradeForm.instrument,
      pnl: parseFloat(tradeForm.pnl),
      pnlPct: parseFloat(tradeForm.pnlPct || 0),
      entryMC: parseFloat(tradeForm.entryMC || 0),
      exitMC: parseFloat(tradeForm.exitMC || 0),
      notes: tradeForm.notes,
      timestamp: Date.now()
    };
    setSessions(prev => prev.map(s => s.date !== modal.date ? s : {
      ...s, tradeList: [...(s.tradeList || []), tr]
    }));
    setTradeForm(emptyTrade());
    setAddTradeOpen(false);
  }

  async function deleteTrade(id) {
    if (!isLocalMode && authUser && isBackendId(id)) {
      try { await deletePaperTradesByIds([id]); } catch { /* non-fatal */ }
      lastSyncedTradeKey.current = "";
    }
    setSessions(prev => prev.map(s => s.date !== modal.date ? s : {
      ...s, tradeList: (s.tradeList || []).filter(t => t.id !== id)
    }));
  }

  // ── Style primitives ───────────────────────────────────────────────────────
  const inp = {
    fontSize: 14, padding: "11px 13px", borderRadius: 6,
    border: `1px solid ${tk.inp.border}`, background: tk.inp.bg,
    color: tk.inp.color, fontFamily: sans, width: "100%",
    WebkitAppearance: "none", outline: "none",
  };
  const panel = {
    background: tk.surface1,
    border: `1px solid ${tk.border}`,
    borderRadius: 2,
    boxShadow: "none",
  };
  const quietPanel = {
    background: tk.surface2,
    border: `1px solid ${tk.borderSub}`,
    borderRadius: 2,
  };
  const actionButton = {
    border: `1px solid ${tk.border}`,
    background: tk.surface2,
    color: tk.text,
    borderRadius: 6,
    cursor: "pointer",
    fontFamily: sans,
    fontWeight: 600,
  };
  const headerAction = {
    background: "transparent",
    border: "none",
    color: tk.textMid,
    cursor: "pointer",
    fontFamily: sans,
    fontSize: 13,
    fontWeight: 600,
    padding: 0,
  };
  const headerButton = {
    ...actionButton,
    background: "transparent",
    borderRadius: 6,
    padding: "8px 14px",
    fontSize: 13,
    color: tk.text,
    lineHeight: 1,
  };
  const streakLevel = curStreak >= 7 ? "inferno" : curStreak >= 4 ? "hot" : "warm";
  const streakTone = curStreakPos && curStreak >= 2 ? {
    warm: {
      color: dark ? "#f1b36c" : "#b87422",
      bg: dark ? "rgba(201,128,48,0.12)" : "rgba(214,149,62,0.12)",
      border: dark ? "rgba(214,149,62,0.24)" : "rgba(184,116,34,0.22)",
      shadow: dark ? "0 0 0 rgba(0,0,0,0)" : "0 0 0 rgba(0,0,0,0)",
      hoverShadow: dark ? "0 6px 16px rgba(201,128,48,0.16)" : "0 6px 16px rgba(184,116,34,0.10)",
      flameScale: 1,
    },
    hot: {
      color: dark ? "#f4b06a" : "#b86a1b",
      bg: dark ? "rgba(214,126,45,0.16)" : "rgba(214,126,45,0.14)",
      border: dark ? "rgba(224,143,68,0.32)" : "rgba(184,106,27,0.26)",
      shadow: dark ? "0 0 10px rgba(214,126,45,0.10)" : "0 0 8px rgba(214,126,45,0.08)",
      hoverShadow: dark ? "0 8px 18px rgba(214,126,45,0.20)" : "0 8px 18px rgba(184,106,27,0.12)",
      flameScale: 1.08,
    },
    inferno: {
      color: dark ? "#f6c07b" : "#a95f17",
      bg: dark ? "rgba(194,98,28,0.20)" : "rgba(194,98,28,0.16)",
      border: dark ? "rgba(225,132,52,0.38)" : "rgba(169,95,23,0.30)",
      shadow: dark ? "0 0 14px rgba(194,98,28,0.14)" : "0 0 10px rgba(194,98,28,0.10)",
      hoverShadow: dark ? "0 10px 22px rgba(194,98,28,0.24)" : "0 10px 22px rgba(169,95,23,0.14)",
      flameScale: 1.16,
    },
  }[streakLevel] : {
    color: tk.textDim,
    bg: tk.surface2,
    border: tk.border,
    shadow: "none",
    hoverShadow: dark ? "0 6px 14px rgba(0,0,0,0.16)" : "0 6px 14px rgba(31,35,40,0.06)",
    flameScale: 1,
  };
  const streakBadge = (
    <div
      className="streak-badge"
      title={curStreakPos ? `Current streak: ${curStreak} positive day${curStreak === 1 ? "" : "s"} in a row` : "Current streak: no active positive streak"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 10px",
        borderRadius: 999,
        border: `1px solid ${streakTone.border}`,
        background: streakTone.bg,
        boxShadow: streakTone.shadow,
        color: streakTone.color,
        flexShrink: 0,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = streakTone.hoverShadow;
        e.currentTarget.style.borderColor = streakTone.color;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = streakTone.shadow;
        e.currentTarget.style.borderColor = streakTone.border;
      }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="streak-badge-icon" style={{ transform: `scale(${streakTone.flameScale})`, transformOrigin: "50% 65%", flexShrink: 0, transition: "transform 160ms ease" }}>
        <path d="M8 16c3.314 0 6 -2 6 -5.5 0 -1.5 -0.5 -4 -2.5 -6 0.25 1.5 -1.25 2 -1.25 2C11 4 9 0.5 6 0c0.357 2 0.5 4 -2 6 -1.25 1 -2 2.729 -2 4.5C2 14 4.686 16 8 16m0 -1c-1.657 0 -3 -1 -3 -2.75 0 -0.75 0.25 -2 1.25 -3C6.125 10 7 10.5 7 10.5c-0.375 -1.25 0.5 -3.25 2 -3.5 -0.179 1 -0.25 2 1 3 0.625 0.5 1 1.364 1 2.25C11 14 9.657 15 8 15" />
      </svg>
      <span style={{ fontSize: 12, fontWeight: 800, lineHeight: 1, letterSpacing: "0.01em" }}>{curStreak}</span>
    </div>
  );
  const currencyToggle = (
    <button
      className="clickable-text currency-toggle"
      onClick={() => setCalendarUnit(u => u === "usd" ? "sol" : "usd")}
      style={{ ...headerAction, color: tk.text, display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0, padding: "5px 8px", borderRadius: 999, border: `1px solid transparent` }}
    >
      <span style={{ fontSize: 14, color: tk.textDim, width: 14, display: "inline-flex", justifyContent: "center", flexShrink: 0 }}>⇅</span>
      <span style={{ display: "inline-block", minWidth: 28, textAlign: "left" }}>{calendarUnit === "usd" ? "USD" : "SOL"}</span>
    </button>
  );
  const labelStyle = {
    fontSize: 10,
    color: tk.textDim,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    fontWeight: 700,
  };
  const sectionPad = isDesktop ? 16 : 16;

  const syncInfo = {
    loading: { col: accent, label: "Loading..." },
    saving:  { col: accent, label: "Saving..." },
    ok:      { col: green,  label: "Synced" },
    local:   { col: green,  label: "Saved locally" },
    setup:   { col: accent, label: "Setup needed" },
    error:   { col: red,    label: "Sync issue" },
  }[syncStatus] ?? { col: accent, label: "..." };
  const syncBadge = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, paddingLeft: 4 }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: syncInfo.col, flexShrink: 0 }} />
      <span style={{ fontSize: 11, color: tk.textDim, whiteSpace: "nowrap", lineHeight: 1 }}>{syncInfo.label}</span>
    </div>
  );
  const currentUserLabel = isLocalMode
    ? "Local mode"
    : authUser?.user_metadata?.full_name?.trim() || authUser?.email || "Account";
  const calendarSectionBg = dark ? "rgba(255,255,255,0.015)" : "rgba(31,35,40,0.02)";
  const railSectionBg = dark ? "rgba(255,255,255,0.02)" : "rgba(31,35,40,0.03)";
  const openTradeCard = {
    background: tk.surface2,
    border: `1px solid ${tk.borderSub}`,
    borderRadius: 12,
    padding: "10px 11px",
  };
  const readinessPalette = missionStats.ready
    ? {
        ring: dark ? "rgba(244,246,251,0.92)" : "#f3f5f8",
        glow: dark ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.45)",
        text: dark ? "#f3f5f8" : "#f3f5f8",
      }
    : missionStats.score >= 70
    ? {
        ring: dark ? "rgba(232,236,244,0.86)" : "#eef1f6",
        glow: dark ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.32)",
        text: dark ? "#eceff5" : "#eef1f6",
      }
    : {
        ring: dark ? "rgba(214,220,230,0.54)" : "#d7dce4",
        glow: dark ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.22)",
        text: dark ? "#d8dde6" : "#d7dce4",
      };

  // ── Session detail derived ─────────────────────────────────────────────────
  const modalTrades = modal?.tradeList || [];
  const modalNet = modal ? netPnl(modal) : 0;
  const modalFees = modalTrades.length * FEE_PER_TRADE;
  const modalGross = modalTrades.reduce((a, t) => a + parseFloat(t.pnl), 0);
  const modalWins = modalTrades.filter(t => t.pnl > 0).length;
  const modalWinTrades = modalTrades.filter(t => tradeNet(t) > 0);
  const modalLossTrades = modalTrades.filter(t => tradeNet(t) < 0);
  const modalWR = modalTrades.length ? Math.round(modalWins / modalTrades.length * 100) : null;
  const modalAvgWin = modalWinTrades.length
    ? modalWinTrades.reduce((a, t) => a + tradeNet(t), 0) / modalWinTrades.length
    : null;
  const modalAvgLoss = modalLossTrades.length
    ? modalLossTrades.reduce((a, t) => a + tradeNet(t), 0) / modalLossTrades.length
    : null;
  const modalViolations = modal ? sessionViolations(modal) : [];
  const modalViolatingTrades = modalTrades.filter(t => checkTrade(t).length > 0);
  const modalViolatingNet = modalViolatingTrades.reduce((a, t) => a + tradeNet(t), 0);
  const modalCleanNet = modalTrades.filter(t => checkTrade(t).length === 0).reduce((a, t) => a + tradeNet(t), 0);
  const monthCleanTradeCount = monthTrades.filter(t => checkTrade(t).length === 0).length;
  const monthCleanTradeRate = monthTrades.length ? Math.round(monthCleanTradeCount / monthTrades.length * 100) : 0;
  const monthViolatingTrades = monthTrades.filter(t => checkTrade(t).length > 0);
  const monthCleanTrades = monthTrades.filter(t => checkTrade(t).length === 0);
  const monthViolatingPositiveTrades = monthViolatingTrades.filter(t => tradeNet(t) > 0);
  const monthViolatingNegativeTrades = monthViolatingTrades.filter(t => tradeNet(t) < 0);
  const ruleBreakNet = monthViolatingTrades.reduce((a, t) => a + tradeNet(t), 0);
  const ruleBreakPositiveNet = monthViolatingPositiveTrades.reduce((a, t) => a + tradeNet(t), 0);
  const ruleBreakNegativeNet = monthViolatingNegativeTrades.reduce((a, t) => a + tradeNet(t), 0);
  const cleanTradeNet = monthCleanTrades.reduce((a, t) => a + tradeNet(t), 0);
  const ruleBreakAvg = monthViolatingTrades.length ? ruleBreakNet / monthViolatingTrades.length : null;
    const cleanTradeAvg = monthCleanTrades.length ? cleanTradeNet / monthCleanTrades.length : null;
  const ruleBreakImpact = (() => {
    if (!monthViolatingTrades.length) {
      return { title: "No violations", detail: "0 trades", color: tk.textMid };
    }
    if (ruleBreakAvg !== null && ruleBreakAvg <= 0) {
      return { title: "Harmful", detail: `avg ${fmtCalendarValue(ruleBreakAvg)}`, color: red };
    }
    if (ruleBreakAvg !== null && cleanTradeAvg !== null && ruleBreakAvg > cleanTradeAvg) {
      return { title: "Temporarily helpful", detail: `avg ${fmtCalendarValue(ruleBreakAvg)}`, color: accent };
    }
    return { title: "Weaker than clean trades", detail: `avg ${fmtCalendarValue(ruleBreakAvg ?? 0)}`, color: tk.text };
  })();
  const biggestTradeProfit = monthTrades.length
    ? monthTrades.reduce((max, t) => Math.max(max, tradeNet(t)), Number.NEGATIVE_INFINITY)
    : null;
  const biggestDayProfit = monthSessions.length
    ? monthSessions.reduce((max, s) => Math.max(max, netPnl(s)), Number.NEGATIVE_INFINITY)
    : null;
  const getSessionQuickStats = s => {
    const trades = s?.tradeList || [];
    const gross = trades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);
    const fees = trades.length * FEE_PER_TRADE;
    const net = gross - fees;
    const wins = trades.filter(t => tradeNet(t) > 0).length;
    const clean = trades.filter(t => checkTrade(t).length === 0).length;
    return {
      gross,
      fees,
      net,
      trades: trades.length,
      winRate: trades.length ? Math.round(wins / trades.length * 100) : 0,
      ruleRate: trades.length ? Math.round(clean / trades.length * 100) : 0,
    };
  };

  // ── Session detail body ────────────────────────────────────────────────────
  const detailBody = modal ? (
    <div style={{ padding: "18px 20px 48px", fontFamily: sans }}>
      <div style={{ ...quietPanel, padding: "16px 16px 14px", marginBottom: 14 }}>
        <div style={{ fontSize: 10, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700, marginBottom: 8 }}>Net P/L</div>
        <div style={{ fontSize: 30, fontWeight: 800, color: fmtColor(modalNet), lineHeight: 1, letterSpacing: "-0.02em" }}>{fmtUsd(modalNet)}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 14 }}>
          {[
            ["Gross", fmtUsd(modalGross), fmtColor(modalGross)],
            ["Fees", fmtUsd(-modalFees), tk.textDim],
            ["Trades", modalTrades.length, tk.text],
            ["Win rate", modalWR !== null ? modalWR + "%" : "—", tk.text],
            ["Avg win", modalAvgWin !== null ? fmtUsd(modalAvgWin) : "—", modalAvgWin !== null ? green : tk.textDim],
            ["Avg loss", modalAvgLoss !== null ? fmtUsd(modalAvgLoss) : "—", modalAvgLoss !== null ? red : tk.textDim],
          ].map(([k, v, c]) => (
            <div key={k} style={{ ...quietPanel, padding: "10px 11px" }}>
              <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{k}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {(modal.good || modal.bad) && (
        <div style={{ display: "grid", gridTemplateColumns: modal.good && modal.bad ? "1fr 1fr" : "1fr", gap: 10, marginBottom: 14 }}>
          {modal.good && (
            <div style={{ ...quietPanel, padding: "14px 15px" }}>
              <div style={{ fontSize: 10, color: tk.text, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700, marginBottom: 8 }}>What went well</div>
              <div style={{ fontSize: 13, color: tk.text, lineHeight: 1.65 }}>{modal.good}</div>
            </div>
          )}
          {modal.bad && (
            <div style={{ ...quietPanel, padding: "14px 15px" }}>
              <div style={{ fontSize: 10, color: tk.text, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700, marginBottom: 8 }}>What could improve</div>
              <div style={{ fontSize: 13, color: tk.text, lineHeight: 1.65 }}>{modal.bad}</div>
            </div>
          )}
        </div>
      )}

      {modalViolations.length > 0 && (
        <div style={{ ...quietPanel, padding: "14px 15px", marginBottom: 14, borderColor: dark ? "rgba(255,255,255,0.08)" : "rgba(31,35,40,0.08)" }}>
          <div style={{ fontSize: 10, color: `${accent}aa`, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700, marginBottom: 10 }}>Rule violations</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
            <div style={{ ...quietPanel, padding: "10px 11px" }}>
              <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>With violations</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: modalViolatingNet >= 0 ? green : red }}>{fmtUsd(modalViolatingNet)}</div>
            </div>
            <div style={{ ...quietPanel, padding: "10px 11px" }}>
              <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Without violations</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: modalCleanNet >= 0 ? green : red }}>{fmtUsd(modalCleanNet)}</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {modalViolations.map((v, i) => (
              <div key={i} style={{ ...quietPanel, padding: "9px 10px", fontSize: 12, color: tk.textMid, lineHeight: 1.55 }}>
                {v.token ? `${v.token}: ` : ""}{v.rule} — {v.detail}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700 }}>Trades ({modalTrades.length})</span>
        </div>

        {addTradeOpen && (
          <div style={{ ...quietPanel, padding: 14, marginBottom: 12, borderColor: `${accent}33` }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              {[
                { id: "instrument", l: "Token",        ph: "NOBODY",  type: "text" },
                { id: "entryMC",    l: "Entry MC ($)", ph: "10100",   type: "number" },
                { id: "exitMC",     l: "Exit MC ($)",  ph: "28200",   type: "number" },
                { id: "pnlPct",     l: "P/L %",        ph: "161.9",   type: "number" },
                { id: "pnl",        l: "P/L (SOL) *",  ph: "0.3238",  type: "number" },
              ].map(f => (
                <div key={f.id}>
                  <label style={{ fontSize: 10, color: `${accent}77`, textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 4 }}>{f.l}</label>
                  <input type={f.type} step="any" placeholder={f.ph} value={tradeForm[f.id]} onChange={e => setTradeForm(p => ({ ...p, [f.id]: e.target.value }))} style={{ ...inp, fontSize: 12, padding: "8px 10px" }} />
                </div>
              ))}
            </div>
            <div style={{ marginBottom: 8 }}>
              <label style={{ fontSize: 10, color: `${accent}77`, textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 4 }}>Notes</label>
              <input placeholder="Setup..." value={tradeForm.notes} onChange={e => setTradeForm(p => ({ ...p, notes: e.target.value }))} style={{ ...inp, fontSize: 12, padding: "8px 10px" }} />
            </div>
            <button onClick={addTradeToSession} style={{ width: "100%", padding: "11px", fontSize: 13, fontWeight: 700, borderRadius: 999, border: `1px solid ${accent}44`, background: "rgba(16,163,127,0.10)", color: accent, cursor: "pointer", fontFamily: sans }}>Save trade</button>
          </div>
        )}

        {!modalTrades.length && !addTradeOpen && (
          <div style={{ ...quietPanel, textAlign: "center", color: tk.textDim, fontSize: 13, padding: "22px 0" }}>No trades yet</div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {modalTrades.map((tr, i) => {
            const tnet = tradeNet(tr);
            const viols = checkTrade(tr);
            return (
              <div key={tr.id || i} style={{ ...quietPanel, borderRadius: 14, padding: "14px 14px 13px", borderLeft: `4px solid ${fmtColor(tnet)}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: tk.text }}>{tr.instrument || "—"}</span>
                      {viols.length > 0 && <span style={{ fontSize: 10, color: accentDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Violation</span>}
                    </div>
                    {tr.entryMC > 0 && <div style={{ marginTop: 10, fontSize: 11, color: tk.textDim }}>MC ${tr.entryMC.toLocaleString()} → ${tr.exitMC.toLocaleString()}</div>}
                    {tr.notes && <div style={{ marginTop: 8, fontSize: 12, color: tk.textMid, lineHeight: 1.55 }}>{tr.notes}</div>}
                    {viols.map((v, j) => <div key={j} style={{ fontSize: 11, color: `${accent}77`, marginTop: 6, lineHeight: 1.5 }}>{v.rule}: {v.detail}</div>)}
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: fmtColor(tnet), whiteSpace: "nowrap" }}>{fmtUsd(tnet)}</div>
                      {tr.pnlPct !== 0 && <div style={{ fontSize: 11, color: fmtColor(tr.pnlPct), marginTop: 4 }}>{fmtPct(tr.pnlPct)}</div>}
                    </div>
                    <button onClick={() => deleteTrade(tr.id)} style={{ background: tk.surface3, border: "none", borderRadius: 999, cursor: "pointer", color: tk.textDim, fontSize: 12, width: 28, height: 28, display: "grid", placeItems: "center", fontFamily: sans, flexShrink: 0 }}>✕</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  ) : null;

  // ── Calendar ───────────────────────────────────────────────────────────────
  const calendarContent = (
    <div style={{ ...panel, background: calendarSectionBg, padding: isDesktop ? `${sectionPad}px ${sectionPad}px 12px` : sectionPad, height: "auto", display: "flex", flexDirection: "column", overflow: "hidden", border: isDesktop ? "none" : `1px solid ${tk.border}`, borderTop: isDesktop ? "none" : `1px solid ${tk.border}`, borderRight: isDesktop ? "none" : undefined, borderLeft: isDesktop ? "none" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: isDesktop ? 14 : 18, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: tk.text, fontWeight: 600, letterSpacing: "0.01em" }}>P/L Calendar</div>
          {syncBadge}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginLeft: "auto" }}>
          <button
            className="clickable-text"
            onClick={() => setCurrentMonth(p => { const d = new Date(p.y, p.m - 1); return { y: d.getFullYear(), m: d.getMonth() }; })}
            style={{ ...headerAction, color: tk.textMid, fontSize: 21, lineHeight: 1, width: 14, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 400 }}
          >
            ‹
          </button>
          <span style={{ fontFamily: sans, fontWeight: 500, fontSize: 13, color: tk.text, minWidth: 88, textAlign: "center" }}>
            {monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1)}
          </span>
          <button
            className={isCurrentMonth ? undefined : "clickable-text"}
            onClick={() => {
              if (isCurrentMonth) return;
              setCurrentMonth(p => { const d = new Date(p.y, p.m + 1); return { y: d.getFullYear(), m: d.getMonth() }; });
            }}
            disabled={isCurrentMonth}
            style={{
              ...headerAction,
              color: isCurrentMonth ? tk.textDim : tk.textMid,
              fontSize: 21,
              lineHeight: 1,
              width: 14,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 400,
              opacity: isCurrentMonth ? 0.42 : 1,
              cursor: isCurrentMonth ? "default" : "pointer",
            }}
          >
            ›
          </button>
        </div>
      </div>

      {monthSessions.length > 0 && (
        <div style={{ padding: isDesktop ? "6px 2px 10px" : "6px 2px 14px", marginBottom: isDesktop ? 12 : 18, flexShrink: 0 }}>
          <div style={{ fontSize: isDesktop ? 22 : 22, fontWeight: 700, color: fmtColor(monthTotal), lineHeight: 1, marginBottom: 8, letterSpacing: "-0.01em" }}>
            {fmtCalendarValue(monthTotal)}
          </div>
          <div style={{ height: 5, borderRadius: 999, background: tk.border, marginBottom: 10, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${winRatio * 100}%`, background: green, borderRadius: 999 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontFamily: sans, fontWeight: 500 }}>
            <span style={{ color: green }}>{monthWins.length} {monthWins.length === 1 ? "profitable day" : "profitable days"} · {fmtCalendarValue(monthWinTotal, true)}</span>
            <span style={{ color: monthLosses.length > 0 ? red : tk.textDim }}>{monthLosses.length} {monthLosses.length === 1 ? "negative day" : "negative days"} · {monthLosses.length > 0 ? fmtCalendarValue(monthLossTotal, true) : calendarUnit === "sol" ? "0 SOL" : "0 USD"}</span>
          </div>
        </div>
      )}

      {sessions.length === 0 && (
        <div style={{ marginBottom: 18, padding: isDesktop ? "6px 2px 2px" : "4px 2px 2px", flexShrink: 0 }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: tk.text, lineHeight: 1.1 }}>No data yet</div>
          <div style={{ marginTop: 8, fontSize: 12, color: tk.textMid, lineHeight: 1.6, maxWidth: 520 }}>
            Import your first session to start tracking P/L, rule adherence, and consistency.
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: isDesktop ? 6 : 5, flexShrink: 0, background: "transparent" }}>
        {DAYS.map((d, i) => (
          <div key={i} style={{ fontSize: 11, color: tk.textDim, textAlign: "center", padding: isDesktop ? "2px 0 6px" : "4px 0", fontFamily: sans, fontWeight: 500 }}>{d}</div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gridTemplateRows: isDesktop ? `repeat(${calendarRows}, ${calendarRows >= 6 ? 86 : 100}px)` : undefined, gap: isDesktop ? 6 : 5, flex: "unset", minHeight: 0, background: "transparent" }}>
        {Array.from({ length: offset }).map((_, i) => <div key={"e" + i} />)}
        {Array.from({ length: daysInMonth }).map((_, di) => {
          const day = di + 1;
          const dateStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const s = sessionsByDate[dateStr];
          const dn = s ? netPnl(s) : 0;
          const isSel = isDesktop && modal?.date === dateStr;
          const minH = isDesktop ? (calendarRows >= 6 ? 54 : 64) : 60;
          const usd = solPrice !== null ? dn * solPrice : null;

          if (!s) return (
            <div key={day} style={{ borderRadius: isDesktop ? 6 : 4, minHeight: minH, padding: isDesktop ? "8px 10px" : "8px 9px", background: tk.surface2, border: "none", opacity: dark ? 0.5 : 0.62 }}>
              <span style={{ fontSize: 11, color: tk.textDim }}>{day}</span>
            </div>
          );

          const isWin = dn >= 0;
          const isBigWin = usd !== null && usd > 500;
          const positiveTone = getPositiveCalendarTone(usd);
          const negativeTone = getNegativeCalendarTone(usd);
          const bg = isBigWin ? tk.calBigWin.bg : isWin ? positiveTone.bg : negativeTone.bg;
          const border = isBigWin ? tk.calBigWin.border : isWin ? positiveTone.border : negativeTone.border;
          const valueColor = isBigWin ? tk.calBigWin.text : isWin ? positiveTone.text : negativeTone.text;
          const quick = getSessionQuickStats(s);
          return (
            <div
              key={day}
              className="calendar-session-cell"
              onClick={() => setModal(s)}
              onMouseEnter={e => {
                if (!isDesktop) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setCalendarHover({
                  session: s,
                  quick,
                  x: rect.left + rect.width / 2,
                  y: rect.top - 10,
                });
              }}
              onMouseLeave={() => setCalendarHover(null)}
              style={{
              borderRadius: isDesktop ? 6 : 4, minHeight: minH, padding: isDesktop ? "8px 10px" : "8px 9px",
              background: bg,
              border: `${isSel ? "1.5px" : "1px"} solid ${isDesktop ? "transparent" : border}`,
              cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "space-between",
              boxShadow: isSel
                ? `0 0 0 1px ${border}, 0 10px 22px ${dark ? "rgba(0,0,0,0.18)" : "rgba(31,35,40,0.08)"}`
                : isDesktop
                ? `inset 0 0 0 1px ${dark ? "rgba(255,255,255,0.02)" : "rgba(31,35,40,0.03)"}`
                : "none",
              outline: "none",
              transition: "transform 140ms ease, filter 140ms ease, box-shadow 140ms ease, border-color 140ms ease",
            }}
            >
              <span className="calendar-session-day" style={{ fontSize: 11, color: tk.textDim }}>{day}</span>
              <span className="calendar-session-value" style={{ fontSize: isDesktop ? 15 : 12, fontWeight: 500, color: valueColor, textAlign: "center", display: "block", letterSpacing: "-0.015em", lineHeight: 1.1 }}>
                {fmtCalendarValue(dn, true)}
              </span>
              <span className="calendar-session-count" style={{ fontSize: 9, color: tk.textDim, textAlign: "right" }}>{s.tradeList?.length || 0}t</span>
            </div>
          );
        })}
        {Array.from({ length: calendarTrailing }).map((_, i) => <div key={"t" + i} />)}
      </div>

      {isDesktop && calendarHover && (
        <div
          style={{
            position: "fixed",
            left: calendarHover.x,
            top: calendarHover.y,
            transform: "translate(-50%, -100%)",
            width: 240,
            background: tk.surface1,
            border: `1px solid ${tk.border}`,
            padding: 12,
            zIndex: 300,
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 12, color: tk.text, fontWeight: 700, marginBottom: 10 }}>
            {new Date(calendarHover.session.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {[
              { l: "Net P/L", v: fmtCalendarValue(calendarHover.quick.net, true), c: fmtColor(calendarHover.quick.net) },
              { l: "Gross", v: fmtCalendarValue(calendarHover.quick.gross, true), c: fmtColor(calendarHover.quick.gross) },
              { l: "Fees", v: fmtCalendarValue(-calendarHover.quick.fees, true), c: tk.textMid },
              { l: "Trades", v: String(calendarHover.quick.trades), c: tk.text },
              { l: "Win rate", v: calendarHover.quick.winRate + "%", c: tk.text },
              { l: "% rules", v: calendarHover.quick.ruleRate + "%", c: green },
            ].map(item => (
              <div key={item.l} style={{ ...quietPanel, padding: "9px 10px" }}>
                <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.l}</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: item.c }}>{item.v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isDesktop && sessions.length > 0 && (
        <div style={{ display: "flex", gap: 7, marginTop: isDesktop ? 12 : 14, flexWrap: "wrap", flexShrink: 0 }}>
          <span style={{ background: tk.surface2, border: `1px solid ${tk.border}`, borderRadius: 4, padding: "4px 10px", fontSize: 12, fontFamily: sans, color: tk.textMid }}>
            Rules: {cleanTradeRate}%
          </span>
        </div>
      )}

      {!isDesktop && sessions.length > 0 && (
        <div style={{ marginTop: 18, ...quietPanel, padding: "18px 18px", fontFamily: sans }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 14 }}>
            <div>
              <div style={labelStyle}>Mission Score</div>
              <div style={{ fontSize: isDesktop ? 19 : 17, fontWeight: 700, color: missionStats.ready ? green : missionStats.score >= 70 ? accent : tk.text, lineHeight: 1.25 }}>
                {missionStats.ready ? "Ready for a micro-size real test" : missionStats.score >= 70 ? "Close - keep paper trading" : "Still building evidence"}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: tk.textMid, lineHeight: 1.6 }}>
                Measures how close your history is to a conservative go-live threshold for a high-variance strategy.
              </div>
            </div>
            <div style={{ minWidth: 92, textAlign: "right" }}>
              <div style={{ fontSize: 36, fontWeight: 850, color: missionStats.ready ? green : missionStats.score >= 70 ? accent : tk.text, lineHeight: 1 }}>{missionStats.score}</div>
              <div style={{ fontSize: 11, color: tk.textDim, marginTop: 2 }}>/ 100</div>
            </div>
          </div>
          <div style={{ height: 7, borderRadius: 999, background: tk.border, overflow: "hidden", marginBottom: 12 }}>
            <div style={{ height: "100%", width: `${missionStats.score}%`, background: missionStats.ready ? green : accent, borderRadius: 999 }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: isDesktop ? "repeat(4, 1fr)" : "repeat(2, 1fr)", gap: 8 }}>
            {missionStats.items.map(item => (
              <div key={item.label} style={{ background: tk.surface2, borderRadius: 12, padding: "11px 12px", border: `1px solid ${item.done ? green + "44" : tk.borderSub}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 6 }}>
                  <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>{item.label}</div>
                  <div style={{ fontSize: 11, color: item.done ? green : tk.textMid, fontWeight: 700 }}>{item.done ? "✓" : Math.round(item.progress * 100) + "%"}</div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: item.done ? green : tk.text }}>{item.value}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 11, color: tk.textDim, lineHeight: 1.6 }}>
            Threshold: {MISSION_TARGETS.trades} trades, {MISSION_TARGETS.profitableWeeks} profitable weeks in a row, and {Math.round(MISSION_TARGETS.ruleCompliance * 100)}% rule compliance.
          </div>
        </div>
      )}

    </div>
  );

  const insightRail = (
    <aside style={{ display: "flex", flexDirection: "column", gap: 0, height: isDesktop ? "100%" : "auto", overflowY: isDesktop ? "auto" : "visible", paddingRight: isDesktop ? 0 : 0, borderLeft: isDesktop ? `1px solid ${tk.border}` : "none", background: railSectionBg }}>
      <div style={{
        padding: sectionPad,
        position: isDesktop ? "sticky" : "static",
        top: isDesktop ? 0 : "auto",
        backdropFilter: "none",
        background: "transparent",
        border: "none",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
          <div>
            <div style={labelStyle}>Readiness</div>
            <div style={{ marginTop: 6, fontSize: 22, fontWeight: 800, color: readinessPalette.text, lineHeight: 1 }}>
              {missionStats.score}%
            </div>
          </div>
          <div style={{
            position: "relative",
            width: 92,
            height: 92,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            boxShadow: `0 0 0 1px ${dark ? "rgba(255,255,255,0.04)" : "rgba(31,35,40,0.05)"}`,
          }}>
            <svg
              width="92"
              height="92"
              viewBox="0 0 92 92"
              aria-hidden="true"
              style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}
            >
              <circle
                cx="46"
                cy="46"
                r="38"
                fill="none"
                stroke={tk.border}
                strokeWidth="8"
              />
              <circle
                cx="46"
                cy="46"
                r="38"
                fill="none"
                stroke={readinessPalette.ring}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 38}
                strokeDashoffset={(2 * Math.PI * 38) * (1 - missionStats.score / 100)}
              />
            </svg>
            <div style={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              background: tk.bg,
              display: "grid",
              placeItems: "center",
              color: readinessPalette.text,
              fontSize: 12,
              fontWeight: 700,
              boxShadow: "none",
              position: "relative",
              zIndex: 1,
            }}>
              {missionStats.score}%
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${dark ? "rgba(255,255,255,0.06)" : "rgba(31,35,40,0.08)"}` }}>
          <div style={{ ...labelStyle, fontSize: 9 }}>Next focus</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          {sessions.length > 0 ? missionStats.items.filter(item => !item.done).slice(0, 3).map(item => (
            <div key={item.label} style={{ padding: "4px 0 8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: tk.text }}>{item.label}</span>
                <span style={{ fontSize: 11, color: tk.textDim }}>{Math.round(item.progress * 100)}%</span>
              </div>
              <div style={{ height: 5, background: tk.border, borderRadius: 999, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round(item.progress * 100)}%`, background: accent, borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 11, color: tk.textMid, marginTop: 7 }}>{item.value}</div>
            </div>
          )) : (
            <div style={{ padding: "4px 0 8px", color: tk.textMid, fontSize: 12, lineHeight: 1.6 }}>
              No data yet. Your next focus areas will appear here after your first imports.
            </div>
          )}
          {sessions.length > 0 && missionStats.items.every(item => item.done) && (
            <div style={{ padding: "4px 0 8px", color: green, fontSize: 12, fontWeight: 700 }}>All criteria reached</div>
          )}
        </div>

      </div>

      <div style={{ padding: sectionPad, border: "none", borderTop: `1px solid ${tk.border}` }}>
        <div style={{ ...labelStyle, fontSize: 9 }}>Highlights</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8, marginTop: 10 }}>
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Trading streak</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: tk.text }}>
              {sessions.length > 0 ? `${tradingStreak} ${tradingStreak === 1 ? "day" : "days"}` : "—"}
            </div>
          </div>
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Rules</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: monthCleanTradeRate >= 85 ? green : tk.text }}>
              {sessions.length > 0 ? `${monthCleanTradeRate}%` : "—"}
            </div>
          </div>
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Best trade</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: tk.text }}>
              {biggestTradeProfit !== null && biggestTradeProfit > 0 ? fmtCalendarValue(biggestTradeProfit) : "—"}
            </div>
          </div>
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Best day</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: tk.text }}>
              {biggestDayProfit !== null && biggestDayProfit > 0 ? fmtCalendarValue(biggestDayProfit) : "—"}
            </div>
          </div>
          <div style={{ padding: "4px 0 8px" }}>
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Rule-break P/L</div>
            <div
              onMouseEnter={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                setHighlightHover({
                  x: rect.left + rect.width / 2,
                  y: rect.top - 8,
                  positiveTrades: monthViolatingPositiveTrades.length,
                  positiveNet: ruleBreakPositiveNet,
                  negativeTrades: monthViolatingNegativeTrades.length,
                  negativeNet: ruleBreakNegativeNet,
                });
              }}
              onMouseLeave={() => setHighlightHover(null)}
              style={{ fontSize: 13, fontWeight: 700, color: monthViolatingTrades.length ? fmtColor(ruleBreakNet) : tk.text, cursor: "default", display: "inline-block" }}
            >
              {monthViolatingTrades.length ? fmtCalendarValue(ruleBreakNet) : "—"}
            </div>
          </div>
        </div>
        {highlightHover && (
          <div
            style={{
              position: "fixed",
              left: highlightHover.x,
              top: highlightHover.y,
              transform: "translate(-50%, -100%)",
              background: tk.surface1,
              border: `1px solid ${tk.border}`,
              color: tk.text,
              padding: 10,
              zIndex: 320,
              pointerEvents: "none",
              boxShadow: dark ? "0 12px 28px rgba(0,0,0,0.26)" : "0 12px 28px rgba(31,35,40,0.12)",
              minWidth: 210,
            }}
          >
            <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8, fontWeight: 700 }}>
              Rule-break trades
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                { label: "Positive", trades: highlightHover.positiveTrades, pnl: highlightHover.positiveNet, color: green },
                { label: "Negative", trades: highlightHover.negativeTrades, pnl: highlightHover.negativeNet, color: red },
              ].map(item => (
                <div key={item.label} style={{ display: "contents" }}>
                  <div style={{ ...quietPanel, padding: "8px 9px" }}>
                    <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label} trades</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: tk.text }}>{item.trades}</div>
                  </div>
                  <div style={{ ...quietPanel, padding: "8px 9px" }}>
                    <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label} P/L</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: item.color }}>{item.trades ? fmtCalendarValue(item.pnl) : fmtCalendarValue(0)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ height: 1, background: tk.borderSub, marginTop: 10, marginLeft: -sectionPad, marginRight: -sectionPad }} />
      </div>

    </aside>
  );

  const authScreen = (
    <div style={{ minHeight: "100vh", background: tk.bg, color: tk.text, fontFamily: sans, display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 460, ...panel, padding: 24, borderRadius: 16 }}>
        <div style={{ fontSize: 11, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Posture</div>
        <div style={{ marginTop: 10, fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>
          {!hasSupabaseConfig ? "Connect Supabase" : authReady ? (
            authMode === "sign-up"
              ? "Create your account"
              : authMode === "forgot-password"
              ? "Reset your password"
              : authMode === "reset-password"
              ? "Choose a new password"
              : "Sign in"
          ) : "Loading account"}
        </div>
        <div style={{ marginTop: 10, fontSize: 13, color: tk.textMid, lineHeight: 1.65 }}>
          {!hasSupabaseConfig
            ? "Add your Supabase project URL and anon key to a local .env file before using the shared login flow."
            : authReady
            ? "Each user gets their own isolated data. Sessions, all-time P/L, and analytics stay tied to the signed-in account."
            : "Checking your current session."}
        </div>

        {!hasSupabaseConfig ? (
          <div style={{ ...quietPanel, marginTop: 18, padding: 14 }}>
            <div style={{ fontSize: 11, color: tk.textDim, marginBottom: 8 }}>Add these env vars:</div>
            <div style={{ fontSize: 13, color: tk.text, lineHeight: 1.7 }}>
              `VITE_SUPABASE_URL`
              <br />
              `VITE_SUPABASE_ANON_KEY`
            </div>
          </div>
        ) : !authReady ? (
          <div style={{ ...quietPanel, marginTop: 18, padding: 14, fontSize: 13, color: tk.textMid }}>Loading session...</div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
              {[
                ["sign-in", "Sign in"],
                ["sign-up", "Sign up"],
              ].map(([mode, label]) => (
                <button
                  key={mode}
                  onClick={() => {
                    setAuthMode(mode);
                    setAuthError("");
                    setAuthNotice("");
                  }}
                  style={{
                    ...actionButton,
                    flex: 1,
                    padding: "10px 14px",
                    borderRadius: 999,
                    background: authMode === mode ? tk.surface2 : "transparent",
                    borderColor: authMode === mode ? tk.border : tk.borderSub,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <form onSubmit={handleAuthSubmit} style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              {authMode === "sign-up" && (
                <>
                  <div>
                    <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Invite code</label>
                    <input
                      value={authForm.inviteCode}
                      onChange={e => setAuthForm(prev => ({ ...prev, inviteCode: e.target.value.toUpperCase() }))}
                      placeholder="XXXXXXXX"
                      style={{ ...inp, fontFamily: "monospace", letterSpacing: "0.08em" }}
                    />
                  </div>
                  <div>
                    <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Name</label>
                    <input
                      value={authForm.fullName}
                      onChange={e => setAuthForm(prev => ({ ...prev, fullName: e.target.value }))}
                      placeholder="Your name"
                      style={inp}
                    />
                  </div>
                </>
              )}
              <div>
                <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Email</label>
                <input
                  type="email"
                  value={authForm.email}
                  onChange={e => setAuthForm(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="you@example.com"
                  style={inp}
                />
              </div>
              <div>
                <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Password</label>
                <input
                  type="password"
                  value={authForm.password}
                  onChange={e => setAuthForm(prev => ({ ...prev, password: e.target.value }))}
                  placeholder={authMode === "forgot-password" ? "Not needed for reset email" : "Minimum 6 characters"}
                  style={inp}
                  disabled={authMode === "forgot-password"}
                />
              </div>
              {authMode === "reset-password" && (
                <div>
                  <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Confirm password</label>
                  <input
                    type="password"
                    value={authForm.confirmPassword}
                    onChange={e => setAuthForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                    placeholder="Repeat your new password"
                    style={inp}
                  />
                </div>
              )}
              <button
                type="submit"
                disabled={
                  authBusy
                  || !authForm.email.trim()
                  || ((authMode === "sign-in" || authMode === "sign-up" || authMode === "reset-password") && !authForm.password)
                  || (authMode === "reset-password" && !authForm.confirmPassword)
                  || (authMode === "sign-up" && !authForm.inviteCode.trim())
                }
                style={{
                  ...actionButton,
                  marginTop: 4,
                  padding: "12px 16px",
                  borderRadius: 999,
                  background: "rgba(16,163,127,0.10)",
                  borderColor: `${accent}44`,
                  color: accent,
                }}
              >
                {authBusy
                  ? "Working..."
                  : authMode === "sign-up"
                  ? "Create account"
                  : authMode === "forgot-password"
                  ? "Send reset email"
                  : authMode === "reset-password"
                  ? "Update password"
                  : "Sign in"}
              </button>
            </form>

            {authMode === "sign-in" && (
              <button
                onClick={() => {
                  setAuthMode("forgot-password");
                  setAuthError("");
                  setAuthNotice("");
                }}
                style={{ ...headerAction, marginTop: 10, color: tk.textMid, alignSelf: "flex-start" }}
              >
                Forgot password?
              </button>
            )}
            {(authMode === "forgot-password" || authMode === "reset-password") && (
              <button
                onClick={() => {
                  setAuthMode("sign-in");
                  setAuthError("");
                  setAuthNotice("");
                }}
                style={{ ...headerAction, marginTop: 10, color: tk.textMid, alignSelf: "flex-start" }}
              >
                Back to sign in
              </button>
            )}

            {authError && <div style={{ marginTop: 12, fontSize: 13, color: red }}>{authError}</div>}
            {authNotice && <div style={{ marginTop: 12, fontSize: 13, color: green, lineHeight: 1.6 }}>{authNotice}</div>}
          </>
        )}
      </div>
    </div>
  );

  if ((!isLocalMode && !hasSupabaseConfig) || !authReady || (!isLocalMode && !authUser)) {
    return authScreen;
  }

  // ── Session detail header ──────────────────────────────────────────────────
  const panelHeader = modal ? (
    <div style={{ padding: "18px 20px 16px", borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.06)" : "rgba(31,35,40,0.07)"}`, position: "sticky", top: 0, background: tk.modalBg, zIndex: 10, fontFamily: sans }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: tk.text, lineHeight: 1.15 }}>{modal.date}</div>
          {modal.instrument && <div style={{ fontSize: 12, color: tk.textDim, marginTop: 5 }}>{modal.instrument}</div>}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <button onClick={deleteSession} style={{ ...actionButton, background: dark ? "rgba(214,69,69,0.08)" : "rgba(214,69,69,0.06)", border: "1px solid rgba(214,69,69,0.18)", fontSize: 13, color: red, padding: "7px 14px", borderRadius: 999 }}>Delete</button>
        </div>
      </div>
    </div>
  ) : null;

  // ── Header ─────────────────────────────────────────────────────────────────
  const appHeader = (
    <header style={{ borderBottom: `1px solid ${tk.border}`, position: "sticky", top: 0, background: dark ? "rgba(6,7,10,0.92)" : "rgba(247,247,245,0.86)", backdropFilter: "blur(18px)", zIndex: 100, fontFamily: sans }}>
      <div style={{ height: isDesktop ? 54 : 56, maxWidth: 1180, margin: "0 auto", padding: isDesktop ? "0 22px" : "0 14px" }}>
        {isDesktop ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", height: "100%", alignItems: "stretch" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, minWidth: 0, padding: `0 ${sectionPad}px` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span style={{ fontSize: 11, color: tk.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "default" }}>{currentUserLabel}</span>
                {streakBadge}
              </div>
              {currencyToggle}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0, borderLeft: `1px solid ${tk.border}`, padding: `0 ${sectionPad}px` }}>
              {sessions.length > 0 ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 11, color: tk.textDim, fontWeight: 600 }}>All-time P/L</span>
                  <span style={{ color: fmtColor(allTimeNet), fontSize: 12, fontWeight: 700 }}>{fmtHeaderPnl(allTimeNet)}</span>
                </div>
              ) : <div />}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {isAdmin && <button onClick={() => { setInvitePanelOpen(true); setInviteListLoading(true); listInvites().then(setInviteList).finally(() => setInviteListLoading(false)); }} style={{ ...headerButton }}>Invites</button>}
                {!isLocalMode && <button onClick={handleSignOut} style={{ ...headerButton }}>Sign out</button>}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, paddingLeft: 18 }}>
                <span style={{ fontSize: 11, color: tk.textDim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", cursor: "default" }}>{currentUserLabel}</span>
                {streakBadge}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
              {sessions.length > 0 && (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 11, color: tk.textDim, fontWeight: 600 }}>All-time P/L</span>
                    <span style={{ color: fmtColor(allTimeNet), fontSize: 12, fontWeight: 700 }}>{fmtHeaderPnl(allTimeNet)}</span>
                  </div>
                  <div style={{ width: 1, height: 22, background: tk.border }} />
                </>
              )}
              {currencyToggle}
              {isAdmin && (
                <>
                  <div style={{ width: 1, height: 22, background: tk.border }} />
                  <button onClick={() => { setInvitePanelOpen(true); setInviteListLoading(true); listInvites().then(setInviteList).finally(() => setInviteListLoading(false)); }} style={{ ...headerButton }}>Invites</button>
                </>
              )}
              {!isLocalMode && (
                <>
                  <div style={{ width: 1, height: 22, background: tk.border }} />
                  <button onClick={handleSignOut} style={{ ...headerButton }}>Sign out</button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );


  // ── Content padding ────────────────────────────────────────────────────────
  const contentPad = isDesktop ? "0 22px 0" : "16px 12px 72px";
  const desktopLeftDivider = (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        bottom: 0,
        left: "max(22px, calc((100vw - 1180px) / 2 + 22px))",
        width: 1,
        background: tk.border,
        pointerEvents: "none",
        zIndex: 150,
      }}
    />
  );
  const desktopRightDivider = (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        bottom: 0,
        right: "max(22px, calc((100vw - 1180px) / 2 + 22px))",
        width: 1,
        background: tk.border,
        pointerEvents: "none",
        zIndex: 150,
      }}
    />
  );

  // ── Invite panel ──────────────────────────────────────────────────────────
  const invitePanel = invitePanelOpen ? (
    <div onClick={() => setInvitePanelOpen(false)} style={{ position: "fixed", inset: 0, background: dark ? "rgba(0,0,0,0.62)" : "rgba(31,35,40,0.28)", backdropFilter: "blur(8px)", zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...panel, background: tk.modalBg, borderRadius: 16, width: "100%", maxWidth: 420, padding: "22px 20px 24px", fontFamily: sans }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: tk.text }}>Invite codes</span>
          <button onClick={() => setInvitePanelOpen(false)} style={{ ...headerButton, color: tk.textMid }}>Close</button>
        </div>

        <button
          onClick={async () => {
            setInviteGenBusy(true);
            try {
              const code = await generateInvite();
              setInviteList(prev => [{ code, created_at: new Date().toISOString(), used_at: null }, ...prev]);
            } catch (err) {
              alert(err?.message || "Failed to generate code.");
            } finally {
              setInviteGenBusy(false);
            }
          }}
          disabled={inviteGenBusy}
          style={{ ...actionButton, width: "100%", padding: "10px 14px", borderRadius: 999, background: "rgba(16,163,127,0.10)", borderColor: `${accent}44`, color: accent, marginBottom: 16 }}
        >
          {inviteGenBusy ? "Generating..." : "+ Generate invite code"}
        </button>

        {inviteListLoading ? (
          <div style={{ fontSize: 13, color: tk.textDim, textAlign: "center", padding: "12px 0" }}>Loading...</div>
        ) : inviteList.length === 0 ? (
          <div style={{ fontSize: 13, color: tk.textDim, textAlign: "center", padding: "12px 0" }}>No codes yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {inviteList.map(inv => {
              const inviteUrl = `${window.location.origin}${window.location.pathname}?invite=${inv.code}`;
              const copied = inviteCopied === inv.code;
              return (
                <div key={inv.code} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "8px 10px", borderRadius: 8, background: inv.used_at ? tk.surface2 : `${accent}0d`, border: `1px solid ${inv.used_at ? tk.borderSub : accent + "22"}` }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 13, letterSpacing: "0.08em", color: inv.used_at ? tk.textDim : tk.text }}>{inv.code}</span>
                    <span style={{ fontSize: 11, color: tk.textDim }}>{inv.used_at ? "Used" : "Available"}</span>
                  </div>
                  {!inv.used_at && (
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(inviteUrl);
                        setInviteCopied(inv.code);
                        setTimeout(() => setInviteCopied(""), 2000);
                      }}
                      style={{ ...headerButton, flexShrink: 0, color: copied ? green : tk.textMid }}
                    >
                      {copied ? "Copied!" : "Copy link"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  ) : null;

  // ══════════════════════════════════════════════════════════════════════════
  // DESKTOP
  // ══════════════════════════════════════════════════════════════════════════
  if (isDesktop) {
    return (
      <div style={{ background: tk.bg, color: tk.text, height: "100vh", overflow: "hidden", fontFamily: sans }}>
        {desktopLeftDivider}
        {desktopRightDivider}
        {appHeader}
        <div style={{ padding: contentPad, maxWidth: 1180, margin: "0 auto", height: "calc(100vh - 54px)", background: tk.bg }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", alignItems: "stretch", gap: 0, height: "100%" }}>
            <div style={{ height: "100%", minHeight: 0, paddingBottom: 22 }}>{calendarContent}</div>
            {insightRail}
          </div>
        </div>

        {modal && (
          <>
            <div onClick={closeModal} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", zIndex: 200 }} />
            <div style={{
              position: "fixed", right: 0, top: 0, width: 420, height: "100vh",
              background: tk.modalBg,
              borderLeft: `1px solid ${dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)"}`,
              zIndex: 201, overflowY: "auto",
              animation: "slideInRight 0.22s cubic-bezier(0.16,1,0.3,1)",
              display: "flex", flexDirection: "column",
            }}>
              {panelHeader}
              {detailBody}
            </div>
          </>
        )}
        {invitePanel}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MOBILE
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ background: tk.bg, color: tk.text, minHeight: "100vh", fontFamily: sans }}>
      {appHeader}
      <div style={{ padding: contentPad, maxWidth: 640, margin: "0 auto", background: tk.bg }}>
        {calendarContent}
      </div>

      {modal && (
        <div onClick={closeModal} style={{ position: "fixed", inset: 0, background: dark ? "rgba(0,0,0,0.68)" : "rgba(31,35,40,0.32)", backdropFilter: "blur(8px)", zIndex: 999, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
          <div onClick={e => e.stopPropagation()} style={{ background: tk.modalBg, borderRadius: "22px 22px 0 0", width: "100%", maxWidth: 560, maxHeight: "92vh", overflowY: "auto", color: tk.text, animation: "sheetUp 0.22s ease" }}>
            <div style={{ padding: "14px 20px 14px", borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)"}`, position: "sticky", top: 0, background: tk.modalBg, zIndex: 10, fontFamily: sans }}>
              <div style={{ width: 32, height: 3, borderRadius: 2, background: `${accent}44`, margin: "0 auto 14px" }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 17 }}>{modal.date}</div>
                  {modal.instrument && <div style={{ fontSize: 12, color: `${accent}66`, marginTop: 1 }}>{modal.instrument}</div>}
                </div>
                <div style={{ display: "flex", gap: 7 }}>
                  <button onClick={deleteSession} style={{ ...actionButton, background: "rgba(214,69,69,0.08)", border: "1px solid rgba(214,69,69,0.20)", fontSize: 13, color: red, padding: "6px 14px" }}>Delete</button>
                </div>
              </div>
            </div>
            {detailBody}
          </div>
        </div>
      )}
      {invitePanel}
    </div>
  );
}
