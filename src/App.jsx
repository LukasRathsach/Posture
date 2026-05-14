import { useState, useEffect, useRef } from "react";
import {
  FEE_PER_TRADE, green, red, sans,
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
  setSessionFromTokens,
  validateInviteCode,
  claimInvite,
  generateInvite,
  listInvites,
  deleteCurrentUser,
} from "./api";
import { attachPostureBridge, postOpenPositionsUpdate, postSessionUpdate } from "./postureBridge";
import { EmptyState, InlineLoader, StatusNotice } from "./uiPrimitives";
import { getCollectionUiState, getSyncPresentation, UI_STATE } from "./uiState";

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
  const ACCENT_PRESETS = [
    {
      key: "axiom", base: "#8FA1BF", dim: "#6E82A4",
      dark: { bg: "#0B1220", surface1: "#111A2B", surface2: "#0D1625", surface3: "#0A1220", border: "#2A3850", borderSub: "#182235", inp: { bg: "#111A2B", border: "#2A3850", color: "#F8FAFC" } },
    },
    {
      key: "amber", base: "#F59E0B", dim: "#D97706",
      dark: { bg: "#0F172A", surface1: "#1E293B", surface2: "#162033", surface3: "#0F1929", border: "#334155", borderSub: "#1E293B", inp: { bg: "#1E293B", border: "#334155", color: "#F8FAFC" } },
    },
    {
      key: "teal", base: "#14B8A6", dim: "#0D9488",
      dark: { bg: "#061516", surface1: "#0C2426", surface2: "#081B1D", surface3: "#051012", border: "#165054", borderSub: "#0C2426", inp: { bg: "#0C2426", border: "#165054", color: "#F8FAFC" } },
    },
    {
      key: "violet", base: "#8B5CF6", dim: "#7C3AED",
      dark: { bg: "#0D0B18", surface1: "#17132A", surface2: "#110F21", surface3: "#0A0815", border: "#2C2350", borderSub: "#17132A", inp: { bg: "#17132A", border: "#2C2350", color: "#F8FAFC" } },
    },
    {
      key: "rose", base: "#F43F5E", dim: "#E11D48",
      dark: { bg: "#130810", surface1: "#221018", surface2: "#1A0C15", surface3: "#0F060C", border: "#3D1425", borderSub: "#221018", inp: { bg: "#221018", border: "#3D1425", color: "#F8FAFC" } },
    },
  ];
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [accentKey, setAccentKey] = useState(() => localStorage.getItem("posture_accent_key") || "amber");
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = e => setDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  const activeAccentPreset = ACCENT_PRESETS.find(p => p.key === accentKey) ?? ACCENT_PRESETS[0];
  const accent = activeAccentPreset.base;
  const accentDim = activeAccentPreset.dim;
  const baseDark = THEME.dark;
  const tk = dark
    ? { ...baseDark, ...activeAccentPreset.dark, modalBg: activeAccentPreset.dark.bg, modalSurf: activeAccentPreset.dark.surface1 }
    : THEME.light;
  useEffect(() => {
    if (!dark) return;
    document.documentElement.style.background = activeAccentPreset.dark.bg;
    document.body.style.background = activeAccentPreset.dark.bg;
  }, [accentKey, dark]);

  // ── Settings panel ─────────────────────────────────────────────────────────
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [virtualBalance, setVirtualBalance] = useState(() => Number(localStorage.getItem("posture_virtual_balance") || "0"));
  const [balanceInputVal, setBalanceInputVal] = useState("");
  const [balanceModalOpen, setBalanceModalOpen] = useState(false);
  const [balanceHover, setBalanceHover] = useState(false);
  const settingsWrapperRef = useRef(null);

  const syncVirtualBalance = nextValue => {
    const normalized = Math.max(0, Number(nextValue || 0));
    const rounded = Number(normalized.toFixed(4));
    setVirtualBalance(rounded);
    localStorage.setItem("posture_virtual_balance", String(rounded));
    window.postMessage({ source: "posture-page", type: "balance_update", value: rounded }, "*");
  };

  const resetVirtualBalance = () => {
    setVirtualBalance(0);
    localStorage.removeItem("posture_virtual_balance");
    window.postMessage({ source: "posture-page", type: "reset_balance" }, "*");
  };

  useEffect(() => {
    if (!settingsPanelOpen) return;
    const handler = e => {
      if (settingsWrapperRef.current && !settingsWrapperRef.current.contains(e.target))
        setSettingsPanelOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [settingsPanelOpen]);

  useEffect(() => {
    if (!balanceModalOpen) return;
    const handler = e => {
      if (e.key === "Escape") {
        setBalanceModalOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [balanceModalOpen]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("modal") !== "balance") return;
    setBalanceModalOpen(true);
    url.searchParams.delete("modal");
    const next = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", next);
  }, []);

  useEffect(() => {
    const requestBridgeBalance = () => {
      window.postMessage({ source: "posture-page", type: "request_balance" }, "*");
    };

    requestBridgeBalance();
    window.addEventListener("focus", requestBridgeBalance);
    document.addEventListener("visibilitychange", requestBridgeBalance);
    return () => {
      window.removeEventListener("focus", requestBridgeBalance);
      document.removeEventListener("visibilitychange", requestBridgeBalance);
    };
  }, []);

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
  const [extensionOpenPositions, setExtensionOpenPositions] = useState(() => {
    try {
      const raw = localStorage.getItem("posture_extension_open_positions");
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
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
  const [authMode, setAuthMode] = useState("sign-up");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
  const [authForm, setAuthForm] = useState({ fullName: "", email: "", password: "", confirmPassword: "", inviteCode: "" });
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [inviteList, setInviteList] = useState([]);
  const [inviteListLoading, setInviteListLoading] = useState(false);
  const [inviteGenBusy, setInviteGenBusy] = useState(false);
  const [inviteCopied, setInviteCopied] = useState("");
  const [inviteStatus, setInviteStatus] = useState(null);
  const [livePositionsStatus, setLivePositionsStatus] = useState(null);
  const [syncFlash, setSyncFlash] = useState("");
  const [openTradeDeleteBusyId, setOpenTradeDeleteBusyId] = useState("");
  const initialized = useRef(false);
  const saveTimer = useRef(null);
  const lastSyncedTradeKey = useRef("");
  const transientTimers = useRef({});
  const previousSyncStatus = useRef(syncStatus);
  const isLocalMode = !hasSupabaseConfig;
  const isAdmin = authUser?.email === "lukas@rathsach.com";
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

  const showTransientMessage = (key, setter, nextValue, timeout = 2200) => {
    if (transientTimers.current[key]) {
      window.clearTimeout(transientTimers.current[key]);
    }
    setter(nextValue);
    transientTimers.current[key] = window.setTimeout(() => {
      setter(null);
      delete transientTimers.current[key];
    }, timeout);
  };

  useEffect(() => () => {
    Object.values(transientTimers.current).forEach(timer => window.clearTimeout(timer));
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
      // Sync session to extension
      postSessionUpdate(session);
    });

    const detachBridge = attachPostureBridge({
      onInjectSession: async ({ access_token, refresh_token }) => {
        try { await setSessionFromTokens(access_token, refresh_token); } catch (_) {}
      },
      onInjectBalance: next => {
        if (next === null || next === undefined) {
          setVirtualBalance(0);
          localStorage.removeItem("posture_virtual_balance");
          return;
        }
        const parsed = Number(next);
        if (Number.isFinite(parsed) && parsed >= 0) {
          const rounded = Number(parsed.toFixed(4));
          setVirtualBalance(rounded);
          localStorage.setItem("posture_virtual_balance", String(rounded));
        }
      },
      onInjectOpenPositions: next => {
        const normalized = next && typeof next === "object" ? next : {};
        setExtensionOpenPositions(normalized);
        localStorage.setItem("posture_extension_open_positions", JSON.stringify(normalized));
      },
    });

    const handleStorage = e => {
      if (e.key === "posture_virtual_balance") {
        const parsed = Number(e.newValue || 0);
        setVirtualBalance(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
      }
      if (e.key === "posture_extension_open_positions") {
        try {
          const parsed = e.newValue ? JSON.parse(e.newValue) : {};
          setExtensionOpenPositions(parsed && typeof parsed === "object" ? parsed : {});
        } catch {
          setExtensionOpenPositions({});
        }
      }
    };
    window.addEventListener("storage", handleStorage);

    return () => {
      alive = false;
      data.subscription.unsubscribe();
      detachBridge();
      window.removeEventListener("storage", handleStorage);
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
    const previous = previousSyncStatus.current;
    if (syncStatus === "ok" && previous !== "ok" && previous !== "loading") {
      showTransientMessage("sync-flash", setSyncFlash, "Session synced");
    }
    if (syncStatus === "local" && previous !== "local" && previous !== "loading") {
      showTransientMessage("sync-flash", setSyncFlash, "Saved on this device");
    }
    previousSyncStatus.current = syncStatus;
  }, [syncStatus]);

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
  const formatAuditMc = value => {
    const mc = Number(value || 0);
    if (!(mc > 0)) return "—";
    if (mc >= 1e9) return `$${(mc / 1e9).toFixed(2)}B`;
    if (mc >= 1e6) return `$${(mc / 1e6).toFixed(2)}M`;
    if (mc >= 1e3) return `$${(mc / 1e3).toFixed(1)}K`;
    return `$${mc.toFixed(0)}`;
  };

  const syncExtensionOpenPositions = nextPositions => {
    const normalized = nextPositions && typeof nextPositions === "object" ? nextPositions : {};
    setExtensionOpenPositions(normalized);
    localStorage.setItem("posture_extension_open_positions", JSON.stringify(normalized));
    postOpenPositionsUpdate(normalized);
    showTransientMessage("live-positions-status", setLivePositionsStatus, {
      tone: "success",
      title: "Live positions refreshed",
      detail: `${Object.keys(normalized).length} tracked ${Object.keys(normalized).length === 1 ? "position" : "positions"} in sync.`,
    });
  };

  const formatProtectionLevel = (pos, kind) => {
    if (!pos) return "—";
    if (kind === "stop") {
      if ((pos.stopLossMode || "pct") === "mc") {
        return pos.stopLossMarketCap ? `${formatAuditMc(pos.stopLossMarketCap)} MC` : "—";
      }
      return pos.stopLossPct ? `${Math.abs(pos.stopLossPct).toFixed(1)}%` : "—";
    }
    if ((pos.targetSellMode || "pct") === "mc") {
      return pos.targetSellMarketCap ? `${formatAuditMc(pos.targetSellMarketCap)} MC` : "—";
    }
    return pos.targetSellPct ? `${pos.targetSellPct.toFixed(1)}%` : "—";
  };

  const formatTimelineTime = timestamp => {
    if (!timestamp) return "—";
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  };

  const normalizedExtensionOpenTrades = (() => {
    const seen = new Set();
    return Object.values(extensionOpenPositions || {})
      .filter(pos => {
        const key = pos?.positionId || pos?.contractAddress || pos?.tokenName;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();

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
          inviteCode: code,
        });
        if (data.session) {
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

  async function loadInvitePanel() {
    setInvitePanelOpen(true);
    setInviteListLoading(true);
    setInviteStatus(null);
    try {
      const nextInvites = await listInvites();
      setInviteList(nextInvites);
      setInviteStatus(null);
    } catch (err) {
      setInviteStatus({
        tone: "error",
        title: "Could not load invite codes",
        detail: err?.message || "Try again in a moment.",
      });
    } finally {
      setInviteListLoading(false);
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

  async function deleteOpenTrade(position) {
    if (!position) return;
    const positionId = position.positionId || "";
    setOpenTradeDeleteBusyId(positionId);
    try {
      if (!isLocalMode && authUser && isBackendId(position.id)) {
        try { await deletePaperTradesByIds([position.id]); } catch { /* non-fatal */ }
        lastSyncedTradeKey.current = "";
      }
      setOpenTrades(prev => prev.filter(item => item.id !== position.id && item.positionId !== position.positionId));
      const nextExtensionOpenPositions = Object.fromEntries(
        Object.entries(extensionOpenPositions || {}).filter(([, value]) => {
          if (!value) return false;
          if (value.positionId && position.positionId && value.positionId === position.positionId) return false;
          const sameContract = value.contractAddress && position.contractAddress && value.contractAddress === position.contractAddress;
          const sameTokenFallback = !position.contractAddress && !value.contractAddress && value.tokenName === position.tokenName;
          return !(sameContract || sameTokenFallback);
        })
      );
      syncExtensionOpenPositions(nextExtensionOpenPositions);
      showTransientMessage("live-positions-status", setLivePositionsStatus, {
        tone: "success",
        title: "Live positions updated",
        detail: `${position.tokenName} was removed from the dashboard view.`,
      });
    } finally {
      setOpenTradeDeleteBusyId("");
    }
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
  const shellPadX = isDesktop ? 22 : 14;
  const sectionPad = isDesktop ? 16 : 16;
  const cardPad = 10;
  const modalPad = 20;
  const uiPalette = {
    neutral: {
      bg: dark ? "rgba(255,255,255,0.03)" : "rgba(31,35,40,0.035)",
      border: dark ? "rgba(255,255,255,0.07)" : "rgba(31,35,40,0.08)",
      text: tk.textMid,
      strongText: tk.text,
    },
    accent: {
      bg: dark ? "rgba(245,158,11,0.09)" : "rgba(245,158,11,0.08)",
      border: dark ? "rgba(245,158,11,0.22)" : "rgba(217,119,6,0.18)",
      text: accent,
      strongText: tk.text,
    },
    success: {
      bg: dark ? "rgba(34,197,94,0.09)" : "rgba(34,197,94,0.08)",
      border: dark ? "rgba(34,197,94,0.22)" : "rgba(21,128,61,0.16)",
      text: green,
      strongText: tk.text,
    },
    error: {
      bg: dark ? "rgba(239,68,68,0.08)" : "rgba(239,68,68,0.07)",
      border: dark ? "rgba(239,68,68,0.18)" : "rgba(185,28,28,0.14)",
      text: red,
      strongText: tk.text,
    },
  };
  const syncInfo = getSyncPresentation(syncStatus);
  const syncToneColor = syncInfo.tone === "success" ? green : syncInfo.tone === "error" ? red : accent;
  const inviteListState = getCollectionUiState({ loading: inviteListLoading, items: inviteList });
  const livePositionsState = openTrades.length > 0
    ? UI_STATE.IDLE
    : (!isLocalMode && authUser && syncStatus === "loading" ? UI_STATE.LOADING : UI_STATE.EMPTY);
  const syncBadge = (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, paddingLeft: 4 }}>
      {(syncInfo.state === UI_STATE.LOADING || syncInfo.state === UI_STATE.SAVING) ? (
        <InlineLoader label={syncInfo.label} tone="accent" />
      ) : (
        <>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: syncToneColor, flexShrink: 0, boxShadow: syncFlash ? `0 0 0 5px ${syncToneColor}22` : "none", transition: "box-shadow 180ms ease" }} />
          <span style={{ fontSize: 11, color: tk.textDim, whiteSpace: "nowrap", lineHeight: 1 }}>{syncFlash || syncInfo.label}</span>
        </>
      )}
    </div>
  );
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
  const OPEN_NOTE_PREFIX = "__TD_OPEN__";
  const completedModalTrades = modalTrades.filter(t => !String(t.notes || "").startsWith(OPEN_NOTE_PREFIX));
  // Group completed trades by instrument — multiple buys/partial-sells on the same token = one position row
  const displayTradeGroups = (() => {
    const groups = {};
    const keyOrder = [];
    completedModalTrades.forEach(t => {
      // Group by positionId when available so re-entries on the same coin are separate rows.
      // Fall back to instrument+id so each unknown trade is its own row rather than all merged.
      const key = t.positionId || `${t.instrument || "—"}_${t.id}`;
      if (!groups[key]) { groups[key] = []; keyOrder.push(key); }
      groups[key].push(t);
    });
    return keyOrder.map(key => { const trades = groups[key];
      const totalPnl  = trades.reduce((s, t) => s + parseFloat(t.pnl || 0), 0);
      const totalNet  = trades.reduce((s, t) => s + tradeNet(t), 0);
      const allViols  = trades.flatMap(t => checkTrade(t));
      const firstEntryMC = trades[0]?.entryMC || 0;
      const lastExitMC   = trades[trades.length - 1]?.exitMC || 0;
      // Weighted-average % across all closes: sum(pnl) / sum(impliedSize)
      let totalImplied = 0;
      trades.forEach(t => {
        const pct = parseFloat(t.pnlPct || 0);
        const pnl = parseFloat(t.pnl || 0);
        if (Math.abs(pct) > 0.001) totalImplied += pnl / (pct / 100);
      });
      const avgPct = Math.abs(totalImplied) > 1e-9 ? (totalPnl / totalImplied) * 100 : null;
      return { instrument: trades[0]?.instrument || "—", trades, totalPnl, totalNet, firstEntryMC, lastExitMC, allViols, avgPct };
    });
  })();
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
            <button className="ui-interactive-button" onClick={addTradeToSession} style={{ width: "100%", padding: "11px", fontSize: 13, fontWeight: 700, borderRadius: 999, border: `1px solid ${accent}44`, background: "rgba(16,163,127,0.10)", color: accent, cursor: "pointer", fontFamily: sans }}>Save trade</button>
          </div>
        )}

        {!modalTrades.length && !addTradeOpen && (
          <EmptyState
            compact
            align="center"
            eyebrow="Session detail"
            title="No closed trades yet"
            detail="This session does not have any completed trade entries to review."
            palette={uiPalette}
          />
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {displayTradeGroups.map((group, i) => {
            const { instrument, trades, totalPnl, totalNet, firstEntryMC, lastExitMC, allViols, avgPct } = group;
            const merged = trades.length > 1;
            const notes = !merged ? (trades[0]?.notes || "") : "";
            const closeMeta = !merged ? (trades[0]?.closeMeta || null) : null;
            return (
              <div key={instrument + i} style={{ ...quietPanel, borderRadius: 14, padding: "14px 14px 13px", borderLeft: `4px solid ${fmtColor(totalNet)}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: tk.text }}>{instrument}</span>
                      {merged && <span style={{ fontSize: 10, color: tk.textDim, letterSpacing: "0.06em" }}>{trades.length} CLOSES</span>}
                      {closeMeta?.trigger && closeMeta.trigger !== "manual" && <span style={{ fontSize: 10, color: green, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>{closeMeta.trigger.replaceAll("_", " ")}</span>}
                      {allViols.length > 0 && <span style={{ fontSize: 10, color: accentDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700 }}>Violation</span>}
                    </div>
                    {firstEntryMC > 0 && <div style={{ marginTop: 10, fontSize: 11, color: tk.textDim }}>
                      {(() => {
                        const fmtMC = v => v >= 1e6 ? `$${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v/1e3).toFixed(1)}K` : `$${v.toFixed(1)}`;
                        return `MC ${fmtMC(firstEntryMC)} → ${fmtMC(lastExitMC)}`;
                      })()}
                    </div>}
                    {notes && <div style={{ marginTop: 8, fontSize: 12, color: tk.textMid, lineHeight: 1.55 }}>{notes}</div>}
                    {allViols.map((v, j) => <div key={j} style={{ fontSize: 11, color: `${accent}77`, marginTop: 6, lineHeight: 1.5 }}>{v.rule}: {v.detail}</div>)}
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexShrink: 0 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: fmtColor(totalNet), whiteSpace: "nowrap" }}>{fmtUsd(totalNet)}</div>
                      {avgPct !== null && <div style={{ fontSize: 11, color: fmtColor(avgPct), marginTop: 4 }}>{fmtPct(avgPct)}</div>}
                    </div>
                    <button
                      className="ui-interactive-button"
                      onClick={async () => { for (const t of trades) await deleteTrade(t.id); }}
                      style={{ background: tk.surface3, border: "none", borderRadius: 999, cursor: "pointer", color: tk.textDim, fontSize: 12, width: 28, height: 28, display: "grid", placeItems: "center", fontFamily: sans, flexShrink: 0 }}
                    >✕</button>
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
    <div style={{ ...panel, background: calendarSectionBg, padding: sectionPad, height: "auto", display: "flex", flexDirection: "column", overflow: "hidden", border: isDesktop ? "none" : `1px solid ${tk.border}`, borderTop: isDesktop ? "none" : `1px solid ${tk.border}`, borderRight: isDesktop ? "none" : undefined, borderLeft: isDesktop ? "none" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: isDesktop ? 14 : 18, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: tk.text, fontWeight: 600, letterSpacing: "0.01em" }}>P/L Calendar</div>
          {syncBadge}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginLeft: "auto" }}>
          {currencyToggle}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
      </div>

      {monthSessions.length > 0 && (
        <div style={{ padding: isDesktop ? "6px 0 12px" : "6px 0 14px", marginBottom: isDesktop ? 12 : 18, flexShrink: 0 }}>
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
        <div style={{ marginBottom: 18, padding: isDesktop ? "6px 0 2px" : "4px 0 2px", flexShrink: 0 }}>
          <EmptyState
            eyebrow="Getting started"
            title="No trading record yet"
            detail="Import your first session to populate the calendar, unlock readiness tracking, and surface your next practice focus."
            palette={uiPalette}
          />
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
              <div key={item.l} style={{ ...quietPanel, padding: cardPad }}>
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

      {openTrades.length > 0 && (
        <div style={{ padding: sectionPad, borderBottom: `1px solid ${tk.borderSub}` }}>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Live positions</div>
            {livePositionsStatus && (
              <div style={{ marginBottom: 10 }}>
                <StatusNotice {...livePositionsStatus} palette={uiPalette} compact />
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {openTrades.map(pos => {
                const entryMC = pos.entryMarketCap;
                const sizeSol = pos.positionSizeSol;
                const sizeUsd = solPrice ? sizeSol * solPrice : null;
                const livePositionValue = calendarUnit === "sol" || sizeUsd === null
                  ? `${sizeSol.toFixed(3)} SOL`
                  : `$${sizeUsd.toFixed(2)}`;
                const deleteBusy = openTradeDeleteBusyId === pos.positionId;
                return (
                  <div key={pos.positionId} className="ui-card-reveal" style={{ ...quietPanel, padding: cardPad, cursor: pos.pageUrl ? "pointer" : "default", animationDelay: `${Math.min(openTrades.indexOf(pos), 5) * 28}ms` }}
                    onClick={() => pos.pageUrl && window.open(pos.pageUrl, "_blank", "noopener,noreferrer")}
                  >
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 5, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: tk.text, lineHeight: 1.2 }}>{pos.tokenName}</span>
                          {pos.tokenFullName && <span style={{ fontSize: 11, color: tk.textDim }}>{pos.tokenFullName}</span>}
                        </div>
                        <div style={{ fontSize: 11, color: tk.textDim, marginTop: 2 }}>
                          entry {formatAuditMc(entryMC)}
                        </div>
                        {pos.contractAddress && (
                          <button
                            type="button"
                            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(pos.contractAddress); }}
                            style={{ marginTop: 4, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10, color: tk.textDim, fontFamily: sans, letterSpacing: "0.01em", display: "flex", alignItems: "center", gap: 4 }}
                          >
                            <span style={{ fontFamily: "monospace", maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>{pos.contractAddress}</span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                          </button>
                        )}
                      </div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: tk.textMid, whiteSpace: "nowrap" }}>
                        {livePositionValue}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); void deleteOpenTrade(pos); }}
                        disabled={deleteBusy}
                        style={{
                          border: "none",
                          background: "transparent",
                          padding: 0,
                          margin: 0,
                          color: deleteBusy ? tk.textDim : red,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: deleteBusy ? "default" : "pointer",
                        }}
                      >
                        {deleteBusy ? "Deleting..." : "Delete trade"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
      )}

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
          {sessions.length > 0 ? missionStats.items.map(item => (
            <div key={item.label} style={{ padding: "4px 0 8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: item.done ? green : tk.text }}>{item.label}</span>
                <span style={{ fontSize: 11, color: item.done ? green : tk.textDim }}>{item.done ? "✓" : Math.round(item.progress * 100) + "%"}</span>
              </div>
              <div style={{ height: 5, background: tk.border, borderRadius: 999, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.round(item.progress * 100)}%`, background: item.done ? green : accent, borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 11, color: item.done ? green : tk.textMid, marginTop: 7 }}>{item.value}</div>
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
                  <div style={{ ...quietPanel, padding: cardPad }}>
                    <div style={{ fontSize: 9, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{item.label} trades</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: tk.text }}>{item.trades}</div>
                  </div>
                  <div style={{ ...quietPanel, padding: cardPad }}>
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

  const switchMode = (mode) => { setAuthMode(mode); setAuthError(""); setAuthNotice(""); };

  const authScreen = (
    <div className="ui-page-enter" style={{ minHeight: "100vh", background: tk.bg, color: tk.text, fontFamily: sans, display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 400 }}>

        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", color: tk.text }}>Posture</div>
          <div style={{ marginTop: 6, fontSize: 13, color: tk.textDim }}>
            {authMode === "sign-up" && "Create your account"}
            {authMode === "sign-in" && "Welcome back"}
            {authMode === "forgot-password" && "Reset your password"}
            {authMode === "reset-password" && "Choose a new password"}
          </div>
        </div>

        <div className="ui-panel-pop" style={{ ...panel, padding: `${modalPad + 4}px ${modalPad + 2}px`, borderRadius: 16, boxShadow: dark ? "0 18px 40px rgba(0,0,0,0.18)" : "0 20px 40px rgba(31,35,40,0.08)" }}>
          {!hasSupabaseConfig ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, color: tk.text, marginBottom: 8 }}>Connect Supabase</div>
              <div style={{ ...quietPanel, padding: 12 }}>
                <div style={{ fontSize: 11, color: tk.textDim, marginBottom: 6 }}>Add these env vars:</div>
                <div style={{ fontSize: 12, color: tk.text, lineHeight: 1.8, fontFamily: "monospace" }}>
                  VITE_SUPABASE_URL<br />VITE_SUPABASE_ANON_KEY
                </div>
              </div>
            </>
          ) : !authReady ? (
            <div style={{ padding: "10px 0 6px" }}>
              <InlineLoader label="Preparing account access" tone="accent" align="center" />
              <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
                <div className="ui-skeleton" style={{ height: 14, borderRadius: 999, opacity: 0.75 }} />
                <div className="ui-skeleton" style={{ height: 42, borderRadius: 10 }} />
                <div className="ui-skeleton" style={{ height: 42, borderRadius: 10 }} />
                <div className="ui-skeleton" style={{ height: 44, borderRadius: 999, opacity: 0.82 }} />
              </div>
            </div>
          ) : (
            <>
              {(authMode === "sign-in" || authMode === "sign-up") && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
                  {[
                    ["sign-up", "Create account"],
                    ["sign-in", "Sign in"],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      className="ui-interactive-button"
                      onClick={() => switchMode(mode)}
                      style={{
                        ...actionButton,
                        borderRadius: 999,
                        padding: "9px 12px",
                        background: authMode === mode ? (dark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.05)") : "transparent",
                        borderColor: authMode === mode ? tk.border : tk.borderSub,
                        color: authMode === mode ? tk.text : tk.textDim,
                        fontSize: 12,
                        fontWeight: 700,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={handleAuthSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {authMode === "sign-up" && (
                  <>
                    <div>
                      <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Invite code</label>
                      <input
                        value={authForm.inviteCode}
                        onChange={e => setAuthForm(prev => ({ ...prev, inviteCode: e.target.value.toUpperCase() }))}
                        placeholder="XXXXXXXX"
                        autoFocus
                        style={{ ...inp, fontFamily: "monospace", letterSpacing: "0.1em", borderRadius: 10 }}
                      />
                    </div>
                    <div>
                      <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Name</label>
                      <input
                        value={authForm.fullName}
                        onChange={e => setAuthForm(prev => ({ ...prev, fullName: e.target.value }))}
                        placeholder="Your name"
                        style={{ ...inp, borderRadius: 10 }}
                      />
                    </div>
                  </>
                )}
                {authMode !== "reset-password" && (
                  <div>
                    <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Email</label>
                    <input
                      type="email"
                      value={authForm.email}
                      onChange={e => setAuthForm(prev => ({ ...prev, email: e.target.value }))}
                      placeholder="you@example.com"
                      autoFocus={authMode === "sign-in"}
                      style={{ ...inp, borderRadius: 10 }}
                    />
                  </div>
                )}
                {authMode !== "forgot-password" && (
                  <div>
                    <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Password</label>
                    <input
                      type="password"
                      value={authForm.password}
                      onChange={e => setAuthForm(prev => ({ ...prev, password: e.target.value }))}
                      placeholder="Minimum 6 characters"
                      style={{ ...inp, borderRadius: 10 }}
                    />
                  </div>
                )}
                {authMode === "reset-password" && (
                  <div>
                    <label style={{ ...labelStyle, display: "block", marginBottom: 6 }}>Confirm password</label>
                    <input
                      type="password"
                      value={authForm.confirmPassword}
                      onChange={e => setAuthForm(prev => ({ ...prev, confirmPassword: e.target.value }))}
                      placeholder="Repeat your new password"
                      style={{ ...inp, borderRadius: 10 }}
                    />
                  </div>
                )}

                {authError && (
                  <StatusNotice
                    tone="error"
                    title="Authentication issue"
                    detail={authError}
                    palette={uiPalette}
                    compact
                  />
                )}
                {authNotice && (
                  <StatusNotice
                    tone="success"
                    title="Account update"
                    detail={authNotice}
                    palette={uiPalette}
                    compact
                  />
                )}

                <button
                  type="submit"
                  className="ui-interactive-button"
                  disabled={
                    authBusy
                    || (authMode !== "forgot-password" && authMode !== "reset-password" && !authForm.email.trim())
                    || ((authMode === "sign-in" || authMode === "sign-up" || authMode === "reset-password") && !authForm.password)
                    || (authMode === "reset-password" && !authForm.confirmPassword)
                    || (authMode === "sign-up" && !authForm.inviteCode.trim())
                  }
                  style={{
                    ...actionButton,
                    padding: "12px 16px",
                    borderRadius: 999,
                    background: tk.surface2,
                    borderColor: tk.border,
                    color: tk.text,
                    fontWeight: 600,
                    fontSize: 14,
                    marginTop: 2,
                    minHeight: 44,
                    boxShadow: authBusy ? "none" : (dark ? "0 8px 18px rgba(0,0,0,0.14)" : "0 8px 18px rgba(31,35,40,0.06)"),
                  }}
                >
                  {authBusy ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <span className="ui-inline-loader-dots" aria-hidden="true"><span /><span /><span /></span>
                      <span>{authMode === "forgot-password" ? "Sending reset email" : authMode === "reset-password" ? "Updating password" : "Working"}</span>
                    </span>
                  ) : authMode === "sign-up" ? "Create account" : authMode === "forgot-password" ? "Send reset email" : authMode === "reset-password" ? "Update password" : "Sign in"}
                </button>
              </form>

              <div style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${tk.borderSub}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                {authMode === "sign-in" && (
                  <span style={{ fontSize: 13, color: tk.textDim }}>
                    Need a new account?{" "}
                    <button type="button" onClick={() => switchMode("sign-up")} style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: tk.textMid, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, fontFamily: sans }}>
                      Create one
                    </button>
                  </span>
                )}
                {authMode === "sign-up" && (
                  <span style={{ fontSize: 13, color: tk.textDim }}>
                    Already set up?{" "}
                    <button type="button" onClick={() => switchMode("sign-in")} style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: tk.textMid, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3, fontFamily: sans }}>
                      Sign in
                    </button>
                  </span>
                )}
                {authMode === "sign-in" && (
                  <button type="button" onClick={() => switchMode("forgot-password")} style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: tk.textDim, cursor: "pointer", fontFamily: sans }}>
                    Forgot password?
                  </button>
                )}
                {(authMode === "forgot-password" || authMode === "reset-password") && (
                  <button type="button" onClick={() => switchMode("sign-in")} style={{ background: "none", border: "none", padding: 0, fontSize: 13, color: tk.textDim, cursor: "pointer", fontFamily: sans }}>
                    ← Back to sign in
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  if ((!isLocalMode && !hasSupabaseConfig) || !authReady || (!isLocalMode && !authUser)) {
    return authScreen;
  }

  // ── Session detail header ──────────────────────────────────────────────────
  const panelHeader = modal ? (
    <div style={{ padding: `${modalPad - 2}px ${modalPad}px ${modalPad - 4}px`, borderBottom: `1px solid ${dark ? "rgba(255,255,255,0.06)" : "rgba(31,35,40,0.07)"}`, position: "sticky", top: 0, background: tk.modalBg, zIndex: 10, fontFamily: sans }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 17, color: tk.text, lineHeight: 1.15 }}>{modal.date}</div>
          {modal.instrument && <div style={{ fontSize: 12, color: tk.textDim, marginTop: 5 }}>{modal.instrument}</div>}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <button className="ui-interactive-button" onClick={deleteSession} style={{ ...actionButton, background: dark ? "rgba(214,69,69,0.08)" : "rgba(214,69,69,0.06)", border: "1px solid rgba(214,69,69,0.18)", fontSize: 13, color: red, padding: "7px 14px", borderRadius: 999 }}>Delete</button>
        </div>
      </div>
    </div>
  ) : null;

  // ── Settings panel ────────────────────────────────────────────────────────
  const settingsPanel = settingsPanelOpen && (
    <div className="ui-panel-pop" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 216, background: tk.modalSurf, border: `1px solid ${tk.border}`, borderRadius: 10, boxShadow: dark ? "0 12px 32px rgba(0,0,0,0.28)" : "0 12px 28px rgba(15,23,42,0.12)", padding: 12, zIndex: 200, fontFamily: sans, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 10, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>Theme</div>
        <div style={{ display: "flex", gap: 7 }}>
          {ACCENT_PRESETS.map(p => (
            <button key={p.key} title={p.key} onClick={() => { setAccentKey(p.key); localStorage.setItem("posture_accent_key", p.key); }} style={{ width: 24, height: 24, borderRadius: "50%", background: p.base, border: accentKey === p.key ? `2.5px solid ${tk.text}` : "2.5px solid transparent", outline: "none", cursor: "pointer", padding: 0, flexShrink: 0, boxShadow: accentKey === p.key ? `0 0 0 3px ${dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)"}` : "none" }} />
          ))}
        </div>
      </div>
      {authUser && (
        <div style={{ borderTop: `1px solid ${tk.border}`, paddingTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
          <button className="ui-interactive-button" onClick={async () => { await signOutUser(); setSettingsPanelOpen(false); }} style={{ background: "none", border: `1px solid ${tk.border}`, borderRadius: 7, padding: "6px 10px", fontSize: 12, color: tk.textMid, cursor: "pointer", fontFamily: sans, textAlign: "left" }}>Sign out</button>
          <button onClick={async () => {
            if (!window.confirm("Delete your account? This cannot be undone.")) return;
            try { await deleteCurrentUser(); } catch { window.alert("Couldn't delete account — contact support."); }
          }} className="ui-interactive-button" style={{ background: "none", border: `1px solid ${tk.border}`, borderRadius: 7, padding: "6px 10px", fontSize: 12, color: red, cursor: "pointer", fontFamily: sans, textAlign: "left" }}>Delete account</button>
        </div>
      )}
    </div>
  );
  const settingsIconBtn = (
    <div ref={settingsWrapperRef} style={{ position: "relative" }}>
      <button className="ui-interactive-button" onClick={() => setSettingsPanelOpen(v => !v)} aria-label="Settings" style={{ ...headerButton, padding: "5px 7px", color: settingsPanelOpen ? accent : tk.textDim, display: "flex", alignItems: "center" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path fillRule="evenodd" clipRule="evenodd" d="M12 8.25C9.92894 8.25 8.25 9.92893 8.25 12C8.25 14.0711 9.92894 15.75 12 15.75C14.0711 15.75 15.75 14.0711 15.75 12C15.75 9.92893 14.0711 8.25 12 8.25ZM9.75 12C9.75 10.7574 10.7574 9.75 12 9.75C13.2426 9.75 14.25 10.7574 14.25 12C14.25 13.2426 13.2426 14.25 12 14.25C10.7574 14.25 9.75 13.2426 9.75 12Z" fill="currentColor"/>
          <path fillRule="evenodd" clipRule="evenodd" d="M11.9747 1.25C11.5303 1.24999 11.1592 1.24999 10.8546 1.27077C10.5375 1.29241 10.238 1.33905 9.94761 1.45933C9.27379 1.73844 8.73843 2.27379 8.45932 2.94762C8.31402 3.29842 8.27467 3.66812 8.25964 4.06996C8.24756 4.39299 8.08454 4.66251 7.84395 4.80141C7.60337 4.94031 7.28845 4.94673 7.00266 4.79568C6.64714 4.60777 6.30729 4.45699 5.93083 4.40743C5.20773 4.31223 4.47642 4.50819 3.89779 4.95219C3.64843 5.14353 3.45827 5.3796 3.28099 5.6434C3.11068 5.89681 2.92517 6.21815 2.70294 6.60307L2.67769 6.64681C2.45545 7.03172 2.26993 7.35304 2.13562 7.62723C1.99581 7.91267 1.88644 8.19539 1.84541 8.50701C1.75021 9.23012 1.94617 9.96142 2.39016 10.5401C2.62128 10.8412 2.92173 11.0602 3.26217 11.2741C3.53595 11.4461 3.68788 11.7221 3.68786 12C3.68785 12.2778 3.53592 12.5538 3.26217 12.7258C2.92169 12.9397 2.62121 13.1587 2.39007 13.4599C1.94607 14.0385 1.75012 14.7698 1.84531 15.4929C1.88634 15.8045 1.99571 16.0873 2.13552 16.3727C2.26983 16.6469 2.45535 16.9682 2.67758 17.3531L2.70284 17.3969C2.92507 17.7818 3.11058 18.1031 3.28089 18.3565C3.45817 18.6203 3.64833 18.8564 3.89769 19.0477C4.47632 19.4917 5.20763 19.6877 5.93073 19.5925C6.30717 19.5429 6.647 19.3922 7.0025 19.2043C7.28833 19.0532 7.60329 19.0596 7.8439 19.1986C8.08452 19.3375 8.24756 19.607 8.25964 19.9301C8.27467 20.3319 8.31403 20.7016 8.45932 21.0524C8.73843 21.7262 9.27379 22.2616 9.94761 22.5407C10.238 22.661 10.5375 22.7076 10.8546 22.7292C11.1592 22.75 11.5303 22.75 11.9747 22.75H12.0252C12.4697 22.75 12.8407 22.75 13.1454 22.7292C13.4625 22.7076 13.762 22.661 14.0524 22.5407C14.7262 22.2616 15.2616 21.7262 15.5407 21.0524C15.686 20.7016 15.7253 20.3319 15.7403 19.93C15.7524 19.607 15.9154 19.3375 16.156 19.1985C16.3966 19.0596 16.7116 19.0532 16.9974 19.2042C17.3529 19.3921 17.6927 19.5429 18.0692 19.5924C18.7923 19.6876 19.5236 19.4917 20.1022 19.0477C20.3516 18.8563 20.5417 18.6203 20.719 18.3565C20.8893 18.1031 21.0748 17.7818 21.297 17.3969L21.3223 17.3531C21.5445 16.9682 21.7301 16.6468 21.8644 16.3726C22.0042 16.0872 22.1135 15.8045 22.1546 15.4929C22.2498 14.7697 22.0538 14.0384 21.6098 13.4598C21.3787 13.1586 21.0782 12.9397 20.7378 12.7258C20.464 12.5538 20.3121 12.2778 20.3121 11.9999C20.3121 11.7221 20.464 11.4462 20.7377 11.2742C21.0783 11.0603 21.3788 10.8414 21.6099 10.5401C22.0539 9.96149 22.2499 9.23019 22.1547 8.50708C22.1136 8.19546 22.0043 7.91274 21.8645 7.6273C21.7302 7.35313 21.5447 7.03183 21.3224 6.64695L21.2972 6.60318C21.0749 6.21825 20.8894 5.89688 20.7191 5.64347C20.5418 5.37967 20.3517 5.1436 20.1023 4.95225C19.5237 4.50826 18.7924 4.3123 18.0692 4.4075C17.6928 4.45706 17.353 4.60782 16.9975 4.79572C16.7117 4.94679 16.3967 4.94036 16.1561 4.80144C15.9155 4.66253 15.7524 4.39297 15.7403 4.06991C15.7253 3.66808 15.686 3.2984 15.5407 2.94762C15.2616 2.27379 14.7262 1.73844 14.0524 1.45933C13.762 1.33905 13.4625 1.29241 13.1454 1.27077C12.8407 1.24999 12.4697 1.24999 12.0252 1.25H11.9747ZM10.5216 2.84515C10.5988 2.81319 10.716 2.78372 10.9567 2.76729C11.2042 2.75041 11.5238 2.75 12 2.75C12.4762 2.75 12.7958 2.75041 13.0432 2.76729C13.284 2.78372 13.4012 2.81319 13.4783 2.84515C13.7846 2.97202 14.028 3.21536 14.1548 3.52165C14.1949 3.61826 14.228 3.76887 14.2414 4.12597C14.271 4.91835 14.68 5.68129 15.4061 6.10048C16.1321 6.51968 16.9974 6.4924 17.6984 6.12188C18.0143 5.9549 18.1614 5.90832 18.265 5.89467C18.5937 5.8514 18.9261 5.94047 19.1891 6.14228C19.2554 6.19312 19.3395 6.27989 19.4741 6.48016C19.6125 6.68603 19.7726 6.9626 20.0107 7.375C20.2488 7.78741 20.4083 8.06438 20.5174 8.28713C20.6235 8.50382 20.6566 8.62007 20.6675 8.70287C20.7108 9.03155 20.6217 9.36397 20.4199 9.62698C20.3562 9.70995 20.2424 9.81399 19.9397 10.0041C19.2684 10.426 18.8122 11.1616 18.8121 11.9999C18.8121 12.8383 19.2683 13.574 19.9397 13.9959C20.2423 14.186 20.3561 14.29 20.4198 14.373C20.6216 14.636 20.7107 14.9684 20.6674 15.2971C20.6565 15.3799 20.6234 15.4961 20.5173 15.7128C20.4082 15.9355 20.2487 16.2125 20.0106 16.6249C19.7725 17.0373 19.6124 17.3139 19.474 17.5198C19.3394 17.72 19.2553 17.8068 19.189 17.8576C18.926 18.0595 18.5936 18.1485 18.2649 18.1053C18.1613 18.0916 18.0142 18.045 17.6983 17.8781C16.9973 17.5075 16.132 17.4803 15.4059 17.8995C14.68 18.3187 14.271 19.0816 14.2414 19.874C14.228 20.2311 14.1949 20.3817 14.1548 20.4784C14.028 20.7846 13.7846 21.028 13.4783 21.1549C13.4012 21.1868 13.284 21.2163 13.0432 21.2327C12.7958 21.2496 12.4762 21.25 12 21.25C11.5238 21.25 11.2042 21.2496 10.9567 21.2327C10.716 21.2163 10.5988 21.1868 10.5216 21.1549C10.2154 21.028 9.97201 20.7846 9.84514 20.4784C9.80512 20.3817 9.77195 20.2311 9.75859 19.874C9.72896 19.0817 9.31997 18.3187 8.5939 17.8995C7.86784 17.4803 7.00262 17.5076 6.30158 17.8781C5.98565 18.0451 5.83863 18.0917 5.73495 18.1053C5.40626 18.1486 5.07385 18.0595 4.81084 17.8577C4.74458 17.8069 4.66045 17.7201 4.52586 17.5198C4.38751 17.314 4.22736 17.0374 3.98926 16.625C3.75115 16.2126 3.59171 15.9356 3.4826 15.7129C3.37646 15.4962 3.34338 15.3799 3.33248 15.2971C3.28921 14.9684 3.37828 14.636 3.5801 14.373C3.64376 14.2901 3.75761 14.186 4.0602 13.9959C4.73158 13.5741 5.18782 12.8384 5.18786 12.0001C5.18791 11.1616 4.73165 10.4259 4.06021 10.004C3.75769 9.81389 3.64385 9.70987 3.58019 9.62691C3.37838 9.3639 3.28931 9.03149 3.33258 8.7028C3.34348 8.62001 3.37656 8.50375 3.4827 8.28707C3.59181 8.06431 3.75125 7.78734 3.98935 7.37493C4.22746 6.96253 4.3876 6.68596 4.52596 6.48009C4.66055 6.27983 4.74468 6.19305 4.81093 6.14222C5.07395 5.9404 5.40636 5.85133 5.73504 5.8946C5.83873 5.90825 5.98576 5.95483 6.30173 6.12184C7.00273 6.49235 7.86791 6.51962 8.59394 6.10045C9.31998 5.68128 9.72896 4.91837 9.75859 4.12602C9.77195 3.76889 9.80512 3.61827 9.84514 3.52165C9.97201 3.21536 10.2154 2.97202 10.5216 2.84515Z" fill="currentColor"/>
        </svg>
      </button>
      {settingsPanel}
    </div>
  );
  const profileTrigger = (
    <div style={{ position: "relative", minWidth: 0 }}>
      <div
        aria-label="Streak"
        style={{
          minWidth: 0,
          display: "flex",
          alignItems: "center",
        }}
      >
        {streakBadge}
      </div>
    </div>
  );
  const headerPnl = (
    <button
      onClick={() => setBalanceModalOpen(true)}
      onMouseEnter={() => setBalanceHover(true)}
      onMouseLeave={() => setBalanceHover(false)}
      style={{
        ...headerButton,
        display: "flex",
        alignItems: "center",
        gap: 5,
        whiteSpace: "nowrap",
        flexShrink: 0,
        padding: "7px 10px",
        background: balanceModalOpen || balanceHover ? (dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.04)") : "transparent",
        border: `1px solid ${balanceModalOpen || balanceHover ? tk.border : "transparent"}`,
        transition: "background 0.16s ease, border-color 0.16s ease",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ flexShrink: 0 }}><path fillRule="evenodd" clipRule="evenodd" d="M2.44955 6.75999H12.0395C12.1595 6.75999 12.2695 6.80999 12.3595 6.89999L13.8795 8.45999C14.1595 8.74999 13.9595 9.23999 13.5595 9.23999H3.96955C3.84955 9.23999 3.73955 9.18999 3.64955 9.09999L2.12955 7.53999C1.84955 7.24999 2.04955 6.75999 2.44955 6.75999ZM2.12955 4.68999L3.64955 3.12999C3.72955 3.03999 3.84955 2.98999 3.96955 2.98999H13.5495C13.9495 2.98999 14.1495 3.47999 13.8695 3.76999L12.3595 5.32999C12.2795 5.41999 12.1595 5.46999 12.0395 5.46999H2.44955C2.04955 5.46999 1.84955 4.97999 2.12955 4.68999ZM13.8695 11.3L12.3495 12.86C12.2595 12.95 12.1495 13 12.0295 13H2.44955C2.04955 13 1.84955 12.51 2.12955 12.22L3.64955 10.66C3.72955 10.57 3.84955 10.52 3.96955 10.52H13.5495C13.9495 10.52 14.1495 11.01 13.8695 11.3Z" fill="url(#solGradH)"/><defs><linearGradient id="solGradH" x1="1.77756" y1="13.3327" x2="13.9679" y2="1.14234" gradientUnits="userSpaceOnUse"><stop stopColor="#9945FF"/><stop offset="0.24" stopColor="#8752F3"/><stop offset="0.465" stopColor="#5497D5"/><stop offset="0.6" stopColor="#43B4CA"/><stop offset="0.735" stopColor="#28E0B9"/><stop offset="1" stopColor="#19FB9B"/></linearGradient></defs></svg>
      <span style={{ color: tk.text, fontSize: 13, fontWeight: 700, letterSpacing: "-0.01em" }}>{virtualBalance.toFixed(2)} SOL</span>
    </button>
  );
  const balanceModal = balanceModalOpen ? (
    <div
      onClick={() => setBalanceModalOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: dark ? "rgba(0,0,0,0.56)" : "rgba(31,35,40,0.22)",
        backdropFilter: "blur(8px)",
        zIndex: 520,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        className="ui-panel-pop"
        onClick={e => e.stopPropagation()}
        style={{
          ...panel,
          background: tk.modalBg,
          width: "100%",
          maxWidth: 380,
          borderRadius: 16,
          padding: modalPad,
          fontFamily: sans,
          boxShadow: dark ? "0 24px 60px rgba(0,0,0,0.34)" : "0 24px 60px rgba(15,23,42,0.14)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14, marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 10, color: tk.textDim, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700, marginBottom: 7 }}>Portfolio balance</div>
            <div style={{ fontSize: 24, fontWeight: 800, color: tk.text, lineHeight: 1 }}>{virtualBalance.toFixed(2)} SOL</div>
          </div>
          <button className="ui-interactive-button" onClick={() => setBalanceModalOpen(false)} style={{ ...headerButton, padding: "6px 8px", color: tk.textMid }}>Close</button>
        </div>
        <div style={{ fontSize: 12, color: tk.textMid, lineHeight: 1.6, marginBottom: 14 }}>
          Add SOL to your paper portfolio and keep it synced with the extension balance.
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            autoFocus
            type="number"
            min="0"
            step="0.1"
            placeholder="Add SOL"
            value={balanceInputVal}
            onChange={e => setBalanceInputVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                const v = Number(balanceInputVal);
                if (v > 0) {
                  syncVirtualBalance(virtualBalance + v);
                  setBalanceInputVal("");
                  setBalanceModalOpen(false);
                }
              }
            }}
            style={{ flex: 1, background: tk.inp.bg, border: `1px solid ${tk.inp.border}`, color: tk.inp.color, borderRadius: 8, padding: "10px 12px", fontSize: 13, fontFamily: sans, outline: "none", minWidth: 0 }}
          />
          <button
            className="ui-interactive-button"
            onClick={() => {
              const v = Number(balanceInputVal);
              if (v > 0) {
                syncVirtualBalance(virtualBalance + v);
                setBalanceInputVal("");
                setBalanceModalOpen(false);
              }
            }}
            style={{ background: `${accent}18`, border: `1px solid ${accent}44`, color: accent, borderRadius: 8, padding: "0 14px", fontSize: 13, fontWeight: 700, fontFamily: sans, cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
          >
            Add
          </button>
        </div>
        <button
          className="ui-interactive-button"
          onClick={() => {
            resetVirtualBalance();
            setBalanceInputVal("");
            setBalanceModalOpen(false);
          }}
          style={{ background: "none", border: "none", color: red, fontSize: 12, fontFamily: sans, cursor: "pointer", padding: 0, opacity: 0.8 }}
        >
          Reset balance
        </button>
      </div>
    </div>
  ) : null;

  // ── Header ─────────────────────────────────────────────────────────────────
  const appHeader = (
    <header style={{ borderBottom: `1px solid ${tk.border}`, position: "sticky", top: 0, background: tk.modalBg, backdropFilter: "blur(18px)", zIndex: 100, fontFamily: sans }}>
      <div style={{ height: isDesktop ? 54 : 56, maxWidth: 1180, margin: "0 auto", padding: `0 ${shellPadX}px` }}>
        {isDesktop ? (
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", height: "100%", alignItems: "stretch" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, padding: `0 ${sectionPad}px` }}>
              {headerPnl}
              {isAdmin && <button className="ui-interactive-button" onClick={() => { void loadInvitePanel(); }} style={{ ...headerButton, fontSize: 12, padding: "4px 8px" }}>Invites</button>}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderLeft: `1px solid ${tk.border}`, padding: `0 ${sectionPad}px`, minWidth: 0 }}>
              {profileTrigger}
              {settingsIconBtn}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, height: "100%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {headerPnl}
              {isAdmin && <button className="ui-interactive-button" onClick={() => { void loadInvitePanel(); }} style={{ ...headerButton, fontSize: 12, padding: "4px 8px" }}>Invites</button>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, minWidth: 0 }}>
              {profileTrigger}
              {settingsIconBtn}
            </div>
          </div>
        )}
      </div>
    </header>
  );


  // ── Content padding ────────────────────────────────────────────────────────
  const contentPad = isDesktop ? `0 ${shellPadX}px 0` : `16px ${shellPadX}px 72px`;
  const desktopLeftDivider = (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        bottom: 0,
        left: `max(${shellPadX}px, calc((100vw - 1180px) / 2 + ${shellPadX}px))`,
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
        right: `max(${shellPadX}px, calc((100vw - 1180px) / 2 + ${shellPadX}px))`,
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
      <div className="ui-panel-pop" onClick={e => e.stopPropagation()} style={{ ...panel, background: tk.modalBg, borderRadius: 16, width: "100%", maxWidth: 420, padding: modalPad, fontFamily: sans }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: tk.text }}>Invite codes</span>
          <button className="ui-interactive-button" onClick={() => setInvitePanelOpen(false)} style={{ ...headerButton, color: tk.textMid }}>Close</button>
        </div>

        <button
          className="ui-interactive-button"
          onClick={async () => {
            setInviteGenBusy(true);
            try {
              const code = await generateInvite();
              setInviteList(prev => [{ code, created_at: new Date().toISOString(), used_at: null }, ...prev]);
              setInviteStatus({
                tone: "success",
                title: "Invite generated",
                detail: `${code} is ready to copy and share.`,
              });
            } catch (err) {
              setInviteStatus({
                tone: "error",
                title: "Could not generate invite code",
                detail: err?.message || "Try again in a moment.",
              });
            } finally {
              setInviteGenBusy(false);
            }
          }}
          disabled={inviteGenBusy}
          style={{ ...actionButton, width: "100%", padding: "10px 14px", borderRadius: 999, background: "rgba(16,163,127,0.10)", borderColor: `${accent}44`, color: accent, marginBottom: 16 }}
        >
          {inviteGenBusy ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span className="ui-inline-loader-dots" aria-hidden="true"><span /><span /><span /></span>
              <span>Generating code</span>
            </span>
          ) : "+ Generate invite code"}
        </button>

        {inviteStatus && (
          <div style={{ marginBottom: 14 }}>
            <StatusNotice {...inviteStatus} palette={uiPalette} compact />
          </div>
        )}

        {inviteListState === UI_STATE.LOADING ? (
          <div style={{ padding: "8px 0 4px" }}>
            <InlineLoader label="Loading invite codes" tone="accent" />
          </div>
        ) : inviteListState === UI_STATE.EMPTY ? (
          <EmptyState
            compact
            align="center"
            eyebrow="Access"
            title="No invite codes yet"
            detail="Generate a code to share controlled access to the dashboard."
            palette={uiPalette}
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto" }}>
            {inviteList.map(inv => {
              const inviteUrl = `${window.location.origin}${window.location.pathname}?invite=${inv.code}`;
              const copied = inviteCopied === inv.code;
              return (
                <div key={inv.code} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: cardPad, borderRadius: 8, background: inv.used_at ? tk.surface2 : `${accent}0d`, border: `1px solid ${inv.used_at ? tk.borderSub : accent + "22"}` }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 13, letterSpacing: "0.08em", color: inv.used_at ? tk.textDim : tk.text }}>{inv.code}</span>
                    <span style={{ fontSize: 11, color: tk.textDim }}>{inv.used_at ? "Used" : "Available"}</span>
                  </div>
                  {!inv.used_at && (
                    <button
                      className="ui-interactive-button"
                      onClick={() => {
                        navigator.clipboard.writeText(inviteUrl);
                        setInviteCopied(inv.code);
                        setInviteStatus({
                          tone: "success",
                          title: "Invite link copied",
                          detail: `${inv.code} is ready to send.`,
                        });
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
      <div className="ui-page-enter" style={{ background: tk.bg, color: tk.text, height: "100vh", overflow: "hidden", fontFamily: sans }}>
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
        {balanceModal}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MOBILE
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="ui-page-enter" style={{ background: tk.bg, color: tk.text, minHeight: "100vh", fontFamily: sans }}>
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
                  <button className="ui-interactive-button" onClick={deleteSession} style={{ ...actionButton, background: "rgba(214,69,69,0.08)", border: "1px solid rgba(214,69,69,0.20)", fontSize: 13, color: red, padding: "6px 14px" }}>Delete</button>
                </div>
              </div>
            </div>
            {detailBody}
          </div>
        </div>
      )}
      {invitePanel}
      {balanceModal}
    </div>
  );
}
