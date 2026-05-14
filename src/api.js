import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const tradeContract = globalThis.PostureTradeContract;
if (!tradeContract) {
  throw new Error("Missing PostureTradeContract.");
}

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

let supabaseClient = null;

function getSupabase() {
  if (!hasSupabaseConfig) {
    throw new Error("Missing Supabase environment variables.");
  }
  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return supabaseClient;
}

export function onAuthStateChange(callback) {
  if (!hasSupabaseConfig) {
    return { data: { subscription: { unsubscribe() {} } } };
  }
  return getSupabase().auth.onAuthStateChange(callback);
}

export async function getCurrentUser() {
  if (!hasSupabaseConfig) return null;
  const { data, error } = await getSupabase().auth.getUser();
  if (error) throw error;
  return data.user;
}

export async function signUpWithEmail({ email, password, fullName, inviteCode }) {
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name: fullName || "",
        invite_code: inviteCode || "",
      },
    },
  });
  if (error) throw error;
  return data;
}

export async function signInWithEmail({ email, password }) {
  const { data, error } = await getSupabase().auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  return data;
}

export async function signOutUser() {
  const { error } = await getSupabase().auth.signOut();
  if (error) throw error;
}

export async function deleteCurrentUser() {
  const sb = getSupabase();
  const { error } = await sb.rpc("delete_user");
  if (error) throw error;
  await sb.auth.signOut();
}

export async function sendPasswordResetEmail(email, redirectTo) {
  const { data, error } = await getSupabase().auth.resetPasswordForEmail(email, {
    redirectTo,
  });
  if (error) throw error;
  return data;
}

export async function setSessionFromTokens(accessToken, refreshToken) {
  if (!hasSupabaseConfig) return;
  const { error } = await getSupabase().auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) throw error;
}

export async function updateUserPassword(password) {
  const { data, error } = await getSupabase().auth.updateUser({
    password,
  });
  if (error) throw error;
  return data;
}

export async function loadSessions(userId) {
  const { data, error } = await getSupabase()
    .from("user_sessions")
    .select("sessions")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.sessions ?? [];
}

export async function saveSessions(userId, sessions) {
  const { error } = await getSupabase()
    .from("user_sessions")
    .upsert(
      { user_id: userId, sessions, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );

  if (error) throw error;
}

async function loadAllPaperTrades(userId) {
  const { data, error } = await getSupabase()
    .from("user_paper_trades")
    .select("id, token_name, pnl_sol, pnl_percentage, entry_market_cap, exit_market_cap, notes, trade_timestamp")
    .eq("user_id", userId)
    .order("trade_timestamp", { ascending: false });

  if (error) throw error;
  return (data || []).map(trade => {
    const closeMeta = parseCloseTradeNote(trade.notes || "");
    return {
      closeMeta,
      positionId: closeMeta?.positionId || null,
      id: trade.id,
      tokenName: closeMeta?.tokenName || trade.token_name || "?",
      pnlSol: Number(trade.pnl_sol || 0),
      pnlPercentage: Number(trade.pnl_percentage || 0),
      entryMarketCap: Number(trade.entry_market_cap || 0),
      exitMarketCap: Number(trade.exit_market_cap || 0),
      notes: closeMeta ? "" : (trade.notes || ""),
      timestamp: trade.trade_timestamp ? new Date(trade.trade_timestamp).getTime() : Date.now(),
    };
  });
}

export async function loadClosedAndOpenPaperTrades(userId) {
  const all = await loadAllPaperTrades(userId);
  const closed = all.filter(t => !(t.notes || "").startsWith(OPEN_TRADE_NOTE_PREFIX) && !t.closeMeta === false || t.closeMeta);
  const open = all
    .map(trade => ({ trade, parsed: parseOpenTradeNote(trade.notes || "", trade) }))
    .filter(entry => entry.parsed)
    .map(({ trade, parsed }) => ({
      id: trade.id,
      positionId: parsed.positionId,
      tokenName: parsed.tokenName,
      positionSizeSol: parsed.positionSizeSol,
      initialSizeSol: parsed.initialSizeSol,
      entryMarketCap: parsed.entryMarketCap,
      realizedPnlSol: parsed.realizedPnlSol,
      openedAt: parsed.openedAt,
      pageUrl: parsed.pageUrl,
      marketCapSource: parsed.marketCapSource,
      contractAddress: parsed.contractAddress,
      pairAddress: parsed.pairAddress,
      stopLossPct: parsed.stopLossPct,
      stopLossMode: parsed.stopLossMode,
      stopLossMarketCap: parsed.stopLossMarketCap,
      targetSellPct: parsed.targetSellPct,
      targetSellMode: parsed.targetSellMode,
      targetSellMarketCap: parsed.targetSellMarketCap,
      entryCapture: parsed.entryCapture || null,
      lastCapture: parsed.lastCapture || null,
      events: parsed.events || [],
    }));
  return { closed, open };
}

const OPEN_TRADE_NOTE_PREFIX = tradeContract.OPEN_TRADE_NOTE_PREFIX;
const parseCloseTradeNote = tradeContract.parseCloseTradeNote;

function parseOpenTradeNote(note, trade) {
  return tradeContract.parseOpenTradeNote(note, trade);
}

export async function deletePaperTradesByIds(ids) {
  if (!ids || !ids.length) return;
  const { error } = await getSupabase()
    .from("user_paper_trades")
    .delete()
    .in("id", ids);
  if (error) throw error;
}

export async function validateInviteCode(code) {
  const { data } = await getSupabase()
    .from("invites")
    .select("code")
    .eq("code", code.toUpperCase())
    .is("used_at", null)
    .maybeSingle();
  return Boolean(data);
}

export async function claimInvite(code) {
  const { data, error } = await getSupabase().rpc("claim_invite", { p_code: code.toUpperCase() });
  if (error) throw error;
  return data;
}

export async function generateInvite() {
  const { data, error } = await getSupabase().rpc("generate_invite");
  if (error) throw error;
  return data;
}

export async function listInvites() {
  const { data, error } = await getSupabase().rpc("list_invites");
  if (error) throw error;
  return data || [];
}

export async function loadClosedPaperTrades(userId) {
  const trades = await loadPaperTrades(userId);
  return trades.filter(trade => !(trade.notes || "").startsWith(OPEN_TRADE_NOTE_PREFIX));
}

export async function loadOpenPaperTrades(userId) {
  const trades = await loadPaperTrades(userId);
  return trades
    .map(trade => ({ trade, parsed: parseOpenTradeNote(trade.notes || "", trade) }))
    .filter(entry => entry.parsed)
    .map(({ trade, parsed }) => ({
      id: trade.id,
      positionId: parsed.positionId,
      tokenName: parsed.tokenName,
      positionSizeSol: parsed.positionSizeSol,
      initialSizeSol: parsed.initialSizeSol,
      entryMarketCap: parsed.entryMarketCap,
      realizedPnlSol: parsed.realizedPnlSol,
      openedAt: parsed.openedAt,
      pageUrl: parsed.pageUrl,
      marketCapSource: parsed.marketCapSource,
      contractAddress: parsed.contractAddress,
      pairAddress: parsed.pairAddress,
      stopLossPct: parsed.stopLossPct,
      stopLossMode: parsed.stopLossMode,
      stopLossMarketCap: parsed.stopLossMarketCap,
      targetSellPct: parsed.targetSellPct,
      targetSellMode: parsed.targetSellMode,
      targetSellMarketCap: parsed.targetSellMarketCap,
      entryCapture: parsed.entryCapture,
      lastCapture: parsed.lastCapture,
      events: parsed.events,
    }));
}
